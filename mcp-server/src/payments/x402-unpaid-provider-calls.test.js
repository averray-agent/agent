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
    async getNetwork() { return { chainId: 8453n }; },
    async send(method, params) { assert.equal(method, "eth_chainId"); assert.deepEqual(params, []);
      calls.push("eth_chainId"); return (await network()).chainId; },
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
  assert.deepEqual(f.calls.sort(), ["call", "call", "eth_chainId"], "startup must validate the actual token domain");
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

test("listing startup waits for domain validation", async () => {
  let release;
  const f = fixture({ network: () => new Promise((resolve) => { release = resolve; }) });
  let ready = false;
  const pending = createConfiguredX402VerificationPaymentGate(env, f.options).then((gate) => { ready = true; return gate; });
  await new Promise(setImmediate);
  assert.equal(ready, false);
  release({ chainId: 8453n });
  assert.ok(await pending);
});

for (const mismatch of ["chain", "provider-chain", "name", "separator"]) {
  test(`listing ${mismatch} mismatch stays fail-closed without retrying`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const f = fixture({ network: async () => {
      if (mismatch === "provider-chain") throw Object.assign(new Error("network changed"), { code: "NETWORK_ERROR", event: "changed" });
      return { chainId: mismatch === "chain" ? 1n : 8453n };
    } });
    f.options.tokenContract = {
      name: async () => mismatch === "name" ? "wrong" : domain.name,
      // Match the wrong live name in its separator, so removing the name
      // comparison cannot hide behind the separator comparison.
      DOMAIN_SEPARATOR: async () => mismatch === "separator" ? "0x" + "00".repeat(32)
        : TypedDataEncoder.hashDomain({ ...domain, name: mismatch === "name" ? "wrong" : domain.name })
    };
    const gate = await createConfiguredX402VerificationPaymentGate(env, f.options);
    t.after(() => gate?.close());
    assert.ok(gate, "valid config must retain its gate");
    assert.equal(f.warnings.length, 1);
    const reads = f.calls.length;
    f.options.provider.send = async () => assert.fail("identity mismatch must not retry");
    for (let i = 0; i < 3; i++) {
      await assert.rejects(gate.eip712Domain(), { statusCode: 503, code: "payment_domain_unavailable",
        details: { status: "unavailable", retryable: false, customerFunds: "unchanged", action: "operator_check_payment_domain" } });
      t.mock.timers.tick(60_000);
      await new Promise(setImmediate);
    }
    assert.equal(f.calls.length, reads);
    assert.equal(gate.getDomainWarnings()[0].code, "verify_payment_domain_unavailable");
  });
}

test("listing RPC outage returns 503 then lazily recovers on the same gate, including in-flight capture reconciliation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let down = true;
  const f = fixture({ network: async () => {
    if (down) throw new Error("RPC unavailable");
    return { chainId: 8453n };
  } });
  const gate = await createConfiguredX402VerificationPaymentGate(env, f.options);
  t.after(() => gate?.close());
  assert.ok(gate);
  assert.equal(gate.getDomainWarnings()[0].code, "verify_payment_domain_unavailable");
  const service = new VerificationRunService({ stateStore: new MemoryStateStore(),
    profileRegistry: new VerificationProfileRegistry(), paymentGate: gate });
  const route = createVerifyRoutes({ enforceLimit: async () => {}, rateLimitConfig: { verifierRun: {} },
    readJsonBody, respond, verificationRunService: service });
  const post = () => invokeHttpRoute(route, { method: "POST", path: "/verify/runs", body: {} });
  await assert.rejects(post(), { statusCode: 503, code: "payment_domain_unavailable" });
  f.options.provider.getTransactionReceipt = async () => {
    if (down) throw new Error("RPC unavailable");
    return { status: 1 };
  };
  const pendingCapture = { authorization: {}, pendingTransactionHash: "0x" + "ab".repeat(32) };
  await assert.rejects(gate.reconcileCapture(pendingCapture), /RPC unavailable/);
  down = false;
  t.mock.timers.tick(1_000);
  const replies = await Promise.all([post(), post(), post()]);
  for (const reply of replies) { assert.equal(reply.statusCode, 402); assert.equal(reply.body.accepts.length, 3); }
  assert.deepEqual(gate.getDomainWarnings(), []);
  assert.deepEqual(await gate.reconcileCapture(pendingCapture), { status: "captured",
    transactionHash: pendingCapture.pendingTransactionHash, proof: "reconciled_from_chain" });
  f.calls.length = 0;
  await post();
  assert.deepEqual(f.calls, [], "healthy requests reuse the recovered domain");
});

