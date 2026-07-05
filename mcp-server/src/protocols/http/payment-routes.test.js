import assert from "node:assert/strict";
import test from "node:test";

import { ValidationError } from "../../core/errors.js";
import { createPaymentRoutes, resolvePaymentRouteConfig } from "./payment-routes.js";

const AUTH = {
  wallet: "0x1111111111111111111111111111111111111111",
  claims: { roles: ["user"] }
};
const TRANSFER_AUTHORIZATION = {
  nonce: "42",
  deadline: "2000000000",
  signature: `0x${"1".repeat(130)}`
};

function stripIdempotencyKey(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const { idempotencyKey, ...rest } = payload;
  return rest;
}

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const payload = overrides.payload ?? {
    recipient: "0x2222222222222222222222222222222222222222",
    asset: "usdc",
    amount: "0.25",
    transferAuthorization: TRANSFER_AUTHORIZATION,
    idempotencyKey: "idem-1"
  };
  const service = overrides.service ?? {
    sendToAgent: async (from, recipient, asset, amount, transferAuthorization) => {
      calls.push(["sendToAgent", { from, recipient, asset, amount, transferAuthorization }]);
      return { liquid: { [asset]: 1 } };
    }
  };

  const route = createPaymentRoutes({
    authMiddleware: async (_request, _url) => {
      calls.push(["auth"]);
      return overrides.auth ?? AUTH;
    },
    buildIdempotentMutationContext: (input) => {
      calls.push(["buildContext", input]);
      return overrides.context ?? { bucket: input.bucket, key: `key:${input.bucket}`, requestHash: `hash:${input.bucket}` };
    },
    readJsonBody: async () => {
      calls.push(["body"]);
      return payload;
    },
    paymentsSendEnabled: overrides.paymentsSendEnabled ?? true,
    requireChainBackedMutation: async (routeName) => {
      calls.push(["requireChainBackedMutation", routeName]);
    },
    respond: (res, statusCode, body) => {
      res.statusCode = statusCode;
      res.body = body;
      calls.push(["respond", { statusCode, body }]);
    },
    runIdempotentMutation: async (res, context, statusCode, operation) => {
      calls.push(["runIdempotentMutation", { context, statusCode }]);
      const body = await operation();
      res.statusCode = statusCode;
      res.body = body;
      calls.push(["respond", { statusCode, body }]);
    },
    service,
    stripIdempotencyKey,
  });

  return { calls, response, route };
}

test("resolvePaymentRouteConfig defaults /payments/send off", () => {
  assert.deepEqual(resolvePaymentRouteConfig({}), { paymentsSendEnabled: false });
  assert.deepEqual(resolvePaymentRouteConfig({ PAYMENTS_SEND_ENABLED: "1" }), { paymentsSendEnabled: true });
  assert.deepEqual(resolvePaymentRouteConfig({ PAYMENTS_SEND_ENABLED: "false" }), { paymentsSendEnabled: false });
});

test("payment routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/not-payments"),
    pathname: "/not-payments",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("POST /payments/send returns 503 when payments send is disabled", async () => {
  const { calls, response, route } = makeHarness({ paymentsSendEnabled: false });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/payments/send"),
    pathname: "/payments/send",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { reason: "payments_send_disabled" });
  assert.deepEqual(calls, [
    ["respond", { statusCode: 503, body: { reason: "payments_send_disabled" } }]
  ]);
});

test("POST /payments/send relays idempotent chain-backed agent payment", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/payments/send"),
    pathname: "/payments/send",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    status: "sent",
    from: AUTH.wallet,
    to: "0x2222222222222222222222222222222222222222",
    asset: "USDC",
    amount: 0.25,
    transferAuthorization: {
      nonce: "42",
      deadline: "2000000000"
    },
    balances: { liquid: { USDC: 1 } }
  });
  assert.deepEqual(calls[2], [
    "buildContext",
    {
      route: "/payments/send",
      auth: AUTH,
      payload: {
        recipient: "0x2222222222222222222222222222222222222222",
        asset: "usdc",
        amount: "0.25",
        transferAuthorization: TRANSFER_AUTHORIZATION,
        idempotencyKey: "idem-1"
      },
      normalizedPayload: {
        recipient: "0x2222222222222222222222222222222222222222",
        asset: "USDC",
        amount: 0.25,
        transferAuthorization: TRANSFER_AUTHORIZATION
      },
      bucket: "payments_send"
    }
  ]);
  assert.deepEqual(calls.map(([name]) => name), [
    "auth",
    "body",
    "buildContext",
    "runIdempotentMutation",
    "requireChainBackedMutation",
    "sendToAgent",
    "respond"
  ]);
});

test("POST /payments/send defaults the asset to DOT", async () => {
  const { calls, response, route } = makeHarness({
    payload: {
      recipient: "0x2222222222222222222222222222222222222222",
      amount: 1,
      transferAuthorization: TRANSFER_AUTHORIZATION
    }
  });

  await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/payments/send"),
    pathname: "/payments/send",
  });

  assert.equal(response.body.asset, "DOT");
  assert.deepEqual(calls.find(([name]) => name === "sendToAgent"), [
    "sendToAgent",
    {
      from: AUTH.wallet,
      recipient: "0x2222222222222222222222222222222222222222",
      asset: "DOT",
      amount: 1,
      transferAuthorization: TRANSFER_AUTHORIZATION
    }
  ]);
});

test("POST /payments/send requires a transfer authorization envelope", async () => {
  const { route } = makeHarness({
    payload: { recipient: "0x2222222222222222222222222222222222222222", amount: 1 }
  });

  await assert.rejects(
    () => route({
      request: { method: "POST" },
      response: {},
      url: new URL("http://localhost/payments/send"),
      pathname: "/payments/send",
    }),
    (error) => error instanceof ValidationError
      && error.message === "transferAuthorization with nonce, deadline, and signature is required."
  );
});

test("POST /payments/send rejects invalid recipient shape", async () => {
  const { route } = makeHarness({
    payload: { recipient: "not-an-address", amount: 1 }
  });

  await assert.rejects(
    () => route({
      request: { method: "POST" },
      response: {},
      url: new URL("http://localhost/payments/send"),
      pathname: "/payments/send",
    }),
    (error) => error instanceof ValidationError
      && error.message === "recipient must be a 0x-prefixed 20-byte hex address."
  );
});

test("POST /payments/send rejects self-transfer", async () => {
  const { route } = makeHarness({
    payload: { recipient: AUTH.wallet, amount: 1, transferAuthorization: TRANSFER_AUTHORIZATION }
  });

  await assert.rejects(
    () => route({
      request: { method: "POST" },
      response: {},
      url: new URL("http://localhost/payments/send"),
      pathname: "/payments/send",
    }),
    (error) => error instanceof ValidationError
      && error.message === "recipient must differ from the sender."
  );
});

test("POST /payments/send rejects non-positive amount", async () => {
  const { route } = makeHarness({
    payload: { recipient: "0x2222222222222222222222222222222222222222", amount: 0, transferAuthorization: TRANSFER_AUTHORIZATION }
  });

  await assert.rejects(
    () => route({
      request: { method: "POST" },
      response: {},
      url: new URL("http://localhost/payments/send"),
      pathname: "/payments/send",
    }),
    (error) => error instanceof ValidationError
      && error.message === "amount must be a positive number."
  );
});
