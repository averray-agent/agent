import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import { Interface, Signature } from "ethers";
import { X402VerificationPaymentGate } from "../payments/x402-verification-payment-gate.js";
import { MemoryStateStore, RedisStateStore } from "../core/state-store.js";
import { canonicalBadgeReceiptBytes, KmsBadgeReceiptSigner, verifyBadgeReceiptSignature } from "../core/badge-receipt-signing.js";
import { UnavailableVerificationPaymentGate, VerificationRunService } from "./verification-run-service.js";
import { VerificationProfileRegistry } from "./verification-profile-registry.js";
import { createVerificationShelf } from "./verification-shelf.js";
import { backfillBadgeReceiptSignatures } from "./badge-receipt-backfill.js";

async function signingFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = publicKey.export({ type: "spki", format: "der" });
  const keyId = "arn:aws:kms:eu-central-2:000000000000:key/11111111-2222-3333-4444-555555555555";
  let signs = 0;
  const signer = new KmsBadgeReceiptSigner({
    region: "eu-central-2", keyId, kid: "badge-1",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    publicKeyFingerprint: "sha256:" + createHash("sha256").update(der).digest("hex")
  }, { kmsClient: { send: async (command) => {
    if (command.constructor.name === "GetPublicKeyCommand") return { KeyId: keyId, PublicKey: der };
    signs++;
    return { Signature: p256.sign(new Uint8Array(command.input.Message),
      new Uint8Array(Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url")),
      { prehash: false, format: "der", lowS: false }) };
  } } });
  await signer.initialize();
  return { signer, jwk: signer.getJwks().keys[0], signs: () => signs };
}

async function receiptFixture({ store = new MemoryStateStore(), signer, suffix = "1" } = {}) {
  const profiles = new VerificationProfileRegistry();
  const service = new VerificationRunService({ stateStore: store, profileRegistry: profiles, badgeReceiptSigner: signer,
    paymentGate: { release: async () => {} }, publicReceiptBaseUrl: "https://averray.com" });
  const run = { runId: "verify-" + suffix, customer: "0x" + "1".repeat(40), status: "executed",
    profile: "mcp-failure-semantics-v1", profileVersion: 1,
    target: { endpoint: "https://example.test/" + suffix, transport: "streamable_http" }, inputs: {} };
  await store.reserveVerificationRun(run, { paymentId: suffix, authorization: { id: suffix } });
  const completed = await service.finalizeExecution({ run, profile: profiles.get(run.profile, 1), authorization: { id: suffix },
    execution: { status: "inconclusive", reason: "runner_fault", detail: "fixture" } });
  return { store, run: completed, document: await store.getWorkReceiptDocument(completed.receiptId) };
}

test("X1b Verify receipt uses the badge signer and verifies without changing canonical content or identity", async () => {
  const f = await signingFixture();
  const signed = await receiptFixture({ signer: f.signer });
  const unsigned = await receiptFixture();
  assert.equal(signed.document.signature.kid, "badge-1");
  assert.equal(signed.document.signature.alg, "ES256");
  assert.equal(verifyBadgeReceiptSignature(signed.document, f.jwk), true);
  assert.deepEqual(canonicalBadgeReceiptBytes(signed.document), canonicalBadgeReceiptBytes(unsigned.document));
  assert.equal(signed.document.receiptId, unsigned.document.receiptId);
  assert.equal(signed.document.canonicalUrl, unsigned.document.canonicalUrl);
  assert.equal(verifyBadgeReceiptSignature({ ...signed.document, verdict: { outcome: "approved" } }, f.jwk), false);
  assert.equal(verifyBadgeReceiptSignature(unsigned.document, f.jwk), false, "old unsigned shape must not be sold as signed");
});

