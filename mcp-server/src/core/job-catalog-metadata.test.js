import test from "node:test";
import assert from "node:assert/strict";

import {
  JobCatalogService,
  ROLE_REQUIREMENTS,
  roleRequirements,
  summarizeRoleGate
} from "./job-catalog-service.js";

function makeService(reputation = { skill: 0, reliability: 0, economic: 0, tier: "starter" }) {
  const jobs = [];
  const profiles = new Map();
  const account = async () => ({ liquid: { DOT: 100 } });
  const getReputation = async () => reputation;
  const bps = async () => 500;
  return new JobCatalogService(jobs, profiles, account, getReputation, bps);
}

const BASE_JOB = {
  id: "github-issue-review-001",
  category: "coding",
  tier: "starter",
  rewardAmount: 1,
  verifierMode: "benchmark",
  verifierTerms: ["github", "tests", "pr"],
  verifierMinimumMatches: 2,
  inputSchemaRef: "schema://jobs/coding-input",
  outputSchemaRef: "schema://jobs/coding-output",
  claimTtlSeconds: 3600,
  retryLimit: 1
};

test("createJob preserves autonomous work metadata", () => {
  const service = makeService();
  const job = service.createJob({
    ...BASE_JOB,
    title: "Add parser regression tests",
    description: "GitHub issue context goes here.",
    jobType: "review",
    requiredRole: "reviewer",
    source: {
      type: "github_issue",
      repo: "example/project",
      issueNumber: 123,
      issueUrl: "https://github.com/example/project/issues/123",
      labels: ["good first issue", "tests"],
      score: 88
    },
    acceptanceCriteria: ["Open a focused PR", "Relevant tests pass"],
    estimatedDifficulty: "starter",
    agentInstructions: ["Keep the patch narrow."],
    verification: {
      method: "github_pr",
      signals: ["pr_opened", "ci_passed", "merged"]
    }
  });

  assert.equal(job.title, "Add parser regression tests");
  assert.equal(job.jobType, "review");
  assert.equal(job.requiredRole, "reviewer");
  assert.equal(job.source.repo, "example/project");
  assert.deepEqual(job.acceptanceCriteria, ["Open a focused PR", "Relevant tests pass"]);
  assert.equal(job.verification.method, "github_pr");
});

test("jobs default to worker work when role fields are omitted", () => {
  const service = makeService();
  const job = service.createJob(BASE_JOB);
  assert.equal(job.jobType, "work");
  assert.equal(job.requiredRole, "worker");
});

test("reviewer role gate blocks low-score agents", async () => {
  const service = makeService({ skill: 60, reliability: 0, economic: 0, tier: "starter" });
  service.createJob({
    ...BASE_JOB,
    jobType: "review",
    requiredRole: "reviewer"
  });

  const preflight = await service.preflightJob("0xagent", BASE_JOB.id);
  assert.equal(preflight.eligible, false);
  assert.equal(preflight.roleGate.role, "reviewer");
  assert.deepEqual(preflight.roleGate.missing, { skill: 40 });
});

test("ROLE_REQUIREMENTS exposes autonomy unlock thresholds", () => {
  assert.deepEqual(ROLE_REQUIREMENTS, {
    worker: { skill: 0 },
    curator: { skill: 50 },
    reviewer: { skill: 100 },
    publisher: { skill: 200 },
    verifier: { skill: 300 },
    arbitrator: { skill: 500 }
  });
  assert.deepEqual(roleRequirements("publisher"), { skill: 200 });
  assert.equal(summarizeRoleGate("curator", { skill: 75 }).unlocked, true);
  assert.deepEqual(summarizeRoleGate("verifier", { skill: 225 }).missing, { skill: 75 });
});
