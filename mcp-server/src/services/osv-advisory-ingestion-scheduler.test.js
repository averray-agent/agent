import test from "node:test";
import assert from "node:assert/strict";

import {
  OsvAdvisoryIngestionScheduler,
  loadOsvAdvisoryIngestionConfig
} from "./osv-advisory-ingestion-scheduler.js";

const TARGET = {
  name: "minimist",
  version: "0.0.8",
  ecosystem: "npm",
  repo: "example/app",
  manifestPath: "package.json"
};

const ADVISORY = {
  id: "GHSA-vh95-rmgr-6w4m",
  aliases: ["CVE-2020-7598"],
  summary: "Prototype pollution in minimist",
  details: "minimist before 1.2.3 allows prototype pollution.",
  severity: [{ type: "CVSS_V3", score: "7.5" }],
  references: [{ type: "ADVISORY", url: "https://osv.dev/vulnerability/GHSA-vh95-rmgr-6w4m" }],
  affected: [
    {
      package: { ecosystem: "npm", name: "minimist" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.2.3" }] }]
    }
  ]
};

function makeFetch() {
  return async (url, request = {}) => {
    if (String(url).includes("raw.githubusercontent.com")) {
      return {
        ok: true,
        async json() {
          return { packages: { "node_modules/minimist": { version: "0.0.8" } } };
        }
      };
    }
    return {
      ok: true,
      async json() {
        return { results: [{ vulns: [ADVISORY] }] };
      }
    };
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

test("OsvAdvisoryIngestionScheduler dry-run does not create jobs", async () => {
  const platform = makePlatformService();
  const scheduler = new OsvAdvisoryIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: true,
    packages: [TARGET],
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-26T10:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
  assert.equal(platform.listJobs().length, 0);
  assert.equal((await scheduler.getStatus()).lastRun.dryRun, true);
});

test("OsvAdvisoryIngestionScheduler creates jobs when dryRun is false", async () => {
  const platform = makePlatformService();
  const scheduler = new OsvAdvisoryIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    packages: [TARGET],
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-26T10:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
  assert.equal(platform.listJobs().length, 1);
  assert.equal(platform.listJobs()[0].source.type, "osv_advisory");
  assert.equal(platform.listJobs()[0].source.advisoryId, "GHSA-vh95-rmgr-6w4m");
});

test("OsvAdvisoryIngestionScheduler can source targets from manifests", async () => {
  const platform = makePlatformService();
  const scheduler = new OsvAdvisoryIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    manifests: [{ repo: "example/app", manifestPath: "package-lock.json", ref: "main" }],
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-26T10:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
  assert.equal(platform.listJobs()[0].source.packageName, "minimist");
  assert.equal((await scheduler.getStatus()).manifestCount, 1);
});

test("OsvAdvisoryIngestionScheduler prefers explicit packages over manifests", async () => {
  const platform = makePlatformService();
  const scheduler = new OsvAdvisoryIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    packages: [TARGET],
    manifests: [{ repo: "example/app", manifestPath: "package-lock.json", ref: "main" }],
    fetchImpl: async (url, request = {}) => {
      assert.equal(String(url), "https://api.osv.dev/v1/querybatch");
      const body = JSON.parse(request.body);
      assert.equal(body.queries[0].package.name, "minimist");
      return makeFetch()(url, request);
    }
  });

  const summary = await scheduler.runOnce(new Date("2026-04-26T10:00:00.000Z"));
  assert.equal(summary.createdCount, 1);
});

test("OsvAdvisoryIngestionScheduler dedupes by advisory package target", async () => {
  const platform = makePlatformService([
    {
      id: "existing",
      source: {
        type: "osv_advisory",
        provider: "osv",
        ecosystem: "npm",
        repo: "example/app",
        manifestPath: "package.json",
        packageName: "minimist",
        vulnerableVersion: "0.0.8",
        advisoryId: "GHSA-vh95-rmgr-6w4m"
      }
    }
  ]);
  const scheduler = new OsvAdvisoryIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    packages: [TARGET],
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-26T10:00:00.000Z"));
  assert.equal(summary.createdCount, 0);
  assert.equal(platform.listJobs().length, 1);
  assert.equal(summary.skipped.at(-1).reason, "source_already_ingested");
});

test("OsvAdvisoryIngestionScheduler stops when max open OSV jobs is reached", async () => {
  const platform = makePlatformService([
    { id: "a", source: { type: "osv_advisory", packageName: "a", vulnerableVersion: "1.0.0", advisoryId: "OSV-A" } }
  ]);
  const scheduler = new OsvAdvisoryIngestionScheduler(platform, undefined, {
    enabled: true,
    dryRun: false,
    packages: [TARGET],
    maxOpenJobs: 1,
    fetchImpl: makeFetch()
  });

  const summary = await scheduler.runOnce(new Date("2026-04-26T10:00:00.000Z"));
  assert.equal(summary.createdCount, 0);
  assert.equal(summary.skipped[0].reason, "max_open_jobs_reached");
});

test("loadOsvAdvisoryIngestionConfig parses env knobs safely", () => {
  const config = loadOsvAdvisoryIngestionConfig({
    OSV_INGEST_ENABLED: "true",
    OSV_INGEST_DRY_RUN: "false",
    OSV_INGEST_INTERVAL_MS: "3600000",
    OSV_INGEST_MIN_SCORE: "70",
    OSV_INGEST_MAX_JOBS_PER_RUN: "4",
    OSV_INGEST_MAX_PACKAGE_TARGETS: "25",
    OSV_INGEST_MAX_OPEN_JOBS: "11",
    OSV_INGEST_PACKAGES_JSON: JSON.stringify([TARGET]),
    OSV_INGEST_MANIFESTS_JSON: JSON.stringify([{ repo: "example/app", manifestPath: "package-lock.json", ref: "main" }])
  });

  assert.equal(config.enabled, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.intervalMs, 3600000);
  assert.equal(config.minScore, 70);
  assert.equal(config.maxJobsPerRun, 4);
  assert.equal(config.maxPackageTargets, 25);
  assert.equal(config.maxOpenJobs, 11);
  assert.deepEqual(config.packages, [TARGET]);
  assert.deepEqual(config.manifests, [{ repo: "example/app", manifestPath: "package-lock.json", ref: "main" }]);
});
