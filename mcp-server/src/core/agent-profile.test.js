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

test("buildAgentProfile attaches verification block per source kind", () => {
  // GitHub session: chainJobId, evidenceHash, verifier, verifierMode,
  // sourceUrl from job.source.issueUrl.
  const githubJob = {
    id: "oss-acme-repo-1",
    category: "coding",
    rewardAsset: "USDC",
    rewardAmount: 5,
    verifierMode: "github_pr",
    source: { type: "github_issue", issueUrl: "https://github.com/acme/repo/issues/1" },
  };
  // Wikipedia session: pinnedRevisionUrl is preferred over articleUrl
  // because the revision URL is reproducible.
  const wikiJob = {
    id: "wiki-en-12345-citation-repair",
    category: "wikipedia",
    rewardAsset: "USDC",
    rewardAmount: 2,
    verifierMode: "wikipedia_proposal_review",
    source: {
      type: "wikipedia_article",
      pinnedRevisionUrl: "https://en.wikipedia.org/w/index.php?title=Foo&oldid=42",
      articleUrl: "https://en.wikipedia.org/wiki/Foo",
    },
  };
  // OSV session with no source URL fields — verification block still
  // populates with chainJobId/evidenceHash/verifier so the badge isn't
  // unverifiable end-to-end.
  const osvJob = {
    id: "osv-npm-foo-1",
    category: "security",
    rewardAsset: "USDC",
    rewardAmount: 7,
    verifierMode: "osv_dependency_pr",
    source: { type: "osv_advisory" },
  };

  const baseSession = (overrides) => ({
    wallet: WALLET,
    status: "resolved",
    verification: {
      outcome: "approved",
      reasonCode: "OK",
      verifier: "0xVerifier000000000000000000000000000000F0",
    },
    chainJobId: "0xchainjob000000000000000000000000000000000000000000000000000000aa",
    evidenceHash: "0xevidence0000000000000000000000000000000000000000000000000000000bb",
    ...overrides,
  });

  const sessions = [
    baseSession({ sessionId: "g1", jobId: "oss-acme-repo-1", updatedAt: "2026-05-08T10:00:00Z" }),
    baseSession({ sessionId: "w1", jobId: "wiki-en-12345-citation-repair", updatedAt: "2026-05-09T10:00:00Z" }),
    baseSession({ sessionId: "o1", jobId: "osv-npm-foo-1", updatedAt: "2026-05-10T10:00:00Z" }),
  ];
  const catalog = new Map([
    [githubJob.id, githubJob],
    [wikiJob.id, wikiJob],
    [osvJob.id, osvJob],
  ]);

  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 200, reliability: 200, economic: 200, tier: "pro" },
    sessions,
    getJobDefinition: makeGetJob(catalog),
    publicBaseUrl: "https://api.averray.com",
    fetchedAt: "2026-05-11T00:00:00Z",
  });

  // Badges sorted newest-first: o1, w1, g1.
  const [osvBadge, wikiBadge, githubBadge] = profile.badges;
  assert.deepEqual(githubBadge.verification, {
    chainJobId: "0xchainjob000000000000000000000000000000000000000000000000000000aa",
    evidenceHash: "0xevidence0000000000000000000000000000000000000000000000000000000bb",
    verifier: "0xVerifier000000000000000000000000000000F0",
    verifierMode: "github_pr",
    sourceUrl: "https://github.com/acme/repo/issues/1",
    sourceKind: "github_issue",
  });
  assert.equal(
    wikiBadge.verification.sourceUrl,
    "https://en.wikipedia.org/w/index.php?title=Foo&oldid=42",
    "wikipedia source url prefers pinned revision over article"
  );
  // OSV with no source URL: the field is dropped entirely so the
  // frontend can render a "no source link" state without parsing a
  // null.
  assert.ok(!("sourceUrl" in osvBadge.verification));
  assert.equal(osvBadge.verification.verifierMode, "osv_dependency_pr");
});

