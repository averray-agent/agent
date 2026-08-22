import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationError, AuthorizationError } from "../../core/errors.js";
import { createWorkerRoutes } from "./worker-routes.js";

const WALLET = "0x97450bf69cb4aeb0b33db3ae51ac2d18224d4b5c";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";

function receipt({
  receiptId = `0x${"1".repeat(64)}`,
  sessionId = "session-new",
  worker = WALLET,
  verifiedAt = "2026-08-22T12:00:00.000Z"
} = {}) {
  return {
    schemaVersion: "averray.work-receipt.v1",
    receiptId,
    canonicalUrl: `https://averray.com/receipts/${receiptId}`,
    sessionId,
    worker,
    verdict: { outcome: "approved" },
    settlement: {
      assetSymbol: "USDC",
      rewardAmount: "0.25",
      rewardAmountRaw: "250000",
      workerAmount: "0.2",
      workerAmountRaw: "200000",
      gasRetentionAmount: "0.05",
      gasRetentionAmountRaw: "50000",
      protocolFeeAmount: "0.05",
      protocolFeeAmountRaw: "50000",
      posterTotalAmount: "0.3",
      posterTotalAmountRaw: "300000"
    },
    timestamps: {
      claimedAt: "2026-08-22T11:00:00.000Z",
      submittedAt: "2026-08-22T11:30:00.000Z",
      verifiedAt
    }
  };
}

function makeHarness(overrides = {}) {
  const calls = [];
  const documents = overrides.documents ?? new Map([
    ["session-new", receipt()],
    ["session-old", receipt({
      receiptId: `0x${"2".repeat(64)}`,
      sessionId: "session-old",
      verifiedAt: "2026-08-21T12:00:00.000Z"
    })]
  ]);
  const route = createWorkerRoutes({
    authMiddleware: async (request) => {
      calls.push(["auth"]);
      if (!request.headers?.authorization) {
        throw new AuthenticationError("Authentication required.", "missing_token");
      }
      return { wallet: WALLET };
    },
    parseLimit: (_url, fallback, max) => Math.min(overrides.limit ?? fallback, max),
    respond(response, statusCode, body) {
      response.statusCode = statusCode;
      response.body = body;
    },
    service: {
      async getReputation(wallet) {
        calls.push(["getReputation", wallet]);
        return { skill: 100, reliability: 100_000, economic: 100, tier: "pro" };
      },
      async getAccountSummary(wallet) {
        calls.push(["getAccountSummary", wallet]);
        return {
          wallet,
          liquid: { USDC: 0.8 },
          jobStakeLocked: { USDC: 0 },
          raw: {
            liquid: { USDC: "800000" },
            jobStakeLocked: { USDC: "0" }
          }
        };
      },
      async collectSessionHistory(wallet) {
        calls.push(["collectSessionHistory", wallet]);
        return overrides.sessions ?? [
          { sessionId: "session-old", wallet },
          { sessionId: "session-new", wallet }
        ];
      }
    },
    stateStore: {
      async getRunReceiptDocument(sessionId) {
        calls.push(["getRunReceiptDocument", sessionId]);
        return documents.get(sessionId);
      }
    },
    workerProgressionService: {
      async getProgression(wallet) {
        calls.push(["getProgression", wallet]);
        return {
          tier: "pro",
          badges: [],
          effectiveCaps: { perJobMax: { amount: 1 }, rolling24h: { amount: 1.5 }, concurrent: { amount: 2.5 } },
          raises: [],
          creditInterest: { eligible: false, registered: false }
        };
      }
    }
  });
  return { calls, route };
}

function invoke(route, path, { authorization = true } = {}) {
  const response = {};
  return route({
    request: { method: "GET", headers: authorization ? { authorization: "Bearer token" } : {} },
    response,
    url: new URL(`https://api.averray.test${path}`),
    pathname: path.split("?")[0]
  }).then((handled) => ({ handled, response }));
}

test("GET /me echoes the wallet, labels both tier ladders, progression, and existing account position", async () => {
  const { route } = makeHarness();
  const { handled, response } = await invoke(route, "/me");

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.wallet, WALLET);
  assert.equal(response.body.claimTier, "pro");
  assert.equal(response.body.reputationTier, "journeyman");
  assert.equal(response.body.progression.tier, "pro");
  assert.deepEqual(response.body.accountPosition, {
    liquid: { USDC: 0.8 },
    jobStakeLocked: { USDC: 0 },
    raw: {
      liquid: { USDC: "800000" },
      jobStakeLocked: { USDC: "0" }
    }
  });
});

test("GET /receipts returns only the signed-in wallet's receipts newest first with a bounded limit", async () => {
  const { route } = makeHarness({ limit: 1 });
  const { handled, response } = await invoke(route, "/receipts?limit=1");

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].sessionId, "session-new");
  assert.equal(response.body[0].outcome, "approved");
  assert.equal(response.body[0].amounts.rewardAmountRaw, "250000");
  assert.equal(response.body[0].timestamps.verifiedAt, "2026-08-22T12:00:00.000Z");
  assert.equal(response.body[0].canonicalUrl, `https://averray.com/receipts/${"0x"}${"1".repeat(64)}`);
});

test("GET /receipts denies an attempted cross-wallet read", async () => {
  const { route } = makeHarness();
  await assert.rejects(
    invoke(route, `/receipts?wallet=${OTHER_WALLET}`),
    (error) => error instanceof AuthorizationError && error.code === "receipt_wallet_mismatch"
  );
});

test("GET /receipts never leaks a receipt whose stored worker differs from the signed-in wallet", async () => {
  const documents = new Map([
    ["session-new", receipt({ worker: OTHER_WALLET })]
  ]);
  const { route } = makeHarness({
    documents,
    sessions: [{ sessionId: "session-new", wallet: WALLET }]
  });
  const { response } = await invoke(route, "/receipts");

  assert.deepEqual(response.body, []);
});

for (const path of ["/me", "/receipts"]) {
  test(`GET ${path} requires wallet authentication`, async () => {
    const { route } = makeHarness();
    await assert.rejects(
      invoke(route, path, { authorization: false }),
      (error) => error instanceof AuthenticationError && error.statusCode === 401
    );
  });
}