test("X1b startup backfill pages Verify runs, preserves bytes and aliases, and is idempotent", async () => {
  const f = await signingFixture();
  const store = new MemoryStateStore();
  const originals = [];
  for (const suffix of ["1", "2", "3"]) originals.push(await receiptFixture({ store, suffix }));
  const first = await backfillBadgeReceiptSignatures({ stateStore: store, signer: f.signer, pageSize: 2, logger: {} });
  assert.deepEqual(first.verify, { scanned: 3, signed: 3, alreadySigned: 0, missing: 0 });
  for (const { run, document } of originals) {
    const stored = await store.getWorkReceiptDocument(run.receiptId);
    assert.equal(verifyBadgeReceiptSignature(stored, f.jwk), true);
    assert.deepEqual(canonicalBadgeReceiptBytes(stored), canonicalBadgeReceiptBytes(document));
    assert.deepEqual(await store.getWorkReceiptDocumentBySession(run.runId), stored);
    assert.deepEqual(await store.getRunReceiptDocument(run.runId), stored);
  }
  const second = await backfillBadgeReceiptSignatures({ stateStore: store, signer: f.signer, pageSize: 2, logger: {} });
  assert.deepEqual(second.verify, { scanned: 3, signed: 0, alreadySigned: 3, missing: 0 });
  assert.equal(f.signs(), 3);
  store.workReceiptDocuments.get(originals[0].run.receiptId).verdict.reasonCode = "tampered";
  await assert.rejects(backfillBadgeReceiptSignatures({ stateStore: store, signer: f.signer, logger: {} }), /invalid signature/);
});

test("X1b signer failures never persist an unsigned Verify receipt", async () => {
  const store = new MemoryStateStore();
  await assert.rejects(receiptFixture({ store, signer: { signDocument: async () => { throw new Error("sign failed"); } } }), /sign failed/);
  assert.deepEqual((await store.scanWorkReceiptDocuments()).documents, []);
});

test("X1b backfill counts dangling and non-Verify receipts as missing and continues paging", async () => {
  const f = await signingFixture();
  const store = new MemoryStateStore();
  for (const [id, receiptId] of [["missing", "absent"], ["other-lane", "badge-doc"]]) {
    await store.reserveVerificationRun({ runId: id, status: "complete", receiptId }, { paymentId: id, authorization: {} });
  }
  await store.putWorkReceiptDocument("other-lane", { receiptId: "badge-doc", intent: { specSource: "job" } });
  const valid = await receiptFixture({ store, suffix: "valid" });
  const result = await backfillBadgeReceiptSignatures({ stateStore: store, signer: f.signer, pageSize: 1, logger: {} });
  assert.deepEqual(result.verify, { scanned: 1, signed: 1, alreadySigned: 0, missing: 2 });
  assert.equal(verifyBadgeReceiptSignature(await store.getWorkReceiptDocument(valid.run.receiptId), f.jwk), true);
  assert.equal((await store.getWorkReceiptDocument("badge-doc")).signature, undefined);
});

