import test from "node:test";
import assert from "node:assert/strict";

import {
  ARBITRATOR_SLA_SECONDS,
  buildDisputeReasoningReceipt,
  buildDisputeResolution,
  normalizeDisputeReleaseRequestPayload,
  normalizeDisputeVerdict,
  normalizeDisputeVerdictRequestPayload,
  publicContentUri
} from "./dispute-resolution.js";
import { ValidationError } from "./errors.js";

test("buildDisputeResolution maps upheld disputes to zero-payout dispute loss", () => {
  const result = buildDisputeResolution({ verdict: "upheld", remainingPayout: 5 });

  assert.equal(result.workerPayout, 0);
  assert.equal(result.reasonCode, "DISPUTE_LOST");
  assert.equal(result.nextSessionStatus, "rejected");
  assert.equal(result.releaseAction, "slash-to-treasury");
});

test("buildDisputeResolution maps dismissed disputes to full worker payout", () => {
  const result = buildDisputeResolution({ verdict: "dismissed", remainingPayout: 5 });

  assert.equal(result.workerPayout, 5);
  assert.equal(result.reasonCode, "DISPUTE_OVERTURNED");
  assert.equal(result.nextSessionStatus, "resolved");
});

test("buildDisputeResolution supports operator-supplied partial payouts", () => {
  const result = buildDisputeResolution({ verdict: "split", remainingPayout: 7, workerPayout: 3 });

  assert.equal(result.workerPayout, 3);
  assert.equal(result.reasonCode, "DISPUTE_PARTIAL");
  assert.equal(result.payoutSource, "operator_supplied");
});

test("buildDisputeResolution has a timeout-shaped worker-favorable outcome", () => {
  const result = buildDisputeResolution({ verdict: "timeout", remainingPayout: 9 });

  assert.equal(result.workerPayout, 9);
  assert.equal(result.reasonCode, "ARB_TIMEOUT");
  assert.equal(result.nextSessionStatus, "resolved");
  assert.equal(ARBITRATOR_SLA_SECONDS, 14 * 24 * 60 * 60);
});

test("normalizeDisputeVerdict rejects unknown values", () => {
  assert.throws(
    () => normalizeDisputeVerdict("maybe"),
    (error) => error instanceof ValidationError && /verdict must be/u.test(error.message)
  );
});

test("normalizeDisputeVerdictRequestPayload folds synonyms so equivalent retries replay", () => {
  const a = normalizeDisputeVerdictRequestPayload("dispute-1", {
    verdict: "uphold",
    payoutAmount: "0",
    rationale: "  spaced  ",
    metadataURI: " urn:averray:content:0xabc "
  });
  const b = normalizeDisputeVerdictRequestPayload("dispute-1", {
    outcome: "UPHELD",
    workerPayout: 0,
    rationale: "spaced",
    metadataURI: "urn:averray:content:0xabc"
  });

  assert.deepEqual(a, {
    disputeId: "dispute-1",
    verdict: "upheld",
    workerPayout: 0,
    rationale: "spaced",
    reasoningHash: undefined,
    metadataURI: "urn:averray:content:0xabc"
  });
  assert.deepEqual(a, b);
});

test("normalizeDisputeVerdictRequestPayload preserves unknown verdict tokens for upstream validation", () => {
  const projected = normalizeDisputeVerdictRequestPayload("dispute-2", { verdict: "not-a-real-verdict" });
  assert.equal(projected.verdict, "not-a-real-verdict");
});

test("normalizeDisputeReleaseRequestPayload falls back to the dispute's staked amount", () => {
  const projected = normalizeDisputeReleaseRequestPayload(
    "dispute-3",
    { stakedAmount: 1.5 },
    { action: "release" }
  );
  assert.deepEqual(projected, { disputeId: "dispute-3", action: "release", amount: 1.5 });
});

