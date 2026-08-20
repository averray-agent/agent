import assert from "node:assert/strict";
import test from "node:test";

import { VerificationProfileRegistry } from "../../services/verification-profile-registry.js";
import { createVerifyRoutes } from "./verify-routes.js";

function harness({ createRun, payload, profiles = new VerificationProfileRegistry().list() } = {}) {
  const calls = [];
  const response = {};
  const route = createVerifyRoutes({
    enforceLimit: async (...args) => calls.push(["limit", ...args]),
    rateLimitConfig: { verifierRun: { limit: 5, windowSeconds: 60 } },
    readJsonBody: async () => payload ?? ({
      profile: "git-patch-tests-v1",
      profileVersion: 1,
      target: { repository: "repo", commit: "a".repeat(40) },
      inputs: { testCommand: ["npm", "test"] }
    }),
    respond: (target, statusCode, body, headers) => Object.assign(target, { statusCode, body, headers }),
    verificationRunService: {
      listProfiles: () => profiles,
      getRun: async (runId) => ({ runId, status: "complete" }),
      createRun: createRun ?? (async (input) => {
        calls.push(["createRun", input]);
        return {
          runId: "verify-1",
          status: "queued",
          customer: "0x1111111111111111111111111111111111111111",
          billing: { status: "authorized", amountRaw: "5000000", asset: "USDC" }
        };
      })
    }
  });
  return { calls, response, route };
}

test("GET /verify/profiles is public and cacheable", async () => {
  const { response, route } = harness();
  assert.equal(await route({ request: { method: "GET" }, response, pathname: "/verify/profiles" }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.body.profiles.map(({ ref }) => ref),
    ["git-patch-tests-v1@1", "mcp-failure-semantics-v1@1", "structured-output-evidence-v1@1"]
  );
  assert.equal(response.headers["cache-control"], "public, max-age=300");
});

test("POST /verify/runs forwards a scoped target token only through the ephemeral header seam", async () => {
  const { calls, response, route } = harness({
    payload: {
      profile: "mcp-failure-semantics-v1",
      profileVersion: 1,
      target: { endpoint: "https://mcp.example.test/run", transport: "streamable_http", auth: { scheme: "bearer", credentialRef: "run-only" } },
      inputs: {}
    }
  });
  const request = {
    method: "POST",
    headers: {
      "payment-signature": "proof",
      "verification-target-authorization": "Bearer scoped-run-secret"
    },
    socket: { remoteAddress: "127.0.0.1" }
  };
  assert.equal(await route({ request, response, pathname: "/verify/runs" }), true);
  const input = calls.find(([name]) => name === "createRun")[1];
  assert.equal(input.ephemeralCredential, "scoped-run-secret");
  assert.doesNotMatch(JSON.stringify(input.target), /scoped-run-secret/u);
  assert.doesNotMatch(JSON.stringify(input.inputs), /scoped-run-secret/u);
});

test("POST /verify/runs accepts the standard x402 header and returns the queued run", async () => {
  const { calls, response, route } = harness();
  const request = {
    method: "POST",
    headers: { "payment-signature": "proof" },
    socket: { remoteAddress: "127.0.0.1" }
  };
  assert.equal(await route({ request, response, pathname: "/verify/runs" }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "queued");
  assert.equal(calls.filter(([name]) => name === "createRun").length, 1);
  assert.equal(calls.find(([name]) => name === "createRun")[1].paymentProof, "proof");
  assert.equal(response.headers, undefined);
});

test("POST /verify/runs returns the x402 challenge before work when unpaid", async () => {
  const paymentRequired = {
    x402Version: 2,
    accepts: [{ scheme: "exact", amount: "5000000", network: "eip155:8453" }]
  };
  const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
  const { response, route } = harness({
    createRun: async () => {
      const error = new Error("payment required");
      error.statusCode = 402;
      error.details = {
        paymentRequired,
        paymentRequiredHeaders: { "payment-required": encoded, "x-payment-required": encoded }
      };
      throw error;
    }
  });
  const request = { method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(await route({ request, response, pathname: "/verify/runs" }), true);
  assert.equal(response.statusCode, 402);
  assert.deepEqual(response.body, paymentRequired);
  assert.equal(response.headers["payment-required"], encoded);
});

test("GET /verify/runs/:runId polls by opaque run id", async () => {
  const { response, route } = harness();
  assert.equal(await route({ request: { method: "GET" }, response, pathname: "/verify/runs/verify-1" }), true);
  assert.deepEqual(response.body, { runId: "verify-1", status: "complete" });
});
