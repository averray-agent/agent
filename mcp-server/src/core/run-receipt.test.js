import assert from "node:assert/strict";
import test from "node:test";

import { buildRunReceipt, RUN_RECEIPT_SCHEMA_VERSION } from "./run-receipt.js";

const WORKER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SERVICE_SIGNER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function fixture(overrides = {}) {
  const outcome = overrides.outcome ?? "approved";
  return buildRunReceipt({
    session: {
      sessionId: `session-${outcome}`,
      jobId: `job-${outcome}`,
      chainJobId: `0x${"1".repeat(64)}`,
      wallet: WORKER,
      claimedAt: "2026-07-12T10:00:00.000Z",
      submittedAt: "2026-07-12T10:05:00.000Z",
      ...(outcome === "approved"
        ? { resolvedAt: "2026-07-12T10:06:00.000Z" }
        : { rejectedAt: "2026-07-12T10:06:00.000Z" })
    },
    job: {
      verifierMode: "benchmark",
      verification: { receiptPolicyTag: "receipt/operator-verifier-cosign@v1" }
    },
    verification: {
      outcome,
      reasonCode: outcome === "approved" ? "BENCHMARK_THRESHOLD_MET" : "BENCHMARK_THRESHOLD_MISSED",
      handler: "benchmark",
      handlerVersion: 1,
      verificationInputHash: `0x${"2".repeat(64)}`
    },
    context: {
      publicBaseUrl: "https://api.averray.com",
      posterAddress: SERVICE_SIGNER,
      verifierAddress: SERVICE_SIGNER
    }
  });
}

test("buildRunReceipt captures an approved verdict without claiming reputation", () => {
  const receipt = fixture();
  assert.equal(receipt.schemaVersion, RUN_RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.kind, "run");
  assert.equal(receipt.verdict.outcome, "approved");
  assert.equal(receipt.verdict.evidenceHash, `0x${"2".repeat(64)}`);
  assert.deepEqual(receipt.verdict.policyTags, ["receipt/operator-verifier-cosign@v1"]);
  assert.deepEqual(receipt.signers.map((entry) => entry.role), ["operator", "verifier", "worker"]);
  assert.equal(receipt.canonicalUrl, "https://api.averray.com/badges/session-approved/run");
  assert.match(receipt.attestation, /does not attest reputation/u);
});

test("buildRunReceipt captures rejected verdicts with the rejection timestamp", () => {
  const receipt = fixture({ outcome: "rejected" });
  assert.equal(receipt.verdict.outcome, "rejected");
  assert.equal(receipt.timestamps.verifiedAt, "2026-07-12T10:06:00.000Z");
  assert.equal(receipt.signers.find((entry) => entry.role === "verifier").at, receipt.timestamps.verifiedAt);
});

test("buildRunReceipt refuses pending, expired, and never-claimed states", () => {
  assert.throws(
    () => buildRunReceipt({ session: { sessionId: "pending", jobId: "job", wallet: WORKER }, verification: {} }),
    /approved or rejected verdict/u
  );
  assert.throws(
    () => buildRunReceipt({
      session: { sessionId: "expired", jobId: "job", wallet: WORKER, expiredAt: "2026-07-12T10:00:00.000Z" },
      verification: { outcome: "rejected" }
    }),
    /session\.claimedAt/u
  );
});
