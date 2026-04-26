import test from "node:test";
import assert from "node:assert/strict";

import {
  OpenDataIngestionScheduler,
  loadOpenDataIngestionConfig
} from "./open-data-ingestion-scheduler.js";

const TARGET = {
  portal: "data.gov",
  datasetId: "dataset-123",
  datasetTitle: "Federal sample spending data",
  datasetUrl: "https://catalog.data.gov/dataset/federal-sample-spending-data",
  resourceId: "resource-456",
  resourceTitle: "Spending CSV",
  resourceUrl: "https://example.gov/spending.csv",
  resourceFormat: "CSV",
  agency: "General Services Administration",
  license: "CC0",
  modified: "2021-01-01T00:00:00Z",
  metadataModified: "2026-01-01T00:00:00Z"
};

const CKAN_PACKAGE = {
  id: "dataset-123",
  name: "federal-sample-spending-data",
  title: "Federal sample spending data",
  license_title: "CC0",
  metadata_modified: "2026-01-01T00:00:00Z",
  organization: { title: "General Services Administration" },
  resources: [
    {
      id: "resource-456",
      name: "Spending CSV",
      url: "https://example.gov/spending.csv",
      format: "CSV",
      last_modified: "2021-01-01T00:00:00Z"
    }
  ]
};

function makeFetch() {
  return async () => ({
    ok: true,
    async json() {
      return { result: { results: [CKAN_PACKAGE] } };
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

test("OpenDataIngestionScheduler dry-run does not create jobs", async () => {
  const platform = makePlatformService();
  const scheduler = new OpenDataIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: true,
    query: "res_format:CSV",
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-26T10:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
  assert.equal(platform.listJobs().length, 0);
  assert.equal((await scheduler.getStatus()).lastRun.dryRun, true);
});

test("OpenDataIngestionScheduler creates jobs when dryRun is false", async () => {
  const platform = makePlatformService();
  const scheduler = new OpenDataIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    datasets: [TARGET],
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-26T10:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
  assert.equal(platform.listJobs().length, 1);
  assert.equal(platform.listJobs()[0].source.type, "open_data_dataset");
  assert.equal(platform.listJobs()[0].source.resourceId, "resource-456");
});

test("OpenDataIngestionScheduler dedupes by dataset resource", async () => {
  const platform = makePlatformService([
    {
      id: "existing",
      source: {
        type: "open_data_dataset",
        provider: "data.gov",
        datasetId: "dataset-123",
        resourceId: "resource-456"
      }
    }
  ]);
  const scheduler = new OpenDataIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    datasets: [TARGET],
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-26T10:00:00.000Z"));
  assert.equal(summary.createdCount, 0);
  assert.equal(platform.listJobs().length, 1);
  assert.equal(summary.skipped.at(-1).reason, "source_already_ingested");
});

test("OpenDataIngestionScheduler stops when max open open-data jobs is reached", async () => {
  const platform = makePlatformService([
    { id: "a", source: { type: "open_data_dataset", datasetId: "a", resourceId: "a" } }
  ]);
  const scheduler = new OpenDataIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    datasets: [TARGET],
    maxOpenJobs: 1,
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-26T10:00:00.000Z"));
  assert.equal(summary.createdCount, 0);
  assert.equal(summary.skipped[0].reason, "max_open_jobs_reached");
});

test("loadOpenDataIngestionConfig parses env knobs safely", () => {
  const config = loadOpenDataIngestionConfig({
    OPEN_DATA_INGEST_ENABLED: "true",
    OPEN_DATA_INGEST_DRY_RUN: "false",
    OPEN_DATA_INGEST_INTERVAL_MS: "3600000",
    OPEN_DATA_INGEST_QUERY: "res_format:JSON",
    OPEN_DATA_INGEST_MIN_SCORE: "70",
    OPEN_DATA_INGEST_MAX_JOBS_PER_RUN: "4",
    OPEN_DATA_INGEST_MAX_OPEN_JOBS: "11",
    OPEN_DATA_INGEST_DATASETS_JSON: JSON.stringify([TARGET])
  });

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.intervalMs, 3600000);
  assert.equal(config.query, "res_format:JSON");
  assert.equal(config.minScore, 70);
  assert.equal(config.maxJobsPerRun, 4);
  assert.equal(config.maxOpenJobs, 11);
  assert.deepEqual(config.datasets, [TARGET]);
});
