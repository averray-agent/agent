import assert from "node:assert/strict";
import test from "node:test";
import { createGasRoutes } from "./gas-routes.js";

const AUTH = { wallet: "0xworker" };

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const payload = overrides.payload ?? {
    userOperation: { sender: "0xsender" },
    context: { policy: "starter" },
  };
  const route = createGasRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return overrides.auth ?? AUTH;
    },
    pimlicoClient: {
      healthCheck: async () => {
        calls.push(["healthCheck"]);
        return overrides.health ?? { ok: true, backend: "pimlico" };
      },
      getCapabilities: () => {
        calls.push(["getCapabilities"]);
        return overrides.capabilities ?? { enabled: true, modes: ["sponsor"] };
      },
      quoteUserOperation: async (userOperation) => {
        calls.push(["quoteUserOperation", userOperation]);
        return overrides.quote ?? { totalGasUsd: "0.01" };
      },
      sponsorUserOperation: async (userOperation, context) => {
        calls.push(["sponsorUserOperation", { userOperation, context }]);
        return overrides.sponsorship ?? { paymasterAndData: "0xpaymaster" };
      },
    },
    readJsonBody: async () => {
      calls.push(["body"]);
      return payload;
    },
    respond: (res, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
  });
  return { calls, response, route };
}

test("gas routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/not-gas"),
    pathname: "/not-gas",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /gas/health returns Pimlico health without auth", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/gas/health"),
    pathname: "/gas/health",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, backend: "pimlico" });
  assert.deepEqual(calls, [
    ["healthCheck"],
    ["respond", { statusCode: 200, body: { ok: true, backend: "pimlico" } }],
  ]);
});

test("GET /gas/capabilities returns Pimlico capabilities without auth", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/gas/capabilities"),
    pathname: "/gas/capabilities",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { enabled: true, modes: ["sponsor"] });
  assert.deepEqual(calls, [
    ["getCapabilities"],
    ["respond", { statusCode: 200, body: { enabled: true, modes: ["sponsor"] } }],
  ]);
});

test("POST /gas/quote authenticates and quotes the user operation", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/gas/quote"),
    pathname: "/gas/quote",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { totalGasUsd: "0.01" });
  assert.deepEqual(calls, [
    ["auth", undefined],
    ["body"],
    ["quoteUserOperation", { sender: "0xsender" }],
    ["respond", { statusCode: 200, body: { totalGasUsd: "0.01" } }],
  ]);
});

test("POST /gas/sponsor authenticates and defaults missing context", async () => {
  const { calls, response, route } = makeHarness({
    payload: {
      userOperation: { sender: "0xsender" },
    },
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/gas/sponsor"),
    pathname: "/gas/sponsor",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { paymasterAndData: "0xpaymaster" });
  assert.deepEqual(calls, [
    ["auth", undefined],
    ["body"],
    ["sponsorUserOperation", {
      userOperation: { sender: "0xsender" },
      context: {},
    }],
    ["respond", { statusCode: 200, body: { paymasterAndData: "0xpaymaster" } }],
  ]);
});
