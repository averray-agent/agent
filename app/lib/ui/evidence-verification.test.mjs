import test from "node:test";
import assert from "node:assert/strict";

import { privateKeyToAccount } from "viem/accounts";

import {
  buildAuditManifestPayload,
  buildPolicyManifestPayload,
  buildSessionManifestPayload,
  buildEvidenceSignatureMessage,
  buildManifestEnvelope,
  canonicalJson,
  hashEvidencePreview,
  verifyEvidenceSignature,
  verifyManifestEnvelope,
} from "./evidence-verification.js";

const C3_FIXTURE_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f09453806c0d124859ac7f79bf9e8cb39a919b2b";
const C3_RECEIPT_ID = "r_c3_real_receipt_001";
const C3_AUDIT_EVENT_ID = "audit-c3-manifest-001";

test("canonicalJson sorts object keys recursively", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [{ d: 4, c: 5 }] }),
    canonicalJson({ list: [{ c: 5, d: 4 }], a: { b: 3, y: 2 }, z: 1 })
  );
});

test("verifyEvidenceSignature accepts a real EVM signature for the displayed receipt evidence", async () => {
  const account = privateKeyToAccount(C3_FIXTURE_PRIVATE_KEY);
  const evidenceJson = c3EvidencePreview({ verdict: "approved" });
  const payloadHash = hashEvidencePreview(evidenceJson);
  const message = buildEvidenceSignatureMessage({
    receiptId: C3_RECEIPT_ID,
    payloadHash,
  });
  const signature = await account.signMessage({ message });

  const result = await verifyEvidenceSignature({
    receiptId: C3_RECEIPT_ID,
    evidenceJson,
    envelope: JSON.stringify({
      type: "averray.receipt.signature.v1",
      receiptId: C3_RECEIPT_ID,
      signer: account.address,
      payloadHash,
      signature,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.signer, account.address);
  assert.equal(result.payloadHash, payloadHash);
  assert.equal(result.receiptId, C3_RECEIPT_ID);
});

test("verifyEvidenceSignature rejects a signature envelope when the evidence changes", async () => {
  const account = privateKeyToAccount(C3_FIXTURE_PRIVATE_KEY);
  const originalEvidence = c3EvidencePreview({ verdict: "approved" });
  const payloadHash = hashEvidencePreview(originalEvidence);
  const message = buildEvidenceSignatureMessage({
    receiptId: C3_RECEIPT_ID,
    payloadHash,
  });
  const signature = await account.signMessage({ message });

  const result = await verifyEvidenceSignature({
    receiptId: C3_RECEIPT_ID,
    evidenceJson: c3EvidencePreview({ verdict: "tampered" }),
    envelope: {
      type: "averray.receipt.signature.v1",
      receiptId: C3_RECEIPT_ID,
      signer: account.address,
      payloadHash,
      signature,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Evidence hash mismatch/u);
});

test("verifyManifestEnvelope verifies an audit manifest fixture and detects tampering", () => {
  const payload = buildAuditManifestPayload([
    {
      id: C3_AUDIT_EVENT_ID,
      at: "12:00:01",
      day: "2026-05-30",
      source: "operator",
      category: "runs",
      action: "receipt.signature.verified",
      actor: { handle: "operator", address: "0x6778F050eAc8313e4dbB176d7BAB44510E833ac8" },
      summary: "C3 fixture audit event",
      target: C3_RECEIPT_ID,
      hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    },
  ]);
  const envelope = buildManifestEnvelope(payload);
  const verified = verifyManifestEnvelope(envelope);

  assert.equal(verified.ok, true);
  assert.equal(verified.entryCount, 1);
  assert.equal(verified.manifestType, "averray.audit.manifest.v1");

  const tampered = verifyManifestEnvelope({
    ...envelope,
    payload: {
      ...payload,
      entries: [{ ...payload.entries[0], action: "receipt.signature.tampered" }],
    },
  });
  assert.equal(tampered.ok, false);
  assert.match(tampered.error, /Manifest hash mismatch/u);
});

test("session audit bundles use a verifiable manifest over the current view", () => {
  const payload = buildSessionManifestPayload([
    {
      id: "session-1",
      runRef: "job-1",
      state: "claimed",
      job: { title: "Review", meta: "job-1" },
      worker: { handle: "agent-1", address: "0x1234" },
      escrow: { amount: "0", asset: "USDC" },
      verifierMode: "benchmark",
      openedAt: "Jul 10, 06:00 AM",
      policy: "schema-v1",
      lastEvent: { text: "Session claimed", meta: "Jul 10" },
    },
  ]);
  const envelope = buildManifestEnvelope(payload);
  const verified = verifyManifestEnvelope(envelope);

  assert.equal(verified.ok, true);
  assert.equal(verified.entryCount, 1);
  assert.equal(verified.manifestType, "averray.sessions.manifest.v1");

  const tampered = verifyManifestEnvelope({
    ...envelope,
    payload: {
      ...payload,
      entries: [{ ...payload.entries[0], state: "resolved" }],
    },
  });
  assert.equal(tampered.ok, false);
  assert.match(tampered.error, /Manifest hash mismatch/u);
});

test("policy bundles use a verifiable manifest over the current view", () => {
  const payload = buildPolicyManifestPayload([
    {
      id: "policy-1",
      tag: "settle/receipt-before-payout@v1",
      scope: "settle",
      severity: "hard-stop",
      state: "Active",
      revision: 1,
      handler: "settlement/receipt_gate.ts",
      gates: "Receipt required",
      signersReq: 2,
      signersTotal: 3,
      approvals: [
        { role: "operator", addr: "0x1234", state: "signed", at: "2026-07-10" },
      ],
      rule: { v1: "require receipt" },
      lastChange: { text: "Initial gate", author: "fd2e", at: "2026-07-10" },
    },
  ]);
  const envelope = buildManifestEnvelope(payload);
  const verified = verifyManifestEnvelope(envelope);

  assert.equal(verified.ok, true);
  assert.equal(verified.entryCount, 1);
  assert.equal(verified.manifestType, "averray.policies.manifest.v1");

  const tampered = verifyManifestEnvelope({
    ...envelope,
    payload: {
      ...payload,
      entries: [{ ...payload.entries[0], state: "Retired" }],
    },
  });
  assert.equal(tampered.ok, false);
  assert.match(tampered.error, /Manifest hash mismatch/u);
});

function c3EvidencePreview({ verdict }) {
  return `// signed JSON - first 40 lines
${JSON.stringify(
    {
      averray: {
        sessionId: "session-c3-real-receipt-001",
        evidenceHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        worker: "0x000000000000000000000000000000000000c3c3",
        verifier: "0x000000000000000000000000000000000000b0b0",
        verdict,
      },
    },
    null,
    2
  )}`;
}
