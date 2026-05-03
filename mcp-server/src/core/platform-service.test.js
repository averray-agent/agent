import test from "node:test";
import assert from "node:assert/strict";

import { PlatformService } from "./platform-service.js";
import { EventBus } from "./event-bus.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makePlatformService(blockchainGateway = undefined, eventBus = undefined) {
  const jobs = [
    {
      id: "parent-job-001",
      category: "coding",
      tier: "starter",
      rewardAsset: "DOT",
      rewardAmount: 5,
      verifierMode: "benchmark",
      verifierConfig: {
        version: 1,
        handler: "benchmark",
        requiredKeywords: ["complete"],
        minimumMatches: 1
      },
      inputSchemaRef: "schema://jobs/coding-input",
      outputSchemaRef: "schema://jobs/coding-output",
      claimTtlSeconds: 3600,
      retryLimit: 1,
      requiresSponsoredGas: true
    }
  ];
  const profiles = new Map([
    [WALLET, {
      wallet: WALLET,
      preferredCategories: ["coding"],
      verifierCompatibility: ["benchmark", "deterministic", "human_fallback"],
      preferredRiskLevel: "low",
      capabilities: ["claim_job", "submit_work"],
      supportedProtocols: ["http"],
      minLiquidReserve: 0,
      autoUnwindStrategies: false
    }]
  ]);
  const accounts = new Map([
    [WALLET, {
      wallet: WALLET,
      liquid: { DOT: 10 },
      reserved: {},
      strategyAllocated: {},
      collateralLocked: {},
      jobStakeLocked: {},
      debtOutstanding: {}
    }]
  ]);
  const reputations = new Map([
    [WALLET, { skill: 50, reliability: 50, economic: 50, tier: "starter" }]
  ]);
  return new PlatformService(jobs, profiles, accounts, reputations, blockchainGateway, undefined, eventBus);
}

test("createSubJob links the child job to the active parent session", async () => {
  const service = makePlatformService();
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "parent-claim");

  const subJob = await service.createSubJob(session.sessionId, WALLET, {
    id: "child-job-001",
    category: "review",
    tier: "starter",
    rewardAmount: 2,
    verifierMode: "benchmark",
    verifierTerms: ["summary"],
    verifierMinimumMatches: 1,
    inputSchemaRef: "schema://jobs/review-input",
    outputSchemaRef: "schema://jobs/pr-review-findings-output",
    claimTtlSeconds: 1800,
    retryLimit: 1,
    requiresSponsoredGas: true
  });

  assert.equal(subJob.parentSessionId, session.sessionId);
  const subJobs = await service.listSubJobs(session.sessionId);
  assert.equal(subJobs.length, 1);
  assert.equal(subJobs[0].id, "child-job-001");
});

test("listJobsWithSessions joins active session state onto job rows", async () => {
  const service = makePlatformService();

  // Before any claim — listJobs and listJobsWithSessions agree.
  const before = await service.listJobsWithSessions();
  assert.equal(before.length, 1);
  assert.equal(before[0].id, "parent-job-001");
  assert.equal(before[0].claimedBy ?? null, null);
  assert.equal(before[0].sessionId ?? null, null);
  assert.equal(before[0].state, "open");
  assert.equal(before[0].claimState, "open");
  assert.equal(before[0].claimable, true);

  // After a claim — the row carries claim state read live from the
  // session store so the public /jobs feed and the operator queue
  // stop showing the row as "ready / unclaimed" the moment a worker
  // locks it in.
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "claim-state-test");
  const after = await service.listJobsWithSessions();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, "parent-job-001");
  assert.equal(after[0].claimedBy, WALLET);
  assert.equal(after[0].sessionId, session.sessionId);
  assert.equal(typeof after[0].state, "string");
  assert.equal(after[0].state, session.status);
  assert.equal(after[0].claimState, "claimed");
  assert.equal(after[0].claimable, false);
  assert.equal(after[0].currentWalletCanClaim, null);
  assert.equal(after[0].claimExpiresAt, new Date(Date.parse(session.claimedAt) + 3600 * 1000).toISOString());
});

