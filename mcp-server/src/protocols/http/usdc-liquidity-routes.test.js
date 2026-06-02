import assert from "node:assert/strict";
import test from "node:test";

import { createUsdcLiquidityRoutes } from "./usdc-liquidity-routes.js";

const AUTH = { wallet: "0xadmin", claims: { roles: ["admin"] } };

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const status = overrides.status ?? {
    asOf: "2026-06-02T12:00:00.000Z",
    chain: "testnet",
    accounts: [],
    treasuryReserveHealthy: true,
    treasuryReserveUsdc: 420
  };
  const route = createUsdcLiquidityRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return overrides.auth ?? AUTH;
    },
    respond: (res, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
    usdcLiquidityStatusService: {
      async getStatus() {
        calls.push(["getStatus"]);
        return status;
      }
    }
  });
  return { calls, response, route, status };
}

test("USDC liquidity routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/not-usdc-liquidity/status"),
    pathname: "/admin/not-usdc-liquidity/status",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /admin/usdc-liquidity/status requires admin auth and returns status", async () => {
  const { calls, response, route, status } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/usdc-liquidity/status"),
    pathname: "/admin/usdc-liquidity/status",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, status);
  assert.deepEqual(calls, [
    ["auth", { requireRole: "admin" }],
    ["getStatus"],
    ["respond", { statusCode: 200, body: status }]
  ]);
});
