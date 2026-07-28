import assert from "node:assert/strict";
import test from "node:test";

import { createOperationalRoutes, resolveMetricsAuthConfig } from "./operational-routes.js";

const AUTH_CONFIG = {
  mode: "strict",
  domain: "averray.test",
  chainId: "1",
  secrets: ["test-secret"]
};

function makeResponse() {
  return {
    _corsHeaders: { "access-control-allow-origin": "https://app.averray.test" },
    _requestId: "req-test",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation exceeded ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function makeHarness(overrides = {}) {
  const calls = [];
  const response = makeResponse();
  const route = createOperationalRoutes({
    authConfig: overrides.authConfig ?? AUTH_CONFIG,
    deployedSha: overrides.deployedSha,
    externalPostingMode: overrides.externalPostingMode,
    externalPostingWatcher: overrides.externalPostingWatcher,
    gateway: overrides.gateway ?? {
      isEnabled: () => false,
      healthCheck: async () => {
        calls.push(["chainHealth"]);
        return { ok: true, backend: "blockchain", enabled: false, mode: "disabled" };
      }
    },
    getRewardBankHealth: overrides.getRewardBankHealth,
    indexerHealthProbe: overrides.indexerHealthProbe ?? (async () => {
      calls.push(["indexerHealth"]);
      return { ok: false, reason: "indexer_status_unconfigured" };
    }),
    metrics: overrides.metrics ?? {
      serialize: () => {
        calls.push(["serializeMetrics"]);
        return "# HELP http_requests_total Total requests\n";
      }
    },
    metricsAuthRequired: overrides.metricsAuthRequired ?? false,
    metricsBearerToken: overrides.metricsBearerToken,
    mutationBackendConfig: overrides.mutationBackendConfig ?? {
      mode: "required",
      defaulted: false,
      requiresChain: true,
      allowsMemory: false
    },
    pimlicoClient: overrides.pimlicoClient ?? {
      healthCheck: async () => {
        calls.push(["gasHealth"]);
        return { ok: true, backend: "pimlico", enabled: false, mode: "disabled" };
      }
    },
    respond: (res, statusCode, body, headers = undefined) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    service: overrides.service ?? {
      xcmSettlementWatcher: {
        getStatus: async () => {
          calls.push(["xcmStatus"]);
          return { enabled: true, running: true, pendingCount: 0 };
        }
      }
    },
    stateStore: overrides.stateStore ?? {
      constructor: { name: "MemoryStateStore" },
      healthCheck: async () => {
        calls.push(["storeHealth"]);
        return { ok: true, backend: "memory", mode: "memory" };
      }
    }
  });
  return { calls, response, route };
}

test("operational routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/not-health"
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, [["chainHealth"]]);
  assert.equal(response.statusCode, undefined);
});

test("GET /health reports service liveness separately from disabled capabilities", async () => {
  const { calls, response, route } = makeHarness({
    deployedSha: "a".repeat(40)
  });

  const handled = await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.deployedSha, "a".repeat(40));
  assert.equal(response.body.serviceHealth.ok, true);
  assert.equal(response.body.capabilityHealth.blockchain, "disabled");
  assert.equal(response.body.capabilityHealth.treasuryMutations, "unavailable");
  assert.equal(response.body.capabilityHealth.xcmObserver, "staged");
  assert.equal(response.body.capabilityHealth.indexer, "unavailable");
  assert.equal(response.body.capabilityHealth.gasSponsor, "disabled");
  assert.equal(response.body.capabilityHealth.externalPosting, "disabled");
  assert.equal(response.body.capabilityHealth.externalPostingWatcherLagSeconds, null);
  assert.equal(response.body.addresses.token, "0x0000053900000000000000000000000001200000");
  assert.equal(response.body.addresses.agentAccountCore, "0x510918E24DEbcA163F306923CA234319e72b22d5");
  assert.equal(response.body.addresses.escrowCore, "0xfE841c2dc58E4389b1AB59E3e42F9EB12A694Bea");
  assert.equal(response.body.addresses.settlementSigner, "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F");
  assert.equal(response.body.addresses.treasuryReserve, "0x1f8c4da4aaac79916350f1fabf1221309591b6f9");
  assert.equal(Object.hasOwn(response.body.addresses, "treasuryPolicy"), false);
  assert.equal(response.body.rewardBank.readable, false);
  assert.equal(response.body.rewardBank.decimals, 6);
  assert.equal(response.body.settlement.source, "backend_state_store");
  assert.deepEqual(
    {
      claimed24h: response.body.settlement.claimed24h,
      submitted24h: response.body.settlement.submitted24h,
      settled24h: response.body.settlement.settled24h,
      claimedNotSubmitted: response.body.settlement.claimedNotSubmitted,
      submittedNotSettled: response.body.settlement.submittedNotSettled
    },
    {
      claimed24h: 0,
      submitted24h: 0,
      settled24h: 0,
      claimedNotSubmitted: 0,
      submittedNotSettled: 0
    }
  );
  assert.deepEqual(response.body.components.stateStore, { ok: true, backend: "memory", mode: "memory" });
  assert.deepEqual(response.body.components.indexer, { ok: false, reason: "indexer_status_unconfigured" });
  assert.ok(response.body.warnings.some((warning) => warning.code === "treasury_mutations_unavailable"));
  assert.deepEqual(calls.map(([name]) => name).sort(), [
    "chainHealth",
    "gasHealth",
    "indexerHealth",
    "respond",
    "storeHealth",
    "xcmStatus",
  ].sort());
});

