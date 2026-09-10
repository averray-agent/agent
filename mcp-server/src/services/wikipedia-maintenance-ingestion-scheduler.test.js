import test from "node:test";
import assert from "node:assert/strict";

import {
  WikipediaMaintenanceIngestionScheduler,
  loadWikipediaMaintenanceIngestionConfig
} from "./wikipedia-maintenance-ingestion-scheduler.js";
import { DEFAULT_CATALOGUE_LANE_REGISTRY, validateCatalogueLaneRegistry } from "../core/catalogue-lane-discipline.js";
import { JobCatalogService } from "../core/job-catalog-service.js";

const GENERATED_WIKI_JOB_ID = "wiki-en-123-citation_repair-example-article";
const CANONICAL_WIKI_JOB_ID = "wiki-en-123-citation-repair-example-article";
const SILENT_LOGGER = {
  info() {},
  warn() {}
};

function makeFetch() {
  return async (url) => {
    if (String(url).includes("list=categorymembers")) {
      return jsonResponse({
        query: {
          categorymembers: [{ pageid: 123, ns: 0, title: "Example article" }]
        }
      });
    }
    return jsonResponse({
      query: {
        pages: {
          123: {
            pageid: 123,
            title: "Example article",
            fullurl: "https://en.wikipedia.org/wiki/Example_article",
            revisions: [{ revid: 987654321, timestamp: "2026-04-25T10:00:00Z" }],
            templates: [{ title: "Template:Dead link" }]
          }
        }
      }
    });
  };
}

function makeMultiArticleFetch(articles) {
  return async (url) => {
    const requestUrl = new URL(url);
    if (requestUrl.searchParams.get("list") === "categorymembers") {
      return jsonResponse({
        query: {
          categorymembers: articles.map((article) => ({
            pageid: article.pageId,
            ns: 0,
            title: article.title
          }))
        }
      });
    }
    const pageId = Number(requestUrl.searchParams.get("pageids"));
    const article = articles.find((candidate) => candidate.pageId === pageId);
    return jsonResponse({
      query: {
        pages: {
          [pageId]: {
            pageid: pageId,
            title: article.title,
            fullurl: `https://en.wikipedia.org/wiki/${encodeURIComponent(article.title)}`,
            revisions: [{
              revid: article.revisionId,
              timestamp: "2026-08-23T08:00:00Z"
            }],
            templates: [{ title: "Template:Dead link" }]
          }
        }
      }
    });
  };
}

// Only these isolated tests supply a review consumer; production remains blocked.
function testConsumer() {
  return { registry: validateCatalogueLaneRegistry({
    ...DEFAULT_CATALOGUE_LANE_REGISTRY,
    "benchmark-showcase": { ...DEFAULT_CATALOGUE_LANE_REGISTRY["benchmark-showcase"], consumer: "Test reviewer applies the proposal." }
  }) };
}

function makePlatformService(initialJobs = []) {
  const jobs = [...initialJobs];
  return {
    catalogueLaneDiscipline: testConsumer(),
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
    },
    async listJobsWithSessions() {
      return [...jobs];
    }
  };
}

test("consumer pin: Wikipedia refuses live and dry-run ingestion without a review-and-apply consumer", async () => {
  for (const dryRun of [false, true]) {
    const platform = makePlatformService();
    delete platform.catalogueLaneDiscipline;
    const scheduler = new WikipediaMaintenanceIngestionScheduler(platform, undefined, {
      enabled: true, dryRun,
      categories: [{ title: "Category:All articles with dead external links", taskType: "citation_repair" }],
      minScore: 55, fetchImpl: makeFetch(), logger: SILENT_LOGGER
    });
    const summary = await scheduler.runOnce(new Date("2026-04-25T10:00:00.000Z"));
    assert.equal(summary.createdCount, 0);
    assert.equal(summary.skipped[0].reason, "lane_consumer_none");
    assert.equal(platform.listJobs().length, 0);
  }
});

