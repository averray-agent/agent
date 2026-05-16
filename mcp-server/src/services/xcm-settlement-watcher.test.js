import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStateStore } from "../core/state-store.js";
import { EventBus } from "../core/event-bus.js";
import { XcmSettlementWatcherService } from "./xcm-settlement-watcher.js";
import { ValidationError } from "../core/errors.js";

const REQUEST_ID = "0x1111111111111111111111111111111111111111111111111111111111111111";

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
            statusLabel: "succeeded"
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
  const stored = await stateStore.getXcmObservation(REQUEST_ID);

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

test("runPendingSettlements emits a request_finalize_failed event with correlationId on errors", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  const events = [];
  eventBus.subscribe({ topics: ["xcm.request_finalize_failed"] }, (event) => events.push(event));
  const watcher = new XcmSettlementWatcherService(
    {
      finalizeXcmRequest: async () => {
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

  assert.equal(await stateStore.getXcmObservation(REQUEST_ID), undefined);
  assert.equal(events.length, 0);
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

  assert.equal(await stateStore.getXcmObservation(REQUEST_ID), undefined);
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
  const stored = await stateStore.getXcmObservation(REQUEST_ID);

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
  await stateStore.markXcmObservationProcessed(REQUEST_ID, { settledVia: "agent_account" });

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
  const stored = await stateStore.getXcmObservation(REQUEST_ID);

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
            statusLabel: outcome.status
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
  const stored = await stateStore.getXcmObservation(REQUEST_ID);
  const pending = await stateStore.listPendingXcmObservations(10);

  assert.equal(replayed.processed, true);
  assert.equal(stored.processed, true);
  assert.equal(stored.status, "succeeded");
  assert.equal(stored.settledAssets, "5");
  assert.equal(pending.length, 0);
  assert.equal(observedEvents.length, 1);
  assert.equal(finalizedCalls.length, 1);
});
