import assert from "node:assert/strict";
import test from "node:test";
import { Interface, TypedDataEncoder } from "ethers";
import { createConfiguredX402VerificationPaymentGate } from "./x402-verification-payment-gate.js";
import { VerificationProfileRegistry } from "../services/verification-profile-registry.js";
import { VerificationRunService } from "../services/verification-run-service.js";
import { MemoryStateStore } from "../core/state-store.js";
import { createVerifyRoutes } from "../protocols/http/verify-routes.js";
import { invokeHttpRoute } from "../protocols/mcp/route-adapter.js";
import { readJsonBody, respond } from "../protocols/http/http-helpers.js";

const domain = { name: "USD Coin", version: "2", chainId: 8453,
  verifyingContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
const env = { X402_VERIFY_MODE: "enabled", X402_PAYMENT_NETWORK: "eip155:8453", BASE_RPC_URL: "https://unused.test",
  X402_PAYMENT_ASSET_ADDRESS: domain.verifyingContract, X402_PAYMENT_PAY_TO: "0x1111111111111111111111111111111111111111",
  X402_PAYMENT_ASSET_EIP712_NAME: domain.name, X402_PAYMENT_ASSET_EIP712_VERSION: domain.version,
  X402_PUBLIC_ORIGIN: "https://api.averray.com" };
const abi = new Interface(["function name() view returns (string)", "function DOMAIN_SEPARATOR() view returns (bytes32)"]);
function fixture({ network = async () => ({ chainId: 8453n }) } = {}) {
  const calls = [];
  const provider = {
    async getNetwork() { calls.push("getNetwork"); return network(); },
    async call({ data }) {
      calls.push("call");
      const fn = abi.parseTransaction({ data }).name;
      return abi.encodeFunctionResult(fn, [fn === "name" ? domain.name : TypedDataEncoder.hashDomain(domain)]);
    },
    async getBlockNumber() { calls.push("getBlockNumber"); throw new Error("unexpected block read"); },
    async getLogs() { calls.push("getLogs"); throw new Error("unexpected log read"); },
    async getTransactionReceipt() { calls.push("getTransactionReceipt"); throw new Error("unexpected receipt read"); }
  };
  const warnings = [];
  return { calls, warnings, options: { provider,
    captureTokenContract: { transferWithAuthorization() { assert.fail("unpaid capture"); } },
    logger: { warn(...args) { warnings.push(args); } }
  } };
}

test("listing unpaid probes use the startup-validated domain: zero provider calls through real route/service/gate", async () => {
  const f = fixture();
  const gate = await createConfiguredX402VerificationPaymentGate(env, f.options);
  assert.ok(gate);
  assert.deepEqual(f.calls.sort(), ["call", "call", "getNetwork"], "startup must validate the actual token domain");
  f.calls.length = 0;
  const store = new MemoryStateStore();
  store.reserveVerificationRun = async () => assert.fail("unpaid reservation");
  const profiles = new VerificationProfileRegistry();
  const service = new VerificationRunService({ stateStore: store, profileRegistry: profiles, paymentGate: gate });
  const route = createVerifyRoutes({ enforceLimit: async () => {}, rateLimitConfig: { verifierRun: {} },
    readJsonBody, respond, verificationRunService: service });
  const post = (body) => invokeHttpRoute(route, { method: "POST", path: "/verify/runs", body });
  const requests = [undefined, {}, ...profiles.list().map((p) => p.workedExample.request)];
  // First request after startup and a concurrent burst both stay RPC-free.
  for (const replies of [[await post({})], await Promise.all(requests.map(post))]) {
    for (const reply of replies) {
      assert.equal(reply.statusCode, 402);
      assert.ok(reply.body.accepts.length > 0);
      assert.deepEqual(JSON.parse(Buffer.from(reply.headers["payment-required"], "base64")), reply.body);
      for (const accept of reply.body.accepts) {
        assert.equal(accept.amount, profiles.list().find((p) => p.ref === accept.extra.profile).price.amountRaw);
        assert.equal(accept.extra.name, domain.name);
        assert.equal(accept.extra.version, domain.version);
      }
    }
  }
  assert.equal((await post({})).body.accepts.length, 3);
  await assert.rejects(post({ profile: "unknown" }), { statusCode: 400 });
  assert.deepEqual(f.calls, [], "unpaid probes must never read a provider, including domain/balance/nonce/block");
  assert.deepEqual(await store.listActiveVerificationRuns(100), []);
});

test("listing startup waits for domain validation and fails closed on wrong chain or RPC failure", async () => {
  let release;
  const f = fixture({ network: () => new Promise((resolve) => { release = resolve; }) });
  let ready = false;
  const pending = createConfiguredX402VerificationPaymentGate(env, f.options).then((gate) => { ready = true; return gate; });
  await new Promise(setImmediate);
  assert.equal(ready, false);
  release({ chainId: 8453n });
  assert.ok(await pending);
  for (const network of [async () => ({ chainId: 1n }), async () => { throw new Error("RPC unavailable"); }]) {
    const bad = fixture({ network });
    assert.equal(await createConfiguredX402VerificationPaymentGate(env, bad.options), undefined);
    assert.equal(bad.warnings.length, 1);
  }
});

test("listing startup domain validation is bounded to eight seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ network: () => new Promise(() => {}) });
  const pending = createConfiguredX402VerificationPaymentGate(env, f.options);
  t.mock.timers.tick(8_000);
  assert.equal(await pending, undefined);
  assert.equal(f.warnings[0][0].err.code, "payment_chain_read_timeout");
});
