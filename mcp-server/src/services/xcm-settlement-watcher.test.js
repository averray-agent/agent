import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStateStore } from "../core/state-store.js";
import { EventBus } from "../core/event-bus.js";
import { XcmSettlementWatcherService as BaseXcmSettlementWatcherService } from "./xcm-settlement-watcher.js";
import { ValidationError } from "../core/errors.js";
import { id } from "ethers";
import { decodeXcmWrapperRevert } from "../blockchain/xcm-wrapper-errors.js";

const REQUEST_ID = "0x1111111111111111111111111111111111111111111111111111111111111111";
const REQUEST_ID_2 = "0x2222222222222222222222222222222222222222222222222222222222222222";
const WRAPPER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADAPTER = "0x88ee70277e486136676c0b50ed9b7d7a1a31371f";
const OTHER_ADAPTER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

class XcmSettlementWatcherService extends BaseXcmSettlementWatcherService {
  constructor(platformService, stateStore, eventBus, options = {}) {
    super({
      getXcmRequest: async (requestId) => ({ requestId, status: 1, statusLabel: "pending" }),
      getXcmRequestAdapterRegistration: async () => ({
        requestAdapter: "0x0000000000000000000000000000000000000000",
        registeredStrategyAdapter: "0x0000000000000000000000000000000000000000",
        adapterManaged: false
      }),
      ...platformService
    }, stateStore, eventBus, { expectedWrapper: WRAPPER, ...options });
  }
}

test("disabled watcher accepts an absent wrapper while malformed configured wrappers fail closed", () => {
  const stateStore = new MemoryStateStore();
  const platformService = { finalizeXcmRequest: async () => ({}) };
  const absent = new BaseXcmSettlementWatcherService(platformService, stateStore, undefined, {
    enabled: false,
    expectedWrapper: null
  });
  assert.equal(absent.expectedWrapper, undefined);

  assert.throws(
    () => new BaseXcmSettlementWatcherService(platformService, stateStore, undefined, {
      enabled: true,
      expectedWrapper: "not-an-address"
    }),
    /wrapperAddress must be a 20-byte address/u
  );
});

test("observeOutcome stores a pending observation and emits an event", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const events = [];
  eventBus.subscribe({ topics: ["xcm.outcome_observed"] }, (event) => events.push(event));

  const watcher = new XcmSettlementWatcherService(
    { finalizeXcmRequest: async () => ({}) },
    stateStore,
    eventBus,
    { enabled: false }
  );

  const observation = await watcher.observeOutcome(REQUEST_ID, {
    status: "succeeded",
    settledAssets: 5
  });

  assert.equal(observation.requestId, REQUEST_ID);
  assert.equal(observation.settledAssets, "5");
  assert.equal(observation.processed, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "xcm.outcome_observed");
  assert.equal(events[0].correlationId, REQUEST_ID);
  assert.equal(events[0].data.settledAssets, "5");
  assert.equal(events[0].data.settledAssetsRaw, "5");
  assert.equal(events[0].data.settledShares, "0");
  assert.equal(events[0].data.settledSharesRaw, "0");
  assert.equal(events[0].data.observedAt, observation.observedAt);
});

test("runPendingSettlements finalizes stored observations and marks them processed", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const events = [];
  eventBus.subscribe({ topics: ["xcm.request_auto_finalized"] }, (event) => events.push(event));
  const finalizedCalls = [];
  const watcher = new XcmSettlementWatcherService(
    {
      finalizeXcmRequest: async (requestId, outcome) => {
        finalizedCalls.push([requestId, outcome]);
        return {
          requestId,
          settledVia: "agent_account",
          strategyRequest: {
            account: "0xabc",
            statusLabel: "succeeded",
            settledAssetsRaw: outcome.settledAssets,
            settledSharesRaw: outcome.settledShares
          }
        };
      }
    },
    stateStore,
    eventBus,
    { enabled: false }
  );

  await watcher.observeOutcome(REQUEST_ID, {
    status: "succeeded",
    settledAssets: 5,
    settledShares: 5
  });

  const results = await watcher.runPendingSettlements();
  const stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);

  assert.equal(results.length, 1);
  assert.equal(finalizedCalls.length, 1);
  assert.equal(finalizedCalls[0][1].settledAssets, "5");
  assert.equal(finalizedCalls[0][1].settledShares, "5");
  assert.equal(stored.processed, true);
  assert.equal(stored.result.settledVia, "agent_account");
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "xcm.request_auto_finalized");
  assert.equal(events[0].correlationId, REQUEST_ID);
  assert.equal(events[0].data.settledAssets, "5");
  assert.equal(events[0].data.settledAssetsRaw, "5");
  assert.equal(events[0].data.settledShares, "5");
  assert.equal(events[0].data.settledSharesRaw, "5");
  assert.equal(events[0].data.source, "observer");
});

