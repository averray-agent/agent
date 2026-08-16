import assert from "node:assert/strict";
import test from "node:test";

import { createAdminCreditRoutes } from "./admin-credit-routes.js";

test("admin credit origination consumes only a stored terms hash", async () => {
  const calls = [];
  const response = {};
  const route = createAdminCreditRoutes({
    authMiddleware: async (_request, _url, options) => calls.push(["auth", options]),
    readJsonBody: async (request) => request.body,
    creditBookDoor: {
      originateConsentedLoan: async (termsHash) => {
        calls.push(["originate", termsHash]);
        return { termsHash, origination: { status: "confirmed" } };
      }
    },
    respond: (res, status, body) => { res.statusCode = status; res.body = body; }
  });
  const termsHash = `0x${"11".repeat(32)}`;
  assert.equal(await route({
    request: { method: "POST", body: { termsHash } }, response,
    url: new URL("https://api/admin/credit/originate"), pathname: "/admin/credit/originate"
  }), true);
  assert.deepEqual(calls, [
    ["auth", { requireCapability: "credit:originate" }],
    ["originate", termsHash]
  ]);
  assert.equal(response.statusCode, 200);
});
