import assert from "node:assert/strict";
import test from "node:test";
import { TypedDataEncoder } from "ethers";

import { VerificationProfileRegistry } from "../../services/verification-profile-registry.js";
import { VerificationRunService } from "../../services/verification-run-service.js";
import { MemoryStateStore } from "../../core/state-store.js";
import { X402VerificationPaymentGate } from "../../payments/x402-verification-payment-gate.js";
import { readJsonBody, respond } from "./http-helpers.js";
import { invokeHttpRoute } from "../mcp/route-adapter.js";
import { createVerifyRoutes } from "./verify-routes.js";
import { VERIFY_BILLING_RULE } from "../../core/verify-product-copy.js";

const PRESENTATION_ENV = {
  X402_PAYMENT_NETWORK: "eip155:8453",
  X402_PAYMENT_ASSET_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
};

function discoveryHarness() {
  const calls = { reserve: 0, capture: 0, authorize: 0 };
  const store = new MemoryStateStore();
  store.reserveVerificationRun = async () => { calls.reserve++; throw new Error("unexpected reservation"); };
  const domain = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: PRESENTATION_ENV.X402_PAYMENT_ASSET_ADDRESS };
  const gate = new X402VerificationPaymentGate({
    config: { enabled: true, network: "eip155:8453", chainId: 8453,
      asset: domain.verifyingContract, payTo: "0x1111111111111111111111111111111111111111",
      assetEip712Name: domain.name, assetEip712Version: domain.version,
      publicOrigin: "https://api.averray.com", captureMarginSeconds: 600 },
    provider: { getNetwork: async () => ({ chainId: 8453n }) },
    tokenContract: { name: async () => domain.name, DOMAIN_SEPARATOR: async () => TypedDataEncoder.hashDomain(domain) },
    captureTokenContract: { transferWithAuthorization: async () => { calls.capture++; throw new Error("unexpected capture"); } }
  });
  const authorize = gate.authorize.bind(gate);
  gate.authorize = async (input) => { calls.authorize++; return authorize(input); };
  const profiles = new VerificationProfileRegistry();
  const service = new VerificationRunService({ stateStore: store, profileRegistry: profiles, paymentGate: gate });
  const route = createVerifyRoutes({ enforceLimit: async () => {}, rateLimitConfig: { verifierRun: {} },
    readJsonBody, respond, verificationRunService: service });
  return { calls, store, service, gate, profiles,
    post: (body, headers = {}) => invokeHttpRoute(route, { method: "POST", path: "/verify/runs", body, headers }) };
}

for (const [label, body] of [["no body", undefined], ["empty object", {}]]) {
  test(`X4b ${label} returns the published-example 402 without creating or reserving a run`, async () => {
    const h = discoveryHarness();
    const actual = await h.post(body);
    const example = h.profiles.get("mcp-failure-semantics-v1", 1).workedExample.request;
    const valid = await h.post(example);
    assert.equal(actual.statusCode, 402);
    assert.deepEqual(actual.body, valid.body);
    assert.equal(actual.body.x402Version, 2);
    assert.equal(actual.body.accepts[0].network, "eip155:8453");
    assert.equal(actual.body.accepts[0].amount, h.profiles.get(example.profile, 1).price.amountRaw);
    assert.equal(actual.body.billingRule, VERIFY_BILLING_RULE);
    assert.equal(actual.body.billing.status, "not_captured");
    assert.deepEqual(JSON.parse(Buffer.from(actual.headers["payment-required"], "base64")), actual.body);
    assert.equal(h.calls.reserve, 0);
    assert.equal(h.calls.capture, 0);
    assert.deepEqual(await h.store.listActiveVerificationRuns(100), []);
  });
}

test("X4b non-empty invalid bodies and non-object JSON remain 400 before payment intake", async () => {
  const h = discoveryHarness();
  for (const body of [{ profile: 1 }, { unrelated: true }, [], null, "", 0]) {
    await assert.rejects(h.post(body), { statusCode: 400, code: "invalid_request" });
  }
  assert.deepEqual(h.calls, { reserve: 0, capture: 0, authorize: 0 });
});

test("X4b proof plus empty body remains 400 for every payment-header alias, with no run or capture", async () => {
  const h = discoveryHarness();
  for (const header of ["payment-signature", "x-payment", "verification-payment"]) {
    for (const body of [undefined, {}]) {
      await assert.rejects(h.post(body, { [header]: "proof" }), { statusCode: 400, code: "invalid_request" });
    }
  }
  assert.deepEqual(h.calls, { reserve: 0, capture: 0, authorize: 0 });
  assert.deepEqual(await h.store.listActiveVerificationRuns(100), []);
});