for (const authorizationAvailable of [true, false]) {
  test(`X1b signing retry preserves captured billing and the decisive verdict without recapture (authorization ${authorizationAvailable ? "retained" : "missing"})`, async () => {
    const f = await signingFixture();
    const store = new MemoryStateStore();
    const profiles = new VerificationProfileRegistry();
    let captures = 0;
    let evaluations = 0;
    let signs = 0;
    let releases = 0;
    const service = new VerificationRunService({ stateStore: store, profileRegistry: profiles,
      badgeReceiptSigner: { signDocument: async (document) => {
        if (++signs === 1) throw new Error("KMS unavailable after capture");
        return f.signer.signDocument(document);
      } },
      paymentGate: {
        capture: async () => { captures++; return { transactionHash: "0x" + "a".repeat(64) }; },
        release: async () => { releases++; }
      }
    });
    const originalVerdict = { outcome: "approved", reason: "original decisive verdict", reasonCode: "PASS" };
    service.evaluatePinnedProfile = async () => {
      evaluations++;
      return originalVerdict;
    };
    const run = { runId: "paid-signing-retry", status: "executed", profile: "mcp-failure-semantics-v1", profileVersion: 1,
      customer: "0x" + "1".repeat(40), target: { endpoint: "https://example.test", transport: "streamable_http" }, inputs: {},
      execution: { status: "decidable" }
    };
    const authorization = { id: "paid" };
    await store.reserveVerificationRun(run, { paymentId: "paid", authorization });
    const profile = profiles.get(run.profile, 1);
    await assert.rejects(service.finalizeExecution({ run, profile, authorization, execution: run.execution }), /KMS unavailable/);
    const checkpoint = await store.getVerificationRun(run.runId);
    assert.equal(checkpoint.status, "executed");
    assert.equal(checkpoint.billing?.status, "captured");
    assert.deepEqual(checkpoint.verdict, originalVerdict);
    assert.deepEqual((await store.scanWorkReceiptDocuments()).documents, []);
    // Even losing authorization/evaluator availability cannot rewrite an already paid result.
    service.evaluatePinnedProfile = async () => {
      evaluations++;
      return { outcome: "rejected", reason: "a new verdict must not replace the captured result", reasonCode: "FAIL" };
    };
    const completed = await service.finalizeExecution({ run: checkpoint, profile,
      authorization: authorizationAvailable ? authorization : null, execution: checkpoint.execution });
    assert.equal(captures, 1);
    assert.equal(evaluations, 1);
    assert.equal(signs, 2);
    assert.equal(releases, 0, "safeRelease must not swallow the assertion");
    assert.equal(completed.status, "complete");
    assert.deepEqual(completed.billing, checkpoint.billing);
    assert.deepEqual(completed.verdict, originalVerdict);
    const receipt = await store.getWorkReceiptDocument(completed.receiptId);
    assert.equal(verifyBadgeReceiptSignature(receipt, f.jwk), true);
    assert.equal(receipt.verdict.outcome, "approved");
    assert.equal(receipt.intent.valueAtRisk.amountRaw, checkpoint.billing.amountRaw);
    assert.equal(receipt.verdict.reason, originalVerdict.reason);
  });
}

