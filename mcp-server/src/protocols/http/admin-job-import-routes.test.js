import assert from "node:assert/strict";
import test from "node:test";

import { ConflictError, ValidationError } from "../../core/errors.js";
import {
  createAdminJobImportRouteDefinitions,
  createJobImportSummary,
  createJobsFromImportResult,
  normalizeSkippedWithNumericCount
} from "./admin-job-import-routes.js";

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function routeDefinitions(env = {}) {
  return createAdminJobImportRouteDefinitions({ env, parsePositiveInteger });
}

test("createJobImportSummary preserves shared import result shape", () => {
  assert.deepEqual(
    createJobImportSummary(
      { minScore: 55, count: 3 },
      {
        dryRun: false,
        created: [{ id: "job-1" }],
        skipped: [{ id: "job-2", reason: "already_exists" }],
        errors: [{ id: "job-3", code: "invalid_request" }],
        extra: { provider: "github" }
      }
    ),
    {
      provider: "github",
      minScore: 55,
      dryRun: false,
      candidateCount: 3,
      created: [{ id: "job-1" }],
      skipped: [{ id: "job-2", reason: "already_exists" }],
      errors: [{ id: "job-3", code: "invalid_request" }]
    }
  );
});

test("normalizeSkippedWithNumericCount appends the legacy numeric skip counter", () => {
  assert.deepEqual(
    normalizeSkippedWithNumericCount(
      { skipped: 4 },
      [{ id: "job-1", reason: "already_exists" }]
    ),
    [
      { id: "job-1", reason: "already_exists" },
      { reason: "below_min_score_or_over_limit", count: 4 }
    ]
  );
});

test("createJobsFromImportResult separates created, duplicate, and errored jobs", () => {
  const service = {
    createJob: (job) => {
      if (job.id === "duplicate") {
        throw new ConflictError("Job already exists.", "job_exists");
      }
      if (job.id === "broken") {
        throw new ValidationError("Nope.");
      }
      return { id: job.id };
    }
  };

  assert.deepEqual(
    createJobsFromImportResult(service, [
      { id: "created" },
      { id: "duplicate" },
      { id: "broken" }
    ]),
    {
      created: [{ id: "created" }],
      skipped: [{ id: "duplicate", reason: "already_exists" }],
      errors: [{ id: "broken", code: "invalid_request", message: "Nope." }]
    }
  );
});

test("github import definition normalizes payload and dry-run body like the route did", () => {
  const github = routeDefinitions({ GITHUB_TOKEN: " token-1 " })
    .find((definition) => definition.pathname === "/admin/jobs/ingest/github");

  assert.deepEqual(github.normalize({
    query: " repo:averray-agent/agent ",
    limit: 3,
    minScore: 60,
    dryRun: false,
    idempotencyKey: "idem-1"
  }), {
    query: "repo:averray-agent/agent",
    limit: 3,
    minScore: 60,
    dryRun: false,
    idempotencyPayload: {
      query: "repo:averray-agent/agent",
      limit: 3,
      minScore: 60,
      dryRun: false
    }
  });

  assert.deepEqual(
    github.dryRunBody({
      minScore: 60,
      count: 5,
      skipped: 2,
      jobs: [{ id: "job-1" }]
    }),
    {
      minScore: 60,
      count: 5,
      skipped: [{ reason: "below_min_score_or_over_limit", count: 2 }],
      jobs: [{ id: "job-1" }],
      dryRun: true,
      created: []
    }
  );
});

test("environment-backed import definitions preserve configured defaults", () => {
  const definitions = routeDefinitions({
    OSV_INGEST_PACKAGES: "lodash@4.17.20",
    OSV_INGEST_MANIFESTS: JSON.stringify([{ repo: "averray-agent/agent", manifestPath: "package-lock.json" }]),
    OPEN_DATA_INGEST_QUERY: "climate",
    OPENAPI_INGEST_SPECS: JSON.stringify([{ apiTitle: "Example API", specUrl: "https://api.example.com/openapi.json" }]),
    STANDARDS_INGEST_SPECS: JSON.stringify([{ specTitle: "Example Spec", specUrl: "https://example.com/spec" }])
  });

  const osv = definitions.find((definition) => definition.pathname === "/admin/jobs/ingest/osv");
  const openData = definitions.find((definition) => definition.pathname === "/admin/jobs/ingest/open-data");
  const openapi = definitions.find((definition) => definition.pathname === "/admin/jobs/ingest/openapi");
  const standards = definitions.find((definition) => definition.pathname === "/admin/jobs/ingest/standards");

  assert.equal(osv.normalize({}).packages.length, 1);
  assert.equal(osv.normalize({}).manifests.length, 1);
  assert.equal(openData.normalize({}).query, "climate");
  assert.equal(openapi.normalize({}).specs.length, 1);
  assert.equal(standards.normalize({}).specs.length, 1);
});
