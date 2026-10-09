import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { TypedDataEncoder, Wallet } from "ethers";
import { MemoryStateStore, RedisStateStore } from "../core/state-store.js";
import { hashCanonicalContent } from "../core/canonical-content.js";
import { X402VerificationPaymentGate } from "../payments/x402-verification-payment-gate.js";
import { VerificationProfileRegistry } from "./verification-profile-registry.js";
import { VerificationRunService } from "./verification-run-service.js";

const redisUrl = process.env.VERIFY_RESERVATION_TEST_REDIS_URL;
const TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" },
  { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }
] };

async function fixture(t, backend) {
  const store = backend === "Memory" ? new MemoryStateStore()
    : new RedisStateStore(redisUrl, `verify-reservation-test:${randomUUID()}`);
  if (backend === "Redis") {
    t.after(async () => { if (store.client.isOpen) await store.client.quit(); });
    await store.connect();
  }
  const wallet = Wallet.createRandom();
  const profiles = new VerificationProfileRegistry();
  const profile = profiles.get("mcp-failure-semantics-v1", 1);
  const domain = { name: "USD Coin", version: "2", chainId: 8453,
    verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
  const clock = { now: new Date("2026-10-09T20:00:00Z"), used: false };
  const seconds = Math.floor(clock.now.getTime() / 1000);
  const calls = { starts: 0, captures: 0, nonceReads: 0 };
  const gate = new X402VerificationPaymentGate({
    config: { enabled: true, network: "eip155:8453", chainId: 8453,
      asset: domain.verifyingContract.toLowerCase(), payTo: "0x1111111111111111111111111111111111111111",
      assetEip712Name: domain.name, assetEip712Version: domain.version,
      publicOrigin: "https://api.averray.com", captureMarginSeconds: 600 },
    provider: { getNetwork: async () => ({ chainId: 8453n }) },
    tokenContract: { name: async () => domain.name, DOMAIN_SEPARATOR: async () => TypedDataEncoder.hashDomain(domain),
      authorizationState: async () => { calls.nonceReads++; return clock.used; } },
    captureTokenContract: { transferWithAuthorization: async () => { calls.captures++; throw new Error("unexpected capture"); } },
    now: () => clock.now
  });
  const service = new VerificationRunService({ stateStore: store, profileRegistry: profiles, paymentGate: gate,
    executionDispatcher: { supports: () => true, start: async () => { calls.starts++; } }, now: () => clock.now });
  async function request(endpoint = "https://one.example/mcp", nonce = `0x${"a".repeat(64)}`, pretty = false) {
    const input = { profile: profile.name, profileVersion: profile.version,
      target: { endpoint, transport: "streamable_http" }, inputs: {} };
    const requestHash = hashCanonicalContent({ profile: profile.ref, target: input.target, inputs: input.inputs });
    const requirements = gate.paymentRequirements({ domain, price: profile.price, profile: profile.ref,
      profileLimits: profile.limits, requestHash });
    const authorization = { from: wallet.address, to: requirements.payTo, value: requirements.amount,
      validAfter: String(seconds - 1), validBefore: String(seconds + Math.ceil(profile.limits.timeoutMs / 1000) + 601), nonce };
    const signature = await wallet.signTypedData(domain, TYPES, authorization);
    input.paymentProof = Buffer.from(JSON.stringify({ x402Version: 2, accepted: requirements,
      payload: { authorization, signature } }, null, pretty ? 2 : undefined)).toString("base64");
    return input;
  }
  return { store, service, request, clock, calls };
}

for (const backend of ["Memory", "Redis"]) {
  const options = { skip: backend === "Redis" && !redisUrl, timeout: 15000 };
  test(`X1e ${backend}: concurrent targets sharing a signed authorization create one run and one 409`, options, async (t) => {
    const h = await fixture(t, backend);
    const [a, b] = await Promise.all([h.request(), h.request("https://two.example/mcp")]);
    const pa = JSON.parse(Buffer.from(a.paymentProof, "base64"));
    const pb = JSON.parse(Buffer.from(b.paymentProof, "base64"));
    assert.deepEqual(pa.payload, pb.payload, "the signature is identical; only the unsigned request binding changed");
    let arrived = 0;
    let unlock;
    const barrier = new Promise((resolve) => { unlock = resolve; });
    const getOwner = h.store.getVerificationRunByAuthorizationId.bind(h.store);
    h.store.getVerificationRunByAuthorizationId = async (id) => {
      const owner = await getOwner(id);
      if (++arrived === 2) unlock();
      await barrier;
      return owner;
    };
    const results = await Promise.allSettled([h.service.createRun(a), h.service.createRun(b)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected");
    assert.equal(rejected.reason.code, "payment_authorization_in_use");
    assert.equal(rejected.reason.statusCode, 409);
    assert.equal((await h.store.listActiveVerificationRuns()).length, 1);
    assert.equal(h.calls.starts, 1);
    assert.equal(h.calls.captures, 0);
  });

  test(`X1e ${backend}: concurrent rewrapped same-request replays return the same run`, options, async (t) => {
    const h = await fixture(t, backend);
    const a = await h.request();
    const b = await h.request(undefined, undefined, true);
    assert.notEqual(a.paymentProof, b.paymentProof);
    const runs = await Promise.all([h.service.createRun(a), h.service.createRun(b)]);
    assert.equal(runs[0].runId, runs[1].runId);
    assert.equal(h.calls.starts, 1);
    await assert.rejects(h.service.createRun({ ...a, target: { ...a.target, endpoint: "https://two.example/mcp" } }),
      { statusCode: 409, code: "payment_authorization_in_use" }, "even an identical proof cannot replay a different request");
  });

  for (const status of ["captured", "not_captured"]) {
    test(`X1e ${backend}: ${status} completion never releases the authorization reservation`, options, async (t) => {
      const h = await fixture(t, backend);
      const run = await h.service.createRun(await h.request());
      await h.store.updateVerificationRun(run.runId, { ...run, status: "complete", billing: { status } });
      h.clock.used = status === "captured";
      h.clock.now = new Date("2026-10-10T20:00:00Z");
      const nonceReads = h.calls.nonceReads;
      const replay = await h.service.createRun(await h.request(undefined, undefined, true));
      assert.equal(replay.runId, run.runId);
      assert.equal(replay.status, "complete");
      assert.equal(h.calls.nonceReads, nonceReads, "expired/used replay is a lookup, not fresh admission");
      await assert.rejects(h.service.createRun(await h.request("https://two.example/mcp")),
        { statusCode: 409, code: "payment_authorization_in_use" });
      assert.equal(h.calls.starts, 1);
    });
  }

  test(`X1e ${backend}: distinct nonces remain independent`, options, async (t) => {
    const h = await fixture(t, backend);
    const a = await h.service.createRun(await h.request());
    const b = await h.service.createRun(await h.request(undefined, `0x${"b".repeat(64)}`));
    assert.notEqual(a.runId, b.runId);
    assert.equal(h.calls.starts, 2);
  });
}