test("normalizeDisputeReleaseRequestPayload defaults missing action to 'release'", () => {
  const projected = normalizeDisputeReleaseRequestPayload(
    "dispute-4",
    { stakedAmount: 0.25 },
    { amount: "0.5" }
  );
  assert.deepEqual(projected, { disputeId: "dispute-4", action: "release", amount: 0.5 });
});

test("publicContentUri prefers PUBLIC_BASE_URL when supplied, falls back to urn form", () => {
  const hash = "0x".padEnd(66, "a");
  assert.equal(
    publicContentUri(hash, { publicBaseUrl: "https://api.averray.com/" }),
    `https://api.averray.com/content/${hash}`
  );
  assert.equal(publicContentUri(hash), `urn:averray:content:${hash}`);
  assert.equal(publicContentUri("not-a-hash"), "");
});

test("buildDisputeReasoningReceipt produces a deterministic content-addressed reasoning record", () => {
  const id = "dispute-5";
  const dispute = { sessionId: "session-5", claimant: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const auth = { wallet: "0x9999999999999999999999999999999999999999" };
  const decidedAt = "2026-05-14T12:00:00.000Z";

  const first = buildDisputeReasoningReceipt({
    id,
    dispute,
    payload: { rationale: " upstream PR merged " },
    auth,
    verdict: "dismissed",
    decidedAt,
    publicBaseUrl: "https://api.averray.test"
  });
  const second = buildDisputeReasoningReceipt({
    id,
    dispute,
    payload: { rationale: "upstream PR merged" },
    auth,
    verdict: "dismissed",
    decidedAt,
    publicBaseUrl: "https://api.averray.test"
  });

  assert.match(first.reasoningHash, /^0x[a-f0-9]{64}$/u);
  assert.equal(first.reasoningHash, second.reasoningHash);
  assert.equal(first.metadataURI, `https://api.averray.test/content/${first.reasoningHash}`);
  assert.equal(first.contentRecord.contentType, "arbitrator_reasoning");
  assert.equal(first.contentRecord.ownerWallet, dispute.claimant);
  assert.equal(first.rationale, "upstream PR merged");
});

test("buildDisputeReasoningReceipt marks an upheld verdict's content record as a failure outcome", () => {
  const result = buildDisputeReasoningReceipt({
    id: "dispute-6",
    dispute: { sessionId: "session-6", claimant: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    payload: { rationale: "evidence insufficient" },
    auth: { wallet: "0x9999999999999999999999999999999999999999" },
    verdict: "upheld",
    decidedAt: "2026-05-14T12:00:00.000Z"
  });
  assert.equal(result.contentRecord.verdict, "fail");
});

test("buildDisputeReasoningReceipt rejects a caller-supplied reasoningHash that disagrees with the canonical hash", () => {
  assert.throws(
    () => buildDisputeReasoningReceipt({
      id: "dispute-7",
      dispute: { sessionId: "session-7", claimant: "0xcccccccccccccccccccccccccccccccccccccccc" },
      payload: { rationale: "x", reasoningHash: "0x".padEnd(66, "f") },
      auth: { wallet: "0x9999999999999999999999999999999999999999" },
      verdict: "dismissed",
      decidedAt: "2026-05-14T12:00:00.000Z"
    }),
    (error) => error instanceof ValidationError && /reasoningHash does not match/u.test(error.message)
  );
});

test("buildDisputeReasoningReceipt honors an explicit metadataURI override", () => {
  const result = buildDisputeReasoningReceipt({
    id: "dispute-8",
    dispute: { sessionId: "session-8", claimant: "0xdddddddddddddddddddddddddddddddddddddddd" },
    payload: { rationale: "x", metadataURI: "ipfs://Qm.../reasoning.json" },
    auth: { wallet: "0x9999999999999999999999999999999999999999" },
    verdict: "dismissed",
    decidedAt: "2026-05-14T12:00:00.000Z"
  });
  assert.equal(result.metadataURI, "ipfs://Qm.../reasoning.json");
});