test("WikipediaMaintenanceIngestionScheduler dry-run does not create jobs", async () => {
  const platform = makePlatformService();
  const scheduler = new WikipediaMaintenanceIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: true,
    categories: [{ title: "Category:All articles with dead external links", taskType: "citation_repair" }],
    minScore: 55,
    fetchImpl: makeFetch(),
    logger: SILENT_LOGGER
  });

  const summary = await scheduler.runOnce(new Date("2026-04-25T10:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
  assert.equal(platform.listJobs().length, 0);
  assert.equal((await scheduler.getStatus()).lastRun.dryRun, true);
});

test("WikipediaMaintenanceIngestionScheduler creates jobs when dryRun is false", async () => {
  const platform = makePlatformService();
  const scheduler = new WikipediaMaintenanceIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    categories: [{ title: "Category:All articles with dead external links", taskType: "citation_repair" }],
    minScore: 55,
    fetchImpl: makeFetch(),
    logger: SILENT_LOGGER
  });

  const summary = await scheduler.runOnce(new Date("2026-04-25T10:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
  assert.equal(platform.listJobs().length, 1);
  assert.equal(platform.listJobs()[0].source.type, "wikipedia_article");
  assert.equal(platform.listJobs()[0].onboardingWaiverEligible, true);
});

test("ingestion parks a poisoned legacy candidate and still mints both fresh jobs", async () => {
  const committedSpecHash = `0x${"ab".repeat(32)}`;
  const candidateSpecHash = `0x${"cd".repeat(32)}`;
  const jobs = [];
  const attemptedIds = [];
  const platform = {
    catalogueLaneDiscipline: testConsumer(),
    listJobs() { return [...jobs]; },
    async listJobsWithSessions() { return [...jobs]; },
    async upsertIngestedJob(job) {
      attemptedIds.push(job.id);
      if (job.id.includes("poisoned-legacy")) {
        const error = new Error("refreshed definition does not match the commitment");
        error.code = "ingest_refused_spec_hash_mismatch";
        error.details = { committedSpecHash, candidateSpecHash };
        throw error;
      }
      jobs.unshift(job);
      return job;
    }
  };
  const scheduler = new WikipediaMaintenanceIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    minClaimableJobs: 2,
    maxJobsPerRun: 2,
    categories: [{ title: "Category:All articles with dead external links", taskType: "citation_repair" }],
    minScore: 55,
    fetchImpl: makeMultiArticleFetch([
      { pageId: 101, title: "Poisoned legacy", revisionId: 1001 },
      { pageId: 102, title: "Fresh A", revisionId: 1002 },
      { pageId: 103, title: "Fresh B", revisionId: 1003 }
    ]),
    logger: SILENT_LOGGER
  });

  const summary = await scheduler.runOnce(new Date("2026-08-23T08:00:00.000Z"));

  assert.equal(summary.createdCount, 2);
  assert.equal(summary.ingestRefusedSpecHashMismatchCount, 1);
  assert.deepEqual(summary.errors, []);
  assert.deepEqual(summary.skipped.at(-1), {
    id: "wiki-en-101-citation-repair-poisoned-legacy",
    reason: "ingest_refused_spec_hash_mismatch",
    committedSpecHash,
    candidateSpecHash
  });
  assert.deepEqual(
    jobs.map((job) => job.id).sort(),
    [
      "wiki-en-102-citation-repair-fresh-a",
      "wiki-en-103-citation-repair-fresh-b"
    ]
  );
  assert.equal(new Set(attemptedIds).size, attemptedIds.length, "a parked id is never re-selected");
});

