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
    }),
    detailsUrl: undefined
  });

  assert.deepEqual(await probe(), {
    ok: true,
    network: "current",
    blockNumber: 42,
    blockTimestamp: 1_700_000_123,
    lagBudgetSeconds: 321
  });
});

test("indexer probe carries a prior Ponder startup recovery into health evidence", async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => url.endsWith("/status")
      ? { chain: { block: { number: 42, timestamp: 1_700_000_123 } } }
      : {
          recovery: {
            startupError: { code: "ponder_schema_identity_mismatch" },
            recoveredAt: "2026-07-12T14:34:22Z"
          }
        }
  });
  const probe = createIndexerHealthProbe({
    statusUrl: "http://indexer.test/status",
    detailsUrl: "http://indexer.test/",
    fetchImpl
  });

  assert.equal((await probe()).recovery.startupError.code, "ponder_schema_identity_mismatch");
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
    detailsUrl: "http://indexer:42069/",
    timeoutMs: 2_000,
    lagBudgetSeconds: 600
  });
});
