import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationError } from "../../core/errors.js";
import { createCreditPoolRoutes } from "./credit-pool-routes.js";
import { respond } from "./http-helpers.js";

const WALLET = "0x4444444444444444444444444444444444444444";

function setup() {
  const calls = [];
  const handler = createCreditPoolRoutes({
    authMiddleware: async () => ({ wallet: WALLET }),
    creditPoolDoor: {
      getInfo: async (wallet) => { calls.push(["info", wallet]); return { available: true, wallet }; },
      buildTransactions: async (wallet, input) => { calls.push(["build", wallet, input]); return { available: true, input }; }
    },
    creditBookDoor: {
      storeConsent: async () => ({ stored: true })
    },
    workerProgressionService: {
      registerCreditInterest: async (wallet) => {
        calls.push(["interest", wallet]);
        return { wallet: wallet.toLowerCase(), status: "interested" };
      }
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

test("POST /credit/interest stores only the wallet's opt-in interest", async () => {
  const { handler, calls } = setup();
  assert.equal(await handler({
    request: { method: "POST", headers: {} },
    response: {},
    url: new URL("https://api/credit/interest"),
    pathname: "/credit/interest"
  }), true);
  assert.deepEqual(calls[0], ["interest", WALLET]);
  assert.equal(calls[1][1], 200);
  assert.match(calls[1][2].statement, /register interest/iu);
  assert.equal(calls[1][2].amount, undefined);
});

test("GET /credit requires wallet authentication", async () => {
  const handler = createCreditPoolRoutes({
    authMiddleware: async () => {
      throw new AuthenticationError("Authentication required.", "missing_token");
    },
    creditPoolDoor: { getInfo: async () => assert.fail("door must not run") },
    readJsonBody: async () => ({}),
    respond
  });
  await assert.rejects(
    handler({
      request: { method: "GET", headers: {} },
      response: capturedResponse(),
      url: new URL("https://api/credit"),
      pathname: "/credit"
    }),
    (error) => error instanceof AuthenticationError && error.statusCode === 401
  );
});

test("GET /credit serializes a no-loan wallet response even when a chain evidence field is bigint", async () => {
  const handler = createCreditPoolRoutes({
    authMiddleware: async () => ({ wallet: WALLET }),
    creditPoolDoor: {
      getInfo: async () => ({
        schemaVersion: 2,
        available: true,
        wallet: {
          address: WALLET,
          outstanding: { raw: "0", decimals: 6 }
        },
        receiptGraph: {
          available: true,
          underwriting: {
            evidence: { headBlock: 19_766_671n }
          },
          wallet: {
            cash: { outstanding: { raw: "0", decimals: 6 }, activeLoan: null },
            posting: { outstanding: { raw: "0", decimals: 6 }, activeLoan: null }
          }
        }
      })
    },
    readJsonBody: async () => ({}),
    respond
  });
  const response = capturedResponse();

  assert.equal(await handler({
    request: { method: "GET", headers: { authorization: "Bearer token" } },
    response,
    url: new URL("https://api/credit"),
    pathname: "/credit"
  }), true);
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.wallet.outstanding.raw, "0");
  assert.equal(body.receiptGraph.wallet.cash.outstanding.raw, "0");
  assert.equal(body.receiptGraph.wallet.posting.outstanding.raw, "0");
  assert.equal(body.receiptGraph.underwriting.evidence.headBlock, "19766671");
});

function capturedResponse() {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(body) {
      this.body = String(body ?? "");
    }
  };
}