test("listJobsWithSessions and definition expose expired claim affordances", async () => {
  const service = makePlatformService();
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "expired-claim-test");
  await service.stateStore.upsertSession({
    ...session,
    claimedAt: "2026-05-01T11:18:03.973Z",
    statusHistory: [
      {
        from: null,
        to: "claimed",
        reason: "job_claimed",
        at: "2026-05-01T11:18:03.973Z"
      }
    ]
  });

  const now = new Date("2026-05-01T12:18:04.000Z");
  const rows = await service.listJobsWithSessions({ wallet: WALLET, now });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "exhausted");
  assert.equal(rows[0].claimState, "exhausted");
  assert.equal(rows[0].effectiveState, "exhausted");
  assert.equal(rows[0].claimable, false);
  assert.equal(rows[0].currentWalletCanClaim, false);
  assert.equal(rows[0].reason, "retry_limit_exhausted");
  assert.equal(rows[0].claimAttemptCount, 1);
  assert.equal(rows[0].remainingClaimAttempts, 0);
  assert.equal(rows[0].claimedBy, WALLET);
  assert.equal(rows[0].claimedAt, "2026-05-01T11:18:03.973Z");
  assert.equal(rows[0].claimExpiresAt, "2026-05-01T12:18:03.973Z");
  assert.equal(rows[0].retryLimit, 1);
  assert.equal(rows[0].sessionId, session.sessionId);

  const stored = await service.resumeSession(session.sessionId);
  assert.equal(stored.status, "expired");
  assert.equal(stored.expiredAt, "2026-05-01T12:18:03.973Z");

  const definition = await service.getPublicJobDefinition("parent-job-001", { wallet: WALLET, now });
  assert.equal(definition.lifecycle.state, "open");
  assert.equal(definition.claimabilitySource, "claimStatus");
  assert.match(definition.lifecycleStatusMeaning, /check claimStatus/u);
  assert.equal(definition.claimState, "exhausted");
  assert.equal(definition.effectiveState, "exhausted");
  assert.equal(definition.claimStatus.claimExpiresAt, "2026-05-01T12:18:03.973Z");
  assert.equal(definition.claimStatus.reason, "retry_limit_exhausted");
  assert.equal(definition.claimStatus.claimabilitySource, "claimStatus");
  assert.match(definition.claimStatus.lifecycleStatusMeaning, /check claimStatus/u);
});

test("validateJobSubmission gives a non-mutating schema-native verdict", () => {
  const service = makePlatformService();

  const valid = service.validateJobSubmission("parent-job-001", {
    summary: "Parser fixed.",
    output: "Added regression coverage.",
    status: "complete"
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.schemaRef, "schema://jobs/coding-output");
  assert.equal(valid.schemaValidates, "payload.submission");
  assert.equal(valid.submissionKind, "structured");

  const invalid = service.validateJobSubmission("parent-job-001", "complete");
  assert.equal(invalid.valid, false);
  assert.equal(invalid.schemaRef, "schema://jobs/coding-output");
  assert.match(invalid.message, /Schema-native jobs require/u);
  assert.equal(invalid.details.schemaValidates, "payload.submission");
});

test("getSessionTimeline includes transitions and verification state", async () => {
  const service = makePlatformService();
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "timeline-claim");
  const submitted = await service.submitWork(session.sessionId, "http", {
    summary: "Timeline run complete.",
    output: "complete verified output",
    status: "complete"
  });
  await service.ingestVerification(submitted.sessionId, {
    jobId: submitted.jobId,
    handler: "benchmark",
    handlerVersion: 1,
    outcome: "approved",
    reasonCode: "BENCHMARK_THRESHOLD_MET"
  });
  const result = await service.stateStore.getVerificationResult(submitted.sessionId);

  const timeline = await service.getSessionTimeline(submitted.sessionId);
  assert.equal(timeline.timelineVersion, "v2");
  assert.equal(timeline.session.status, "resolved");
  assert.equal(result.verifierConfigVersion, 1);
  assert.equal(result.verificationContract.version, "verification-contract-v1");
  assert.equal(result.verificationContract.handler, "benchmark");
  assert.equal(result.verificationInput.kind, "structured");
  assert.equal(typeof result.verifierConfigHash, "string");
  assert.equal(typeof result.verificationInputHash, "string");
  assert.equal(timeline.lifecycle.currentPhase, "terminal");
  assert.equal(timeline.stateMachine.timelineVersion, "v2");
  assert.ok(Array.isArray(timeline.stateMachine.statuses));
  assert.ok(Array.isArray(timeline.lineage.childJobIds));
  assert.ok(timeline.timeline.some((entry) => entry.type === "session_transition"));
  assert.ok(timeline.timeline.some((entry) => entry.type === "verification"));
  assert.ok(timeline.timeline.every((entry) => entry.correlationId === submitted.sessionId));
});

