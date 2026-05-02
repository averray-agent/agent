import test from "node:test";
import assert from "node:assert/strict";

import {
  WikipediaMaintenanceIngestionScheduler,
  loadWikipediaMaintenanceIngestionConfig
} from "./wikipedia-maintenance-ingestion-scheduler.js";
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
    },
    async listJobsWithSessions() {
      return [...jobs];
    }
  };
}

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

test("WikipediaMaintenanceIngestionScheduler reissues exhausted source jobs with a fresh id", async () => {
  const platform = makePlatformService([
    {
      ...claimableWikipediaJob(GENERATED_WIKI_JOB_ID, 123),
      claimable: false,
      effectiveState: "exhausted",
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
    source: {
      type: "wikipedia_article",
      language: "en",
      pageId,
      revisionId: "987654321",
      taskType: "citation_repair"
    }
  };
}
