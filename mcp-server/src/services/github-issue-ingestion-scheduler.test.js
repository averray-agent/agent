import test from "node:test";
import assert from "node:assert/strict";
import { CatalogueLaneDiscipline, loadCatalogueLaneRegistry } from "../core/catalogue-lane-discipline.js";
import { MemoryStateStore } from "../core/state-store.js";
import { PlatformService } from "../core/platform-service.js";
import { createJobsFromImportResult } from "../protocols/http/admin-job-import-routes.js";

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

const RETIRE_WALLET = `0x${"a".repeat(40)}`;
function retirementFixture(options = {}) {
  const job = {
    id: "upstream-retirement-fixture", category: "coding", tier: "starter",
    rewardAsset: "DOT", rewardAmount: 5, verifierMode: "benchmark", verifierTerms: ["complete"],
    verifierConfig: { version: 1, handler: "benchmark", requiredKeywords: ["complete"], minimumMatches: 1 },
    inputSchemaRef: "schema://jobs/coding-input", outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 3600, retryLimit: 1, requiresSponsoredGas: true, onboardingWaiverEligible: true,
    source: { type: "github_issue", repo: "example/project", issueNumber: 42 }
  };
  const store = new MemoryStateStore();
  const platform = new PlatformService([job], new Map([[RETIRE_WALLET, {
    wallet: RETIRE_WALLET, preferredCategories: ["coding"], verifierCompatibility: ["benchmark"],
    preferredRiskLevel: "low", capabilities: ["claim_job", "submit_work"], supportedProtocols: ["http"],
    minLiquidReserve: 0, autoUnwindStrategies: false
  }]]), new Map([[RETIRE_WALLET, {
    wallet: RETIRE_WALLET, liquid: { DOT: 10 }, reserved: {}, strategyAllocated: {},
    collateralLocked: {}, jobStakeLocked: {}, debtOutstanding: {}
  }]]), new Map([[RETIRE_WALLET, { skill: 50, reliability: 50, economic: 50, tier: "starter" }]]), undefined, store);
  const events = [];
  const scheduler = new GithubIssueIngestionScheduler(platform, { publish: (event) => events.push(event) }, {
    enabled: true, dryRun: false, queries: [], logger: { warn() {}, info() {} },
    fetchImpl: async () => Response.json({ state: "closed", state_reason: "not_planned" }), ...options
  });
  return { job, platform, store, scheduler, events };
}

test("closed not_planned upstream retires the claimable listing after one scheduler tick", async () => {
  const { job, platform, scheduler, events } = retirementFixture();
  assert.equal(platform.getClaimableJobDefinition(job.id).id, job.id);
  const summary = await scheduler.runOnce();
  assert.throws(() => platform.getClaimableJobDefinition(job.id), /not claimable/i);
  assert.equal(summary.retiredCount, 1);
  assert.equal(platform.listJobs().length, 0);
  assert.deepEqual(events.filter(({ topic }) => topic === "catalogue.upstream_retired").map(({ data }) => data), [{
    jobId: job.id, repo: "example/project", issueNumber: 42, closeReason: "not_planned"
  }]);
});

test("closed completed retires while open upstream remains claimable even at the add cap", async () => {
  for (const state of ["closed", "open"]) {
    const { job, platform, scheduler } = retirementFixture({ queries: ["unused"], maxOpenJobs: 1,
      fetchImpl: async () => Response.json({ state, state_reason: "completed" }) });
    const summary = await scheduler.runOnce();
    assert.equal(summary.skipped[0].reason, "max_open_jobs_reached");
    assert.equal(summary.retiredCount, state === "closed" ? 1 : 0);
    if (state === "open") assert.equal(platform.getClaimableJobDefinition(job.id).id, job.id);
    else assert.throws(() => platform.getClaimableJobDefinition(job.id), /not claimable/i);
  }
});

test("unknown upstream 403 500 timeout or malformed JSON retires exactly zero listings", async (t) => {
  for (const [name, fetchImpl] of Object.entries({
    forbidden: async () => new Response(null, { status: 403 }),
    server_error: async () => new Response(null, { status: 500 }),
    timeout: async () => new Promise(() => {}),
    malformed: async () => new Response("not json", { status: 200 }),
    missing_state: async () => Response.json({}),
    unknown_state: async () => Response.json({ state: "missing" }),
    network_error: async () => { throw new Error("network unavailable"); }
  })) {
    await t.test(name, async () => {
      const { job, platform, scheduler, events } = retirementFixture({ fetchImpl, retirementReadTimeoutMs: 5 });
      platform.createJob({ ...job, id: "second-listing" });
      const before = platform.listJobs();
      const summary = await scheduler.runOnce();
      assert.equal(summary.retiredCount, 0);
      assert.equal(summary.upstreamUnknownCount, 2);
      assert.deepEqual(platform.listJobs(), before);
      for (const listed of before) assert.equal(platform.getClaimableJobDefinition(listed.id).id, listed.id);
      assert.equal(events.filter(({ topic }) => topic === "catalogue.upstream_retired").length, 0);
    });
  }
});

