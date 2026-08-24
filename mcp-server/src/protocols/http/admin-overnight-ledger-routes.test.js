import assert from "node:assert/strict";
import test from "node:test";

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
    respond: (response, statusCode, body) => Object.assign(response, { statusCode, body })
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
