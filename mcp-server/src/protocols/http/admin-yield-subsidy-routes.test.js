import assert from "node:assert/strict";
import test from "node:test";

import { createAdminYieldSubsidyRoutes } from "./admin-yield-subsidy-routes.js";

function harness() {
  const authCalls = [];
  const responses = [];
  const attestations = [];
  const handler = createAdminYieldSubsidyRoutes({
    async authMiddleware(_request, _url, options) {
      authCalls.push(options);
      return { wallet: "0x2222222222222222222222222222222222222222" };
    },
    async readJsonBody() { return { txHash: `0x${"ab".repeat(32)}` }; },
    respond(_response, status, payload) { responses.push({ status, payload }); },
    yieldAttributionService: {
      async getLedger() { return { available: true, entryCount: 0 }; },
      async attestSubsidy(input) {
        attestations.push(input);
        return { created: true, entry: { txHash: input.txHash } };
      }
    }
  });
  return { handler, authCalls, responses, attestations };
}

test("admin subsidy ledger separates read access from operator attestation authority", async () => {
  const h = harness();
  const url = new URL("https://api.averray.com/admin/deposit-pool/subsidies");

  assert.equal(await h.handler({ request: { method: "GET" }, response: {}, url, pathname: url.pathname }), true);
  assert.deepEqual(h.authCalls[0], { requireCapability: "ops:view" });
  assert.equal(h.responses[0].status, 200);

  assert.equal(await h.handler({ request: { method: "POST" }, response: {}, url, pathname: url.pathname }), true);
  assert.deepEqual(h.authCalls[1], { requireCapability: "admin:yield-subsidy:attest" });
  assert.equal(h.responses[1].status, 201);
  assert.equal(h.attestations[0].attestedBy, "0x2222222222222222222222222222222222222222");
});

test("admin subsidy ledger ignores unrelated routes", async () => {
  const h = harness();
  const url = new URL("https://api.averray.com/admin/other");
  assert.equal(await h.handler({ request: { method: "GET" }, response: {}, url, pathname: url.pathname }), false);
  assert.equal(h.authCalls.length, 0);
});
