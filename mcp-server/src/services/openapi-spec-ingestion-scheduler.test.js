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

test("OpenApiSpecIngestionScheduler counts specHash overwrite refusals without replacing the run error", async () => {
  const platform = makePlatformService();
  platform.upsertIngestedJob = async () => {
    const error = new Error("refreshed definition does not match the commitment");
    error.code = "ingest_refused_spec_hash_mismatch";
    error.details = {
      committedSpecHash: `0x${"ab".repeat(32)}`,
      candidateSpecHash: `0x${"cd".repeat(32)}`
    };
    throw error;
  };
  const scheduler = new OpenApiSpecIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    specs: [SPEC],
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-27T08:00:00.000Z"));

  assert.equal(summary.createdCount, 0);
  assert.equal(summary.ingestRefusedSpecHashMismatchCount, 1);
  assert.equal(summary.errors.length, 0);
  assert.deepEqual(summary.skipped.at(-1), {
    id: "openapi-averray-averray-http-api",
    reason: "ingest_refused_spec_hash_mismatch",
    committedSpecHash: `0x${"ab".repeat(32)}`,
    candidateSpecHash: `0x${"cd".repeat(32)}`
  });
});

test("a backlog-throttled ingestion run is a healthy skip while genuine errors increment scheduler failures", async () => {
  const throttleWarnings = [];
  const throttledPlatform = makePlatformService();
  throttledPlatform.upsertIngestedJob = async () => {
    const error = new Error("lane backlog is full");
    error.code = "lane_backlog_saturated";
    error.details = {
      lane: "liveness",
      resumeAt: "2026-08-23T09:00:00.000Z",
      retryWhen: "a queued job is claimed"
    };
    throw error;
  };
  const throttled = new OpenApiSpecIngestionScheduler(throttledPlatform, undefined, {
    enabled: true,
    dryRun: false,
    specs: [SPEC],
    fetchImpl: makeFetch(),
    logger: { warn(...args) { throttleWarnings.push(args); } }
  });

  const summary = await throttled.runOnceAndSchedule(new Date("2026-08-23T08:00:00.000Z"));
  assert.equal(summary.createdCount, 0);
  assert.deepEqual(summary.errors, []);
  assert.deepEqual(summary.skipped.at(-1), {
    id: "openapi-averray-averray-http-api",
    reason: "lane_backlog_saturated",
    lane: "liveness",
    resumeAt: "2026-08-23T09:00:00.000Z",
    retryWhen: "a queued job is claimed"
  });
  assert.equal(throttled.schedulerLoop.consecutiveSchedulerFailures, 0);
  assert.equal(throttleWarnings.length, 0, "healthy throttles never emit run_failed");

  const failingPlatform = makePlatformService();
  failingPlatform.upsertIngestedJob = async () => {
    throw new Error("unexpected write failure");
  };
  const failureWarnings = [];
  const failing = new OpenApiSpecIngestionScheduler(failingPlatform, undefined, {
    enabled: true,
    dryRun: false,
    specs: [SPEC],
    fetchImpl: makeFetch(),
    logger: { warn(...args) { failureWarnings.push(args); } }
  });

  assert.equal(
    await failing.runOnceAndSchedule(new Date("2026-08-23T08:00:00.000Z")),
    undefined
  );
  assert.equal(failing.schedulerLoop.consecutiveSchedulerFailures, 1);
  assert.ok(failureWarnings.some(([, event]) => event === "openapi_ingest.run_failed"));
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