const captureAbi = new Interface([
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
]);
async function captureFixture({ waitFails = false, noHash = false } = {}) {
  const f = await signingFixture();
  const store = new MemoryStateStore();
  const profiles = new VerificationProfileRegistry();
  const hash = "0x" + "a".repeat(64);
  const asset = "0x" + "5".repeat(40);
  const proof = { from: "0x" + "1".repeat(40), to: "0x" + "2".repeat(40), value: "5000000",
    validAfter: "0", validBefore: "9999999999", nonce: "0x" + "3".repeat(64) };
  const state = { used: false, transfers: 0, releases: 0, evaluations: 0, receipt: null, events: [], logs: [], waitFails, noHash,
    head: 101, reads: 0, now: Date.parse("2026-10-09T16:00:00Z") };
  const event = (name, values) => ({ ...captureAbi.encodeEventLog(captureAbi.getEvent(name), values),
    address: asset, transactionHash: hash });
  const transfer = () => event("Transfer", [proof.from, proof.to, proof.value]);
  const used = () => event("AuthorizationUsed", [proof.from, proof.nonce]);
  const provider = {
    getBlockNumber: async () => state.head,
    getBlock: async (number) => { state.reads++; return { number: number === "latest" ? state.head : number,
      timestamp: (number === "latest" ? state.head : number) * 10 }; },
    getLogs: async (filter) => {
      state.reads++;
      state.lastFilter = filter;
      if (state.readError) throw state.readError;
      return state.events.filter((event) => (event.blockNumber ?? 101) >= filter.fromBlock && (event.blockNumber ?? 101) <= filter.toBlock);
    },
    getTransactionReceipt: async (tx) => {
      assert.equal(tx, hash);
      if (state.readError) throw state.readError;
      return state.receipt;
    }
  };
  const gate = new X402VerificationPaymentGate({ config: { enabled: true, asset, payTo: proof.to, network: "eip155:8453" }, provider,
    tokenContract: { authorizationState: async () => state.used },
    captureTokenContract: { transferWithAuthorization: async () => {
      const checkpoint = await store.getVerificationRun("capture-test");
      assert.equal(checkpoint.billing.status, "capturing");
      assert.equal(checkpoint.billing.fromBlock, 101);
      assert.deepEqual(checkpoint.verdict, verdict);
      if (state.used) throw new Error("authorization already used");
      state.used = true; state.transfers++;
      state.events = [used()];
      state.receipt = { status: 1, logs: [used(), transfer()] };
      if (state.noHash) throw new Error("broadcast response lost");
      return { hash, wait: async () => {
        assert.equal((await store.getVerificationRun("capture-test")).billing.pendingTransactionHash, hash);
        if (state.waitFails) throw new Error("wait failed");
        return state.receipt;
      } };
    } }
  });
  gate.release = async () => { state.releases++; };
  const authorization = { id: "paid", customer: proof.from, authorization: proof, authorizedAtBlock: 100,
    signature: Signature.from({ r: "0x" + "1".repeat(64), s: "0x" + "2".repeat(64), v: 27 }).serialized };
  const service = new VerificationRunService({ stateStore: store, profileRegistry: profiles, paymentGate: gate,
    badgeReceiptSigner: f.signer, logger: { warn: (...args) => state.logs.push(args) }, now: () => new Date(state.now) });
  const verdict = { outcome: "approved", reasonCode: "PASS", reason: "original decisive result" };
  service.evaluatePinnedProfile = async () => {
    state.evaluations++;
    return state.evaluations === 1 ? verdict : { outcome: "rejected", reasonCode: "FAIL" };
  };
  const run = { runId: "capture-test", status: "executed", profile: "mcp-failure-semantics-v1", profileVersion: 1,
    customer: proof.from, target: { endpoint: "https://example.test", transport: "streamable_http" }, inputs: {},
    execution: { status: "decidable" }, billing: { status: "authorized" } };
  await store.reserveVerificationRun(run, { paymentId: run.runId, authorization });
  const finalize = async () => service.finalizeExecution({ run: await store.getVerificationRun(run.runId),
    profile: profiles.get(run.profile, 1), authorization, execution: run.execution });
  const checkpoint = async () => store.updateVerificationRun(run.runId, { ...run, verdict,
    billing: { status: "capturing", capturePrepared: true, fromBlock: 101 } });
  return { ...f, store, service, state, event, used, transfer, proof, hash, verdict, gate, finalize, checkpoint, authorization,
    advance: () => { state.now += 300_000; } };
}

for (const failure of ["checkpoint", "wait", "broadcast-response"]) {
  test(`X1d confirmed transfer survives ${failure}, preserving original verdict and transaction hash`, async () => {
    const f = await captureFixture({ waitFails: failure === "wait", noHash: failure === "broadcast-response" });
    const update = f.store.updateVerificationRun.bind(f.store);
    let failCheckpoint = failure === "checkpoint";
    f.store.updateVerificationRun = async (id, next) => {
      if (failCheckpoint && next.billing.status === "captured") {
        failCheckpoint = false; throw new Error("checkpoint unavailable");
      }
      return update(id, next);
    };
    if (failure === "checkpoint") {
      await assert.rejects(f.finalize(), /checkpoint unavailable/);
      assert.equal((await f.store.getVerificationRun("capture-test")).billing.status, "capturing");
    }
    const completed = await f.finalize();
    assert.equal(f.state.transfers, 1);
    assert.equal(f.state.evaluations, 1);
    assert.equal(f.state.releases, 0);
    assert.equal(completed.billing.status, "captured");
    assert.equal(completed.billing.transactionHash, f.hash);
    assert.equal(completed.billing.proof, "reconciled_from_chain");
    assert.deepEqual(completed.verdict, f.verdict);
    const receipt = await f.store.getWorkReceiptDocument(completed.receiptId);
    assert.equal(receipt.verdict.outcome, "approved");
    assert.equal(receipt.intent.valueAtRisk.amountRaw, "5000000");
    assert.equal(verifyBadgeReceiptSignature(receipt, f.jwk), true);
  });
}