test("upstream retirement preserves a held claim its TTL pinned terms and submission path", async () => {
  const { job, platform, store, scheduler } = retirementFixture();
  const claim = await platform.claimJob(RETIRE_WALLET, job.id, "http", "retirement-claim");
  const before = structuredClone(await store.getSession(claim.sessionId));
  assert.equal((await scheduler.runOnce()).retiredCount, 1);
  assert.deepEqual(await store.getSession(claim.sessionId), before);
  assert.throws(() => platform.getClaimableJobDefinition(job.id), /not claimable/i);
  const submitted = await platform.submitWork(claim.sessionId, "http", {
    summary: "Work complete before own PR closed upstream", output: "complete verified output", status: "complete"
  });
  assert.equal(submitted.sessionId, claim.sessionId);
  assert.equal((await store.getSession(claim.sessionId)).status, "submitted");
});

test("retire pass is bounded fair conditional and dry-run only reports intent", async () => {
  const calls = [];
  let closed = false;
  const { job, platform, scheduler, events } = retirementFixture({ dryRun: true, retirementBatchSize: 1,
    fetchImpl: async (url, { headers }) => {
      calls.push({ url, headers });
      if (headers["If-None-Match"] && !closed) return new Response(null, { status: 304 });
      return Response.json({ state: closed ? "closed" : "open" }, { headers: { etag: '"revision-1"' } });
    }
  });
  platform.createJob({ ...job, id: "second-listing", source: { ...job.source, issueNumber: 43 } });
  for (let i = 0; i < 3; i++) {
    const summary = await scheduler.runOnce();
    assert.equal(summary.upstreamCheckedCount, 1);
    assert.equal(summary.upstreamUnknownCount, 0);
  }
  assert.notEqual(calls[0].url, calls[1].url);
  assert.equal(calls[0].url, calls[2].url);
  assert.equal(calls[2].headers["If-None-Match"], '"revision-1"');
  closed = true;
  const summary = await scheduler.runOnce();
  assert.equal(summary.wouldRetireCount, 1);
  assert.equal(summary.retiredCount, 0);
  assert.equal(platform.listJobs().length, 2);
  assert.equal(events.length, 0);
  scheduler.enabled = false;
  assert.equal((await scheduler.runOnce()).upstreamCheckedCount, 0);
  assert.equal(calls.length, 4);
});

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

test("GitHub scheduler logs reserved headroom in summary.skipped while operator import still posts", async () => {
  const platform = makePlatformService();
  const now = new Date("2026-09-05T12:00:00.000Z");
  const logged = [];
  platform.catalogueLaneDiscipline = new CatalogueLaneDiscipline({
    stateStore: new MemoryStateStore(),
    registry: loadCatalogueLaneRegistry({}),
    gasEstimateUsdc: 0,
    now: () => now,
    logger: { info(details, reason) { logged.push({ details, reason }); } }
  });
  const scheduler = new GithubIssueIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    queries: ["is:issue is:open label:good-first-issue"],
    minScore: 55,
    maxJobsPerRun: 8,
    maxJobsPerQuery: 8,
    maxOpenJobs: 30,
    fetchImpl: makeFetch([ISSUE, { ...ISSUE, number: 43, html_url: "https://github.com/example/project/issues/43" }])
  });
  const summary = await scheduler.runOnce(now);
  assert.equal(summary.createdCount, 1);
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.skipped.length, 1);
  const refusal = summary.skipped[0];
  assert.equal(refusal.reason, "lane_scheduler_headroom_reserved");
  assert.equal(refusal.lane, "oss-anchored");
  assert.ok(refusal.id);
  assert.ok(refusal.retryWhen);
  assert.equal((await scheduler.getStatus()).lastRun, summary);
  assert.ok(logged.some(({ details, reason }) => reason === refusal.reason
    && details.withheldJobId === refusal.id && details.unclaimedCount === 1
    && details.operatorReserve === 2 && details.origin === "scheduler"));

  // Same github_issue source and verifier, different declared posting origin.
  const operatorJob = { ...platform.listJobs()[0], id: "operator-bundle", rewardAmount: 2 };
  const imported = await createJobsFromImportResult(platform, [operatorJob], { now });
  assert.deepEqual(imported.errors, []);
  assert.deepEqual(imported.skipped, []);
  assert.equal(imported.created[0].id, operatorJob.id);
  assert.equal(platform.listJobs().find(({ id }) => id !== operatorJob.id).rewardAmount, 0.2);
});

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

test("GithubIssueIngestionScheduler dedupes github_pr jobs by source repo and issue number", async () => {
  const existing = {
    id: "existing",
    verifierMode: "github_pr",
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

test("GithubIssueIngestionScheduler replaces a legacy benchmark for the same issue", async () => {
  const existing = {
    id: "oss-example-project-42-legacy-report",
    verifierMode: "benchmark",
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

  const summary = await scheduler.runOnce(new Date("2026-08-30T10:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
  assert.equal(platform.listJobs().length, 2, "create replacement before retiring legacy inventory");
  assert.ok(platform.listJobs().some((job) => job.id === "pr-example-project-42"));
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
