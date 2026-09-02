import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDisputeOutcomeRationale,
  buildSessionOutcomeRationale,
  formatReasonCode,
  isNegativeSessionState,
} from "./outcome-rationale.js";

test("formatReasonCode humanizes verifier and dispute reason codes", () => {
  assert.equal(formatReasonCode("reason:BENCHMARK_THRESHOLD_MISSED"), "Benchmark Threshold Missed");
  assert.equal(formatReasonCode("human-review-required"), "Human Review Required");
  assert.equal(formatReasonCode(""), "");
});

test("isNegativeSessionState only flags terminal/contested negative session states", () => {
  assert.equal(isNegativeSessionState("rejected"), true);
  assert.equal(isNegativeSessionState("disputed"), true);
  assert.equal(isNegativeSessionState("slashed"), true);
  assert.equal(isNegativeSessionState("approved"), false);
  assert.equal(isNegativeSessionState("settled"), false);
});

test("buildSessionOutcomeRationale cites verifier policy and receipt for rejected sessions", () => {
  const rationale = buildSessionOutcomeRationale({
    state: "rejected",
    sessionId: "session-1",
    policy: "schema://jobs/dependency-remediation-output",
    statusHistory: [],
    verification: {
      outcome: "rejected",
      reasonCode: "BENCHMARK_THRESHOLD_MISSED",
      handler: "benchmark",
      verifierPolicyVersion: 4,
    },
    verifierHref: "/session/timeline?sessionId=session-1",
  });

  assert.deepEqual(rationale, {
    tone: "bad",
    statusLabel: "Rejected",
    reason: "Benchmark Threshold Missed",
    reasonCode: "BENCHMARK_THRESHOLD_MISSED",
    detail: undefined,
    policyLabel: "benchmark policy v4",
    policyHref: "/policies",
    receiptLabel: "verification receipt",
    receiptHref: "/session/timeline?sessionId=session-1",
    summary: "Rejected by Benchmark Threshold Missed",
    sourceId: "session-1",
  });
});

test("buildSessionOutcomeRationale uses dispute metadata for disputed/slashed sessions", () => {
  const rationale = buildSessionOutcomeRationale({
    state: "disputed",
    sessionId: "session-2",
    policy: "schema pending",
    statusHistory: [
      {
        to: "submitted",
        reason: "worker_submitted",
      },
      {
        to: "disputed",
        reason: "verification_contested",
        metadata: {
          disputeId: "dispute-session-2",
          reasonCode: "HUMAN_REVIEW_REQUIRED",
          handler: "human_fallback",
          verifierPolicyVersion: 2,
        },
      },
    ],
    verificationSummary: {
      outcome: "needs_review",
    },
    disputeHref: "/disputes?sessionId=session-2",
    verifierHref: "/session/timeline?sessionId=session-2",
  });

  assert.equal(rationale.tone, "warn");
  assert.equal(rationale.statusLabel, "Disputed");
  assert.equal(rationale.reason, "Human Review Required");
  assert.equal(rationale.policyLabel, "human fallback policy v2");
  assert.equal(rationale.receiptLabel, "dispute dispute-session-2");
  assert.equal(rationale.receiptHref, "/disputes?sessionId=session-2");
});

test("buildSessionOutcomeRationale returns null for non-negative session states", () => {
  assert.equal(
    buildSessionOutcomeRationale({
      state: "approved",
      sessionId: "session-3",
      policy: "schema://jobs/ok",
    }),
    null
  );
});

test("buildDisputeOutcomeRationale links open disputes back to the session receipt", () => {
  const rationale = buildDisputeOutcomeRationale({
    state: "open",
    origin: "schema",
    openingReceipt: "dispute-opened-1",
    sessionId: "session-4",
    reasonCode: "SCHEMA_MISMATCH",
  });

  assert.equal(rationale.tone, "warn");
  assert.equal(rationale.statusLabel, "Disputed");
  assert.equal(rationale.reason, "Schema Mismatch");
  assert.equal(rationale.policyLabel, "Schema policy");
  assert.equal(rationale.receiptLabel, "dispute-opened-1");
  assert.equal(rationale.receiptHref, "/session/timeline?sessionId=session-4");
});

test("buildDisputeOutcomeRationale surfaces resolved verdict rationale and reasoning receipt", () => {
  const rationale = buildDisputeOutcomeRationale({
    state: "resolved",
    origin: "policy-violation",
    openingReceipt: "dispute-opened-2",
    resolution: {
      decision: "uphold",
      reasonCode: "DISPUTE_LOST",
      reasoningHash: "0x1234567890abcdef1234",
      rationale: "Verifier evidence prevailed; worker stake slashed.",
    },
  });

  assert.equal(rationale.tone, "bad");
  assert.equal(rationale.statusLabel, "Upheld");
  assert.equal(rationale.reason, "Dispute Lost");
  assert.equal(rationale.detail, "Verifier evidence prevailed; worker stake slashed.");
  assert.equal(rationale.receiptLabel, "reasoning 0x123456...1234");
});
