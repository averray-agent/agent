import assert from "node:assert/strict";
import test from "node:test";

import { getRouteCapabilityRequirements, ROUTE_CAPABILITY_RULES } from "../../auth/capabilities.js";
import { auditAgentSurfaceCoverage } from "../../core/agent-surface-parity.js";
import { HTTP_METRIC_PATHS } from "./http-helpers.js";
import { createAdminOvernightLedgerRoutes } from "./admin-overnight-ledger-routes.js";

function harness() {
  const calls = [];
  const route = createAdminOvernightLedgerRoutes({
    authMiddleware: async (_request, _url, options) => calls.push(["auth", options]),
    overnightLedger: {
      async getLedger(window) {
        calls.push(["ledger", window]);
        return { window };
      },
      getTopupDestinations() {
        calls.push(["topups"]);
        return { topupDestinations: {} };
      }
    },
    respond: (response, statusCode, body, headers) => Object.assign(response, { statusCode, body, headers })
  });
  return { calls, route };
}

test("overnight ledger route is ops:view gated and passes the shared window", async () => {
  const { calls, route } = harness();
  const response = {};
  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("https://api.example/admin/ops/overnight-ledger?window=48h"),
    pathname: "/admin/ops/overnight-ledger"
  });
  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { window: "48h" });
  assert.deepEqual(calls, [
    ["auth", { requireCapability: "ops:view" }],
    ["ledger", "48h"]
  ]);
});

test("top-up destinations route is ops:view gated and unwindowed", async () => {
  const { calls, route } = harness();
  const response = {};
  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("https://api.example/admin/ops/topup-destinations"),
    pathname: "/admin/ops/topup-destinations"
  });
  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [
    ["auth", { requireCapability: "ops:view" }],
    ["topups"]
  ]);
});

test("bank moves are ops:view gated, no-store, and absent from public monitor paths", async () => {
  const calls = [];
  const route = createAdminOvernightLedgerRoutes({
    authMiddleware: async (_request, _url, options) => calls.push(options),
    overnightLedger: {
      async getBankMoves(since, options) {
        calls.push(["moves", since, options]);
        return { since };
      }
    },
    respond: (response, statusCode, body, headers) => Object.assign(response, { statusCode, body, headers })
  });
  const response = {};
  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("https://api.example/admin/ops/bank-moves?since=2026-10-01T00:00:00.000Z&limit=25"),
    pathname: "/admin/ops/bank-moves"
  });
  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(calls, [
    { requireCapability: "ops:view" },
    ["moves", "2026-10-01T00:00:00.000Z", { limit: "25" }]
  ]);
  assert.equal(await route({
    request: { method: "GET" },
    response: {},
    url: new URL("https://api.example/monitor/arrivals"),
    pathname: "/monitor/arrivals"
  }), false);
  assert.equal(await route({
    request: { method: "GET" },
    response: {},
    url: new URL("https://api.example/transparency"),
    pathname: "/transparency"
  }), false);
  assert.deepEqual(getRouteCapabilityRequirements("GET", "/admin/ops/bank-moves"), ["ops:view"]);
  assert.ok(ROUTE_CAPABILITY_RULES.some((entry) => (
    entry.method === "GET"
    && entry.path === "/admin/ops/bank-moves"
    && entry.capabilities.length === 1
    && entry.capabilities[0] === "ops:view"
  )));
  assert.equal(auditAgentSurfaceCoverage().unclassifiedRoutes.includes("GET /admin/ops/bank-moves"), false);
  assert.ok(HTTP_METRIC_PATHS.includes("/admin/ops/bank-moves"));
});
