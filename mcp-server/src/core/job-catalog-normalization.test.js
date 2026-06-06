import test from "node:test";
import assert from "node:assert/strict";

import { ValidationError } from "./errors.js";
import {
  buildVerifierConfig,
  normalizeJobId,
  normalizeJobInput,
  normaliseDelegationPolicy,
  normaliseLifecycle,
  normaliseRecurringPolicy,
  validateSchemaRef
} from "./job-catalog-normalization.js";

const BASE_JOB = {
  id: " GitHub Issue Review 001 ",
  category: " Coding ",
  tier: "starter",
  rewardAmount: 1.5,
  verifierMode: "benchmark",
  verifierTerms: ["github", "tests", "pr"],
  verifierMinimumMatches: 2,
  inputSchemaRef: "schema://jobs/coding-input",
  outputSchemaRef: "schema://jobs/coding-output",
  lifecycle: {
    createdAt: "2026-05-01T12:00:00.000Z"
  }
};

test("normalizeJobInput returns the canonical job record shape", () => {
  const job = normalizeJobInput({
    ...BASE_JOB,
    jobType: "review",
    requiredRole: "reviewer",
    rewardAsset: "usdc",
    source: { type: "github_issue", repo: "example/project" },
    acceptanceCriteria: [" Open a PR ", "", "Run tests"],
    agentInstructions: ["Keep the patch narrow."],
    delegationPolicy: {
      maxDepth: 1,
      maxSubJobs: 2,
      budgetAmount: 1,
      budgetAsset: "USDC"
    }
  });

  assert.equal(job.id, "github-issue-review-001");
  assert.equal(job.category, "coding");
  assert.equal(job.rewardAsset, "USDC");
  assert.equal(job.jobType, "review");
  assert.equal(job.requiredRole, "reviewer");
  assert.deepEqual(job.acceptanceCriteria, ["Open a PR", "Run tests"]);
  assert.deepEqual(job.source, { type: "github_issue", repo: "example/project" });
  assert.deepEqual(job.delegationPolicy, {
    maxDepth: 1,
    maxSubJobs: 2,
    budgetAmount: 1,
    budgetAsset: "USDC"
  });
  assert.deepEqual(job.verifierConfig, {
    version: 1,
    handler: "benchmark",
    requiredKeywords: ["github", "tests", "pr"],
    minimumMatches: 2
  });
  assert.equal(job.lifecycle.createdAt, "2026-05-01T12:00:00.000Z");
  assert.equal(job.lifecycle.staleAt, "2026-05-15T12:00:00.000Z");
});

test("normalizeJobInput preserves recurring schedule and finite reserve policy", () => {
  const job = normalizeJobInput({
    ...BASE_JOB,
    id: "weekly-digest",
    rewardAmount: 5,
    recurring: true,
    schedule: { cron: "0 9 * * 1", timezone: "Europe/Zurich" },
    recurringPolicy: { maxRuns: 3 }
  });

  assert.equal(job.recurring, true);
  assert.deepEqual(job.schedule, { cron: "0 9 * * 1", timezone: "Europe/Zurich" });
  assert.deepEqual(job.recurringPolicy, {
    maxRuns: 3,
    reserveAmount: 15,
    reserveAsset: "USDC"
  });
  assert.equal(job.lifecycle.staleAt, undefined);
});

test("buildVerifierConfig supports deterministic, github_pr, and human fallback modes", () => {
  assert.deepEqual(
    buildVerifierConfig("deterministic", {
      verifierTerms: ["expected output"],
      verifierMatchMode: "exact"
    }),
    {
      version: 1,
      handler: "deterministic",
      expectedOutputs: ["expected output"],
      matchMode: "exact"
    }
  );
  assert.deepEqual(
    buildVerifierConfig("github_pr", { verifierMinimumScore: 70, requireTestEvidence: false }),
    {
      version: 1,
      handler: "github_pr",
      minimumScore: 70,
      requireIssueReference: true,
      requireTestEvidence: false,
      acceptMergedAsApproved: true
    }
  );
  assert.deepEqual(
    buildVerifierConfig("human_fallback", { escalationMessage: "Please review.", autoApprove: true }),
    {
      version: 1,
      handler: "human_fallback",
      escalationMessage: "Please review.",
      autoApprove: true
    }
  );
});

test("policy helpers reject invalid budget, reserve, lifecycle, and schema shapes", () => {
  assert.throws(
    () => normaliseDelegationPolicy({ budgetAmount: 2 }, { rewardAmount: 1, rewardAsset: "DOT" }),
    (err) => err instanceof ValidationError && /cannot exceed rewardAmount/.test(err.message)
  );
  assert.throws(
    () => normaliseRecurringPolicy({ reserveAmount: 4 }, { recurring: true, rewardAmount: 5, rewardAsset: "DOT" }),
    (err) => err instanceof ValidationError && /cover at least one run/.test(err.message)
  );
  assert.throws(
    () => normaliseLifecycle({ status: "closed" }),
    (err) => err instanceof ValidationError && /Invalid job lifecycle status/.test(err.message)
  );
  assert.throws(
    () => validateSchemaRef("https://example.com/schema.json", "outputSchemaRef"),
    (err) => err instanceof ValidationError && /schema:\/\/jobs/.test(err.message)
  );
});

test("normalizeJobId preserves the catalog slug semantics", () => {
  assert.equal(normalizeJobId("  Some Job: 123 "), "some-job-123");
  assert.equal(normalizeJobId("!!!"), "");
});
