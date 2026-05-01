import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_PROFILE_SCHEMA_VERSION, buildAgentProfile } from "./agent-profile.js";
import { ValidationError } from "./errors.js";

const WALLET = "0x1234567890123456789012345678901234567890";

function jobCatalog() {
  return new Map([
    ["starter-coding-001", { id: "starter-coding-001", category: "coding", rewardAsset: "DOT", rewardAmount: 5, claimTtlSeconds: 3600 }],
    ["governance-pro-001", { id: "governance-pro-001", category: "governance", rewardAsset: "DOT", rewardAmount: 25, payoutMode: "milestone" }]
  ]);
}

function makeGetJob(catalog = jobCatalog()) {
  return (jobId) => catalog.get(jobId);
}

function approvedSession({ jobId, sessionId, updatedAt }) {
  return {
    sessionId,
    wallet: WALLET,
    jobId,
    status: "resolved",
    updatedAt,
    verification: { outcome: "approved", reasonCode: "OK" }
  };
}

function rejectedSession({ jobId, sessionId, updatedAt }) {
  return {
    sessionId,
    wallet: WALLET,
    jobId,
    status: "rejected",
    updatedAt,
    verification: { outcome: "rejected", reasonCode: "REJECTED" }
  };
}

test("buildAgentProfile returns a schema-shaped document for a known wallet", () => {
  const sessions = [
    approvedSession({ jobId: "starter-coding-001", sessionId: "s1", updatedAt: "2026-04-10T10:00:00Z" }),
    approvedSession({ jobId: "starter-coding-001", sessionId: "s2", updatedAt: "2026-04-12T10:00:00Z" }),
    approvedSession({ jobId: "governance-pro-001", sessionId: "s3", updatedAt: "2026-04-15T10:00:00Z" }),
    rejectedSession({ jobId: "starter-coding-001", sessionId: "s4", updatedAt: "2026-04-14T10:00:00Z" })
  ];

  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 150, reliability: 170, economic: 80, tier: "pro" },
    sessions,
    getJobDefinition: makeGetJob(),
    publicBaseUrl: "https://api.averray.com",
    fetchedAt: "2026-04-16T00:00:00Z"
  });

  assert.equal(profile.schemaVersion, AGENT_PROFILE_SCHEMA_VERSION);
  assert.equal(profile.wallet, WALLET.toLowerCase());
  assert.equal(profile.reputation.tier, "pro");
  assert.equal(profile.stats.totalBadges, 3);
  assert.equal(profile.stats.approvedCount, 3);
  assert.equal(profile.stats.rejectedCount, 1);
  assert.equal(profile.stats.completionRate, 0.75);
  // 2 coding @ 5 DOT + 1 governance @ 25 DOT = 35 DOT at 18 decimals.
  assert.equal(profile.stats.totalEarned.amount, "35000000000000000000");
  assert.equal(profile.stats.totalEarned.decimals, 18);
  assert.equal(profile.stats.activeSince, "2026-04-10T10:00:00.000Z");
  assert.equal(profile.stats.lastActive, "2026-04-15T10:00:00.000Z");
  assert.deepEqual(profile.stats.preferredCategories, [
    { category: "coding", count: 2 },
    { category: "governance", count: 1 }
  ]);
  assert.deepEqual(profile.categoryLevels, { coding: 1, governance: 2 });
  // Badges list is newest-first.
  assert.equal(profile.badges[0].sessionId, "s3");
  assert.equal(profile.badges[0].level, 2); // milestone job
  assert.equal(profile.badges[0].badgeUrl, "https://api.averray.com/badges/s3");
  assert.equal(profile.badges.length, 3);
});

test("buildAgentProfile returns null completionRate when no terminal sessions exist", () => {
  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 0, reliability: 0, economic: 0, tier: "starter" },
    sessions: [],
    getJobDefinition: makeGetJob()
  });
  assert.equal(profile.stats.completionRate, null);
  assert.equal(profile.stats.totalBadges, 0);
  assert.equal(profile.stats.totalEarned.amount, "0");
  assert.equal(profile.stats.activeSince, null);
  assert.equal(profile.stats.lastActive, null);
  assert.deepEqual(profile.stats.preferredCategories, []);
  assert.deepEqual(profile.categoryLevels, {});
  assert.deepEqual(profile.badges, []);
});

test("buildAgentProfile derives tier from skill when not supplied", () => {
  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 250, reliability: 100, economic: 100 },
    sessions: [],
    getJobDefinition: makeGetJob()
  });
  assert.equal(profile.reputation.tier, "elite");
});

test("buildAgentProfile rejects malformed wallet", () => {
  assert.throws(
    () =>
      buildAgentProfile({
        wallet: "nope",
        reputation: { skill: 0, reliability: 0, economic: 0, tier: "starter" },
        sessions: [],
        getJobDefinition: makeGetJob()
      }),
    (err) => err instanceof ValidationError && /wallet/.test(err.message)
  );
});