test("WikipediaMaintenanceIngestionScheduler dedupes by article revision", async () => {
  const platform = makePlatformService([
    {
      id: "existing",
      source: {
        type: "wikipedia_article",
        language: "en",
        pageId: 123,
        revisionId: "987654321",
        taskType: "citation_repair"
      }
    }
  ]);
  const scheduler = new WikipediaMaintenanceIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    categories: [{ title: "Category:All articles with dead external links", taskType: "citation_repair" }],
    minScore: 55,
    fetchImpl: makeFetch(),
    logger: SILENT_LOGGER
  });

  const summary = await scheduler.runOnce(new Date("2026-04-25T10:00:00.000Z"));
  assert.equal(summary.createdCount, 0);
  assert.equal(platform.listJobs().length, 1);
  assert.equal(summary.skipped[0].reason, "source_already_ingested");
});

test("WikipediaMaintenanceIngestionScheduler skips replenishment when minimum claimable inventory is satisfied", async () => {
  const platform = makePlatformService([
    claimableWikipediaJob("wiki-1", 1),
    claimableWikipediaJob("wiki-2", 2)
  ]);
  const scheduler = new WikipediaMaintenanceIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    minClaimableJobs: 2,
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    },
    logger: SILENT_LOGGER
  });

  const summary = await scheduler.runOnce(new Date("2026-04-25T10:00:00.000Z"));

  assert.equal(summary.createdCount, 0);
  assert.equal(summary.claimableWikipediaJobs, 2);
  assert.equal(summary.skipped[0].reason, "minimum_claimable_satisfied");
});

test("WikipediaMaintenanceIngestionScheduler reissues exhausted source jobs only after the cooldown", async () => {
  const platform = makePlatformService([
    {
      ...claimableWikipediaJob(GENERATED_WIKI_JOB_ID, 123),
      claimable: false,
      effectiveState: "exhausted",
      completedAt: "2026-03-25T10:00:00.000Z",
      claimState: "exhausted",
      reason: "retry_limit_exhausted"
    }
  ]);
  const scheduler = new WikipediaMaintenanceIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    minClaimableJobs: 1,
    categories: [{ title: "Category:All articles with dead external links", taskType: "citation_repair" }],
    minScore: 55,
    fetchImpl: makeFetch(),
    logger: SILENT_LOGGER
  });

  const summary = await scheduler.runOnce(new Date("2026-04-25T10:00:00.000Z"));
  const jobs = platform.listJobs();

  assert.equal(summary.createdCount, 1);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].id, `${CANONICAL_WIKI_JOB_ID}-r2`);
  assert.equal(jobs[0].source.reissueOf, CANONICAL_WIKI_JOB_ID);
  assert.equal(jobs[0].source.reissueReason, "inventory_replenishment");
  assert.equal(jobs[1].effectiveState, "exhausted");
});

test("WikipediaMaintenanceIngestionScheduler avoids hidden stale job id collisions", async () => {
  const catalog = new JobCatalogService(
    [{
      id: GENERATED_WIKI_JOB_ID,
      category: "wikipedia",
      tier: "starter",
      lifecycle: {
        status: "open",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
        staleAt: "2026-04-15T00:00:00.000Z"
      },
      source: {
        type: "wikipedia_article",
        language: "en",
        pageId: 123,
        revisionId: "987654321",
        taskType: "citation_repair"
      }
    }],
    [],
    () => ({}),
    () => ({}),
    () => 0
  );
  const platform = {
    catalogueLaneDiscipline: testConsumer(),
    listJobs(options = {}) {
      return catalog.listJobs(options);
    },
    createJob(job) {
      return catalog.createJob(job);
    }
  };
  const scheduler = new WikipediaMaintenanceIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    minClaimableJobs: 1,
    categories: [{ title: "Category:All articles with dead external links", taskType: "citation_repair" }],
    minScore: 55,
    fetchImpl: makeFetch(),
    logger: SILENT_LOGGER
  });

  const summary = await scheduler.runOnce(new Date("2026-04-25T10:00:00.000Z"));
  const jobs = catalog.listJobs({ includeStale: true });

  assert.equal(summary.createdCount, 1);
  assert.deepEqual(summary.errors, []);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].id, `${CANONICAL_WIKI_JOB_ID}-r2`);
  assert.equal(jobs[0].source.reissueOf, CANONICAL_WIKI_JOB_ID);
});

