import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProviderOperations,
  PROVIDER_STATUS_FALLBACK,
  sanitizeProviderOperations
} from "./provider-operations-status.js";

test("buildProviderOperations projects scheduler statuses into provider rows", () => {
  const operations = buildProviderOperations({
    githubIngestion: {
      enabled: true,
      running: true,
      dryRun: true,
      intervalMs: 60_000,
      maxJobsPerRun: 4,
      maxJobsPerQuery: 2,
      maxOpenJobs: 10,
      currentOpenJobs: 3,
      queryCount: 3,
      lastRun: {
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:05.000Z",
        candidateCount: 4,
        createdCount: 1,
        skipped: [{ reason: "source_already_ingested" }],
        errors: []
      }
    },
    wikipediaIngestion: {
      enabled: true,
      dryRun: false,
      categoryCount: 9,
      minClaimableJobs: 2,
      currentClaimableJobs: 0,
      maxOpenJobs: 5,
      currentOpenJobs: 5
    },
    openDataIngestion: {
      enabled: true,
      dryRun: false,
      targetCount: 3,
      queryCount: 7,
      nextQuery: "transport",
      maxOpenJobs: 10,
      currentOpenJobs: 1,
      lastRun: {
        candidateCount: 2,
        createdCount: 1,
        queries: [
          { skipped: [{ reason: "dataset_already_ingested" }] }
        ],
        errors: []
      }
    },
    openApiIngestion: {
      enabled: true,
      dryRun: false,
      specCount: 1,
      lastRun: {
        candidateCount: 1,
        createdCount: 0,
        errors: [{ message: "fetch failed" }]
      }
    }
  });

  assert.deepEqual(Object.keys(operations).sort(), ["github", "openApi", "openData", "osv", "standards", "wikipedia"]);
  assert.equal(operations.github.label, "GitHub issues");
  assert.equal(operations.github.mode, "dry_run");
  assert.equal(operations.github.currentOpenJobs, 3);
  assert.equal(operations.github.maxJobsPerQuery, 2);
  assert.equal(operations.github.lastRunAt, "2026-01-01T00:00:05.000Z");
  assert.equal(operations.github.lastRun.summary, "4 candidate(s), 1 created, 1 skipped, 0 error(s)");
  assert.equal(operations.github.lastRun.skipped[0].reason, "source_already_ingested");
  assert.equal(operations.github.queryCount, undefined);
  assert.equal(operations.github.nextQuery, undefined);

  assert.equal(operations.wikipedia.mode, "live");
  assert.equal(operations.wikipedia.health, "at_capacity");
  assert.equal(operations.wikipedia.minClaimableJobs, 2);
  assert.equal(operations.wikipedia.currentClaimableJobs, 0);

  assert.equal(operations.openData.health, "healthy");
  assert.equal(operations.openData.targetCount, 3);
  assert.equal(operations.openData.queryCount, 7);
  assert.equal(operations.openData.nextQuery, "transport");
  assert.equal(operations.openData.lastRun.skipped[0].reason, "dataset_already_ingested");

  assert.equal(operations.openApi.health, "error");
  assert.equal(operations.openApi.lastRun.errorCount, 1);
  assert.equal(operations.osv.health, "disabled");
  assert.equal(operations.standards.mode, "disabled");
});

test("buildProviderOperations infers current open jobs from lastRun fields", () => {
  const operations = buildProviderOperations({
    osvIngestion: {
      enabled: true,
      dryRun: false,
      targetCount: 4,
      maxOpenJobs: 10,
      lastRun: {
        candidateCount: 4,
        createdCount: 2,
        openOsvJobs: 6,
        skipped: [],
        errors: []
      }
    }
  });

  assert.equal(operations.osv.currentOpenJobs, 6);
  assert.equal(operations.osv.health, "healthy");
});

test("sanitizeProviderOperations preserves counts and clears detail arrays", () => {
  const operations = buildProviderOperations({
    githubIngestion: {
      enabled: true,
      dryRun: true,
      queryCount: 1,
      lastRun: {
        candidateCount: 3,
        createdCount: 1,
        skipped: [{ reason: "private_url", url: "https://internal.example/path" }],
        errors: [{ message: "stack trace" }]
      }
    }
  });

  const sanitized = sanitizeProviderOperations(operations);

  assert.equal(sanitized.github.lastRun.skippedCount, 1);
  assert.equal(sanitized.github.lastRun.errorCount, 1);
  assert.deepEqual(sanitized.github.lastRun.skipped, []);
  assert.deepEqual(sanitized.github.lastRun.errors, []);
});

test("PROVIDER_STATUS_FALLBACK is a disabled dry-run status", () => {
  const operations = buildProviderOperations({
    githubIngestion: PROVIDER_STATUS_FALLBACK
  });

  assert.equal(operations.github.enabled, false);
  assert.equal(operations.github.dryRun, true);
  assert.equal(operations.github.mode, "disabled");
  assert.equal(operations.github.health, "disabled");
});