test("adapter-owned pending request makes zero finalize attempts across repeated sweeps", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const pendingEvents = [];
  const failureEvents = [];
  eventBus.subscribe({ topics: ["xcm.request_adapter_managed_pending"] }, (event) => pendingEvents.push(event));
  eventBus.subscribe({ topics: ["xcm.request_finalize_failed"] }, (event) => failureEvents.push(event));
  let finalizeCalls = 0;
  const watcher = new XcmSettlementWatcherService(
    {
      getXcmRequest: async (requestId) => ({
        requestId,
        strategyId: `0x${"12".repeat(32)}`,
        status: 1,
        statusLabel: "pending"
      }),
      getXcmRequestAdapterRegistration: async () => ({
        requestAdapter: ADAPTER,
        registeredStrategyAdapter: ADAPTER,
        adapterManaged: true
      }),
      finalizeXcmRequest: async () => {
        finalizeCalls += 1;
        throw new Error("adapter-owned requests must never use direct finalize");
      }
    },
    stateStore,
    eventBus,
    { enabled: false, now: () => Date.parse("2026-08-21T13:20:00.000Z"), logger: { info() {} } }
  );
  await watcher.observeOutcome(REQUEST_ID, { status: "succeeded", settledAssets: 5 });

  for (let sweep = 0; sweep < 6; sweep += 1) {
    await watcher.runPendingSettlements();
  }

  const stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);
  assert.equal(finalizeCalls, 0, "removing the adapter-ownership check causes repeated direct finalize attempts");
  assert.equal(stored.processed, false);
  assert.equal(stored.finalizeState, "adapter_managed_pending");
  assert.equal(stored.attemptCount, 0);
  assert.equal(pendingEvents.length, 1, "adapter-managed pending rows are low-frequency, not per-sweep");
  assert.equal(pendingEvents[0].data.requestAdapter, ADAPTER);
  assert.equal(failureEvents.length, 0);
});

test("adapter-owned request reconciles when it becomes terminal without a finalize attempt", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const reconciledEvents = [];
  eventBus.subscribe({ topics: ["xcm.request_reconciled_terminal"] }, (event) => reconciledEvents.push(event));
  let terminal = false;
  let finalizeCalls = 0;
  const watcher = new XcmSettlementWatcherService(
    {
      getXcmRequest: async (requestId) => ({
        requestId,
        strategyId: `0x${"12".repeat(32)}`,
        account: "0x1111111111111111111111111111111111111111",
        status: terminal ? 2 : 1,
        statusLabel: terminal ? "succeeded" : "pending",
        settledAssetsRaw: terminal ? "5" : "0",
        settledSharesRaw: "0",
        remoteRef: `0x${"34".repeat(32)}`
      }),
      getXcmRequestAdapterRegistration: async () => ({
        requestAdapter: ADAPTER,
        registeredStrategyAdapter: ADAPTER,
        adapterManaged: true
      }),
      finalizeXcmRequest: async () => {
        finalizeCalls += 1;
      }
    },
    stateStore,
    eventBus,
    { enabled: false, logger: { info() {} } }
  );
  await watcher.observeOutcome(REQUEST_ID, { status: "succeeded", settledAssets: 5 });

  await watcher.runPendingSettlements();
  terminal = true;
  await watcher.runPendingSettlements();

  const stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);
  assert.equal(finalizeCalls, 0);
  assert.equal(stored.processed, true);
  assert.equal(stored.finalizeState, "reconciled_terminal");
  assert.equal(reconciledEvents.length, 1);
  assert.equal(reconciledEvents[0].data.onChainStatus, "succeeded");
});

test("non-adapter request preserves reconcile-before-finalize behavior", async () => {
  const stateStore = new MemoryStateStore();
  let finalizeCalls = 0;
  const watcher = new XcmSettlementWatcherService(
    {
      getXcmRequestAdapterRegistration: async () => ({
        requestAdapter: ADAPTER,
        registeredStrategyAdapter: OTHER_ADAPTER,
        adapterManaged: false
      }),
      finalizeXcmRequest: async (_requestId, outcome) => {
        finalizeCalls += 1;
        return {
          settledVia: "xcm_wrapper",
          statusLabel: outcome.status,
          settledAssetsRaw: outcome.settledAssets,
          settledSharesRaw: outcome.settledShares
        };
      }
    },
    stateStore,
    undefined,
    { enabled: false }
  );
  await watcher.observeOutcome(REQUEST_ID, { status: "succeeded", settledAssets: 5 });

  await watcher.runPendingSettlements();

  const stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);
  assert.equal(finalizeCalls, 1);
  assert.equal(stored.processed, true);
  assert.equal(stored.result.settledVia, "xcm_wrapper");
});