test("WikipediaMaintenanceIngestionScheduler avoids historical session id collisions", async () => {
  const platform = {
    catalogueLaneDiscipline: testConsumer(),
    jobs: [],
    listJobs() {
      return [...this.jobs];
    },
    createJob(job) {
      this.jobs.unshift(job);
      return job;
    },
    async listRecentSessions() {
      return [{
        sessionId: `${CANONICAL_WIKI_JOB_ID}:0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05`,
        jobId: CANONICAL_WIKI_JOB_ID,
        wallet: "0x30BC468dA4E95a8FA4b3f2043c86687a57CdeE05",
        status: "expired"
      }];
    }
  };
  const scheduler = new WikipediaMaintenanceIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    minClaimableJobs: 1,
    categories: [{ title: "Category:All articles with dead external links", taskType: "citation_repair" }],
    minScore: 55,
    fetchImpl: makeFetch(),
    logger: SILENT_LOGGER
  });

  const summary = await scheduler.runOnce(new Date("2026-04-25T10:00:00.000Z"));

  assert.equal(summary.createdCount, 1);
  assert.deepEqual(summary.errors, []);
  assert.equal(platform.jobs[0].id, `${CANONICAL_WIKI_JOB_ID}-r2`);
  assert.equal(platform.jobs[0].source.reissueOf, CANONICAL_WIKI_JOB_ID);
});

test("loadWikipediaMaintenanceIngestionConfig parses env knobs safely", () => {
  const config = loadWikipediaMaintenanceIngestionConfig({
    WIKIPEDIA_INGEST_ENABLED: "true",
    WIKIPEDIA_INGEST_DRY_RUN: "false",
    WIKIPEDIA_INGEST_INTERVAL_MS: "1800000",
    WIKIPEDIA_INGEST_LANGUAGE: "de",
    WIKIPEDIA_INGEST_MIN_SCORE: "80",
    WIKIPEDIA_INGEST_MAX_JOBS_PER_RUN: "3",
    WIKIPEDIA_INGEST_MAX_OPEN_JOBS: "12",
    WIKIPEDIA_INGEST_MIN_CLAIMABLE_JOBS: "4",
    WIKIPEDIA_INGEST_COMPLETED_COOLDOWN_DAYS: "45",
    WIKIPEDIA_INGEST_MAX_REISSUES: "3",
    WIKIPEDIA_INGEST_CATEGORIES_JSON: '[{"title":"Category:Wikipedia articles in need of updating","taskType":"freshness_check"}]'
  });

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.intervalMs, 1800000);
  assert.equal(config.language, "de");
  assert.equal(config.minScore, 80);
  assert.equal(config.maxJobsPerRun, 3);
  assert.equal(config.maxOpenJobs, 12);
  assert.equal(config.minClaimableJobs, 4);
  assert.equal(config.completedCooldownDays, 45);
  assert.equal(config.maxReissues, 3);
  assert.deepEqual(config.categories, [
    { title: "Category:Wikipedia articles in need of updating", taskType: "freshness_check" }
  ]);
});

test("loadWikipediaMaintenanceIngestionConfig enables production ingestion by default", () => {
  const config = loadWikipediaMaintenanceIngestionConfig({
    NODE_ENV: "production"
  });

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.intervalMs, 30 * 60 * 1000);
  assert.equal(config.language, "en");
  assert.equal(config.maxJobsPerRun, 2);
  assert.equal(config.maxOpenJobs, 20);
  assert.equal(config.minClaimableJobs, 2);
  assert.equal(config.completedCooldownDays, 30);
  assert.equal(config.maxReissues, 2);
});

test("loadWikipediaMaintenanceIngestionConfig stays opt-in outside production", () => {
  const config = loadWikipediaMaintenanceIngestionConfig({
    NODE_ENV: "development"
  });

  assert.equal(config.enabled, false);
  assert.equal(config.dryRun, true);
  assert.equal(config.minClaimableJobs, 0);
});

