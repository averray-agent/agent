import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import canonicalize from "canonicalize";

import {
  BADGE_RECEIPT_KID,
  BADGE_RECEIPT_TYP,
  receiptHasSignature,
  selectCanonicalReceiptDocument,
  verifyReceiptSignature,
} from "./receipt-signature-verification.js";

const SIGNED_AT = "2026-07-12T12:00:00.000Z";

test("badge receipts render verified, failed after mutation, and unsigned legacy states", async () => {
  const fixture = await signedFixture(badgeDocument());

  assert.deepEqual(await verify(fixture.document, fixture.jwk), {
    state: "verified",
    kid: BADGE_RECEIPT_KID,
    signedAt: SIGNED_AT,
  });
  assert.deepEqual(
    await verify({
      ...fixture.document,
      averray: { ...fixture.document.averray, category: "tampered" },
    }, fixture.jwk),
    { state: "failed", error: "Signature does not match the canonical receipt document." }
  );
  assert.deepEqual(await verify(badgeDocument(), fixture.jwk), { state: "unsigned" });
});

test("run receipts render verified, failed after mutation, and unsigned legacy states", async () => {
  const fixture = await signedFixture(runDocument());

  assert.deepEqual(await verify(fixture.document, fixture.jwk), {
    state: "verified",
    kid: BADGE_RECEIPT_KID,
    signedAt: SIGNED_AT,
  });
  assert.deepEqual(
    await verify({
      ...fixture.document,
      verdict: { ...fixture.document.verdict, outcome: "approved" },
    }, fixture.jwk),
    { state: "failed", error: "Signature does not match the canonical receipt document." }
  );
  assert.deepEqual(await verify(runDocument(), fixture.jwk), { state: "unsigned" });
});

test("protected signedAt mismatch is a failed alarm state", async () => {
  const fixture = await signedFixture(runDocument());
  const document = {
    ...fixture.document,
    signature: { ...fixture.document.signature, signedAt: "2026-07-12T12:00:01.000Z" },
  };

  assert.deepEqual(await verify(document, fixture.jwk), {
    state: "failed",
    error: "Protected header does not integrity-bind alg, kid, typ, and signedAt.",
  });
});

test("canonical target selection never verifies a run list-row wrapper", () => {
  const embeddedRun = { ...runDocument(), signature: { kid: BADGE_RECEIPT_KID } };
  const listWrapper = {
    kind: "run",
    verdict: "rejected",
    signature: { kid: "wrapper-footgun" },
    runReceipt: embeddedRun,
  };
  const badgeDetail = { ...badgeDocument(), signature: { kid: BADGE_RECEIPT_KID } };

  assert.equal(selectCanonicalReceiptDocument({
    kind: "run",
    listRow: listWrapper,
    detailDocument: { wrong: "run detail is not the selected source" },
  }), embeddedRun);
  assert.equal(selectCanonicalReceiptDocument({
    kind: "badge",
    listRow: { badge: { wrong: "list badge wrapper" } },
    detailDocument: badgeDetail,
  }), badgeDetail);
  assert.equal(receiptHasSignature(badgeDetail), true);
  assert.equal(receiptHasSignature(badgeDocument()), false);
});

async function verify(document, jwk) {
  return verifyReceiptSignature({
    document,
    cryptoImpl: webcrypto,
    jwksUrl: "https://api.averray.test/.well-known/badge-receipt-jwks.json",
    fetchImpl: async () => ({ ok: true, async json() { return { keys: [jwk] }; } }),
  });
}

async function signedFixture(unsignedDocument) {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  Object.assign(jwk, { alg: "ES256", kid: BADGE_RECEIPT_KID, use: "sig" });
  const protectedHeader = {
    alg: "ES256",
    kid: BADGE_RECEIPT_KID,
    signedAt: SIGNED_AT,
    typ: BADGE_RECEIPT_TYP,
  };
  const protectedSegment = base64url(new TextEncoder().encode(canonicalize(protectedHeader)));
  const payloadSegment = base64url(new TextEncoder().encode(canonicalize(unsignedDocument)));
  const signingInput = new TextEncoder().encode(`${protectedSegment}.${payloadSegment}`);
  const signatureBytes = new Uint8Array(await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    signingInput
  ));
  assert.equal(signatureBytes.byteLength, 64, "WebCrypto fixture must emit raw ES256 R||S");

  return {
    jwk,
    document: {
      ...unsignedDocument,
      signature: {
        alg: "ES256",
        kid: BADGE_RECEIPT_KID,
        sig: `${protectedSegment}..${base64url(signatureBytes)}`,
        signedAt: SIGNED_AT,
      },
    },
  };
}

function badgeDocument() {
  return {
    name: "Averray Agent Badge",
    averray: {
      schemaVersion: "averray.agent-badge.v1",
      sessionId: "badge-session",
      category: "coding",
      level: 1,
    },
    signers: [],
  };
}

function runDocument() {
  return {
    schemaVersion: "averray.run-receipt.v1",
    kind: "run",
    sessionId: "run-session",
    jobId: "run-job",
    worker: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    verifier: { mode: "benchmark", handler: "benchmark", version: 1 },
    verdict: {
      outcome: "rejected",
      reasonCode: "BENCHMARK_THRESHOLD_MISSED",
      evidenceHash: `0x${"1".repeat(64)}`,
      policyTags: [],
    },
    timestamps: {
      claimedAt: "2026-07-12T11:58:00.000Z",
      submittedAt: "2026-07-12T11:59:00.000Z",
      verifiedAt: SIGNED_AT,
    },
    signers: [],
  };
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
