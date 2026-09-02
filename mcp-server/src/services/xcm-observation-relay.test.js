import test from "node:test";
import assert from "node:assert/strict";

import { EventBus } from "../core/event-bus.js";
import { MemoryStateStore } from "../core/state-store.js";
import { XcmObservationRelayService } from "./xcm-observation-relay.js";

const REQUEST_ID = "0x2222222222222222222222222222222222222222222222222222222222222222";
const FAILURE_CODE = "0x4444444444444444444444444444444444444444444444444444444444444444";

test("pollOnce relays terminal outcomes into the platform watcher and stores cursor state", async () => {
  const calls = [];
  const events = [];
  const stateStore = new MemoryStateStore();
  const eventBus = new EventBus();
  eventBus.subscribe({ topics: ["xcm.outcome_relayed"] }, (event) => events.push(event));
  const relay = new XcmObservationRelayService(
    {
      observeXcmOutcome: async (requestId, outcome) => {
        calls.push([requestId, outcome]);
        return outcome;
      }
    },
    stateStore,
    eventBus,
    {
      enabled: true,
      feedUrl: "https://observer.example/outcomes",
      fetchImpl: async (url) => {
        assert.match(String(url), /cursor=/u);
        return {
          ok: true,
          async json() {
            return {
              items: [
                {
                  requestId: REQUEST_ID,
                  status: "succeeded",
                  settledAssets: 7,
                  settledShares: 7,
                  remoteRef: "0x3333333333333333333333333333333333333333333333333333333333333333",
                  observedAt: "2026-04-22T10:00:00.000Z"
                }
              ],
              nextCursor: "cursor-2"
            };
          }
        };
      }
    }
  );

  await stateStore.upsertServiceState("xcm-observation-relay", { cursor: "cursor-1" });
  const result = await relay.pollOnce();

  assert.equal(result.observedCount, 1);
  assert.equal(result.cursor, "cursor-2");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], REQUEST_ID);
  assert.equal(calls[0][1].status, "succeeded");
  assert.equal(calls[0][1].settledAssets, "7");
  assert.equal(calls[0][1].settledShares, "7");
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "xcm.outcome_relayed");
  assert.equal(events[0].correlationId, REQUEST_ID);
  assert.equal(events[0].data.settledAssets, "7");
  assert.equal(events[0].data.settledAssetsRaw, "7");
  assert.equal(events[0].data.settledShares, "7");
  assert.equal(events[0].data.settledSharesRaw, "7");
  assert.equal(events[0].data.remoteRef, "0x3333333333333333333333333333333333333333333333333333333333333333");
  assert.equal(events[0].data.observedAt, "2026-04-22T10:00:00.000Z");

  const stored = await stateStore.getServiceState("xcm-observation-relay");
  assert.equal(stored.cursor, "cursor-2");
  assert.equal(stored.lastObservedCount, 1);
});

test("pollOnce preserves exact uint256 settlement amounts from observer feed", async () => {
  const calls = [];
  const relay = new XcmObservationRelayService(
    {
      observeXcmOutcome: async (requestId, outcome) => {
        calls.push([requestId, outcome]);
        return outcome;
      }
    },
    new MemoryStateStore(),
    undefined,
    {
      enabled: true,
      feedUrl: "https://observer.example/outcomes",
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            items: [
              {
                requestId: REQUEST_ID,
                status: "succeeded",
                settledAssets: "9007199254740993",
                settledShares: "18446744073709551616"
              }
            ],
            nextCursor: "cursor-1"
          };
        }
      })
    }
  );

  const result = await relay.pollOnce();

  assert.equal(result.observedCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].settledAssets, "9007199254740993");
  assert.equal(calls[0][1].settledShares, "18446744073709551616");
});

test("pollOnce rejects unsafe numeric settlement amounts from observer feed", async () => {
  const relay = new XcmObservationRelayService(
    {
      observeXcmOutcome: async () => undefined
    },
    new MemoryStateStore(),
    undefined,
    {
      enabled: true,
      feedUrl: "https://observer.example/outcomes",
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            items: [
              {
                requestId: REQUEST_ID,
                status: "succeeded",
                settledAssets: Number.MAX_SAFE_INTEGER + 2
              }
            ],
            nextCursor: "cursor-1"
          };
        }
      }),
      logger: { warn() {} }
    }
  );

  await assert.rejects(() => relay.pollOnce(), /exact non-negative uint256/u);
});

test("pollOnce records upstream failures in service state", async () => {
  const stateStore = new MemoryStateStore();
  const relay = new XcmObservationRelayService(
    {
      observeXcmOutcome: async () => undefined
    },
    stateStore,
    undefined,
    {
      enabled: true,
      feedUrl: "https://observer.example/outcomes",
      fetchImpl: async () => ({
        ok: false,
        status: 503
      }),
      logger: { warn() {} }
    }
  );

  await assert.rejects(() => relay.pollOnce(), /HTTP 503/u);
  const stored = await stateStore.getServiceState("xcm-observation-relay");
  assert.match(stored.lastError, /HTTP 503/u);
});