function jsonResponse(payload) {
  return {
    ok: true,
    async json() {
      return payload;
    }
  };
}

function claimableWikipediaJob(id, pageId) {
  return {
    id,
    category: "wikipedia",
    tier: "starter",
    claimable: true,
    effectiveState: "claimable",
    onboardingWaiverEligible: true,
    source: {
      type: "wikipedia_article",
      language: "en",
      pageId,
      revisionId: "987654321",
      taskType: "citation_repair"
    }
  };
}

const NOW = new Date("2026-09-10T12:00:00.000Z");
const ARTICLES = [
  { pageId: 123, title: "Example article", revisionId: 987654321 },
  { pageId: 456, title: "Next article", revisionId: 987654322 },
  { pageId: 789, title: "Third article", revisionId: 987654323 }
];
function completedJob(overrides = {}) {
  return {
    ...claimableWikipediaJob(CANONICAL_WIKI_JOB_ID, 123),
    claimable: false,
    effectiveState: "exhausted",
    resolvedAt: "2026-09-09T12:00:00.000Z",
    ...overrides
  };
}
function replenisher(jobs, options = {}) {
  const platform = makePlatformService(jobs);
  const scheduler = new WikipediaMaintenanceIngestionScheduler(platform, undefined, {
    enabled: true, dryRun: false, minClaimableJobs: 1, maxJobsPerRun: 1,
    categories: [{ title: "Category:All articles with dead external links", taskType: "citation_repair" }],
    minScore: 55, fetchImpl: makeMultiArticleFetch(ARTICLES), logger: SILENT_LOGGER,
    ...options
  });
  return { platform, scheduler };
}

test("completed Wikipedia sources stay seen inside the cooldown without occupying active inventory", async () => {
  for (const effectiveState of ["exhausted", "completed", "resolved"]) {
    const { scheduler } = replenisher([completedJob({ effectiveState })]);
    const snapshot = await scheduler.inventorySnapshot(NOW);
    assert.equal(snapshot.activeSourceKeys.has("en:123:987654321"), false);
    assert.equal(snapshot.seenSourceKeys.has("en:123:987654321"), true);
    const summary = await scheduler.runOnce(NOW);
    assert.equal(summary.skipped[0].reason, "completed_cooldown");
    assert.equal(summary.createdCount, 1);
    assert.equal(summary.selected[0].title, "Next article");
    assert.deepEqual(summary.errors, []);
  }
});

test("a changed upstream Wikipedia revision bypasses the completed cooldown and starts a new cap", async () => {
  const old = completedJob();
  old.source = { ...old.source, reissueNumber: 25 };
  const { platform, scheduler } = replenisher([old], {
    fetchImpl: makeMultiArticleFetch([{ ...ARTICLES[0], revisionId: 999999999 }])
  });
  const summary = await scheduler.runOnce(NOW);
  assert.equal(summary.createdCount, 1);
  assert.deepEqual(summary.skipped, []);
  assert.equal(platform.listJobs()[0].source.revisionId, "999999999");
  assert.equal(platform.listJobs()[0].source.reissueNumber, 1);
});

test("Wikipedia reissues never exceed the per-revision cap and report reissue_cap_reached", async () => {
  const old = completedJob({ resolvedAt: "2026-07-01T12:00:00.000Z" });
  const { platform, scheduler } = replenisher([old]);
  const first = await scheduler.runOnce(NOW);
  assert.equal(first.createdCount, 1);
  const secondJob = platform.listJobs()[0];
  assert.equal(secondJob.source.reissueNumber, 2);
  Object.assign(secondJob, { effectiveState: "exhausted", claimable: false, resolvedAt: NOW.toISOString() });
  // Restart, alter the title and the task type: none resets the revision cap.
  const { scheduler: restarted } = replenisher(platform.listJobs(), {
    categories: [{ title: "Category:Wikipedia articles in need of updating", taskType: "freshness_check" }],
    fetchImpl: makeMultiArticleFetch([{ ...ARTICLES[0], title: "Renamed article" }, ARTICLES[1]])
  });
  const second = await restarted.runOnce(new Date("2026-10-11T12:00:00.000Z"));
  assert.ok(second.selected.every((job) => job.reissueNumber <= 2), "no generation above the cap can be created");
  assert.equal(second.skipped[0].reason, "reissue_cap_reached");
  assert.equal(second.selected[0].title, "Next article");
  assert.equal(second.selected[0].reissueNumber, 1);
});