test("adapter-owned backfill leaves retry attempt count unchanged and clears its schedule", async () => {
  const stateStore = new MemoryStateStore();
  let finalizeCalls = 0;
  const watcher = new XcmSettlementWatcherService(
    {
      getXcmRequestAdapterRegistration: async () => ({
        requestAdapter: ADAPTER,
        registeredStrategyAdapter: ADAPTER,
        adapterManaged: true
      }),
      finalizeXcmRequest: async () => {
        finalizeCalls += 1;
      }
    },
    stateStore,
    undefined,
    { enabled: false, logger: { info() {} } }
  );
  await watcher.observeOutcome(REQUEST_ID, { status: "succeeded", settledAssets: 5 });
  await stateStore.markXcmObservationFailed(
    WRAPPER,
    REQUEST_ID,
    new Error("XcmWrapperV22.Unauthorized()"),
    { nextAttemptAt: "2099-01-01T00:00:00.000Z", retryDelayMs: 60_000 }
  );

  await watcher.runPendingSettlements();
  const stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);

  assert.equal(finalizeCalls, 0);
  assert.equal(stored.processed, false);
  assert.equal(stored.finalizeState, "adapter_managed_pending");
  assert.equal(stored.attemptCount, 1, "ownership reconciliation must not add a retry attempt");
  assert.equal(stored.nextAttemptAt, undefined);
  assert.equal(stored.retryDelayMs, undefined);
  assert.equal(stored.lastError, undefined);
});

test("parked adapter-owned backfill drains finalize_exhausted and later reconciles by name", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const reconciledEvents = [];
  eventBus.subscribe({ topics: ["xcm.request_reconciled_terminal"] }, (event) => reconciledEvents.push(event));
  let terminal = false;
  let finalizeCalls = 0;
  const watcher = new XcmSettlementWatcherService(
    {
      getXcmRequest: async (requestId) => ({
        requestId,
        strategyId: `0x${"12".repeat(32)}`,
        status: terminal ? 2 : 1,
        statusLabel: terminal ? "succeeded" : "pending",
        settledAssetsRaw: terminal ? "5" : "0",
        settledSharesRaw: "0"
      }),
      getXcmRequestAdapterRegistration: async () => ({
        requestAdapter: ADAPTER,
        registeredStrategyAdapter: ADAPTER,
        adapterManaged: true
      }),
      finalizeXcmRequest: async () => {
        finalizeCalls += 1;
      }
    },
    stateStore,
    eventBus,
    { enabled: false, logger: { info() {} } }
  );
  await watcher.observeOutcome(REQUEST_ID, { status: "succeeded", settledAssets: 5 });
  await stateStore.markXcmObservationFinalizeExhausted(
    WRAPPER,
    REQUEST_ID,
    new Error("XcmWrapperV22.Unauthorized()"),
    { maxFinalizeAttempts: 5 }
  );
  assert.equal((await watcher.listFinalizeExhausted()).length, 1);

  await watcher.runPendingSettlements();
  let stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);
  assert.equal(stored.processed, false);
  assert.equal(stored.finalizeState, "adapter_managed_pending");
  assert.equal((await watcher.listFinalizeExhausted()).length, 0);
  assert.equal(finalizeCalls, 0);

  terminal = true;
  await watcher.runPendingSettlements();
  stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);
  assert.equal(stored.processed, true);
  assert.equal(stored.finalizeState, "reconciled_terminal");
  assert.equal(reconciledEvents.length, 1);
  assert.equal(finalizeCalls, 0);
});

