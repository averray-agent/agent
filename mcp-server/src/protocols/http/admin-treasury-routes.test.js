import assert from "node:assert/strict";
import test from "node:test";

import { createAdminTreasuryRoutes } from "./admin-treasury-routes.js";

test("GET /admin/treasury/summary authenticates an admin and always returns the service payload as 200", async () => {
  const calls = [];
  const response = {};
  const route = createAdminTreasuryRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return { wallet: "0xadmin" };
    },
    treasurySummary: {
      getSummary: async (wallet) => {
        calls.push(["summary", wallet]);
        return { warnings: [{ code: "strategyLanes_read_failed" }] };
      }
    },
    respond: (target, statusCode, body) => Object.assign(target, { statusCode, body })
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("https://api.example/admin/treasury/summary"),
    pathname: "/admin/treasury/summary"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [["auth", { requireRole: "admin" }], ["summary", "0xadmin"]]);
  assert.deepEqual(response.body.warnings, [{ code: "strategyLanes_read_failed" }]);
});

test("admin treasury route ignores every other path", async () => {
  const route = createAdminTreasuryRoutes({
    authMiddleware: async () => { throw new Error("must not run"); },
    treasurySummary: {},
    respond: () => {}
  });
  assert.equal(await route({
    request: { method: "GET" },
    response: {},
    url: new URL("https://api.example/admin/status"),
    pathname: "/admin/status"
  }), false);
});