test("GET /health exposes watcher lag and stages open external posting while the indexer is stale", async () => {
  const { response, route } = makeHarness({
    externalPostingMode: "open",
    externalPostingWatcher: {
      async getStatus() {
        return {
          enabled: true,
          running: true,
          current: false,
          lagSeconds: 3_600,
          lagBudgetSeconds: 600,
          finalizedBlockNumber: "1234",
          finalizedBlockTimestamp: "2026-07-28T10:00:00.000Z"
        };
      }
    }
  });

  await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(response.body.capabilityHealth.externalPosting, "staged");
  assert.equal(response.body.capabilityHealth.externalPostingWatcherLagSeconds, 3_600);
  assert.equal(response.body.components.externalPostingWatcher.current, false);
  assert.ok(response.body.warnings.some((warning) => warning.code === "external_posting_staged"));
});

test("GET /health reuses the injected reward-bank provider", async () => {
  let sharedReads = 0;
  const { response, route } = makeHarness({
    getRewardBankHealth: async () => {
      sharedReads += 1;
      return {
        asset: "USDC",
        decimals: 6,
        liquid: 23.9,
        liquidRaw: "23900000",
        readable: true,
        asOf: "2026-07-27T12:00:00.000Z",
        source: "agent_account_position"
      };
    }
  });

  await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(sharedReads, 1);
  assert.equal(response.body.rewardBank.liquidRaw, "23900000");
});

test("GET /health p99 stays sub-second when live chain reads are blackholed", async () => {
  const blackhole = new Promise(() => {});
  const { route } = makeHarness({
    gateway: {
      isEnabled: () => true,
      healthCheck: async () => blackhole,
      getTreasuryPolicyStatus: async () => blackhole
    }
  });

  const durations = await Promise.all(
    Array.from({ length: 100 }, async () => {
      const response = makeResponse();
      const startedAt = performance.now();
      await withTimeout(
        route({
          request: { method: "GET", headers: {} },
          response,
          pathname: "/health"
        }),
        1_000
      );
      assert.equal(response.statusCode, 200);
      assert.ok(Number.isFinite(Date.parse(response.body.components.blockchain.asOf)));
      assert.ok(Number.isFinite(Date.parse(response.body.rewardBank.asOf)));
      return performance.now() - startedAt;
    })
  );
  const p99 = durations.sort((left, right) => left - right)[98];

  assert.ok(p99 < 500, `expected /health p99 < 500ms; observed ${p99.toFixed(1)}ms`);
});

test("GET /health exposes and warns on an empty onboarding waiver inventory", async () => {
  const { response, route } = makeHarness({
    service: {
      xcmSettlementWatcher: {
        getStatus: async () => ({ enabled: true, running: true, pendingCount: 0 })
      },
      listJobs: () => [],
      attachClaimState: async (job) => job
    }
  });

  await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(response.body.onboarding.status, "warning");
  assert.equal(response.body.onboarding.waiverEligibleClaimableJobs, 0);
  assert.equal(response.body.onboarding.minimumWaiverEligibleClaimableJobs, 2);
  assert.ok(response.body.warnings.some((warning) => (
    warning.code === "onboarding_waiver_inventory_empty"
  )));
});

