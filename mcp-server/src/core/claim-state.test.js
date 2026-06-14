import test from "node:test";
import assert from "node:assert/strict";

import { claimExpiresAt, countClaimAttempts, isExpiredClaim, summarizeJobClaimState } from "./claim-state.js";

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

const OPEN_JOB = { id: "job-fund", lifecycle: { state: "open" }, retryLimit: 2 };
const WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("ingestion-prefund pending job is never advertised claimable (no session)", () => {
  const status = summarizeJobClaimState({
    job: { ...OPEN_JOB, funding: { source: "ingestion_prefund", state: "pending" } },
    wallet: WALLET
  });
  assert.equal(status.claimable, false);
  assert.equal(status.currentWalletCanClaim, false);
  assert.equal(status.reason, "reward_funding_pending");
  assert.equal(status.fundingState, "pending");
  assert.notEqual(status.effectiveState, "claimable");
});

test("ingestion-prefund pending job is null (not false) when no wallet is supplied", () => {
  const status = summarizeJobClaimState({
    job: { ...OPEN_JOB, funding: { source: "ingestion_prefund", state: "pending" } }
  });
  assert.equal(status.claimable, false);
  assert.equal(status.currentWalletCanClaim, null);
  assert.equal(status.reason, "reward_funding_pending");
});

test("ingestion-prefund funded job behaves exactly like a normal open job", () => {
  const status = summarizeJobClaimState({
    job: { ...OPEN_JOB, funding: { source: "ingestion_prefund", state: "funded" } },
    wallet: WALLET
  });
  assert.equal(status.claimable, true);
  assert.equal(status.currentWalletCanClaim, true);
  assert.equal(status.reason, "claimable");
  assert.equal(status.fundingState, "funded");
  assert.equal(status.effectiveState, "claimable");
});

test("a job with no funding field is unaffected by the gate (no regression)", () => {
  const status = summarizeJobClaimState({ job: OPEN_JOB, wallet: WALLET });
  assert.equal(status.claimable, true);
  assert.equal(status.reason, "claimable");
  assert.equal(status.fundingState, undefined);
});

test("the gate is scoped to ingestion_prefund — recurring reserve jobs stay claimable", () => {
  const status = summarizeJobClaimState({
    job: {
      ...OPEN_JOB,
      funding: { source: "recurring_template_reserve", state: "pending", wallet: WALLET, templateId: "tpl-1" }
    },
    wallet: WALLET
  });
  assert.equal(status.claimable, true);
  assert.equal(status.fundingState, undefined);
});

test("expired claim on an unfunded prefund job never re-advertises as claimable", () => {
  const expiredSession = {
    sessionId: "job-fund:0xexpired",
    jobId: "job-fund",
    wallet: WALLET,
    status: "claimed",
    claimedAt: "2026-05-01T10:00:00.000Z",
    chainClaimExpiresAt: "2026-05-01T10:00:30.000Z"
  };
  const status = summarizeJobClaimState({
    job: { ...OPEN_JOB, claimTtlSeconds: 30, funding: { source: "ingestion_prefund", state: "pending" } },
    session: expiredSession,
    sessions: [expiredSession],
    wallet: WALLET,
    now: new Date("2026-05-01T10:01:00.000Z")
  });
  assert.equal(status.claimState, "expired");
  assert.equal(status.claimable, false);
  assert.equal(status.reason, "reward_funding_pending");
  assert.equal(status.effectiveState, "expired");
});

test("retry exhaustion takes precedence over funding-pending in the reason", () => {
  const attempts = [
    { sessionId: "job-fund:0x1", status: "expired", claimedAt: "2026-05-01T10:00:00.000Z" },
    { sessionId: "job-fund:0x2", status: "expired", claimedAt: "2026-05-01T10:05:00.000Z" }
  ];
  const status = summarizeJobClaimState({
    job: { ...OPEN_JOB, retryLimit: 2, funding: { source: "ingestion_prefund", state: "pending" } },
    sessions: attempts,
    wallet: WALLET
  });
  assert.equal(status.claimable, false);
  assert.equal(status.reason, "retry_limit_exhausted");
});

test("countClaimAttempts excludes an infra-failed submit that never reached submitted", () => {
  const sessions = [
    {
      sessionId: "job-x:0x1",
      claimedAt: "2026-05-01T10:00:00.000Z",
      status: "claimed",
      submitFailedAt: "2026-05-01T10:00:05.000Z"
    }
  ];
  assert.equal(countClaimAttempts(sessions), 0);
});

test("countClaimAttempts counts a session that reached submitted even if an earlier submit failed", () => {
  const sessions = [
    {
      sessionId: "job-x:0x1",
      claimedAt: "2026-05-01T10:00:00.000Z",
      status: "submitted",
      submitFailedAt: "2026-05-01T10:00:05.000Z",
      submittedAt: "2026-05-01T10:00:10.000Z"
    }
  ];
  assert.equal(countClaimAttempts(sessions), 1);
});

test("countClaimAttempts still counts normal claims, no-show expiries, and rejections", () => {
  assert.equal(countClaimAttempts([{ sessionId: "a", claimedAt: "t", status: "claimed" }]), 1);
  assert.equal(countClaimAttempts([{ sessionId: "b", claimedAt: "t", status: "expired" }]), 1);
  assert.equal(
    countClaimAttempts([{ sessionId: "c", claimedAt: "t", status: "rejected", submittedAt: "t2" }]),
    1
  );
});
