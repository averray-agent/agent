import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import { MemoryStateStore, RedisStateStore } from "../core/state-store.js";
import { canonicalBadgeReceiptBytes, KmsBadgeReceiptSigner, verifyBadgeReceiptSignature } from "../core/badge-receipt-signing.js";
import { VerificationRunService } from "./verification-run-service.js";
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
  assert.deepEqual(first.verify, { scanned: 3, signed: 3, alreadySigned: 0 });
  for (const { run, document } of originals) {
    const stored = await store.getWorkReceiptDocument(run.receiptId);
    assert.equal(verifyBadgeReceiptSignature(stored, f.jwk), true);
    assert.deepEqual(canonicalBadgeReceiptBytes(stored), canonicalBadgeReceiptBytes(document));
    assert.deepEqual(await store.getWorkReceiptDocumentBySession(run.runId), stored);
    assert.deepEqual(await store.getRunReceiptDocument(run.runId), stored);
  }
  const second = await backfillBadgeReceiptSignatures({ stateStore: store, signer: f.signer, pageSize: 2, logger: {} });
  assert.deepEqual(second.verify, { scanned: 3, signed: 0, alreadySigned: 3 });
  assert.equal(f.signs(), 3);
  store.workReceiptDocuments.get(originals[0].run.receiptId).verdict.reasonCode = "tampered";
  await assert.rejects(backfillBadgeReceiptSignatures({ stateStore: store, signer: f.signer, logger: {} }), /invalid signature/);
});

test("X1b signer failures never persist an unsigned Verify receipt", async () => {
  const store = new MemoryStateStore();
  await assert.rejects(receiptFixture({ store, signer: { signDocument: async () => { throw new Error("sign failed"); } } }), /sign failed/);
  assert.deepEqual((await store.scanWorkReceiptDocuments()).documents, []);
});

test("X1b shelf receives the same bootstrap badge signer", async () => {
  const f = await signingFixture();
  const shelf = await createVerificationShelf({ stateStore: new MemoryStateStore(), badgeReceiptSigner: f.signer, env: {}, logger: {} });
  assert.equal(shelf.verificationRunService.badgeReceiptSigner, f.signer);
  const bootstrap = readFileSync(new URL("./bootstrap.js", import.meta.url), "utf8");
  assert.match(bootstrap, /createVerificationShelf\(\{[\s\S]*?paymentGate: verificationPaymentGate,\s*badgeReceiptSigner,/u);
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