test("buildAgentProfile omits the verification block when nothing is computable", () => {
  // Session without chainJobId / evidenceHash / verifier and a job
  // without source.* — no verification fields can be derived. The
  // block is dropped entirely so the frontend renders an honest "no
  // verification details" state instead of an empty object.
  const job = {
    id: "starter-coding-001",
    category: "coding",
    rewardAsset: "USDC",
    rewardAmount: 5,
    // verifierMode intentionally absent
  };
  const session = {
    sessionId: "n1",
    wallet: WALLET,
    jobId: job.id,
    status: "resolved",
    updatedAt: "2026-05-08T10:00:00Z",
    verification: { outcome: "approved", reasonCode: "OK" },
  };
  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 50, reliability: 50, economic: 50, tier: "starter" },
    sessions: [session],
    getJobDefinition: makeGetJob(new Map([[job.id, job]])),
  });
  assert.equal(profile.badges.length, 1);
  assert.ok(!("verification" in profile.badges[0]));
});

test("buildAgentProfile surfaces dispute history with verdict outcomes", () => {
  // Three sessions:
  //   - one currently disputed with no verdict yet (open)
  //   - one disputed with an "upheld" verdict (worker lost)
  //   - one disputed with a "dismissed" verdict (worker won)
  const sessions = [
    {
      sessionId: "s-open",
      wallet: WALLET,
      jobId: "starter-coding-001",
      status: "disputed",
      disputedAt: "2026-05-08T10:00:00Z",
      updatedAt: "2026-05-08T10:00:00Z",
      verification: { outcome: "rejected", reasonCode: "REJECTED" },
    },
    {
      sessionId: "s-lost",
      wallet: WALLET,
      jobId: "starter-coding-001",
      status: "rejected",
      disputedAt: "2026-04-30T10:00:00Z",
      updatedAt: "2026-05-02T12:00:00Z",
      verification: { outcome: "rejected", reasonCode: "DISPUTE_LOST" },
    },
    {
      sessionId: "s-won",
      wallet: WALLET,
      jobId: "governance-pro-001",
      status: "resolved",
      disputedAt: "2026-04-20T10:00:00Z",
      updatedAt: "2026-04-22T12:00:00Z",
      verification: { outcome: "approved", reasonCode: "DISPUTE_OVERTURNED" },
    },
  ];
  const receiptsBySession = new Map([
    ["s-lost", {
      verdict: { verdict: "upheld", reasonCode: "DISPUTE_LOST", txHash: "0xab" },
    }],
    ["s-won", {
      verdict: { verdict: "dismissed", reasonCode: "DISPUTE_OVERTURNED", workerPayout: "5000000" },
    }],
  ]);

  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 200, reliability: 200, economic: 200, tier: "pro" },
    sessions,
    getJobDefinition: makeGetJob(),
    getDisputeReceipts: (sessionId) => receiptsBySession.get(sessionId),
  });

  assert.equal(profile.disputes.length, 3);
  // Newest-first ordering by openedAt.
  assert.equal(profile.disputes[0].sessionId, "s-open");
  assert.equal(profile.disputes[0].status, "open");
  assert.ok(!("verdict" in profile.disputes[0]));
  assert.equal(profile.disputes[1].sessionId, "s-lost");
  assert.equal(profile.disputes[1].status, "resolved");
  assert.equal(profile.disputes[1].verdict, "upheld");
  assert.equal(profile.disputes[1].reasonCode, "DISPUTE_LOST");
  assert.equal(profile.disputes[2].verdict, "dismissed");
  assert.equal(profile.disputes[2].workerPayout, "5000000");

  // Outcome counts surface on stats.disputes for the strip view.
  assert.equal(profile.stats.disputes.total, 3);
  assert.equal(profile.stats.disputes.open, 1);
  assert.equal(profile.stats.disputes.lost, 1);
  assert.equal(profile.stats.disputes.won, 1);
  assert.equal(profile.stats.disputes.split, 0);
  assert.equal(profile.stats.disputes.timeout, 0);

  // Each dispute carries a stable id derived from the session id.
  for (const dispute of profile.disputes) {
    assert.match(dispute.id, /^dispute-[a-f0-9]{12}$/u);
    assert.equal(typeof dispute.openedAt, "string");
    assert.equal(typeof dispute.windowEndsAt, "string");
    assert.equal(dispute.slaSeconds, 14 * 24 * 60 * 60);
  }
});

