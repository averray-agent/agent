import test from "node:test";
import assert from "node:assert/strict";

import {
  GithubIssueIngestionScheduler,
  loadGithubIssueIngestionConfig
} from "./github-issue-ingestion-scheduler.js";

const ISSUE = {
  title: "Add tests for parser validation error",
  body: "Add a regression test for the invalid parser edge case and improve the validation error.",
  number: 42,
  html_url: "https://github.com/example/project/issues/42",
  repository_url: "https://api.github.com/repos/example/project",
  labels: [
    { name: "good first issue" },
    { name: "help wanted" },
    { name: "tests" }
  ],
  comments: 2,
  locked: false
};

function makeFetch(issues = [ISSUE]) {
  return async () => ({
    ok: true,
    async json() {
      return { items: issues };
    }
  });
}

function makePlatformService(initialJobs = []) {
  const jobs = [...initialJobs];
  return {
    listJobs() {
      return [...jobs];
    },
    createJob(job) {
      jobs.unshift(job);
      return job;
    },
    getJobDefinition(jobId) {
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (!job) {
        throw new Error("not found");
      }
      return job;
    }
  };
}

function specHashRefusal(jobId) {
  const error = new Error("refreshed definition does not match the commitment");
  error.code = "ingest_refused_spec_hash_mismatch";
  error.details = {
    jobId,
    committedSpecHash: `0x${"ab".repeat(32)}`,
    candidateSpecHash: `0x${"cd".repeat(32)}`,
    legacyDrift: true,
    recovery: "operator_tombstone_rescue_after_review_window"
  };
  return error;
}

test("GithubIssueIngestionScheduler dry-run does not create jobs", async () => {
  const platform = makePlatformService();
  const scheduler = new GithubIssueIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: true,
    queries: ["is:issue is:open label:good-first-issue"],
    minScore: 55,
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-24T10:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
  assert.equal(platform.listJobs().length, 0);
  assert.equal((await scheduler.getStatus()).lastRun.dryRun, true);
});

test("GithubIssueIngestionScheduler creates jobs when dryRun is false", async () => {
  const platform = makePlatformService();
  const scheduler = new GithubIssueIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    queries: ["is:issue is:open label:good-first-issue"],
    minScore: 55,
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-24T10:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
  assert.equal(platform.listJobs().length, 1);
  assert.equal(platform.listJobs()[0].source.issueNumber, 42);
});

test("GithubIssueIngestionScheduler parks a poisoned legacy job and still mints fresh A and B", async () => {
  const jobs = [];
  const logLines = [];
  const platform = {
    listJobs() {
      return [...jobs];
    },
    getJobDefinition(jobId) {
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (!job) throw new Error("not found");
      return job;
    },
    async upsertIngestedJob(job) {
      if (job.source.issueNumber === 1) throw specHashRefusal(job.id);
      jobs.unshift(job);
      return job;
    }
  };
  const issues = [1, 2, 3].map((number) => ({
    ...ISSUE,
    number,
    html_url: `https://github.com/example/project/issues/${number}`
  }));
  const scheduler = new GithubIssueIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    queries: ["is:issue is:open label:good-first-issue"],
    minScore: 55,
    maxJobsPerRun: 2,
    maxJobsPerQuery: 2,
    fetchImpl: makeFetch(issues),
    logger: {
      info(payload, event) { logLines.push({ payload, event }); },
      warn() {}
    }
  });

  const summary = await scheduler.runOnce(new Date("2026-08-23T10:00:00.000Z"));
  const parked = summary.skipped.find((entry) => entry.reason === "ingest_refused_spec_hash_mismatch");

  assert.equal(summary.createdCount, 2);
  assert.equal(summary.queries[0].created, 2);
  assert.equal(summary.parkedSpecHashRefusals, 1);
  assert.equal(summary.errors.length, 0);
  assert.deepEqual(jobs.map((job) => job.source.issueNumber).sort(), [2, 3]);
  assert.equal(parked.jobId, "oss-example-project-1-add-tests-for-parser-validation-error");
  assert.equal(parked.recovery, "operator_tombstone_rescue_after_review_window");
  assert.equal((await scheduler.getStatus()).parkedSpecHashRefusals, 1);
  assert.deepEqual(logLines.at(-1), {
    event: "github_ingest.run_complete",
    payload: {
      startedAt: "2026-08-23T10:00:00.000Z",
      finishedAt: summary.finishedAt,
      candidateCount: 3,
      createdCount: 2,
      skippedCount: 1,
      errorCount: 0,
      parkedSpecHashRefusals: 1
    }
  });
});