test("buildAgentProfile lowercases the wallet in the output", () => {
  const mixed = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd";
  const profile = buildAgentProfile({
    wallet: mixed,
    reputation: { skill: 0, reliability: 0, economic: 0, tier: "starter" },
    sessions: [],
    getJobDefinition: makeGetJob()
  });
  assert.equal(profile.wallet, mixed.toLowerCase());
});

test("buildAgentProfile ignores sessions that are pending verification", () => {
  const sessions = [
    approvedSession({ jobId: "starter-coding-001", sessionId: "s1", updatedAt: "2026-04-10T10:00:00Z" }),
    {
      sessionId: "s-pending",
      wallet: WALLET,
      jobId: "starter-coding-001",
      status: "submitted",
      submittedAt: "2026-04-15T10:00:00Z",
      updatedAt: "2026-04-15T10:00:00Z",
      verification: undefined
    }
  ];

  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 100, reliability: 100, economic: 100, tier: "pro" },
    sessions,
    getJobDefinition: makeGetJob()
  });
  assert.equal(profile.stats.approvedCount, 1);
  assert.equal(profile.stats.rejectedCount, 0);
  assert.equal(profile.stats.completionRate, 1);
  // Active-since stays pinned to approved sessions; lastActive tracks the
  // latest session update including pending ones.
  assert.equal(profile.stats.activeSince, "2026-04-10T10:00:00.000Z");
  assert.equal(profile.stats.lastActive, "2026-04-15T10:00:00.000Z");
  assert.deepEqual(profile.currentActivity, {
    sessionId: "s-pending",
    jobId: "starter-coding-001",
    status: "submitted",
    label: "Submitted",
    phase: "verification",
    outcome: "awaiting_verification",
    submittedAt: "2026-04-15T10:00:00.000Z",
    updatedAt: "2026-04-15T10:00:00.000Z",
    canSubmit: false,
    awaitingVerification: true
  });
});

test("buildAgentProfile exposes the latest claimed session as current activity", () => {
  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 0, reliability: 0, economic: 0, tier: "starter" },
    sessions: [
      {
        sessionId: "wiki-en-62871101-citation-repair-hash:0x1234567890123456789012345678901234567890",
        wallet: WALLET,
        jobId: "starter-coding-001",
        status: "claimed",
        claimedAt: "2026-05-01T12:18:03.973Z",
        updatedAt: "2026-05-01T12:18:03.973Z",
        verification: undefined
      }
    ],
    getJobDefinition: makeGetJob()
  });

  assert.equal(profile.stats.totalBadges, 0);
  assert.equal(profile.stats.completionRate, null);
  assert.deepEqual(profile.badges, []);
  assert.deepEqual(profile.currentActivity, {
    sessionId: "wiki-en-62871101-citation-repair-hash:0x1234567890123456789012345678901234567890",
    jobId: "starter-coding-001",
    status: "claimed",
    label: "Claimed",
    phase: "work",
    outcome: "in_progress",
    claimedAt: "2026-05-01T12:18:03.973Z",
    updatedAt: "2026-05-01T12:18:03.973Z",
    deadlineAt: "2026-05-01T13:18:03.973Z",
    canSubmit: true,
    awaitingVerification: false
  });
});

test("buildAgentProfile aggregates GitHub reputation signals", () => {
  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 100, reliability: 100, economic: 100, tier: "pro" },
    sessions: [
      {
        sessionId: "github-1",
        wallet: WALLET,
        jobId: "starter-coding-001",
        status: "resolved",
        updatedAt: "2026-04-10T10:00:00Z",
        verification: {
          outcome: "approved",
          reputationSignals: {
            attempted: 1,
            prOpened: 1,
            checksPassed: 1,
            maintainerApproved: 0,
            merged: 0
          }
        }
      },
      {
        sessionId: "github-2",
        wallet: WALLET,
        jobId: "starter-coding-001",
        status: "resolved",
        updatedAt: "2026-04-11T10:00:00Z",
        verification: {
          outcome: "approved",
          reputationSignals: {
            attempted: 1,
            prOpened: 1,
            checksPassed: 1,
            maintainerApproved: 1,
            merged: 1
          }
        }
      }
    ],
    getJobDefinition: makeGetJob()
  });

  assert.deepEqual(profile.stats.githubSignals, {
    attempted: 2,
    prOpened: 2,
    checksPassed: 2,
    maintainerApproved: 1,
    merged: 1
  });
});

test("buildAgentProfile omits badgeUrl when publicBaseUrl is not provided", () => {
  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 100, reliability: 100, economic: 100, tier: "pro" },
    sessions: [approvedSession({ jobId: "starter-coding-001", sessionId: "s1", updatedAt: "2026-04-10T10:00:00Z" })],
    getJobDefinition: makeGetJob()
  });
  assert.equal(profile.badges[0].sessionId, "s1");
  assert.ok(!("badgeUrl" in profile.badges[0]));
});