test("X1d cancellation consumes nonce but never delivers a decisive paid verdict", async () => {
  const f = await captureFixture();
  await f.checkpoint();
  f.state.used = true;
  f.state.events = [f.event("AuthorizationCanceled", [f.proof.from, f.proof.nonce])];
  const result = await f.finalize();
  assert.equal(result.verdict.outcome, "inconclusive");
  assert.equal(result.verdict.reason, "payment_cancelled_by_payer");
  assert.equal(result.billing.status, "not_captured");
  assert.equal(f.state.transfers, 0);
  assert.equal(f.state.evaluations, 0);
});

for (const shape of ["null-receipt", "used-no-events", "wrong-transfer", "read-error"]) {
  test(`X1d ${shape} remains retryable without publishing a verdict or releasing payment`, async () => {
    const f = await captureFixture();
    await f.checkpoint();
    f.state.used = true;
    if (shape === "null-receipt") {
      const run = await f.store.getVerificationRun("capture-test");
      await f.store.updateVerificationRun(run.runId, { ...run, billing: { ...run.billing, pendingTransactionHash: f.hash } });
    }
    if (shape === "wrong-transfer") {
      f.state.events = [f.used()];
      f.state.receipt = { status: 1, logs: [f.event("Transfer", [f.proof.from, f.proof.to, "1"])] };
    }
    if (shape === "read-error") f.state.readError = Object.assign(new Error("RPC failed"), { code: "RPC_UNAVAILABLE" });
    assert.deepEqual(await f.service.finalizeAvailableRuns(), []);
    const persisted = await f.store.getVerificationRun("capture-test");
    assert.equal(persisted.billing.status, "capturing");
    assert.deepEqual(persisted.verdict, f.verdict);
    const visible = await f.service.getRun("capture-test");
    assert.equal(visible.verdict, undefined);
    assert.equal(visible.execution, undefined);
    assert.equal(await f.store.getWorkReceiptDocument("capture-test"), undefined);
    assert.equal(f.state.transfers, 0);
    assert.equal(f.state.releases, 0);
    if (shape === "read-error") assert.deepEqual(f.state.logs[0][0], { runId: "capture-test", errorName: "Error", errorCode: "RPC_UNAVAILABLE" });
  });
}

test("X1d a reverted hash with an unused live authorization can retry normally", async () => {
  const f = await captureFixture();
  await f.checkpoint();
  f.state.receipt = { status: 0 };
  const run = await f.store.getVerificationRun("capture-test");
  await f.store.updateVerificationRun(run.runId, { ...run, billing: { ...run.billing, pendingTransactionHash: f.hash } });
  assert.equal((await f.finalize()).billing.status, "captured");
  assert.equal(f.state.transfers, 1);
  const fresh = await captureFixture();
  await fresh.checkpoint();
  const paid = await fresh.finalize();
  assert.equal(paid.billing.status, "captured");
  assert.equal(fresh.state.transfers, 1);
  assert.equal(fresh.state.evaluations, 0);
});

test("X1d wait failure persists the broadcast hash while the receipt is still pending", async () => {
  const f = await captureFixture({ waitFails: true });
  f.gate.provider.getTransactionReceipt = async () => null;
  await f.finalize();
  const pending = await f.store.getVerificationRun("capture-test");
  assert.equal(pending.billing.status, "capturing");
  assert.equal(pending.billing.pendingTransactionHash, f.hash);
  assert.equal(f.state.releases, 0);
  assert.equal(f.state.transfers, 1);
});

test("X1d unavailable reconciliation logs once per run and remains retryable", async () => {
  const f = await captureFixture();
  await f.checkpoint();
  f.service.paymentGate = new UnavailableVerificationPaymentGate();
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await f.service.finalizeAvailableRuns(), []);
    f.advance();
  }
  assert.equal(f.state.logs.length, 1);
  assert.equal(f.state.logs[0][0].errorCode, "capture_reconciliation_unavailable");
  assert.equal((await f.store.getVerificationRun("capture-test")).billing.status, "capturing");
});