test("GithubIssueIngestionScheduler dedupes by source repo and issue number", async () => {
  const existing = {
    id: "existing",
    source: {
      type: "github_issue",
      repo: "example/project",
      issueNumber: 42
    }
  };
  const platform = makePlatformService([existing]);
  const scheduler = new GithubIssueIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    queries: ["is:issue is:open label:good-first-issue"],
    minScore: 55,
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-24T10:00:00.000Z"));
  assert.equal(summary.createdCount, 0);
  assert.equal(platform.listJobs().length, 1);
  assert.equal(summary.queries[0].skipped[0].reason, "source_already_ingested");
});

test("GithubIssueIngestionScheduler stops when max open GitHub jobs is reached", async () => {
  const platform = makePlatformService([
    { id: "a", source: { type: "github_issue", repo: "example/a", issueNumber: 1 } }
  ]);
  const scheduler = new GithubIssueIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    queries: ["is:issue is:open label:good-first-issue"],
    maxOpenJobs: 1,
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-24T10:00:00.000Z"));
  assert.equal(summary.createdCount, 0);
  assert.equal(summary.skipped[0].reason, "max_open_jobs_reached");
});

test("GithubIssueIngestionScheduler caps noisy queries within a run", async () => {
  const platform = makePlatformService();
  const scheduler = new GithubIssueIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    queries: ["q1", "q2"],
    minScore: 55,
    maxJobsPerRun: 8,
    maxJobsPerQuery: 2,
    fetchImpl: async (url) => {
      const query = new URL(url).searchParams.get("q") ?? "";
      const offset = query.includes("q2") ? 100 : 0;
      return {
        ok: true,
        async json() {
          return {
            items: Array.from({ length: 5 }, (_, index) => ({
              ...ISSUE,
              number: offset + index + 1,
              html_url: `https://github.com/example/project/issues/${offset + index + 1}`
            }))
          };
        }
      };
    }
  });

  const summary = await scheduler.runOnce(new Date("2026-04-24T10:00:00.000Z"));
  assert.equal(summary.createdCount, 4);
  assert.equal(platform.listJobs().length, 4);
  assert.deepEqual(summary.queries.map((query) => query.created), [2, 2]);
  assert.deepEqual(summary.queries.map((query) => query.maxJobsPerQuery), [2, 2]);
});

test("loadGithubIssueIngestionConfig parses env knobs safely", () => {
  const config = loadGithubIssueIngestionConfig({
    GITHUB_INGEST_ENABLED: "true",
    GITHUB_INGEST_DRY_RUN: "false",
    GITHUB_INGEST_INTERVAL_MS: "900000",
    GITHUB_INGEST_MIN_SCORE: "80",
    GITHUB_INGEST_MAX_JOBS_PER_RUN: "3",
    GITHUB_INGEST_MAX_JOBS_PER_QUERY: "2",
    GITHUB_INGEST_MAX_OPEN_JOBS: "12",
    GITHUB_INGEST_OPEN_PR_CAP: "4",
    GITHUB_INGEST_POLICY_SCAN_ENABLED: "true",
    GITHUB_INGEST_DENYLIST_REPOS: "example/project",
    GITHUB_INGEST_QUERIES_JSON: '["q1","q2"]',
    GITHUB_TOKEN: "ghp_test"
  });

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.intervalMs, 900000);
  assert.equal(config.minScore, 80);
  assert.equal(config.maxJobsPerRun, 3);
  assert.equal(config.maxJobsPerQuery, 2);
  assert.equal(config.maxOpenJobs, 12);
  assert.equal(config.openPrCap, 4);
  assert.equal(config.scanRepoPolicies, true);
  assert.ok(config.denylistRepos.includes("example/project"));
  assert.deepEqual(config.queries, ["q1", "q2"]);
  assert.equal(config.githubToken, "ghp_test");
});
