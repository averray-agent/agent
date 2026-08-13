import assert from "node:assert/strict";
import test from "node:test";

import { createCreditPoolRoutes } from "./credit-pool-routes.js";

const WALLET = "0x4444444444444444444444444444444444444444";

function setup() {
  const calls = [];
  const handler = createCreditPoolRoutes({
    authMiddleware: async () => ({ wallet: WALLET }),
    creditPoolDoor: {
      getInfo: async (wallet) => { calls.push(["info", wallet]); return { available: true, wallet }; },
      buildTransactions: async (wallet, input) => { calls.push(["build", wallet, input]); return { available: true, input }; }
    },
    readJsonBody: async (request) => request.body,
    respond: (_response, status, payload) => calls.push(["response", status, payload])
  });
  return { handler, calls };
}

test("credit HTTP routes require wallet auth and preserve the door payload", async () => {
  const { handler, calls } = setup();
  assert.equal(await handler({ request: { method: "GET", headers: {} }, response: {}, url: new URL("https://api/credit"), pathname: "/credit" }), true);
  assert.equal(await handler({ request: { method: "POST", headers: {}, body: { direction: "borrow", amount: "1", pledgeShares: "2" } }, response: {}, url: new URL("https://api/credit/transactions"), pathname: "/credit/transactions" }), true);
  assert.deepEqual(calls[0], ["info", WALLET]);
  assert.deepEqual(calls[2], ["build", WALLET, { direction: "borrow", amount: "1", pledgeShares: "2" }]);
});