test("GET /health earns synced indexer status only from a fresh checkpoint", async () => {
  const { response, route } = makeHarness({
    indexerHealthProbe: async () => ({
      ok: true,
      network: "polkadotHubTestnet",
      blockNumber: 10_901_852,
      blockTimestamp: Math.floor(Date.now() / 1000),
      lagBudgetSeconds: 600
    })
  });

  await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(response.body.capabilityHealth.indexer, "synced");
  assert.equal(response.body.components.indexer.blockNumber, 10_901_852);
  assert.equal(
    response.body.warnings.some((warning) => warning.code.startsWith("indexer_")),
    false
  );
});

test("GET /health reports lagging and unavailable indexer probes honestly", async () => {
  const staleHarness = makeHarness({
    indexerHealthProbe: async () => ({
      ok: true,
      blockNumber: 10,
      blockTimestamp: Math.floor(Date.now() / 1000) - 601,
      lagBudgetSeconds: 600
    })
  });
  await staleHarness.route({
    request: { method: "GET", headers: {} },
    response: staleHarness.response,
    pathname: "/health"
  });
  assert.equal(staleHarness.response.body.capabilityHealth.indexer, "lagging");

  const downHarness = makeHarness({
    indexerHealthProbe: async () => ({ ok: false, reason: "indexer_status_http_error" })
  });
  await downHarness.route({
    request: { method: "GET", headers: {} },
    response: downHarness.response,
    pathname: "/health"
  });
  assert.equal(downHarness.response.body.capabilityHealth.indexer, "unavailable");
});

test("GET /health degrades when service liveness is not ok", async () => {
  const { response, route } = makeHarness({
    stateStore: {
      constructor: { name: "MemoryStateStore" },
      healthCheck: async () => ({ ok: false, backend: "memory", mode: "memory" })
    }
  });

  const handled = await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.status, "degraded");
  assert.equal(response.body.serviceHealth.ok, false);
});

test("GET /metrics emits Prometheus text with CORS and request id headers", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/metrics"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/plain/);
  assert.equal(response.headers["access-control-allow-origin"], "https://app.averray.test");
  assert.equal(response.headers["x-request-id"], "req-test");
  assert.match(response.body, /# HELP http_requests_total/);
  assert.deepEqual(calls, [["serializeMetrics"], ["chainHealth"]]);
});

test("GET /metrics fails closed when auth is required but no token is configured", async () => {
  const { response, route } = makeHarness({ metricsAuthRequired: true });

  const handled = await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/metrics"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: "metrics_auth_unconfigured" });
});

test("GET /metrics rejects missing or wrong bearer tokens", async () => {
  const { response, route } = makeHarness({
    metricsAuthRequired: true,
    metricsBearerToken: "metrics-token-1234567890"
  });

  const missing = await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/metrics"
  });
  assert.equal(missing, true);
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: "unauthorized" });

  const wrongResponse = makeResponse();
  const wrong = await route({
    request: { method: "GET", headers: { authorization: "Bearer wrong-token" } },
    response: wrongResponse,
    pathname: "/metrics"
  });
  assert.equal(wrong, true);
  assert.equal(wrongResponse.statusCode, 401);
  assert.deepEqual(wrongResponse.body, { error: "unauthorized" });
});

test("GET /metrics accepts the configured bearer token", async () => {
  const { response, route } = makeHarness({
    metricsAuthRequired: true,
    metricsBearerToken: "metrics-token-1234567890"
  });

  const handled = await route({
    request: {
      method: "GET",
      headers: { authorization: "Bearer metrics-token-1234567890" }
    },
    response,
    pathname: "/metrics"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /# HELP http_requests_total/);
});

test("metrics auth config defaults to fail-closed in production", () => {
  assert.deepEqual(
    resolveMetricsAuthConfig({ NODE_ENV: "production", METRICS_BEARER_TOKEN: "  token-value  " }),
    { metricsBearerToken: "token-value", metricsAuthRequired: true }
  );
  assert.deepEqual(
    resolveMetricsAuthConfig({ NODE_ENV: "production", METRICS_AUTH_REQUIRED: "0" }),
    { metricsBearerToken: undefined, metricsAuthRequired: false }
  );
  assert.deepEqual(
    resolveMetricsAuthConfig({ NODE_ENV: "test" }),
    { metricsBearerToken: undefined, metricsAuthRequired: false }
  );
});
