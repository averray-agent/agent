import test from "node:test";
import assert from "node:assert/strict";

import {
  WikipediaMaintenanceIngestionScheduler,
  loadWikipediaMaintenanceIngestionConfig
} from "./wikipedia-maintenance-ingestion-scheduler.js";

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
    fetchImpl: makeFetch()
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
    fetchImpl: makeFetch()
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
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-25T10:00:00.000Z"));
  assert.equal(summary.createdCount, 0);
  assert.equal(platform.listJobs().length, 1);
  assert.equal(summary.skipped[0].reason, "source_already_ingested");
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
    WIKIPEDIA_INGEST_CATEGORIES_JSON: '[{"title":"Category:Wikipedia articles in need of updating","taskType":"freshness_check"}]'
  });

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.intervalMs, 1800000);
  assert.equal(config.language, "de");
  assert.equal(config.minScore, 80);
  assert.equal(config.maxJobsPerRun, 3);
  assert.equal(config.maxOpenJobs, 12);
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
});

test("loadWikipediaMaintenanceIngestionConfig stays opt-in outside production", () => {
  const config = loadWikipediaMaintenanceIngestionConfig({
    NODE_ENV: "development"
  });

  assert.equal(config.enabled, false);
  assert.equal(config.dryRun, true);
});

function jsonResponse(payload) {
  return {
    ok: true,
    async json() {
      return payload;
    }
  };
}