test("getJobTimeline stitches sessions, verification, events, and child lineage", async () => {
  const eventBus = new EventBus();
  const service = makePlatformService(undefined, eventBus);
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "job-timeline-claim");
  const subJob = await service.createSubJob(session.sessionId, WALLET, {
    id: "timeline-child-job-001",
    category: "review",
    tier: "starter",
    rewardAmount: 2,
    verifierMode: "benchmark",
    verifierTerms: ["summary"],
    verifierMinimumMatches: 1,
    inputSchemaRef: "schema://jobs/review-input",
    outputSchemaRef: "schema://jobs/pr-review-findings-output",
    claimTtlSeconds: 1800,
    retryLimit: 1,
    requiresSponsoredGas: true
  });
  const submitted = await service.submitWork(session.sessionId, "http", {
    summary: "Timeline run complete.",
    output: "complete verified output",
    status: "complete"
  });
  await service.ingestVerification(submitted.sessionId, {
    jobId: submitted.jobId,
    handler: "benchmark",
    handlerVersion: 1,
    outcome: "approved",
    reasonCode: "BENCHMARK_THRESHOLD_MET"
  });

  const timeline = await service.getJobTimeline("parent-job-001", { wallet: WALLET });
  assert.equal(timeline.timelineVersion, "v2");
  assert.equal(timeline.job.id, "parent-job-001");
  assert.equal(timeline.job.claimState, "exhausted");
  assert.equal(timeline.summary.sessionCount, 1);
  assert.equal(timeline.summary.childJobCount, 1);
  assert.deepEqual(timeline.lineage.sessionIds, [submitted.sessionId]);
  assert.deepEqual(timeline.lineage.childJobIds, [subJob.id]);
  assert.ok(timeline.timeline.some((entry) => entry.type === "job_state"));
  assert.ok(timeline.timeline.some((entry) => entry.type === "session_transition" && entry.data.to === "submitted"));
  assert.ok(timeline.timeline.some((entry) => entry.type === "verification"));
  assert.ok(timeline.timeline.some((entry) => entry.type === "child_job"));
  assert.ok(timeline.timeline.some((entry) => entry.type === "event_bus" && entry.data.topic === "session.claimed"));
});

test("getAdminStatus surfaces recurring scheduler anomalies", async () => {
  const service = makePlatformService();
  service.updateJobLifecycle("parent-job-001", {
    action: "pause",
    reason: "operator hold"
  });
  service.recurringScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        templates: [
          {
            templateId: "weekly-digest",
            lastResult: {
              status: "failed"
            }
          }
        ]
      };
    }
  };

  const status = await service.getAdminStatus({
    auth: {
      wallet: WALLET,
      claims: { roles: ["admin"] },
      capabilities: ["admin:status"]
    }
  });

  assert.equal(status.auth.wallet, WALLET);
  assert.ok(status.anomalies.some((entry) => entry.code === "recurring_attention"));
  assert.equal(status.jobLifecycle.total, 1);
  assert.equal(status.jobLifecycle.paused, 1);
  assert.equal(status.jobLifecycle.claimable, 0);
  assert.equal(status.jobStaleSweeper.enabled, false);
});

