import test from "node:test";
import assert from "node:assert/strict";

import { ValidationError } from "./errors.js";
import { JobExecutionService } from "./job-execution-service.js";
import { MemoryStateStore } from "./state-store.js";
import { computeClaimEconomics } from "./claim-economics.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeJob(overrides = {}) {
  return {
    id: "pr-review-job-001",
    category: "review",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: 6,
    verifierMode: "benchmark",
    verifierConfig: {
      version: 1,
      handler: "benchmark",
      requiredKeywords: ["summary", "findings", "risk_level"],
      minimumMatches: 2
    },
    outputSchemaRef: "schema://jobs/pr-review-findings-output",
    claimTtlSeconds: 3600,
    ...overrides
  };
}

test("submitWork accepts structured output for built-in schemas", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob();
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-1");
  const submitted = await service.submitWork(claimed.sessionId, "http", {
    summary: "Auth flow has one blocker.",
    findings: [
      {
        severity: "high",
        file: "frontend/auth.js",
        issue: "Session refresh is hidden behind retry logic.",
        recommendation: "Show a visible sign-in refresh path."
      }
    ],
    risk_level: "high",
    files_touched: ["frontend/auth.js"],
    recommended_next_step: "request_changes"
  });

  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.submission.kind, "structured");
  assert.equal(submitted.statusHistory.length, 2);
  assert.equal(submitted.statusHistory[1].metadata.schemaRef, "schema://jobs/pr-review-findings-output");
});

test("submitWork rejects structured output when the schema ref is unknown", async () => {
  const stateStore = new MemoryStateStore();
  const job = makeJob({ outputSchemaRef: "schema://jobs/custom-output" });
  const service = new JobExecutionService(stateStore, undefined, () => job);

  const claimed = await service.claimJob(WALLET, job.id, "http", "idemp-2");

  await assert.rejects(
    () => service.submitWork(claimed.sessionId, "http", { anything: "goes" }),
    (error) => error instanceof ValidationError && /known built-in schema/.test(error.message)
  );
});

test("computeClaimEconomics waives first three claims and then applies stake plus fee", () => {
  const waived = computeClaimEconomics({
    rewardAmount: 5,
    rewardAsset: "DOT",
    priorClaimCount: 2,
    claimStakeBps: 1000,
    minClaimFeeByAsset: { DOT: 0.05 }
  });
  assert.equal(waived.claimEconomicsWaived, true);
  assert.equal(waived.totalClaimLock, 0);

  const paid = computeClaimEconomics({
    rewardAmount: 5,
    rewardAsset: "DOT",
    priorClaimCount: 3,
    claimStakeBps: 1000,
    minClaimFeeByAsset: { DOT: 0.05 }
  });
  assert.equal(paid.claimEconomicsWaived, false);
  assert.equal(paid.claimStake, 0.5);
  assert.equal(paid.claimFee, 0.1);
  assert.equal(paid.totalClaimLock, 0.6);

  const floorBound = computeClaimEconomics({
    rewardAmount: 1,
    rewardAsset: "DOT",
    priorClaimCount: 3,
    claimStakeBps: 1000,
    minClaimFeeByAsset: { DOT: 0.05 }
  });
  assert.equal(floorBound.claimFee, 0.05);
});

test("claimJob records onboarding waiver and claim fee economics on sessions", async () => {
  const stateStore = new MemoryStateStore();
  const jobs = new Map(
    Array.from({ length: 4 }, (_, index) => {
      const job = makeJob({ id: `job-${index + 1}`, rewardAmount: 5 });
      return [job.id, job];
    })
  );
  const service = new JobExecutionService(
    stateStore,
    undefined,
    (jobId) => jobs.get(jobId),
    undefined,
    undefined,
    async () => 1000,
    (jobId) => jobs.get(jobId),
    async () => ({ minClaimFeeByAsset: { DOT: 0.05 } })
  );

  for (let index = 0; index < 3; index++) {
    const session = await service.claimJob(WALLET, `job-${index + 1}`, "http", `idemp-waived-${index}`);
    assert.equal(session.claimEconomicsWaived, true);
    assert.equal(session.totalClaimLock, 0);
    assert.equal(session.claimNumber, index + 1);
  }

  const paid = await service.claimJob(WALLET, "job-4", "http", "idemp-paid");
  assert.equal(paid.claimEconomicsWaived, false);
  assert.equal(paid.claimNumber, 4);
  assert.equal(paid.claimStake, 0.5);
  assert.equal(paid.claimFee, 0.1);
  assert.equal(paid.totalClaimLock, 0.6);
});
