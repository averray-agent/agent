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
  const clock = { now: new Date("2026-10-09T20:00:00Z"), used: false, balance: BigInt(profile.price.amountRaw) };
  const seconds = Math.floor(clock.now.getTime() / 1000);
  const calls = { starts: 0, captures: 0, nonceReads: 0, balances: [] };
  const gate = new X402VerificationPaymentGate({
    config: { enabled: true, network: "eip155:8453", chainId: 8453,
      asset: domain.verifyingContract.toLowerCase(), payTo: "0x1111111111111111111111111111111111111111",
      assetEip712Name: domain.name, assetEip712Version: domain.version,
      publicOrigin: "https://api.averray.com", captureMarginSeconds: 600 },
    provider: { getNetwork: async () => ({ chainId: 8453n }), getBlockNumber: async () => 100 },
    tokenContract: { name: async () => domain.name, DOMAIN_SEPARATOR: async () => TypedDataEncoder.hashDomain(domain),
      balanceOf: async (payer) => { calls.balances.push(payer); if (clock.balanceError) throw clock.balanceError; return clock.balance; },
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
  return { store, service, request, clock, calls, wallet, domain };
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
    assert.deepEqual(rejected.reason.details, { action: "sign_fresh_authorization" });
    assert.match(rejected.reason.message, /fresh authorization with a new nonce/u);
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
    test(`X1e ${backend}: ${status} completion retains the reservation through the expiry grace period`, options, async (t) => {
      const h = await fixture(t, backend);
      const run = await h.service.createRun(await h.request());
      await h.store.updateVerificationRun(run.runId, { ...run, status: "complete", billing: { status } });
      h.clock.used = status === "captured";
      h.clock.balance = 0n;
      h.clock.balanceError = new Error("replay must not need a fresh balance read");
      h.clock.now = new Date("2026-10-10T20:00:00Z");
      const nonceReads = h.calls.nonceReads;
      const replay = await h.service.createRun(await h.request(undefined, undefined, true));
      assert.equal(replay.runId, run.runId);
      assert.equal(replay.status, "complete");
      assert.equal(h.calls.nonceReads, nonceReads, "expired/used replay is a lookup, not fresh admission");
      assert.equal(h.calls.balances.length, 1, "only the original admission reads the balance");
      await assert.rejects(h.service.createRun(await h.request("https://two.example/mcp")),
        { statusCode: 409, code: "payment_authorization_in_use" });
      assert.equal(h.calls.starts, 1);
    });
  }

  test(`X1e ${backend}: normalized decoded authorizations share one key across address, nonce and proof encodings`, options, async (t) => {
    const h = await fixture(t, backend);
    const input = await h.request();
    const decoded = JSON.parse(Buffer.from(input.paymentProof, "base64"));
    const keys = [];
    const getOwner = h.store.getVerificationRunByAuthorizationId.bind(h.store);
    h.store.getVerificationRunByAuthorizationId = async (id) => { keys.push(id); return getOwner(id); };
    const first = await h.service.createRun(input);
    for (const from of [h.wallet.address.toLowerCase(), `0x${h.wallet.address.slice(2).toUpperCase()}`, h.wallet.address]) {
      for (const encoding of ["base64", "base64url"]) {
        const variant = structuredClone(decoded);
        variant.payload.authorization.from = from;
        variant.payload.authorization.nonce = `0x${variant.payload.authorization.nonce.slice(2).toUpperCase()}`;
        const paymentProof = Buffer.from(JSON.stringify(variant, null, 2)).toString(encoding);
        assert.equal((await h.service.createRun({ ...input, paymentProof })).runId, first.runId);
      }
    }
    assert.equal(keys.length, 7, "each rewrapped proof reaches the verified owner lookup");
    assert.equal(new Set(keys).size, 1);
    assert.equal(h.calls.starts, 1);
  });

  test(`X1e ${backend}: forged signature cannot look up or read a reserved authorization owner`, options, async (t) => {
    const h = await fixture(t, backend);
    const input = await h.request();
    const owner = await h.service.createRun(input);
    const decoded = JSON.parse(Buffer.from(input.paymentProof, "base64"));
    decoded.payload.signature = await Wallet.createRandom().signTypedData(h.domain, TYPES, decoded.payload.authorization);
    let ownerLookups = 0;
    let runReads = 0;
    const lookup = h.store.getVerificationRunByAuthorizationId.bind(h.store);
    const read = h.store.getVerificationRun.bind(h.store);
    h.store.getVerificationRunByAuthorizationId = async (id) => { ownerLookups++; return lookup(id); };
    h.store.getVerificationRun = async (id) => { runReads++; return read(id); };
    await assert.rejects(h.service.createRun({ ...input, paymentProof: Buffer.from(JSON.stringify(decoded)).toString("base64") }), (error) => {
      assert.equal(error.statusCode, 402);
      assert.equal(error.code, "payment_payer_mismatch");
      assert.ok(!JSON.stringify(error).includes(owner.runId));
      return true;
    });
    assert.equal(ownerLookups, 0);
    assert.equal(runReads, 0);
    assert.equal(h.calls.starts, 1);
  });

  test(`X1e ${backend}: far-future validBefore is refused without a reservation`, options, async (t) => {
    const h = await fixture(t, backend);
    const input = await h.request();
    const decoded = JSON.parse(Buffer.from(input.paymentProof, "base64"));
    for (const validBefore of [Math.floor(h.clock.now.getTime() / 1000) + decoded.accepted.maxTimeoutSeconds + 301, 2n ** 256n - 1n]) {
      decoded.payload.authorization.validBefore = String(validBefore);
      decoded.payload.signature = await h.wallet.signTypedData(h.domain, TYPES, decoded.payload.authorization);
      await assert.rejects(h.service.createRun({ ...input, paymentProof: Buffer.from(JSON.stringify(decoded)).toString("base64") }),
        { statusCode: 402, code: "payment_authorization_window_too_long", details: { action: "sign_fresh_authorization", customerFunds: "unchanged" } });
    }
    assert.equal((await h.store.listActiveVerificationRuns()).length, 0);
    assert.equal(h.calls.starts, 0);
    assert.equal(h.calls.nonceReads, 0);
  });

  test(`X1e ${backend}: authorization and payment indexes expire after validBefore plus 24 hours without replay extension`, options, async (t) => {
    const h = await fixture(t, backend);
    const input = await h.request();
    const run = await h.service.createRun(input);
    const authorization = await h.store.getVerificationRunAuthorization(run.runId);
    const paymentId = hashCanonicalContent(input.paymentProof);
    const maximumTtl = Number(authorization.authorization.validBefore) - Math.floor(h.clock.now.getTime() / 1000) + 86400;
    const remaining = async () => backend === "Redis"
      ? Promise.all([h.store.client.ttl(h.store.key("verification-authorization", authorization.id)), h.store.client.ttl(h.store.key("verification-payment", paymentId))])
      : [h.store.verificationAuthorizationRuns.get(authorization.id), h.store.verificationPaymentRuns.get(paymentId)]
        .map((entry) => (entry.expiresAt - Date.now()) / 1000);
    const before = await remaining();
    for (const ttl of before) assert.ok(ttl > maximumTtl - 5 && ttl <= maximumTtl, `bounded TTL: ${ttl}`);
    await h.service.createRun(await h.request(undefined, undefined, true));
    const after = await remaining();
    after.forEach((ttl, i) => assert.ok(ttl <= before[i], "replay must not extend retention"));

    // Exercise real expiration independently of the day-long production window.
    await h.store.reserveVerificationRun({ ...run, runId: "short-lived", requestHash: "short" },
      { paymentId: "short-proof", authorization: { id: "short-auth" }, reservationTtlSeconds: 1 });
    if (backend === "Memory") {
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      t.mock.timers.tick(1100);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    assert.equal(await h.store.getVerificationRunByPaymentId("short-proof"), undefined);
    assert.equal(await h.store.getVerificationRunByAuthorizationId("short-auth"), undefined);
    assert.equal((await h.store.getVerificationRun("short-lived")).runId, "short-lived", "run history is retained");
  });

  test(`X1e ${backend}: distinct nonces remain independent`, options, async (t) => {
    const h = await fixture(t, backend);
    const a = await h.service.createRun(await h.request());
    const b = await h.service.createRun(await h.request(undefined, `0x${"b".repeat(64)}`));
    assert.notEqual(a.runId, b.runId);
    assert.equal(h.calls.starts, 2);
  });

  for (const scenario of ["insufficient", "unavailable"]) {
    test(`X1f ${backend}: ${scenario} balance creates no run and no reservation key`, options, async (t) => {
      const h = await fixture(t, backend);
      h.clock.balance = 0n;
      if (scenario === "unavailable") h.clock.balanceError = new Error("Base read failed");
      let reservations = 0;
      const reserve = h.store.reserveVerificationRun.bind(h.store);
      h.store.reserveVerificationRun = async (...args) => { reservations++; return reserve(...args); };
      await assert.rejects(h.service.createRun(await h.request()), {
        statusCode: scenario === "insufficient" ? 402 : 503,
        code: scenario === "insufficient" ? "payment_insufficient_balance" : "payment_balance_unavailable"
      });
      assert.deepEqual(h.calls.balances, [h.wallet.address]);
      assert.equal(reservations, 0);
      assert.equal(h.calls.starts, 0);
      assert.equal(h.calls.captures, 0);
      assert.deepEqual(await h.store.listActiveVerificationRuns(), []);
      if (backend === "Redis") {
        assert.deepEqual(await h.store.client.keys(`${h.store.namespace}:verification-*`), []);
      } else {
        assert.equal(h.store.verificationPaymentRuns.size, 0);
        assert.equal(h.store.verificationAuthorizationRuns.size, 0);
        assert.equal(h.store.verificationRuns.size, 0);
      }
    });
  }
}