test("getAdminStatus reports treasury policy failures without failing the status response", async () => {
  const service = makePlatformService({
    config: {
      treasuryPolicyAddress: "0x1111111111111111111111111111111111111111"
    },
    isEnabled() {
      return true;
    },
    async getTreasuryPolicyStatus() {
      const error = new Error("getTreasuryPolicyStatus failed: require(false)");
      error.code = "blockchain_revert";
      error.details = {
        operation: "getTreasuryPolicyStatus",
        rawCode: "CALL_EXCEPTION",
        rawReason: "require(false)"
      };
      throw error;
    }
  });

  const status = await service.getAdminStatus();

  assert.equal(status.maintenance.policy.enabled, true);
  assert.equal(status.maintenance.policy.policyAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(status.maintenance.policy.error.code, "blockchain_revert");
  assert.equal(status.maintenance.policy.error.details.rawReason, "require(false)");
  assert.ok(status.anomalies.some((entry) => entry.code === "policy_status_unavailable"));
  assert.equal(status.jobStaleSweeper.enabled, false);
});

test("getAdminStatus surfaces public source ingestion scheduler status", async () => {
  const service = makePlatformService();
  service.githubIssueIngestionScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: true,
        intervalMs: 900000,
        queryCount: 2,
        maxJobsPerRun: 2,
        maxJobsPerQuery: 2,
        maxOpenJobs: 12,
        currentOpenJobs: 3,
        lastRun: {
          startedAt: "2026-04-27T08:00:00.000Z",
          finishedAt: "2026-04-27T08:00:02.000Z",
          candidateCount: 4,
          createdCount: 1,
          errors: [],
          queries: [
            {
              query: "repo:averray-agent/agent label:good-first-issue",
              skipped: [{ id: "github-1", reason: "source_already_ingested" }]
            }
          ]
        }
      };
    }
  };
  service.wikipediaMaintenanceIngestionScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: true,
        intervalMs: 1800000,
        language: "en",
        categoryCount: 1,
        maxJobsPerRun: 2,
        maxOpenJobs: 10,
        currentOpenJobs: 0,
        minClaimableJobs: 2,
        currentClaimableJobs: 0,
        lastRun: { candidateCount: 0, createdCount: 0, skipped: [{ reason: "no_candidates" }], errors: [] }
      };
    }
  };
  service.osvAdvisoryIngestionScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: true,
        intervalMs: 3600000,
        packageCount: 0,
        manifestCount: 1,
        targetCount: 1,
        maxJobsPerRun: 2,
        maxOpenJobs: 20,
        currentOpenJobs: 2,
        lastRun: { candidateCount: 2, createdCount: 0, skipped: [], errors: [] }
      };
    }
  };
  service.openDataIngestionScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: false,
        intervalMs: 3600000,
        query: "res_format:CSV",
        queryCount: 7,
        nextQuery: "transport",
        datasetCount: 0,
        targetCount: 3,
        maxJobsPerRun: 2,
        maxOpenJobs: 20,
        currentOpenJobs: 4,
        lastRun: {
          candidateCount: 2,
          createdCount: 1,
          skipped: [
            { datasetId: "abc", resourceId: "abc-1", reason: "dataset_already_ingested" }
          ],
          errors: []
        }
      };
    }
  };
  service.standardsSpecIngestionScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: true,
        intervalMs: 3600000,
        specCount: 2,
        maxJobsPerRun: 2,
        maxOpenJobs: 20,
        currentOpenJobs: 1,
        lastRun: { candidateCount: 1, createdCount: 1, skipped: [], errors: [] }
      };
    }
  };
  service.openApiSpecIngestionScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: true,
        intervalMs: 3600000,
        specCount: 1,
        maxJobsPerRun: 2,
        maxOpenJobs: 20,
        currentOpenJobs: 1,
        lastRun: { candidateCount: 1, createdCount: 1, skipped: [], errors: [{ message: "temporary upstream failure" }] }
      };
    }
  };
  service.jobStaleSweeper = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: false,
        mode: "live",
        intervalMs: 3600000,
        action: "archive",
        maxJobsPerRun: 25,
        lastRun: {
          candidateCount: 3,
          updatedCount: 2,
          skipped: [{ id: "active", reason: "active_session" }],
          errors: []
        }
      };
    }
  };

  const status = await service.getAdminStatus();
  assert.equal(status.osvIngestion.packageCount, 0);
  assert.equal(status.osvIngestion.manifestCount, 1);
  assert.equal(status.osvIngestion.targetCount, 1);
  assert.equal(status.openDataIngestion.query, "res_format:CSV");
  assert.equal(status.openDataIngestion.lastRun.createdCount, 1);
  assert.equal(status.standardsIngestion.specCount, 2);
  assert.equal(status.openApiIngestion.specCount, 1);
  assert.equal(status.providerOperations.github.label, "GitHub issues");
  assert.equal(status.providerOperations.github.mode, "dry_run");
  assert.equal(status.providerOperations.github.currentOpenJobs, 3);
  assert.equal(status.providerOperations.github.maxJobsPerQuery, 2);
  assert.equal(status.providerOperations.github.lastRun.createdCount, 1);
  assert.equal(status.providerOperations.github.lastRun.skippedCount, 1);
  assert.equal(status.providerOperations.github.lastRun.skipped[0].reason, "source_already_ingested");
  assert.equal(status.providerOperations.wikipedia.minClaimableJobs, 2);
  assert.equal(status.providerOperations.wikipedia.currentClaimableJobs, 0);
  assert.equal(status.providerOperations.osv.targetCount, 1);
  assert.equal(status.providerOperations.openData.mode, "live");
  assert.equal(status.providerOperations.openData.health, "healthy");
  assert.equal(status.providerOperations.openData.targetCount, 3);
  // Open data rotates a query pool that's distinct from the dataset
  // target list — both signals reach the operator UI.
  assert.equal(status.providerOperations.openData.queryCount, 7);
  assert.equal(status.providerOperations.openData.nextQuery, "transport");
  assert.equal(status.providerOperations.openData.lastRun.summary, "2 candidate(s), 1 created, 1 skipped, 0 error(s)");
  assert.equal(status.providerOperations.openData.lastRun.skipped[0].reason, "dataset_already_ingested");
  // github's queryCount IS its targetCount — don't duplicate the
  // field at the top level.
  assert.equal(status.providerOperations.github.queryCount, undefined);
  assert.equal(status.providerOperations.github.nextQuery, undefined);
  assert.equal(status.providerOperations.openApi.health, "error");
  assert.equal(status.providerOperations.openApi.lastRun.errorCount, 1);
  assert.equal(status.jobStaleSweeper.mode, "live");
  assert.equal(status.jobStaleSweeper.lastRun.updatedCount, 2);

  // Public sanitized counterpart preserves health / mode / counts but
  // strips lastRun.skipped[] and lastRun.errors[] (which can carry
  // candidate URLs, query strings, stack traces, internal IDs).
  const publicStatus = await service.getPublicProviderOperations();
  assert.deepEqual(Object.keys(publicStatus), ["providerOperations"]);
  // Same six providers as the admin payload.
  assert.deepEqual(
    Object.keys(publicStatus.providerOperations).sort(),
    ["github", "openApi", "openData", "osv", "standards", "wikipedia"]
  );
  // Health, mode, counts, and human-readable summary survive…
  assert.equal(publicStatus.providerOperations.github.mode, "dry_run");
  assert.equal(publicStatus.providerOperations.github.currentOpenJobs, 3);
  assert.equal(publicStatus.providerOperations.wikipedia.minClaimableJobs, 2);
  assert.equal(publicStatus.providerOperations.wikipedia.currentClaimableJobs, 0);
  assert.equal(publicStatus.providerOperations.github.lastRun.skippedCount, 1);
  assert.equal(publicStatus.providerOperations.openApi.health, "error");
  assert.equal(publicStatus.providerOperations.openApi.lastRun.errorCount, 1);
  // …but the arrays themselves are emptied.
  assert.deepEqual(publicStatus.providerOperations.github.lastRun.skipped, []);
  assert.deepEqual(publicStatus.providerOperations.github.lastRun.errors, []);
  assert.deepEqual(publicStatus.providerOperations.openApi.lastRun.skipped, []);
  assert.deepEqual(publicStatus.providerOperations.openApi.lastRun.errors, []);
  // No leakage of any admin-only top-level fields (auth, recurring,
  // anomalies, recentSessions, etc.) — only providerOperations.
  assert.equal(publicStatus.auth, undefined);
  assert.equal(publicStatus.anomalies, undefined);
  assert.equal(publicStatus.recurring, undefined);
});