test("reconcile-before-finalize drains five already-terminal requests on the first sweep", async () => {
  const requestIds = Array.from({ length: 5 }, (_, index) =>
    `0x${String(index + 1).repeat(64)}`
  );
  const failureCode = `0x51554f54${"0".repeat(56)}`;
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const reconciledEvents = [];
  eventBus.subscribe({ topics: ["xcm.request_reconciled_terminal"] }, (event) => reconciledEvents.push(event));
  let finalizeCalls = 0;
  const watcher = new XcmSettlementWatcherService(
    {
      getXcmRequest: async (requestId) => {
        const failed = requestId === requestIds.at(-1);
        return {
          requestId,
          account: "0x1111111111111111111111111111111111111111",
          status: failed ? 3 : 2,
          statusLabel: failed ? "failed" : "succeeded",
          settledAssetsRaw: failed ? "0" : "100000",
          settledSharesRaw: failed ? "0" : "100000",
          remoteRef: `0x${"12".repeat(32)}`,
          failureCode: failed ? failureCode : undefined,
          failureCodeLabel: failed ? "QUOT" : undefined
        };
      },
      finalizeXcmRequest: async () => {
        finalizeCalls += 1;
        throw new Error("terminal requests must never be finalized");
      }
    },
    stateStore,
    eventBus,
    { enabled: false, logger: { info() {} } }
  );
  for (const requestId of requestIds) {
    await watcher.observeOutcome(requestId, { status: "succeeded", settledAssets: 1 });
  }

  const results = await watcher.runPendingSettlements();
  await watcher.runPendingSettlements();

  assert.equal(results.length, 5);
  assert.equal(finalizeCalls, 0);
  assert.equal((await stateStore.listPendingXcmObservations()).length, 0);
  assert.equal(reconciledEvents.length, 5, "each terminal request emits exactly one reconciliation row");
  assert.deepEqual(reconciledEvents.map((event) => event.data.onChainStatus), [
    "succeeded", "succeeded", "succeeded", "succeeded", "failed"
  ]);
  assert.equal(reconciledEvents.at(-1).data.failureCode, failureCode);
  assert.equal(reconciledEvents.at(-1).data.failureCodeLabel, "QUOT");
  const failed = await stateStore.getXcmObservation(WRAPPER, requestIds.at(-1));
  assert.equal(failed.processed, true);
  assert.equal(failed.finalizeState, "reconciled_terminal");
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureCode, failureCode);
});

test("mutation drill: reconcile guard prevents repeated finalize attempts against an already-Succeeded request", async () => {
  const stateStore = new MemoryStateStore();
  let nowMs = Date.parse("2026-08-20T02:58:00.000Z");
  let finalizeCalls = 0;
  const watcher = new XcmSettlementWatcherService(
    {
      getXcmRequest: async (requestId) => ({
        requestId,
        status: 2,
        statusLabel: "succeeded",
        settledAssetsRaw: "5",
        settledSharesRaw: "0"
      }),
      finalizeXcmRequest: async () => {
        finalizeCalls += 1;
        throw new Error("InvalidStatus");
      }
    },
    stateStore,
    undefined,
    {
      enabled: false,
      retryBaseMs: 1,
      retryMaxMs: 1,
      now: () => nowMs,
      logger: { info() {}, warn() {}, error() {} }
    }
  );
  await watcher.observeOutcome(REQUEST_ID, { status: "succeeded", settledAssets: 5 });

  await watcher.runPendingSettlements();
  nowMs += 2;
  await watcher.runPendingSettlements();

  assert.equal(finalizeCalls, 0, "removing the terminal reconcile guard causes two finalize attempts");
  assert.equal((await stateStore.getXcmObservation(WRAPPER, REQUEST_ID)).finalizeState, "reconciled_terminal");
});

test("reconcile-before-finalize treats an on-chain Cancelled request as terminal", async () => {
  const stateStore = new MemoryStateStore();
  let finalizeCalls = 0;
  const watcher = new XcmSettlementWatcherService(
    {
      getXcmRequest: async (requestId) => ({
        requestId,
        status: 4,
        statusLabel: "cancelled",
        settledAssetsRaw: "0",
        settledSharesRaw: "0"
      }),
      finalizeXcmRequest: async () => {
        finalizeCalls += 1;
      }
    },
    stateStore,
    undefined,
    { enabled: false, logger: { info() {} } }
  );
  await watcher.observeOutcome(REQUEST_ID, { status: "cancelled" });

  await watcher.runPendingSettlements();

  assert.equal(finalizeCalls, 0);
  assert.equal((await stateStore.getXcmObservation(WRAPPER, REQUEST_ID)).status, "cancelled");
});

