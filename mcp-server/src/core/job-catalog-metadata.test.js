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

test("job lifecycle hides paused, archived, and stale jobs from public discovery", async () => {
  const service = makeService();
  const now = new Date("2026-04-27T10:00:00.000Z");
  const open = service.createJob({
    ...BASE_JOB,
    id: "open-lifecycle-001",
    lifecycle: {
      createdAt: "2026-04-27T09:00:00.000Z",
      updatedAt: "2026-04-27T09:00:00.000Z",
      staleAt: "2026-05-11T09:00:00.000Z"
    }
  });
  service.createJob({
    ...BASE_JOB,
    id: "stale-lifecycle-001",
    lifecycle: {
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      staleAt: "2026-04-15T00:00:00.000Z"
    }
  });

  assert.equal(open.lifecycle.status, "open");
  assert.equal(open.lifecycle.staleAt, "2026-05-11T09:00:00.000Z");
  service.updateJobLifecycle("open-lifecycle-001", { action: "pause", reason: "waiting for provider fix" }, now);

  assert.deepEqual(service.listJobs({ now }).map((job) => job.id), []);
  assert.deepEqual(
    service.listJobs({ includePaused: true, includeStale: true, now }).map((job) => [job.id, job.lifecycle.state]),
    [
      ["stale-lifecycle-001", "stale"],
      ["open-lifecycle-001", "paused"]
    ]
  );

  const preflight = await service.preflightJob("0xagent", "open-lifecycle-001");
  assert.equal(preflight.eligible, false);
  assert.equal(preflight.lifecycle.state, "paused");
});

test("job lifecycle supports archival and claimability guardrails", () => {
  const service = makeService();
  service.createJob({
    ...BASE_JOB,
    id: "archive-lifecycle-001",
    lifecycle: {
      createdAt: "2026-04-27T09:00:00.000Z",
      updatedAt: "2026-04-27T09:00:00.000Z",
      staleAt: "2026-05-11T09:00:00.000Z"
    }
  });

  const archived = service.updateJobLifecycle("archive-lifecycle-001", {
    action: "archive",
    reason: "superseded"
  }, new Date("2026-04-27T10:00:00.000Z"));

  assert.equal(archived.lifecycle.state, "archived");
  assert.throws(
    () => service.getPublicJobDefinition("archive-lifecycle-001"),
    /Unknown job: archive-lifecycle-001/
  );
  assert.throws(
    () => service.getClaimableJobDefinition("archive-lifecycle-001"),
    /not claimable/
  );
  assert.deepEqual(service.getJobLifecycleSummary(), {
    total: 1,
    open: 0,
    claimable: 0,
    stale: 0,
    paused: 0,
    archived: 1
  });
});

test("createJob accepts github_pr verifier configuration", () => {
  const service = makeService();
  const job = service.createJob({
    ...BASE_JOB,
    id: "github-pr-evidence-001",
    verifierMode: "github_pr",
    verifierTerms: undefined,
    outputSchemaRef: "schema://jobs/github-pr-evidence-output",
    verifierMinimumScore: 70
  });

  assert.equal(job.verifierMode, "github_pr");
  assert.equal(job.verifierConfig.handler, "github_pr");
  assert.equal(job.verifierConfig.minimumScore, 70);
});

test("public Wikipedia definitions include direct agent affordances", () => {
  const service = makeService();
  service.createJob({
    ...BASE_JOB,
    id: "wiki-en-123-citation-repair-example",
    title: "Wikipedia citation repair: Example article",
    category: "wikipedia",
    jobType: "review",
    outputSchemaRef: "schema://jobs/wikipedia-citation-repair-output",
    acceptanceCriteria: ["Names the page and revision.", "Does not edit Wikipedia directly."],
    source: {
      type: "wikipedia_article",
      project: "wikipedia",
      language: "en",
      pageId: 123,
      pageTitle: "Example article",
      pageUrl: "https://en.wikipedia.org/wiki/Example_article",
      revisionId: "987654321",
      taskType: "citation_repair",
      attribution: {
        directEdit: false
      }
    }
  });

  const job = service.getPublicJobDefinition("wiki-en-123-citation-repair-example");

  assert.deepEqual(job.publicDetails, {
    jobId: "wiki-en-123-citation-repair-example",
    source: "wikipedia",
    taskType: "citation_repair",
    pageTitle: "Example article",
    lang: "en",
    revisionId: "987654321",
    articleUrl: "https://en.wikipedia.org/wiki/Example_article",
    pinnedRevisionUrl: "https://en.wikipedia.org/w/index.php?title=Example_article&oldid=987654321",
    acceptanceCriteria: ["Names the page and revision.", "Does not edit Wikipedia directly."],
    outputSchemaRef: "schema://jobs/wikipedia-citation-repair-output",
    outputSchemaUrl: "/schemas/jobs/wikipedia-citation-repair-output.json",
    proposalOnly: true,
    attributionPolicy: "Averray proposal only / no direct Wikipedia edit"
  });
  assert.equal(job.submissionContract.endpoint, "POST /jobs/submit");
  assert.equal(job.submissionContract.validationEndpoint, "POST /jobs/validate-submission");
  assert.equal(job.submissionContract.submissionShape, "direct_schema_object");
  assert.equal(job.submissionContract.structuredSubmissionRequired, true);
  assert.equal(job.submissionContract.schemaValidates, "payload.submission");
  assert.equal(job.submissionContract.doNotWrapInOutput, true);
  assert.deepEqual(job.submissionContract.compatibilityAliases, ["payload.submission.output"]);
  assert.equal(job.submissionContract.submitPayloadExample.sessionId, "<session-id>");
  assert.deepEqual(Object.keys(job.submissionContract.submitPayloadExample.submission), [
    "page_title",
    "revision_id",
    "citation_findings",
    "proposed_changes",
    "review_notes"
  ]);
  assert.equal(job.submissionContract.submitPayloadExample.submission.page_title, "Example article");
  assert.equal(job.schemaContract.output.validationEndpoint, "POST /jobs/validate-submission");
  assert.equal(job.schemaContract.output.validates, "payload.submission");
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
