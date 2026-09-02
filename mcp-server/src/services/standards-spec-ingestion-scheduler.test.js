import test from "node:test";
import assert from "node:assert/strict";

import {
  StandardsSpecIngestionScheduler,
  loadStandardsSpecIngestionConfig
} from "./standards-spec-ingestion-scheduler.js";

const SPEC = {
  provider: "w3c",
  specId: "vc-data-model-2.0",
  specTitle: "Verifiable Credentials Data Model v2.0",
  specUrl: "https://www.w3.org/TR/vc-data-model-2.0/",
  expectedStatus: "W3C Recommendation",
  localSurface: "docs/RC1_WORKING_SPEC.md"
};

function makeFetch() {
  return async () => ({
    ok: true,
    status: 200,
    url: SPEC.specUrl,
    headers: new Map([
      ["content-type", "text/html"],
      ["last-modified", "Mon, 27 Apr 2026 08:00:00 GMT"]
    ]),
    async text() {
      return `<title>${SPEC.specTitle}</title>`;
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

test("StandardsSpecIngestionScheduler dry-run does not create jobs", async () => {
  const platform = makePlatformService();
  const scheduler = new StandardsSpecIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: true,
    specs: [SPEC],
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-27T08:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
  assert.equal(platform.listJobs().length, 0);
  assert.equal((await scheduler.getStatus()).lastRun.dryRun, true);
});

test("StandardsSpecIngestionScheduler creates jobs when dryRun is false", async () => {
  const platform = makePlatformService();
  const scheduler = new StandardsSpecIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    specs: [SPEC],
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-27T08:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
  assert.equal(platform.listJobs().length, 1);
  assert.equal(platform.listJobs()[0].source.type, "standards_spec");
});

test("StandardsSpecIngestionScheduler dedupes by standards source", async () => {
  const platform = makePlatformService([
    {
      id: "existing",
      source: {
        type: "standards_spec",
        provider: "w3c",
        specUrl: SPEC.specUrl,
        localSurface: SPEC.localSurface
      }
    }
  ]);
  const scheduler = new StandardsSpecIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    specs: [SPEC],
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-27T08:00:00.000Z"));
  assert.equal(summary.createdCount, 0);
  assert.equal(platform.listJobs().length, 1);
  assert.equal(summary.skipped.at(-1).reason, "source_already_ingested");
});

test("StandardsSpecIngestionScheduler skips when no specs are configured", async () => {
  const platform = makePlatformService();
  const scheduler = new StandardsSpecIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    specs: [],
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-27T08:00:00.000Z"));
  assert.equal(summary.createdCount, 0);
  assert.equal(summary.skipped[0].reason, "no_specs_configured");
});

test("loadStandardsSpecIngestionConfig parses env knobs safely", () => {
  const config = loadStandardsSpecIngestionConfig({
    STANDARDS_INGEST_ENABLED: "true",
    STANDARDS_INGEST_DRY_RUN: "false",
    STANDARDS_INGEST_INTERVAL_MS: "3600000",
    STANDARDS_INGEST_SPECS_JSON: JSON.stringify([SPEC]),
    STANDARDS_INGEST_MIN_SCORE: "70",
    STANDARDS_INGEST_MAX_JOBS_PER_RUN: "4",
    STANDARDS_INGEST_MAX_OPEN_JOBS: "11"
  });

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.intervalMs, 3600000);
  assert.equal(config.specs.length, 1);
  assert.equal(config.minScore, 70);
  assert.equal(config.maxJobsPerRun, 4);
  assert.equal(config.maxOpenJobs, 11);
});
