import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVerifierOutput,
  LOCKED_VERIFIER_MESSAGE,
  NO_SESSION_VERIFIER_MESSAGE,
} from "./verifier-output.js";

const base = {
  verifierMode: "benchmark",
  claimState: "claimable",
  sessionPresence: "live",
  sessionTimelinePresence: "live",
  verifierResultPresence: "live",
  badgePresence: "live",
  jobTimelinePresence: "live",
};

test("unclaimed runs render a plain no-session state", () => {
  const output = buildVerifierOutput(base);
  assert.equal(output.kind, "empty");
  assert.equal(output.message, NO_SESSION_VERIFIER_MESSAGE);
});

test("submitted sessions render awaiting without confidence numbers", () => {
  const output = buildVerifierOutput({
    ...base,
    sessionId: "session-1",
    claimState: "submitted",
    verifierResultPayload: {
      status: "verifying",
      sessionId: "session-1",
      sessionStatus: "submitted",
      awaitingSince: "2026-07-09T10:12:00.000Z",
    },
  });
  assert.equal(output.kind, "awaiting");
  assert.equal(output.verdict.status, "Awaiting verification");
  assert.equal(output.verdict.score, "—");
  assert.equal(output.verdict.scoreLabel, "no verdict yet");
  assert.equal(JSON.stringify(output).includes("confidence"), false);
});

test("approved sessions use real verifier and badge references", () => {
  const output = buildVerifierOutput({
    ...base,
    sessionId: "session-2",
    claimState: "submitted",
    verifierResultPayload: {
      outcome: "approved",
      reasonCode: "AUTO_VERIFIER_PASS",
      handler: "benchmark",
      handlerVersion: "v1",
      session: {
        resolvedAt: "2026-07-09T10:20:00.000Z",
      },
    },
    badgePayload: {
      averray: {
        sessionId: "session-2",
        verifierMode: "benchmark",
        completedAt: "2026-07-09T10:20:01.000Z",
        evidenceHash: "0xabc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd",
        chainJobId: "0xdef456def456def456def456def456def456def456def456def456def456def0",
      },
    },
  });
  assert.equal(output.kind, "terminal");
  assert.equal(output.verdict.status, "Approved");
  assert.equal(output.receiptRef, "/badges/session-2");
  assert.equal(output.verdict.score, "AUTO_VERIFIER_PASS");
  assert.match(output.lines.at(-1).message, /\/badges\/session-2/u);
});

test("summary-only rejected sessions render rejected, not approved", () => {
  const output = buildVerifierOutput({
    ...base,
    sessionId: "session-rejected",
    claimState: "submitted",
    sessionPayload: {
      verificationSummary: {
        outcome: "rejected",
        reasonCode: "BENCHMARK_FAILED",
        handler: "benchmark",
        handlerVersion: "v2",
      },
      resolvedAt: "2026-07-09T11:20:00.000Z",
    },
  });

  assert.equal(output.kind, "terminal");
  assert.equal(output.outcome, "rejected");
  assert.equal(output.verdict.status, "Rejected");
  assert.equal(output.verdict.score, "BENCHMARK_FAILED");
  assert.match(
    output.lines.find((line) => line.label === "verdict")?.message ?? "",
    /Rejected/u
  );
});

test("locked admin/session feeds are explicit when no public result is available", () => {
  const output = buildVerifierOutput({
    ...base,
    sessionId: "session-3",
    verifierResultPayload: { status: "not_found" },
    sessionPresence: "locked",
    sessionTimelinePresence: "locked",
    jobTimelinePresence: "locked",
  });
  assert.equal(output.kind, "locked");
  assert.equal(output.message, LOCKED_VERIFIER_MESSAGE);
});
