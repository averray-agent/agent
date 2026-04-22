import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStateStore } from "../core/state-store.js";
import { EventBus } from "../core/event-bus.js";
import { XcmSettlementWatcherService } from "./xcm-settlement-watcher.js";

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
  assert.equal(observation.processed, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "xcm.outcome_observed");
});

test("runPendingSettlements finalizes stored observations and marks them processed", async () => {
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
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
  assert.equal(stored.processed, true);
  assert.equal(stored.result.settledVia, "agent_account");
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