test("two identical Wikipedia category runs rotate the first candidate after a skip", async () => {
  const { scheduler } = replenisher([completedJob()], { dryRun: true });
  const first = await scheduler.runOnce(NOW);
  const second = await scheduler.runOnce(NOW);
  assert.equal(first.candidates[0].title, "Example article");
  assert.equal(first.skipped[0].reason, "completed_cooldown");
  assert.equal(second.candidates[0].title, "Next article");
  assert.equal(second.selected[0].title, "Next article");
});

test("Wikipedia category continuation advances beyond the first page and wraps on exhaustion", async () => {
  const requests = [];
  let categoryReads = 0;
  const fetchArticles = makeMultiArticleFetch(ARTICLES);
  const { scheduler } = replenisher([], {
    dryRun: true,
    fetchImpl: async (url) => {
      if (new URL(url).searchParams.get("list") !== "categorymembers") return fetchArticles(url);
      requests.push(new URL(url).searchParams.get("cmcontinue"));
      categoryReads += 1;
      return jsonResponse({ query: { categorymembers: [{ pageid: 456, title: "Next article" }] },
        ...(categoryReads === 1 ? { continue: { cmcontinue: "page-2" } } : {}) });
    }
  });
  await scheduler.runOnce(NOW);
  await scheduler.runOnce(NOW);
  await scheduler.runOnce(NOW);
  assert.deepEqual(requests, [null, "page-2", null]);
});

test("archived and removed catalogue rows retain completion and cap evidence through session pins", async () => {
  const { platform, scheduler } = replenisher([]);
  platform.stateStore = {
    async listRecentSessions() {
      return [{ jobId: CANONICAL_WIKI_JOB_ID, status: "resolved", resolvedAt: NOW.toISOString(),
        jobSnapshot: { definition: completedJob() } }];
    }
  };
  const summary = await scheduler.runOnce(NOW);
  assert.equal(summary.skipped[0].reason, "completed_cooldown");
  assert.equal(summary.selected[0].title, "Next article");
});

test("overlapping replenisher calls share one pass and cannot race the reissue cap", async () => {
  const { platform, scheduler } = replenisher([completedJob({ resolvedAt: "2026-07-01T00:00:00Z" })]);
  const [first, second] = await Promise.all([scheduler.runOnce(NOW), scheduler.runOnce(NOW)]);
  assert.deepEqual(first, second);
  assert.equal(platform.listJobs().length, 2);
  assert.equal(platform.listJobs()[0].source.reissueNumber, 2);
});

test("an article that leaves the upstream category is no longer a replenishment candidate", async () => {
  const { scheduler } = replenisher([completedJob()], { fetchImpl: makeMultiArticleFetch([ARTICLES[1]]) });
  const summary = await scheduler.runOnce(NOW);
  assert.equal(summary.candidates.some((job) => job.sourceKey === "en:123:987654321"), false);
  assert.equal(summary.selected[0].title, "Next article");
});

test("incomplete inventory fails closed with a run error before any upstream fetch or creation", async () => {
  const { platform, scheduler } = replenisher([], { fetchImpl: async () => assert.fail("must not fetch") });
  platform.stateStore = { listRecentSessions: async () => Array(200).fill({ jobId: "unknown" }) };
  const summary = await scheduler.runOnce(NOW);
  assert.equal(summary.createdCount, 0);
  assert.equal(summary.errors[0].message, "inventory_history_incomplete");
});