test("runPendingSettlements serializes concurrent triggers and drains queued observations", async () => {
  const stateStore = new MemoryStateStore();
  const finalizedCalls = [];
  let releaseFirstFinalize;
  const firstFinalizeReleased = new Promise((resolve) => {
    releaseFirstFinalize = resolve;
  });
  let firstFinalizeStarted;
  const firstFinalizeStartedPromise = new Promise((resolve) => {
    firstFinalizeStarted = resolve;
  });

  const watcher = new XcmSettlementWatcherService(
    {
      finalizeXcmRequest: async (requestId, outcome) => {
        finalizedCalls.push([requestId, outcome]);
        if (requestId === REQUEST_ID) {
          firstFinalizeStarted();
          await firstFinalizeReleased;
        }
        return {
          requestId,
          settledVia: "agent_account",
          strategyRequest: {
            account: "0xabc",
            statusLabel: outcome.status,
            settledAssetsRaw: outcome.settledAssets,
            settledSharesRaw: outcome.settledShares
          }
        };
      }
    },
    stateStore,
    undefined,
    { enabled: false }
  );

  await watcher.observeOutcome(REQUEST_ID, {
    status: "succeeded",
    settledAssets: 5
  });

  const firstRun = watcher.runPendingSettlements();
  await firstFinalizeStartedPromise;

  await watcher.observeOutcome(REQUEST_ID_2, {
    status: "succeeded",
    settledAssets: 7
  });
  const concurrentRun = watcher.runPendingSettlements();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finalizedCalls.length, 1);

  releaseFirstFinalize();
  const [firstResults, concurrentResults] = await Promise.all([firstRun, concurrentRun]);
  const storedFirst = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);
  const storedSecond = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID_2);

  assert.equal(finalizedCalls.length, 2);
  assert.equal(finalizedCalls[0][0], REQUEST_ID);
  assert.equal(finalizedCalls[1][0], REQUEST_ID_2);
  assert.equal(firstResults.length, 2);
  assert.equal(concurrentResults.length, 2);
  assert.equal(storedFirst.processed, true);
  assert.equal(storedSecond.processed, true);
});

test("runPendingSettlements emits a request_finalize_failed event with correlationId on errors", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const events = [];
  eventBus.subscribe({ topics: ["xcm.request_finalize_failed"] }, (event) => events.push(event));
  const watcher = new XcmSettlementWatcherService(
    {
      finalizeXcmRequest: async (_requestId, outcome) => {
        throw new Error("downstream settle failed");
      }
    },
    stateStore,
    eventBus,
    { enabled: false, logger: { warn: () => {} } }
  );

  await watcher.observeOutcome(REQUEST_ID, { status: "succeeded", settledAssets: 5 });
  await watcher.runPendingSettlements();

  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "xcm.request_finalize_failed");
  assert.equal(events[0].correlationId, REQUEST_ID);
  assert.equal(events[0].data.requestId, REQUEST_ID);
  assert.match(events[0].data.message, /downstream settle failed/u);
});

test("InvalidStatus custom-error selector is decoded and named in the observer row", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const events = [];
  eventBus.subscribe({ topics: ["xcm.request_finalize_failed"] }, (event) => events.push(event));
  const revert = new Error("execution reverted (unknown custom error)");
  revert.code = "CALL_EXCEPTION";
  revert.data = id("InvalidStatus()").slice(0, 10);
  const decoded = decodeXcmWrapperRevert(revert);
  const decodedError = new Error(`finalizeXcmRequest failed: ${decoded.reason}`);
  decodedError.details = { customError: decoded.name };
  const watcher = new XcmSettlementWatcherService(
    {
      finalizeXcmRequest: async () => {
        throw decodedError;
      }
    },
    stateStore,
    eventBus,
    { enabled: false, logger: { warn() {} } }
  );
  await watcher.observeOutcome(REQUEST_ID, { status: "succeeded", settledAssets: 5 });

  await watcher.runPendingSettlements();

  assert.equal(events.length, 1);
  assert.match(events[0].data.message, /XcmWrapperV22\.InvalidStatus\(\)/u);
  assert.doesNotMatch(events[0].data.message, /unknown custom error/u);
  assert.equal(events[0].data.customError, "InvalidStatus");
});

test("finalize attempt exhaustion parks the request and the ops listing exposes it", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const exhaustedEvents = [];
  eventBus.subscribe({ topics: ["xcm.request_finalize_exhausted"] }, (event) => exhaustedEvents.push(event));
  let nowMs = Date.parse("2026-08-20T03:00:00.000Z");
  let finalizeCalls = 0;
  const watcher = new XcmSettlementWatcherService(
    {
      finalizeXcmRequest: async () => {
        finalizeCalls += 1;
        throw new Error("permanent future revert class");
      }
    },
    stateStore,
    eventBus,
    {
      enabled: false,
      maxFinalizeAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 1,
      now: () => nowMs,
      logger: { warn() {}, error() {} }
    }
  );
  await watcher.observeOutcome(REQUEST_ID, { status: "succeeded", settledAssets: 5 });

  await watcher.runPendingSettlements();
  nowMs += 2;
  await watcher.runPendingSettlements();
  nowMs += 2;
  await watcher.runPendingSettlements();

  const stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);
  const parked = await watcher.listFinalizeExhausted();
  assert.equal(finalizeCalls, 2);
  assert.equal(stored.processed, true);
  assert.equal(stored.finalizeState, "finalize_exhausted");
  assert.equal(stored.attemptCount, 2);
  assert.equal((await stateStore.listPendingXcmObservations()).length, 0);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].requestId, REQUEST_ID);
  assert.equal(exhaustedEvents.length, 1);
  assert.equal(exhaustedEvents[0].data.finalizeState, "finalize_exhausted");
});