test("buildAgentProfile leaves disputes empty when no contested sessions exist", () => {
  const sessions = [
    approvedSession({ jobId: "starter-coding-001", sessionId: "s1", updatedAt: "2026-04-10T10:00:00Z" }),
    rejectedSession({ jobId: "starter-coding-001", sessionId: "s2", updatedAt: "2026-04-12T10:00:00Z" }),
  ];
  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 100, reliability: 100, economic: 100, tier: "pro" },
    sessions,
    getJobDefinition: makeGetJob(),
  });
  assert.deepEqual(profile.disputes, []);
  assert.deepEqual(profile.stats.disputes, {
    total: 0,
    open: 0,
    lost: 0,
    won: 0,
    split: 0,
    timeout: 0,
    resolved: 0,
  });
});

test("buildAgentProfile surfaces sub-contracting lineage when getLineage returns a parent or children", () => {
  const PARENT_WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const sessions = [
    approvedSession({
      jobId: "starter-coding-001",
      sessionId: "session-parent",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    approvedSession({
      jobId: "governance-pro-001",
      sessionId: "session-child",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }),
  ];
  // session-parent posted one sub-job; session-child worked on a
  // sub-job whose parent belonged to PARENT_WALLET.
  const lineageBySession = {
    "session-parent": {
      children: [{ jobId: "child-job-1", parentWallet: WALLET.toLowerCase() }],
    },
    "session-child": {
      parent: {
        sessionId: "remote-session",
        jobId: "remote-job",
        wallet: PARENT_WALLET,
      },
    },
  };
  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 70, reliability: 60, economic: 40 },
    sessions,
    getJobDefinition: makeGetJob(),
    getLineage: (sessionId) => lineageBySession[sessionId],
  });

  assert.equal(profile.stats.lineage.delegated, 1);
  assert.equal(profile.stats.lineage.subcontracted, 1);
  assert.equal(profile.lineage.delegated.length, 1);
  assert.equal(profile.lineage.subcontracted.length, 1);

  const delegated = profile.lineage.delegated[0];
  assert.equal(delegated.role, "parent");
  assert.equal(delegated.sessionId, "session-parent");
  assert.equal(delegated.children.count, 1);
  assert.deepEqual(delegated.children.jobIds, ["child-job-1"]);

  const subcontracted = profile.lineage.subcontracted[0];
  assert.equal(subcontracted.role, "child");
  assert.equal(subcontracted.sessionId, "session-child");
  assert.equal(subcontracted.parent.sessionId, "remote-session");
  assert.equal(subcontracted.parent.jobId, "remote-job");
  assert.equal(subcontracted.parent.wallet, PARENT_WALLET.toLowerCase());
  assert.equal(subcontracted.parent.isSelf, false);
});

test("buildAgentProfile flags a session whose parent wallet equals its own wallet as self-delegated", () => {
  const sessions = [
    approvedSession({
      jobId: "governance-pro-001",
      sessionId: "session-self",
      updatedAt: "2026-01-03T00:00:00.000Z",
    }),
  ];
  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 50, reliability: 50, economic: 50 },
    sessions,
    getJobDefinition: makeGetJob(),
    getLineage: () => ({
      parent: { sessionId: "self-parent", jobId: "self-job", wallet: WALLET },
    }),
  });
  assert.equal(profile.lineage.subcontracted[0].parent.isSelf, true);
});

test("buildAgentProfile leaves lineage empty when no sessions carry sub-contracting markers", () => {
  const sessions = [
    approvedSession({
      jobId: "starter-coding-001",
      sessionId: "session-plain",
      updatedAt: "2026-01-04T00:00:00.000Z",
    }),
  ];
  const profile = buildAgentProfile({
    wallet: WALLET,
    reputation: { skill: 50, reliability: 50, economic: 50 },
    sessions,
    getJobDefinition: makeGetJob(),
    // Lookup returns nothing — same as the common case where the
    // HTTP layer's preloadLineage short-circuits because no session
    // has a parent or children.
    getLineage: () => undefined,
  });
  assert.deepEqual(profile.lineage, { delegated: [], subcontracted: [] });
  assert.deepEqual(profile.stats.lineage, { delegated: 0, subcontracted: 0 });
});
