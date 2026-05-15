import test from "node:test";
import assert from "node:assert/strict";

import { claimExpiresAt, isExpiredClaim, summarizeJobClaimState } from "./claim-state.js";

const CLAIMED_SESSION = {
  sessionId: "job-001:0xabc",
  jobId: "job-001",
  wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  status: "claimed",
  claimedAt: "2026-05-01T10:00:00.000Z"
};

const JOB = {
  id: "job-001",
  lifecycle: { state: "open" },
  claimTtlSeconds: 60,
  retryLimit: 2
};

test("claim expiry follows the escrow timeout boundary at the exact deadline", () => {
  assert.equal(
    claimExpiresAt(CLAIMED_SESSION, JOB),
    "2026-05-01T10:01:00.000Z"
  );
  assert.equal(isExpiredClaim(CLAIMED_SESSION, JOB, new Date("2026-05-01T10:01:00.000Z")), false);
  assert.equal(isExpiredClaim(CLAIMED_SESSION, JOB, new Date("2026-05-01T10:01:00.001Z")), true);
});

test("claim expiry prefers the canonical on-chain claimExpiry when present", () => {
  const session = {
    ...CLAIMED_SESSION,
    chainClaimExpiresAt: "2026-05-01T10:00:45.000Z"
  };

  assert.equal(claimExpiresAt(session, JOB), "2026-05-01T10:00:45.000Z");
  assert.equal(isExpiredClaim(session, JOB, new Date("2026-05-01T10:00:45.000Z")), false);
  assert.equal(isExpiredClaim(session, JOB, new Date("2026-05-01T10:00:45.001Z")), true);
});

test("summarizeJobClaimState uses chain expiry before local claimedAt ttl", () => {
  const status = summarizeJobClaimState({
    job: JOB,
    session: {
      ...CLAIMED_SESSION,
      chainClaimExpiresAt: "2026-05-01T10:00:45.000Z"
    },
    sessions: [CLAIMED_SESSION],
    now: new Date("2026-05-01T10:00:46.000Z")
  });

  assert.equal(status.claimState, "expired");
  assert.equal(status.effectiveState, "claimable");
  assert.equal(status.claimExpiresAt, "2026-05-01T10:00:45.000Z");
});