test("failed finalization retries with exponential backoff and then recovers", async () => {
  const stateStore = new MemoryStateStore();
  let nowMs = Date.parse("2026-08-05T13:18:41.000Z");
  let attempts = 0;
  const watcher = new XcmSettlementWatcherService(
    {
      finalizeXcmRequest: async (_requestId, outcome) => {
        attempts += 1;
        if (attempts <= 2) throw new Error("adapter route unavailable");
        return {
          settledVia: "strategy_adapter",
          statusLabel: "succeeded",
          settledAssetsRaw: outcome.settledAssets,
          settledSharesRaw: outcome.settledShares
        };
      }
    },
    stateStore,
    undefined,
    {
      enabled: false,
      retryBaseMs: 15_000,
      retryMaxMs: 60_000,
      now: () => nowMs,
      logger: { warn: () => {} }
    }
  );

  await watcher.observeOutcome(REQUEST_ID, {
    status: "succeeded",
    settledAssets: 100_000,
    settledShares: 100_000
  });
  await watcher.runPendingSettlements();
  let stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);
  assert.equal(attempts, 1);
  assert.equal(stored.processed, false);
  assert.equal(stored.retryDelayMs, 15_000);
  assert.equal(stored.nextAttemptAt, "2026-08-05T13:18:56.000Z");

  await watcher.runPendingSettlements();
  assert.equal(attempts, 1, "a poll before nextAttemptAt must not repeat the same revert");

  nowMs += 15_000;
  await watcher.runPendingSettlements();
  stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);
  assert.equal(attempts, 2);
  assert.equal(stored.processed, false);
  assert.equal(stored.retryDelayMs, 30_000);
  assert.equal(stored.nextAttemptAt, "2026-08-05T13:19:26.000Z");

  await watcher.runPendingSettlements();
  assert.equal(attempts, 2, "the second identical revert must wait for the longer backoff");

  nowMs += 30_000;
  await watcher.runPendingSettlements();
  stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);
  assert.equal(attempts, 3);
  assert.equal(stored.processed, true);
  assert.equal(stored.result.settledVia, "strategy_adapter");
  assert.equal(stored.nextAttemptAt, undefined);
});

test("runPendingSettlements runs settlement preflight before finalizing observed outcomes", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const events = [];
  eventBus.subscribe({ topics: ["xcm.request_finalize_failed"] }, (event) => events.push(event));
  let finalizeCalled = false;
  const watcher = new XcmSettlementWatcherService(
    {
      preflightXcmSettlementOutcome: async (requestId, outcome) => {
        assert.equal(requestId, REQUEST_ID);
        assert.equal(outcome.settledAssets, "5");
        throw new ValidationError("settlement ratio mismatch");
      },
      finalizeXcmRequest: async () => {
        finalizeCalled = true;
        return {};
      }
    },
    stateStore,
    eventBus,
    { enabled: false, logger: { warn: () => {} } }
  );

  await watcher.observeOutcome(REQUEST_ID, {
    status: "succeeded",
    settledAssets: 5,
    settledShares: 7
  });
  await watcher.runPendingSettlements();

  assert.equal(finalizeCalled, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "xcm.request_finalize_failed");
  assert.match(events[0].data.message, /settlement ratio mismatch/u);
});

test("observeOutcome preserves large uint256 settlement amounts exactly", async () => {
  const stateStore = new MemoryStateStore();
  const watcher = new XcmSettlementWatcherService(
    { finalizeXcmRequest: async () => ({}) },
    stateStore,
    undefined,
    { enabled: false }
  );

  const observation = await watcher.observeOutcome(REQUEST_ID, {
    status: "succeeded",
    settledAssets: "9007199254740993",
    settledShares: 18446744073709551616n
  });

  assert.equal(observation.settledAssets, "9007199254740993");
  assert.equal(observation.settledShares, "18446744073709551616");
});