test("pollOnce rejects non-terminal statuses from the observer feed", async () => {
  const relay = new XcmObservationRelayService(
    {
      observeXcmOutcome: async () => undefined
    },
    new MemoryStateStore(),
    undefined,
    {
      enabled: true,
      feedUrl: "https://observer.example/outcomes",
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            items: [
              {
                requestId: REQUEST_ID,
                status: "pending"
              }
            ],
            nextCursor: "cursor-1"
          };
        }
      }),
      logger: { warn() {} }
    }
  );

  await assert.rejects(() => relay.pollOnce(), /terminal status/u);
});

test("pollOnce rejects numeric non-terminal statuses from the observer feed", async () => {
  const relay = new XcmObservationRelayService(
    {
      observeXcmOutcome: async () => undefined
    },
    new MemoryStateStore(),
    undefined,
    {
      enabled: true,
      feedUrl: "https://observer.example/outcomes",
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            items: [
              {
                requestId: REQUEST_ID,
                status: 1
              }
            ],
            nextCursor: "cursor-1"
          };
        }
      }),
      logger: { warn() {} }
    }
  );

  await assert.rejects(() => relay.pollOnce(), /terminal status/u);
});

test("pollOnce rejects failed observer outcomes without failureCode", async () => {
  const calls = [];
  const relay = new XcmObservationRelayService(
    {
      observeXcmOutcome: async (requestId, outcome) => {
        calls.push([requestId, outcome]);
        return outcome;
      }
    },
    new MemoryStateStore(),
    undefined,
    {
      enabled: true,
      feedUrl: "https://observer.example/outcomes",
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            items: [
              {
                requestId: REQUEST_ID,
                status: "failed"
              }
            ],
            nextCursor: "cursor-1"
          };
        }
      }),
      logger: { warn() {} }
    }
  );

  await assert.rejects(() => relay.pollOnce(), /failed items must include failureCode/u);
  assert.equal(calls.length, 0);
});

test("pollOnce relays failed observer outcomes with failureCode", async () => {
  const calls = [];
  const events = [];
  const eventBus = new EventBus();
  eventBus.subscribe({ topics: ["xcm.outcome_relayed"] }, (event) => events.push(event));
  const relay = new XcmObservationRelayService(
    {
      observeXcmOutcome: async (requestId, outcome) => {
        calls.push([requestId, outcome]);
        return outcome;
      }
    },
    new MemoryStateStore(),
    eventBus,
    {
      enabled: true,
      feedUrl: "https://observer.example/outcomes",
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            items: [
              {
                requestId: REQUEST_ID,
                status: "failed",
                failureCode: FAILURE_CODE
              }
            ],
            nextCursor: "cursor-1"
          };
        }
      })
    }
  );

  const result = await relay.pollOnce();

  assert.equal(result.observedCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].status, "failed");
  assert.equal(calls[0][1].failureCode, FAILURE_CODE);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.status, "failed");
  assert.equal(events[0].data.failureCode, FAILURE_CODE);
});

test("pollOnce rejects non-empty observer feed batches without nextCursor before relaying", async () => {
  const calls = [];
  const stateStore = new MemoryStateStore();
  const relay = new XcmObservationRelayService(
    {
      observeXcmOutcome: async (requestId, outcome) => {
        calls.push([requestId, outcome]);
        return outcome;
      }
    },
    stateStore,
    undefined,
    {
      enabled: true,
      feedUrl: "https://observer.example/outcomes",
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            items: [
              {
                requestId: REQUEST_ID,
                status: "succeeded"
              }
            ]
          };
        }
      }),
      logger: { warn() {} }
    }
  );

  await assert.rejects(
    () => relay.pollOnce(),
    /non-empty XCM batches must advance the cursor/u
  );
  assert.equal(calls.length, 0);
  const stored = await stateStore.getServiceState("xcm-observation-relay");
  assert.match(stored.lastError, /non-empty XCM batches must advance the cursor/u);
});

test("pollOnce accepts empty observer feed end-of-feed pages without nextCursor", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertServiceState("xcm-observation-relay", { cursor: "cursor-2" });
  const relay = new XcmObservationRelayService(
    {
      observeXcmOutcome: async () => {
        throw new Error("unexpected relay");
      }
    },
    stateStore,
    undefined,
    {
      enabled: true,
      feedUrl: "https://observer.example/outcomes",
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            items: []
          };
        }
      })
    }
  );

  const result = await relay.pollOnce();

  assert.equal(result.observedCount, 0);
  assert.equal(result.cursor, "cursor-2");
});