test("listing background recovery retries with bounded exponential backoff without any request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let down = true;
  const f = fixture({ network: async () => {
    if (down) throw new Error("RPC unavailable");
    return { chainId: 8453n };
  } });
  const gate = await createConfiguredX402VerificationPaymentGate(env, f.options);
  t.after(() => gate.close());
  let attempts = 1;
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    t.mock.timers.tick(delay - 1); await new Promise(setImmediate);
    assert.equal(f.calls.filter((c) => c === "eth_chainId").length, attempts, "backoff avoids a retry storm");
    t.mock.timers.tick(1); await new Promise(setImmediate);
    assert.equal(f.calls.filter((c) => c === "eth_chainId").length, ++attempts);
  }
  down = false;
  t.mock.timers.tick(30_000); await new Promise(setImmediate);
  assert.deepEqual(gate.getDomainWarnings(), [], "background retry must recover without a probe");
  const reads = f.calls.length;
  t.mock.timers.tick(60_000); await new Promise(setImmediate);
  assert.equal(f.calls.length, reads, "success stops background reads");
});

test("listing startup domain timeout is bounded to eight seconds and recovers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let down = true;
  const f = fixture({ network: () => down ? new Promise(() => {}) : Promise.resolve({ chainId: 8453n }) });
  const pending = createConfiguredX402VerificationPaymentGate(env, f.options);
  await new Promise(setImmediate);
  t.mock.timers.tick(8_000);
  const gate = await pending;
  t.after(() => gate.close());
  assert.ok(gate);
  assert.equal(f.warnings[0][0].err.code, "payment_domain_unavailable");
  assert.equal(f.warnings[0][0].err.statusCode, 503);
  down = false;
  t.mock.timers.tick(1_000); await new Promise(setImmediate);
  assert.deepEqual(gate.getDomainWarnings(), []);
});


test("listing request bursts obey the deadline; first request after it starts exactly one shared attempt", async (t) => {
  // Move only the wall clock: the background timer has not fired when a
  // request reaches the deadline, so this specifically tests lazy recovery.
  t.mock.timers.enable({ apis: ["Date"] });
  let down = true, release;
  const f = fixture({ network: async () => {
    if (down) throw new Error("RPC unavailable");
    return new Promise((resolve) => { release = resolve; });
  } });
  const gate = await createConfiguredX402VerificationPaymentGate(env, f.options);
  t.after(() => gate.close());
  f.calls.length = 0;
  const unavailable = (error) => error.code === "payment_domain_unavailable"
    && error.statusCode === 503 && error.details.retryAfterSeconds === 1;
  for (let i = 0; i < 50; i++) await assert.rejects(gate.eip712Domain(), unavailable);
  t.mock.timers.tick(999);
  await Promise.all(Array.from({ length: 50 }, () => assert.rejects(gate.eip712Domain(), unavailable)));
  assert.deepEqual(f.calls, [], "requests within the retry window must do zero provider work");
  t.mock.timers.tick(1);
  await assert.rejects(gate.eip712Domain(), (error) => error.code === "payment_domain_unavailable"
    && error.statusCode === 503 && error.details.retryAfterSeconds === 2,
  "a fresh failed attempt must advertise the next backoff, before any cached request");
  assert.deepEqual(f.calls.sort(), ["call", "call", "eth_chainId"]);
  f.calls.length = 0;
  down = false;
  t.mock.timers.tick(1_999);
  await assert.rejects(gate.eip712Domain(), unavailable);
  assert.deepEqual(f.calls, []);
  t.mock.timers.tick(1);
  const pending = Array.from({ length: 50 }, () => gate.eip712Domain());
  await new Promise(setImmediate);
  assert.deepEqual(f.calls.sort(), ["call", "call", "eth_chainId"], "one domain attempt, shared across the burst");
  release({ chainId: 8453n });
  for (const value of await Promise.all(pending)) assert.deepEqual(value, domain);
  assert.deepEqual(gate.getDomainWarnings(), []);
});