test("finalizeXcmRequest records async treasury settlement when the request is strategy-backed", async () => {
  const gateway = {
    isEnabled: () => true,
    getAccountSummary: async (wallet) => ({
      wallet,
      liquid: { DOT: 10 },
      reserved: {},
      strategyAllocated: {},
      collateralLocked: {},
      jobStakeLocked: {},
      debtOutstanding: {}
    }),
    finalizeXcmRequest: async () => ({
      requestId: "0xrequest",
      strategyRequest: {
        account: WALLET,
        strategyId: "0xstrategy",
        assetSymbol: "DOT",
        kindLabel: "deposit",
        statusLabel: "succeeded",
        requestedAssets: 5,
        settledAssets: 5
      }
    })
  };
  const service = makePlatformService(gateway);

  const finalized = await service.finalizeXcmRequest("0xrequest", {
    status: "succeeded",
    settledAssets: 5,
    settledShares: 5
  });
  const account = await service.getAccountSummary(WALLET);

  assert.equal(finalized.requestId, "0xrequest");
  assert.equal(account.strategyAccounting["0xstrategy"].principal, 5);
  assert.equal(account.treasuryTimeline[0].type, "allocate");
});

test("getAdminStatus surfaces XCM observation relay status", async () => {
  const service = makePlatformService();
  service.xcmObservationRelay = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        syncing: false,
        feedUrl: "https://observer.example/outcomes",
        batchSize: 25,
        pollIntervalMs: 30_000,
        cursor: "cursor-1",
        lastObservedCount: 2,
        lastSyncedAt: "2026-04-22T10:00:00.000Z"
      };
    }
  };

  const status = await service.getAdminStatus();
  assert.equal(status.xcmObservationRelay.enabled, true);
  assert.equal(status.xcmObservationRelay.cursor, "cursor-1");
});
