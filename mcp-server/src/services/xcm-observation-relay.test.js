import test from "node:test";
import assert from "node:assert/strict";

import { EventBus } from "../core/event-bus.js";
import { MemoryStateStore } from "../core/state-store.js";
import { XcmObservationRelayService } from "./xcm-observation-relay.js";

const REQUEST_ID = "0x2222222222222222222222222222222222222222222222222222222222222222";

test("pollOnce relays terminal outcomes into the platform watcher and stores cursor state", async () => {
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
    new EventBus(),
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

  const stored = await stateStore.getServiceState("xcm-observation-relay");
  assert.equal(stored.cursor, "cursor-2");
  assert.equal(stored.lastObservedCount, 1);
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
            ]
          };
        }
      }),
      logger: { warn() {} }
    }
  );

  await assert.rejects(() => relay.pollOnce(), /terminal status/u);
});
