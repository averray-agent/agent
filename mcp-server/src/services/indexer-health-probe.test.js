import assert from "node:assert/strict";
import test from "node:test";

import {
  createConfiguredIndexerHealthProbe,
  createIndexerHealthProbe,
  resolveIndexerHealthProbeConfig
} from "./indexer-health-probe.js";

test("indexer probe is honestly unavailable when no status URL is configured", async () => {
  const probe = createConfiguredIndexerHealthProbe({});
  assert.deepEqual(await probe(), {
    ok: false,
    reason: "indexer_status_url_unconfigured"
  });
});

test("indexer probe returns the newest valid checkpoint with its lag budget", async () => {
  const probe = createIndexerHealthProbe({
    statusUrl: "http://indexer.test/status",
    lagBudgetSeconds: 321,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        older: { block: { number: 10, timestamp: 1_700_000_000 } },
        current: { block: { number: 42, timestamp: 1_700_000_123 } }
      })
    })
  });

  assert.deepEqual(await probe(), {
    ok: true,
    network: "current",
    blockNumber: 42,
    blockTimestamp: 1_700_000_123,
    lagBudgetSeconds: 321,
    stallBudgetSeconds: 900,
    headUnchangedSeconds: 0
  });
});

test("indexer probe never earns ok from malformed checkpoint data", async () => {
  const probe = createIndexerHealthProbe({
    statusUrl: "http://indexer.test/status",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        invalidNumber: { block: { number: "42", timestamp: 1_700_000_000 } },
        invalidTimestamp: { block: { number: 42, timestamp: null } }
      })
    })
  });

  assert.deepEqual(await probe(), {
    ok: false,
    reason: "indexer_status_missing_checkpoint"
  });
});

test("indexer probe reports HTTP and transport failures without throwing", async () => {
  const httpProbe = createIndexerHealthProbe({
    statusUrl: "http://indexer.test/status",
    fetchImpl: async () => ({ ok: false, status: 502 })
  });
  assert.deepEqual(await httpProbe(), {
    ok: false,
    reason: "indexer_status_http_error",
    statusCode: 502
  });

  const downProbe = createIndexerHealthProbe({
    statusUrl: "http://indexer.test/status",
    fetchImpl: async () => {
      throw new Error("connection refused");
    }
  });
  assert.deepEqual(await downProbe(), {
    ok: false,
    reason: "indexer_status_unavailable"
  });
});

test("indexer probe configuration rejects zero and nonnumeric good-state budgets", () => {
  assert.deepEqual(resolveIndexerHealthProbeConfig({
    INDEXER_STATUS_URL: " http://indexer:42069/status ",
    INDEXER_HEALTH_TIMEOUT_MS: "0",
    INDEXER_LAG_BUDGET_SECONDS: "not-a-number"
  }), {
    statusUrl: "http://indexer:42069/status",
    timeoutMs: 2_000,
    lagBudgetSeconds: 600,
    stallBudgetSeconds: 900
  });
});

test("indexer probe remembers head progress so a frozen head is distinguishable from a replaying one", async () => {
  // 2026-09-10: Ponder's sync wedged at one block for ~10h while /health stayed
  // 200 and /status kept answering the same checkpoint. A schema replay also
  // reports an old checkpoint, but its head advances every probe.
  let nowMs = 1_000_000;
  let head = { number: 20_501_734, timestamp: 1_789_074_768 };
  const probe = createIndexerHealthProbe({
    statusUrl: "http://indexer.test/status",
    lagBudgetSeconds: 600,
    stallBudgetSeconds: 900,
    now: () => nowMs,
    fetchImpl: async () => ({ ok: true, json: async () => ({ polkadotHubMainnet: { block: head } }) })
  });

  assert.equal((await probe()).headUnchangedSeconds, 0, "first observation starts the clock");
  nowMs += 60_000;
  assert.equal((await probe()).headUnchangedSeconds, 60);
  nowMs += 900_000;
  const stalled = await probe();
  assert.equal(stalled.headUnchangedSeconds, 960);
  assert.equal(stalled.stallBudgetSeconds, 900);
  assert.equal(stalled.blockNumber, 20_501_734);

  head = { number: 20_501_735, timestamp: 1_789_074_774 };
  nowMs += 60_000;
  assert.equal((await probe()).headUnchangedSeconds, 0, "any head change resets the clock");
  head = { number: 18_647_521, timestamp: 1_777_000_000 };
  nowMs += 60_000;
  assert.equal((await probe()).headUnchangedSeconds, 0, "a replay from the start block is progress, not a stall");
});

test("indexer probe configuration reads the stall budget alongside the lag budget", () => {
  assert.equal(resolveIndexerHealthProbeConfig({}).stallBudgetSeconds, 900);
  assert.equal(resolveIndexerHealthProbeConfig({ INDEXER_STALL_BUDGET_SECONDS: "1200" }).stallBudgetSeconds, 1200);
  assert.equal(resolveIndexerHealthProbeConfig({ INDEXER_STALL_BUDGET_SECONDS: "0" }).stallBudgetSeconds, 900);
});
