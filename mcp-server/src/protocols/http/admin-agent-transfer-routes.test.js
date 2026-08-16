import assert from "node:assert/strict";
import test from "node:test";

import { AuthorizationError, ValidationError } from "../../core/errors.js";
import {
  createAdminAgentTransferRoutes,
  resolveAgentTransferRecipientAllowlist,
} from "./admin-agent-transfer-routes.js";

const FROM = "0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05";
const REWARD_BANK = "0x5a6836c6D4d293F6E5377E6c28054F4171915813";
const OTHER = "0x2222222222222222222222222222222222222222";
const USDC = "0x0000053900000000000000000000000001200000";
const SIGNATURE = `0x${"11".repeat(65)}`;

function payload(overrides = {}) {
  return {
    from: FROM,
    recipient: REWARD_BANK,
    asset: USDC,
    amount: "100000",
    nonce: "42",
    deadline: "2000000000",
    signature: SIGNATURE,
    ...overrides,
  };
}

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const body = overrides.payload ?? payload();
  const route = createAdminAgentTransferRoutes({
    allowedRecipients: overrides.allowedRecipients ?? new Set([REWARD_BANK.toLowerCase()]),
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return { wallet: "0xadmin", claims: { roles: overrides.roles ?? ["admin"] } };
    },
    buildMutationRequestHash: (input) => {
      calls.push(["hash", input]);
      return "request-hash";
    },
    enforceLimit: async (...args) => calls.push(["limit", ...args]),
    gateway: {
      async submitAuthorizedAgentTransfer(input) {
        calls.push(["submit", input]);
        return {
          txHash: `0x${"ab".repeat(32)}`,
          blockNumber: 123,
          from: FROM,
          recipient: REWARD_BANK,
          asset: USDC,
          amountRaw: "100000",
        };
      },
      ...overrides.gateway,
    },
    rateLimitConfig: { adminJobs: { windowMs: 1_000, max: 10 } },
    readJsonBody: async () => body,
    requireChainBackedMutation: async (path) => calls.push(["chain", path]),
    respond: (res, statusCode, responseBody) => {
      res.statusCode = statusCode;
      res.body = responseBody;
      calls.push(["respond", statusCode]);
    },
    runIdempotentMutation: async (res, context, statusCode, operation) => {
      calls.push(["idempotent", context]);
      if (overrides.replay) {
        res.statusCode = overrides.replay.statusCode;
        res.body = overrides.replay.body;
        calls.push(["respond", overrides.replay.statusCode]);
        return;
      }
      const responseBody = await operation();
      res.statusCode = statusCode;
      res.body = responseBody;
      calls.push(["respond", statusCode]);
    },
  });
  return { calls, response, route };
}

test("admin agent transfer allowlist defaults to the configured reward bank", () => {
  assert.deepEqual(
    [...resolveAgentTransferRecipientAllowlist({ rewardBankAddress: REWARD_BANK })],
    [REWARD_BANK.toLowerCase()],
  );
  assert.throws(
    () => resolveAgentTransferRecipientAllowlist({ rewardBankAddress: "not-an-address" }),
    /reward bank address/u,
  );
});

test("admin agent transfer allowlist also admits the configured CreditBook", () => {
  assert.deepEqual(
    [...resolveAgentTransferRecipientAllowlist({
      rewardBankAddress: REWARD_BANK,
      additionalRecipients: [OTHER],
    })].sort(),
    [REWARD_BANK, OTHER].map((value) => value.toLowerCase()).sort(),
  );
});

test("POST /admin/agent-transfers accepts admin or service-token capability and relays exact raw units", async () => {
  const { calls, response, route } = makeHarness({ roles: ["service"] });
  assert.equal(await route({
    request: { method: "POST" },
    response,
    url: new URL("https://api.example/admin/agent-transfers"),
    pathname: "/admin/agent-transfers",
  }), true);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "confirmed");
  assert.equal(response.body.txHash, `0x${"ab".repeat(32)}`);
  assert.deepEqual(calls[0], ["auth", { requireCapability: "agent-transfers:submit" }]);
  assert.deepEqual(calls.find(([name]) => name === "submit")?.[1], {
    from: FROM,
    recipient: REWARD_BANK,
    asset: USDC,
    amountRaw: "100000",
    nonce: "42",
    deadline: "2000000000",
    signature: SIGNATURE,
  });
});

test("agent transfer idempotency is always scoped to (from, nonce)", async () => {
  const { calls, route } = makeHarness();
  await route({
    request: { method: "POST" },
    response: {},
    url: new URL("https://api.example/admin/agent-transfers"),
    pathname: "/admin/agent-transfers",
  });
  const replay = calls.find(([name]) => name === "idempotent")?.[1];
  assert.equal(replay.bucket, "admin_agent_transfers");
  assert.equal(replay.key, `${FROM.toLowerCase()}:42`);
  assert.equal(replay.requestHash, "request-hash");
});

test("agent transfer replay returns the durable receipt without a second chain write", async () => {
  const existing = { statusCode: 200, body: { status: "confirmed", txHash: `0x${"cd".repeat(32)}` } };
  const { calls, response, route } = makeHarness({ replay: existing });
  await route({
    request: { method: "POST" },
    response,
    url: new URL("https://api.example/admin/agent-transfers"),
    pathname: "/admin/agent-transfers",
  });
  assert.deepEqual(response.body, existing.body);
  assert.equal(calls.some(([name]) => name === "submit"), false);
});

test("agent transfer refuses a signed transfer to a non-operator recipient", async () => {
  const { route } = makeHarness({ payload: payload({ recipient: OTHER }) });
  await assert.rejects(
    () => route({
      request: { method: "POST" },
      response: {},
      url: new URL("https://api.example/admin/agent-transfers"),
      pathname: "/admin/agent-transfers",
    }),
    (error) => error instanceof AuthorizationError && error.code === "agent_transfer_recipient_not_allowed",
  );
});

test("agent transfer refuses ambiguous or lossy raw values", async () => {
  for (const [field, value] of [["amount", 0], ["amount", "1.5"], ["nonce", -1], ["deadline", "nope"]]) {
    const { route } = makeHarness({ payload: payload({ [field]: value }) });
    await assert.rejects(
      () => route({
        request: { method: "POST" },
        response: {},
        url: new URL("https://api.example/admin/agent-transfers"),
        pathname: "/admin/agent-transfers",
      }),
      (error) => error instanceof ValidationError,
    );
  }
});