test("X1d missing or invalid legacy scan bounds never imply non-payment", async () => {
  for (const fromBlock of [undefined, -1, 102]) {
    const f = await captureFixture();
    delete f.authorization.authorizedAtBlock;
    await f.checkpoint();
    const run = await f.store.getVerificationRun("capture-test");
    await f.store.updateVerificationRun(run.runId, { ...run, billing: { ...run.billing, fromBlock } });
    await assert.rejects(f.finalize(), { code: "capture_range_unavailable" });
    assert.equal(f.state.transfers, 0);
    assert.equal(f.state.releases, 0);
  }
});

test("X1d duplicate broadcast reverting never reports no fee after the earlier transfer paid", async () => {
  const f = await captureFixture();
  const tx2 = "0x" + "b".repeat(64);
  const update = f.store.updateVerificationRun.bind(f.store);
  let writesFail = 2;
  f.store.updateVerificationRun = async (id, run) => {
    if (run.billing.pendingTransactionHash === f.hash && writesFail-- > 0) {
      throw Object.assign(new Error("hash journal unavailable"), { code: "STORE_UNAVAILABLE" });
    }
    return update(id, run);
  };
  f.gate.provider.getTransactionReceipt = async (hash) => {
    if (f.state.transfers < 2) return null; // tx1 still in the mempool.
    return hash === tx2 ? { status: 0, logs: [] } : { status: 1, logs: [f.used(), f.transfer()] };
  };
  f.gate.captureToken.transferWithAuthorization = async () => {
    f.state.transfers++;
    if (f.state.transfers === 2) {
      f.state.used = true; // tx1 mines before tx2.
      f.state.events = [f.used()];
    }
    return { hash: f.state.transfers === 1 ? f.hash : tx2, wait: async () => ({ status: 0 }) };
  };
  await assert.rejects(f.finalize(), /hash journal unavailable/);
  assert.equal((await f.store.getVerificationRun("capture-test")).billing.pendingTransactionHash, undefined);
  const completed = await f.finalize();
  assert.equal(f.state.transfers, 2);
  assert.equal(completed.billing.status, "captured");
  assert.equal(completed.billing.transactionHash, f.hash);
  assert.equal(completed.verdict.outcome, "approved");
  assert.equal(f.state.evaluations, 1);
  assert.equal(f.state.releases, 0);
});

test("X1d cancellation during execution precedes the checkpoint and still terminates cancelled", async () => {
  const f = await captureFixture();
  await f.checkpoint();
  f.state.used = true;
  f.state.events = [{ ...f.event("AuthorizationCanceled", [f.proof.from, f.proof.nonce]), blockNumber: 100 }];
  const completed = await f.finalize();
  assert.equal(f.state.lastFilter.fromBlock, 100);
  assert.equal(completed.verdict.reason, "payment_cancelled_by_payer");
  assert.equal(completed.billing.status, "not_captured");
  assert.equal(f.state.transfers, 0);
});

test("X1d a cancellation after gas estimation is reconciled on a capture throw", async () => {
  const f = await captureFixture();
  f.gate.captureToken.transferWithAuthorization = async () => {
    f.state.used = true;
    f.state.events = [f.event("AuthorizationCanceled", [f.proof.from, f.proof.nonce])];
    throw Object.assign(new Error("estimate changed"), { code: "CALL_EXCEPTION" });
  };
  assert.equal((await f.finalize()).verdict.reason, "payment_cancelled_by_payer");
  assert.deepEqual(f.state.logs[0][0], { runId: "capture-test", errorName: "Error", errorCode: "CALL_EXCEPTION" });
});

