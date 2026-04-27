import test from "node:test";
import assert from "node:assert/strict";

import { PlatformService } from "./platform-service.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makePlatformService(blockchainGateway = undefined) {
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
  return new PlatformService(jobs, profiles, accounts, reputations, blockchainGateway);
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

test("getSessionTimeline includes transitions and verification state", async () => {
  const service = makePlatformService();
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "timeline-claim");
  const submitted = await service.submitWork(session.sessionId, "http", "complete");
  await service.ingestVerification(submitted.sessionId, {
    jobId: submitted.jobId,
    handler: "benchmark",
    handlerVersion: 1,
    outcome: "approved",
    reasonCode: "BENCHMARK_THRESHOLD_MET"
  });

  const timeline = await service.getSessionTimeline(submitted.sessionId);
  assert.equal(timeline.timelineVersion, "v2");
  assert.equal(timeline.session.status, "resolved");
  assert.equal(timeline.lifecycle.currentPhase, "terminal");
  assert.equal(timeline.stateMachine.timelineVersion, "v2");
  assert.ok(Array.isArray(timeline.stateMachine.statuses));
  assert.ok(Array.isArray(timeline.lineage.childJobIds));
  assert.ok(timeline.timeline.some((entry) => entry.type === "session_transition"));
  assert.ok(timeline.timeline.some((entry) => entry.type === "verification"));
  assert.ok(timeline.timeline.every((entry) => entry.correlationId === submitted.sessionId));
});

test("getAdminStatus surfaces recurring scheduler anomalies", async () => {
  const service = makePlatformService();
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
        packageCount: 1,
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
        datasetCount: 0,
        maxJobsPerRun: 2,
        maxOpenJobs: 20,
        currentOpenJobs: 4,
        lastRun: { candidateCount: 2, createdCount: 2, skipped: [], errors: [] }
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

  const status = await service.getAdminStatus();
  assert.equal(status.osvIngestion.packageCount, 1);
  assert.equal(status.openDataIngestion.query, "res_format:CSV");
  assert.equal(status.openDataIngestion.lastRun.createdCount, 2);
  assert.equal(status.standardsIngestion.specCount, 2);
  assert.equal(status.openApiIngestion.specCount, 1);
  assert.equal(status.providerOperations.github.label, "GitHub issues");
  assert.equal(status.providerOperations.github.mode, "dry_run");
  assert.equal(status.providerOperations.github.currentOpenJobs, 3);
  assert.equal(status.providerOperations.github.lastRun.createdCount, 1);
  assert.equal(status.providerOperations.github.lastRun.skippedCount, 1);
  assert.equal(status.providerOperations.github.lastRun.skipped[0].reason, "source_already_ingested");
  assert.equal(status.providerOperations.openData.mode, "live");
  assert.equal(status.providerOperations.openData.health, "healthy");
  assert.equal(status.providerOperations.openData.lastRun.summary, "2 candidate(s), 2 created, 0 skipped, 0 error(s)");
  assert.equal(status.providerOperations.openApi.health, "error");
  assert.equal(status.providerOperations.openApi.lastRun.errorCount, 1);
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