test("observeOutcome normalizes numeric terminal statuses and observedAt", async () => {
  const stateStore = new MemoryStateStore();
  const watcher = new XcmSettlementWatcherService(
    { finalizeXcmRequest: async () => ({}) },
    stateStore,
    undefined,
    { enabled: false }
  );

  const observation = await watcher.observeOutcome(REQUEST_ID, {
    status: 2,
    settledAssets: 5,
    observedAt: "2026-05-14T12:00:00Z"
  });

  assert.equal(observation.status, "succeeded");
  assert.equal(observation.observedAt, "2026-05-14T12:00:00.000Z");
});

test("observeOutcome rejects unsafe numeric settlement amounts", async () => {
  const stateStore = new MemoryStateStore();
  const watcher = new XcmSettlementWatcherService(
    { finalizeXcmRequest: async () => ({}) },
    stateStore,
    undefined,
    { enabled: false }
  );

  await assert.rejects(
    () => watcher.observeOutcome(REQUEST_ID, {
      status: "succeeded",
      settledAssets: Number.MAX_SAFE_INTEGER + 2
    }),
    ValidationError
  );
});

test("observeOutcome rejects missing or non-terminal statuses before storing", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const events = [];
  eventBus.subscribe({ topics: ["xcm.outcome_observed"] }, (event) => events.push(event));
  const watcher = new XcmSettlementWatcherService(
    { finalizeXcmRequest: async () => ({}) },
    stateStore,
    eventBus,
    { enabled: false }
  );

  await assert.rejects(
    () => watcher.observeOutcome(REQUEST_ID, {
      settledAssets: 5
    }),
    ValidationError
  );
  await assert.rejects(
    () => watcher.observeOutcome(REQUEST_ID, {
      status: "pending",
      settledAssets: 5
    }),
    ValidationError
  );

  assert.equal(await stateStore.getXcmObservation(WRAPPER, REQUEST_ID), undefined);
  assert.equal(events.length, 0);
});

test("observeOutcome rejects failed observations without failureCode before storing", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const events = [];
  eventBus.subscribe({ topics: ["xcm.outcome_observed"] }, (event) => events.push(event));
  const watcher = new XcmSettlementWatcherService(
    { finalizeXcmRequest: async () => ({}) },
    stateStore,
    eventBus,
    { enabled: false }
  );

  await assert.rejects(
    () => watcher.observeOutcome(REQUEST_ID, {
      status: "failed"
    }),
    /failed observations must include failureCode/u
  );
  await assert.rejects(
    () => watcher.observeOutcome(REQUEST_ID, {
      status: "failed",
      failureCode: "   "
    }),
    /failed observations must include failureCode/u
  );

  assert.equal(await stateStore.getXcmObservation(WRAPPER, REQUEST_ID), undefined);
  assert.equal(events.length, 0);
});

test("observeOutcome trims failed observation failureCode", async () => {
  const stateStore = new MemoryStateStore();
  const watcher = new XcmSettlementWatcherService(
    { finalizeXcmRequest: async () => ({}) },
    stateStore,
    undefined,
    { enabled: false }
  );

  const observation = await watcher.observeOutcome(REQUEST_ID, {
    status: "failed",
    failureCode: " XCM_FAILED "
  });

  assert.equal(observation.failureCode, "XCM_FAILED");
});

test("observeOutcome rejects invalid observedAt before storing", async () => {
  const stateStore = new MemoryStateStore();
  const watcher = new XcmSettlementWatcherService(
    { finalizeXcmRequest: async () => ({}) },
    stateStore,
    undefined,
    { enabled: false }
  );

  await assert.rejects(
    () => watcher.observeOutcome(REQUEST_ID, {
      status: "succeeded",
      settledAssets: 5,
      observedAt: "not-a-date"
    }),
    ValidationError
  );

  assert.equal(await stateStore.getXcmObservation(WRAPPER, REQUEST_ID), undefined);
});

test("runPendingSettlements keeps failed observations pending for retry", async () => {
  const stateStore = new MemoryStateStore();
  const watcher = new XcmSettlementWatcherService(
    {
      finalizeXcmRequest: async () => {
        throw new Error("finalize failed");
      }
    },
    stateStore,
    undefined,
    {
      enabled: false,
      logger: { warn() {} }
    }
  );

  await watcher.observeOutcome(REQUEST_ID, {
    status: "failed",
    failureCode: "XCM_FAILED"
  });

  const results = await watcher.runPendingSettlements();
  const stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);

  assert.equal(results.length, 0);
  assert.equal(stored.processed, false);
  assert.equal(stored.attemptCount, 1);
  assert.match(stored.lastError, /finalize failed/u);
});