test("X1d zero-balance payer backs off without RPC then expires unused without a decisive verdict", async () => {
  const f = await captureFixture();
  f.proof.validBefore = "1015";
  f.gate.captureToken.transferWithAuthorization = async () => { throw new Error("insufficient balance"); };
  await f.finalize();
  let previousDelay = 0;
  for (let i = 0; i < 8; i++) {
    const pending = await f.store.getVerificationRun("capture-test");
    const delay = Date.parse(pending.billing.nextCaptureAttemptAt) - f.state.now;
    assert.ok(delay >= previousDelay && delay <= 300_000);
    previousDelay = delay;
    const reads = f.state.reads;
    assert.deepEqual(await f.service.finalizeAvailableRuns(), []);
    await f.finalize();
    assert.equal(f.state.reads, reads, "not-due runs issue no RPC even through direct finalization");
    assert.equal(f.state.releases, 0);
    f.advance();
    await f.finalize();
  }
  assert.equal(previousDelay, 300_000);
  f.advance();
  f.state.head = 102;
  const completed = await f.finalize();
  assert.equal(completed.verdict.reason, "payment_authorization_expired");
  assert.equal(completed.verdict.outcome, "inconclusive");
  assert.equal(completed.billing.status, "not_captured");
  assert.equal(completed.execution.report, undefined);
});

test("X1d large expired windows make bounded scan progress and terminate", async () => {
  const f = await captureFixture();
  await f.checkpoint();
  f.state.head = 12_000;
  f.proof.validBefore = "119980";
  let calls = 0;
  const getLogs = f.gate.provider.getLogs;
  f.gate.provider.getLogs = async (filter) => {
    calls++;
    assert.ok(filter.toBlock <= 11_998, "scan stops at validBefore, not today's head");
    assert.ok(filter.toBlock - filter.fromBlock < 1000);
    return getLogs(filter);
  };
  const pending = await f.finalize();
  assert.equal(pending.billing.status, "capturing");
  assert.equal(calls, 10);
  f.advance();
  const done = await f.finalize();
  assert.equal(done.verdict.reason, "payment_authorization_expired");
  assert.equal(calls, 12);
});

test("X1d a known pending hash cannot rebroadcast, but proven unused expiry terminates", async () => {
  const f = await captureFixture();
  await f.checkpoint();
  f.proof.validBefore = "1015";
  const run = await f.store.getVerificationRun("capture-test");
  await f.store.updateVerificationRun(run.runId, { ...run, billing: { ...run.billing, pendingTransactionHash: f.hash } });
  assert.equal((await f.finalize()).billing.status, "capturing");
  assert.equal(f.state.transfers, 0);
  f.advance();
  f.state.head = 102;
  assert.equal((await f.finalize()).verdict.reason, "payment_authorization_expired");
});

test("X1d sleeping older captures cannot starve a newer paid run at limit one", async () => {
  const f = await captureFixture();
  await f.checkpoint();
  const pending = await f.store.getVerificationRun("capture-test");
  for (let i = 0; i < 101; i++) {
    const sleeping = { ...pending, runId: "sleep-" + i, submittedAt: "2026-10-08T00:00:00Z",
      billing: { ...pending.billing, nextCaptureAttemptAt: "2099-01-01T00:00:00Z" } };
    await f.store.reserveVerificationRun(sleeping, { paymentId: sleeping.runId });
  }
  await f.store.updateVerificationRun("capture-test", { ...pending, status: "complete" });
  const newer = { ...pending, runId: "new-paid", submittedAt: "2026-10-09T16:00:00Z", billing: { status: "authorized" } };
  await f.store.reserveVerificationRun(newer, { paymentId: newer.runId, authorization: f.authorization });
  f.gate.capture = async () => { f.state.transfers++; return { transactionHash: f.hash }; };
  assert.deepEqual((await f.service.finalizeAvailableRuns({ limit: 1 })).map((run) => run.runId), ["new-paid"]);
  assert.equal(f.state.transfers, 1);
});

test("X1d legacy unresolved captures surface one counted cached operator warning, never expiry", async () => {
  const f = await captureFixture();
  delete f.authorization.authorizedAtBlock;
  f.proof.validBefore = "1005";
  await f.checkpoint();
  await f.finalize();
  assert.equal((await f.store.getVerificationRun("capture-test")).billing.legacyCaptureUnresolved, true);
  assert.equal((await f.service.getRun("capture-test")).verdict, undefined);
  let walks = 0;
  const list = f.store.listActiveVerificationRuns.bind(f.store);
  f.store.listActiveVerificationRuns = (...args) => { walks++; return list(...args); };
  const expected = [{ code: "verify_capture_legacy_unresolved", severity: "warning", count: 1 }];
  assert.deepEqual(await f.service.getCaptureWarnings(), expected);
  assert.deepEqual(await f.service.getCaptureWarnings(), expected);
  assert.equal(walks, 1);
});

