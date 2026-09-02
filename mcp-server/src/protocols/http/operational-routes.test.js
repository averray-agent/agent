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

function makeHarness(overrides = {}) {
  const calls = [];
  const response = makeResponse();
  const route = createOperationalRoutes({
    authConfig: overrides.authConfig ?? AUTH_CONFIG,
    gateway: overrides.gateway ?? {
      isEnabled: () => false,
      healthCheck: async () => {
        calls.push(["chainHealth"]);
        return { ok: true, backend: "blockchain", enabled: false, mode: "disabled" };
      }
    },
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
  assert.deepEqual(calls, []);
  assert.equal(response.statusCode, undefined);
});

test("GET /health reports service liveness separately from disabled capabilities", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET", headers: {} },
    response,
    pathname: "/health"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.serviceHealth.ok, true);
  assert.equal(response.body.capabilityHealth.blockchain, "disabled");
  assert.equal(response.body.capabilityHealth.treasuryMutations, "unavailable");
  assert.equal(response.body.capabilityHealth.xcmObserver, "staged");
  assert.equal(response.body.capabilityHealth.indexer, "unavailable");
  assert.equal(response.body.capabilityHealth.gasSponsor, "disabled");
  assert.deepEqual(response.body.components.stateStore, { ok: true, backend: "memory", mode: "memory" });
  assert.ok(response.body.warnings.some((warning) => warning.code === "treasury_mutations_unavailable"));
  assert.deepEqual(calls.map(([name]) => name), [
    "storeHealth",
    "chainHealth",
    "gasHealth",
    "xcmStatus",
    "respond"
  ]);
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
  assert.deepEqual(calls, [["serializeMetrics"]]);
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