test("observeOutcome does not requeue an equivalent processed observation", async () => {
  const stateStore = new MemoryStateStore();
  const watcher = new XcmSettlementWatcherService(
    { finalizeXcmRequest: async () => ({}) },
    stateStore,
    undefined,
    { enabled: false }
  );

  await watcher.observeOutcome(REQUEST_ID, {
    status: "succeeded",
    settledAssets: 5,
    settledShares: 5
  });
  await stateStore.markXcmObservationProcessed(WRAPPER, REQUEST_ID, { settledVia: "agent_account" });

  const replayed = await watcher.observeOutcome(REQUEST_ID, {
    status: "succeeded",
    settledAssets: 5,
    settledShares: 5
  });

  assert.equal(replayed.processed, true);
  const pending = await stateStore.listPendingXcmObservations(10);
  assert.equal(pending.length, 0);
});

test("observeOutcome ignores stale conflicting observations for the same request", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const events = [];
  eventBus.subscribe({ topics: ["xcm.outcome_observed"] }, (event) => events.push(event));
  const watcher = new XcmSettlementWatcherService(
    { finalizeXcmRequest: async () => ({}) },
    stateStore,
    eventBus,
    { enabled: false }
  );

  await watcher.observeOutcome(REQUEST_ID, {
    status: "succeeded",
    settledAssets: 5,
    observedAt: "2026-05-14T12:00:00Z"
  });

  const replayed = await watcher.observeOutcome(REQUEST_ID, {
    status: "failed",
    settledAssets: 0,
    failureCode: "STALE_FAILURE",
    observedAt: "2026-05-14T11:59:59Z"
  });
  const stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);

  assert.equal(replayed.status, "succeeded");
  assert.equal(stored.status, "succeeded");
  assert.equal(stored.settledAssets, "5");
  assert.equal(stored.observedAt, "2026-05-14T12:00:00.000Z");
  assert.equal(events.length, 1);
});

test("observeOutcome does not reopen a processed request with a conflicting replay", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const observedEvents = [];
  const finalizedCalls = [];
  eventBus.subscribe({ topics: ["xcm.outcome_observed"] }, (event) => observedEvents.push(event));
  const watcher = new XcmSettlementWatcherService(
    {
      finalizeXcmRequest: async (requestId, outcome) => {
        finalizedCalls.push([requestId, outcome]);
        return {
          requestId,
          settledVia: "agent_account",
          strategyRequest: {
            account: "0xabc",
            statusLabel: outcome.status,
            settledAssetsRaw: outcome.settledAssets,
            settledSharesRaw: outcome.settledShares
          }
        };
      }
    },
    stateStore,
    eventBus,
    { enabled: false }
  );

  await watcher.observeOutcome(REQUEST_ID, {
    status: "succeeded",
    settledAssets: 5,
    observedAt: "2026-05-14T12:00:00Z"
  });
  await watcher.runPendingSettlements();

  const replayed = await watcher.observeOutcome(REQUEST_ID, {
    status: "failed",
    settledAssets: 0,
    failureCode: "CONFLICTING_REPLAY",
    observedAt: "2026-05-14T12:01:00Z"
  });
  const stored = await stateStore.getXcmObservation(WRAPPER, REQUEST_ID);
  const pending = await stateStore.listPendingXcmObservations(10);

  assert.equal(replayed.processed, true);
  assert.equal(stored.processed, true);
  assert.equal(stored.status, "succeeded");
  assert.equal(stored.settledAssets, "5");
  assert.equal(pending.length, 0);
  assert.equal(observedEvents.length, 1);
  assert.equal(finalizedCalls.length, 1);
});

test("same request id from a foreign wrapper cannot suppress the current observation", async () => {
  const stateStore = new MemoryStateStore();
  const foreignWrapper = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await stateStore.upsertXcmObservation({
    wrapperAddress: foreignWrapper,
    requestId: REQUEST_ID,
    status: "succeeded",
    settledAssets: "100000",
    settledShares: "100000",
    processed: true
  });
  const watcher = new XcmSettlementWatcherService(
    { finalizeXcmRequest: async () => ({}) },
    stateStore,
    undefined,
    { enabled: false }
  );

  const current = await watcher.observeOutcome(REQUEST_ID, {
    status: "succeeded",
    settledAssets: "100000",
    settledShares: "100000"
  });

  assert.equal(current.wrapperAddress, WRAPPER);
  assert.equal(current.processed, false);
  assert.equal((await stateStore.getXcmObservation(foreignWrapper, REQUEST_ID)).processed, true);
  assert.equal((await stateStore.listPendingXcmObservations()).length, 1);
});