test("X4b discovery fails closed if a custom gate accepts absent payment", async () => {
  const h = discoveryHarness();
  h.gate.authorize = async () => ({ id: "unexpected-authorization" });
  await assert.rejects(h.post({}), { statusCode: 503, code: "verification_discovery_unavailable" });
  assert.equal(h.calls.reserve, 0);
  assert.equal(h.calls.capture, 0);
});

function harness({ createRun, getRun, payload, profiles = new VerificationProfileRegistry().list() } = {}) {
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
    presentationEnv: PRESENTATION_ENV,
    verificationRunService: {
      listProfiles: () => profiles,
      getRun: getRun ?? (async (runId) => ({ runId, status: "complete" })),
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

test("GET /verify/runs names POST as the only creation method and never creates a run", async () => {
  const { response, route, calls } = harness();
  assert.equal(await route({ request: { method: "GET" }, response, pathname: "/verify/runs" }), true);
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "POST");
  assert.deepEqual(calls, []);
});

test("GET /verify/profiles is public, cacheable, and leads with the URL-only MCP profile", async () => {
  const { response, route } = harness();
  assert.equal(await route({ request: { method: "GET" }, response, pathname: "/verify/profiles" }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.body.profiles.map(({ ref }) => ref),
    ["mcp-failure-semantics-v1@1", "git-patch-tests-v1@1", "structured-output-evidence-v1@1"]
  );
  assert.equal(response.headers["cache-control"], "public, max-age=300");
});

test("POST /verify/runs calls the verify_runs rate limiter for unpaid and paid requests", async () => {
  const { calls, response, route } = harness();
  for (const headers of [{}, { "payment-signature": "proof" }]) {
    await route({ request: { method: "POST", headers, socket: { remoteAddress: "127.0.0.1" } }, response, pathname: "/verify/runs" });
  }
  const limits = calls.filter(([name]) => name === "limit").map(([, ...args]) => args);
  assert.equal(limits.length, 2);
  assert.equal(limits[1][0], "verify_runs");
  assert.deepEqual(limits[0], limits[1]);
  assert.deepEqual(calls.map(([name]) => name), ["limit", "createRun", "limit", "createRun"]);
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
  assert.deepEqual(response.body.assetContext, {
    symbol: "USDC",
    chain: "eip155:8453",
    chainName: "Base",
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  });
  assert.equal(calls.filter(([name]) => name === "createRun").length, 1);
  assert.equal(calls.find(([name]) => name === "createRun")[1].paymentProof, "proof");
  assert.equal(response.headers, undefined);
});

test("queued Verify response names the poll route and PASS settlement timing", async () => {
  const { response, route } = harness();
  const request = {
    method: "POST",
    headers: { "payment-signature": "proof" },
    socket: { remoteAddress: "127.0.0.1" }
  };

  assert.equal(await route({ request, response, pathname: "/verify/runs" }), true);
  assert.deepEqual(response.body.asyncStatus, {
    meaning: "Queued means the request was accepted for asynchronous verification. It is neither a failure nor a completed purchase.",
    poll: { method: "GET", path: "/verify/runs/verify-1" },
    settlement: "The settlement transaction is absent while queued. For a PASS, it appears only after PASS completes and payment capture succeeds."
  });

  const polled = harness({
    getRun: async (runId) => ({ runId, status: "queued" })
  });
  assert.equal(await polled.route({
    request: { method: "GET" },
    response: polled.response,
    pathname: "/verify/runs/verify-1"
  }), true);
  assert.deepEqual(polled.response.body.asyncStatus, response.body.asyncStatus);
});

test("POST /verify/runs returns the x402 challenge before work when unpaid", async () => {
  const paymentRequired = {
    x402Version: 2,
    billing: { status: "not_captured" },
    billingRule: VERIFY_BILLING_RULE,
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

test("GET /verify/runs/:runId is public and polls by opaque run id", async () => {
  const { response, route } = harness({
    getRun: async (runId) => ({
      runId,
      status: "complete",
      verdict: { outcome: "approved", reasonCode: "DETERMINISTIC_MATCH" },
      billing: { status: "captured", amountRaw: "5000000", asset: "USDC" }
    })
  });
  assert.equal(await route({ request: { method: "GET" }, response, pathname: "/verify/runs/verify-1" }), true);
  assert.deepEqual(response.body, {
    runId: "verify-1",
    status: "complete",
    billingRule: VERIFY_BILLING_RULE,
    verdict: { outcome: "approved", reasonCode: "DETERMINISTIC_MATCH" },
    billing: { status: "captured", amountRaw: "5000000", asset: "USDC" },
    result: "PASS",
    assetContext: {
      symbol: "USDC",
      chain: "eip155:8453",
      chainName: "Base",
      token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
    }
  });
});