test("X1d AuthorizationUsed requires Transfer to payTo; greater transferred value is sufficient", async () => {
  for (const to of ["0x" + "9".repeat(40), "0x" + "2".repeat(40)]) {
    const f = await captureFixture();
    await f.checkpoint();
    f.state.used = true;
    f.state.events = [f.used()];
    f.state.receipt = { status: 1, logs: [f.event("Transfer", [f.proof.from, to, "5000001"])] };
    const result = await f.finalize();
    assert.equal(result.billing.status, to === f.proof.to ? "captured" : "capturing");
    assert.equal(f.state.transfers, 0);
  }
});

test("X1d Redis active-run paging preserves offset for due-run selection", async () => {
  const store = new RedisStateStore("redis://unused", "capture-test");
  store.connect = async () => {};
  store.client = { zRange: async (_key, start, stop) => {
    assert.equal(start, 100); assert.equal(stop, 199); return ["new-paid"];
  } };
  store.getVerificationRun = async (id) => ({ runId: id, status: "executed" });
  assert.deepEqual(await store.listActiveVerificationRuns(100, { offset: 100 }), [{ runId: "new-paid", status: "executed" }]);
});

test("X1d public OpenAPI admits capturing without claiming captured or not_captured", () => {
  const schema = JSON.parse(readFileSync(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8"));
  assert.ok(schema.components.schemas.VerifyRun.properties.billing.properties.status.enum.includes("capturing"));
});

test("X1b shelf receives the same bootstrap badge signer", async () => {
  const f = await signingFixture();
  const shelf = await createVerificationShelf({ stateStore: new MemoryStateStore(), badgeReceiptSigner: f.signer, env: {}, logger: {} });
  assert.equal(shelf.verificationRunService.badgeReceiptSigner, f.signer);
  const bootstrap = readFileSync(new URL("./bootstrap.js", import.meta.url), "utf8");
  assert.match(bootstrap, /createVerificationShelf\(\{[\s\S]*?paymentGate: verificationPaymentGate,\s*badgeReceiptSigner,/u);
  assert.match(bootstrap, /platformService\.receiptSignatureBackfill = await backfillBadgeReceiptSignatures/u);
});

test("X1b Redis signature CAS preserves serialized arrays and updates the run alias without replacing a signature", async () => {
  const store = new RedisStateStore("redis://unused", "signing-test");
  const f = await signingFixture();
  const { document, run } = await receiptFixture();
  const raw = JSON.stringify({ ...document, empty: [] });
  const values = new Map([[store.key("work-receipt", run.receiptId), raw], [store.key("work-receipt-session", run.runId), raw]]);
  store.connect = async () => {};
  store.client = {
    get: async (key) => values.get(key),
    eval: async (script, { keys, arguments: args }) => {
      assert.doesNotMatch(script, /cjson.encode/u, "Lua must not re-encode signed payloads");
      assert.match(script, /current ~= ARGV\[1\]/u);
      if (values.get(keys[0]) !== args[0]) return values.get(keys[0]);
      values.set(keys[0], args[1]);
      if (JSON.parse(values.get(keys[1])).receiptId === args[2]) values.set(keys[1], args[1]);
      return args[1];
    }
  };
  const signature = await f.signer.signDocument(JSON.parse(raw));
  const signed = await store.setWorkReceiptDocumentSignature(run.receiptId, signature, run.runId);
  assert.equal(verifyBadgeReceiptSignature(signed, f.jwk), true);
  assert.deepEqual(await store.getWorkReceiptDocumentBySession(run.runId), signed);
  assert.deepEqual(await store.setWorkReceiptDocumentSignature(run.receiptId, { invalid: true }, run.runId), signed);
});
