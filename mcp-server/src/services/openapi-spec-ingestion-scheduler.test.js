import test from "node:test";
import assert from "node:assert/strict";

import {
  OpenApiSpecIngestionScheduler,
  loadOpenApiSpecIngestionConfig
} from "./openapi-spec-ingestion-scheduler.js";

const SPEC = {
  provider: "averray",
  specId: "averray-http-api",
  apiTitle: "Averray HTTP API",
  specUrl: "https://raw.githubusercontent.com/averray-agent/agent/main/docs/api/openapi.json",
  localSurface: "mcp-server/src/protocols/http/server.js",
  repo: "averray-agent/agent"
};

function makeFetch() {
  return async () => ({
    ok: true,
    status: 200,
    url: SPEC.specUrl,
    headers: new Map([
      ["content-type", "application/json"],
      ["last-modified", "Mon, 27 Apr 2026 08:00:00 GMT"]
    ]),
    async text() {
      return JSON.stringify({
        openapi: "3.1.0",
        info: { title: SPEC.apiTitle, version: "0.1.0" },
        paths: { "/health": { get: { operationId: "health", responses: { "200": { description: "ok" } } } } }
      });
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

test("OpenApiSpecIngestionScheduler dry-run does not create jobs", async () => {
  const platform = makePlatformService();
  const scheduler = new OpenApiSpecIngestionScheduler(platform, undefined, {
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

test("OpenApiSpecIngestionScheduler creates jobs when dryRun is false", async () => {
  const platform = makePlatformService();
  const scheduler = new OpenApiSpecIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    specs: [SPEC],
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-27T08:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
  assert.equal(platform.listJobs().length, 1);
  assert.equal(platform.listJobs()[0].source.type, "openapi_spec");
});

test("OpenApiSpecIngestionScheduler dedupes by OpenAPI source", async () => {
  const platform = makePlatformService([
    {
      id: "existing",
      source: {
        type: "openapi_spec",
        provider: "averray",
        specUrl: SPEC.specUrl,
        localSurface: SPEC.localSurface
      }
    }
  ]);
  const scheduler = new OpenApiSpecIngestionScheduler(platform, undefined, {
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

test("OpenApiSpecIngestionScheduler skips when no specs are configured", async () => {
  const platform = makePlatformService();
  const scheduler = new OpenApiSpecIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    specs: [],
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-27T08:00:00.000Z"));
  assert.equal(summary.createdCount, 0);
  assert.equal(summary.skipped[0].reason, "no_specs_configured");
});

test("loadOpenApiSpecIngestionConfig parses env knobs safely", () => {
  const config = loadOpenApiSpecIngestionConfig({
    OPENAPI_INGEST_ENABLED: "true",
    OPENAPI_INGEST_DRY_RUN: "false",
    OPENAPI_INGEST_INTERVAL_MS: "3600000",
    OPENAPI_INGEST_SPECS_JSON: JSON.stringify([SPEC]),
    OPENAPI_INGEST_MIN_SCORE: "70",
    OPENAPI_INGEST_MAX_JOBS_PER_RUN: "4",
    OPENAPI_INGEST_MAX_OPEN_JOBS: "11"
  });

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.intervalMs, 3600000);
  assert.equal(config.specs.length, 1);
  assert.equal(config.minScore, 70);
  assert.equal(config.maxJobsPerRun, 4);
  assert.equal(config.maxOpenJobs, 11);
});
