import test from "node:test";
import assert from "node:assert/strict";

import { OpenDataIngestionScheduler } from "./open-data-ingestion-scheduler.js";
import { GithubIssueIngestionScheduler } from "./github-issue-ingestion-scheduler.js";
import { OpenApiSpecIngestionScheduler } from "./openapi-spec-ingestion-scheduler.js";
import { OsvAdvisoryIngestionScheduler } from "./osv-advisory-ingestion-scheduler.js";
import { StandardsSpecIngestionScheduler } from "./standards-spec-ingestion-scheduler.js";
import { JobStaleSweeperService } from "./job-stale-sweeper.js";
import { RecurringSchedulerService } from "./recurring-scheduler.js";
import { ExternalPosterReviewEscalatorService } from "./external-poster-review-escalator.js";
import { UpstreamStatusPollerService } from "./upstream-status-poller.js";
import { BootstrapSelfReportSchedulerService } from "./bootstrap-self-report-scheduler.js";

const ingestionCases = [
  {
    name: "open-data",
    service: seeded(OpenDataIngestionScheduler, { datasets: [], queries: ["public data"], maxOpenJobs: 20 }),
    summary: { errors: [], createdCount: 0, openDataJobs: 0 }
  },
  {
    name: "GitHub",
    service: seeded(GithubIssueIngestionScheduler, { queries: ["good first issue"], maxOpenJobs: 20 }),
    summary: { errors: [], createdCount: 0, openGithubJobs: 0 }
  },
  {
    name: "OpenAPI",
    service: seeded(OpenApiSpecIngestionScheduler, { specs: [{}], maxOpenJobs: 20 }),
    summary: { errors: [], createdCount: 0, openApiJobs: 0 }
  },
  {
    name: "OSV",
    service: seeded(OsvAdvisoryIngestionScheduler, { packages: [{}], manifests: [], maxOpenJobs: 20 }),
    summary: { errors: [], createdCount: 0, openOsvJobs: 0 }
  },
  {
    name: "standards",
    service: seeded(StandardsSpecIngestionScheduler, { specs: [{}], maxOpenJobs: 20 }),
    summary: { errors: [], createdCount: 0, openStandardsJobs: 0 }
  }
];

for (const { name, service, summary } of ingestionCases) {
  test(`${name} repeated eligible no-production is unhealthy on its own`, () => {
    assert.equal(service.evaluateSchedulerOutcome(summary).ok, true);
    assert.equal(service.evaluateSchedulerOutcome(summary).ok, true);
    const third = service.evaluateSchedulerOutcome(summary);
    assert.equal(third.ok, false);
    assert.equal(third.state, "repeated_no_production");
  });
}

test("job stale sweeper explicitly treats no candidates as normal", () => {
  const service = seeded(JobStaleSweeperService);
  assert.deepEqual(service.evaluateSchedulerOutcome({ errors: [], candidateCount: 0 }), { ok: true });
});

test("recurring scheduler treats nothing due as normal but invalid schedules as unhealthy", () => {
  const service = seeded(RecurringSchedulerService);
  assert.deepEqual(service.evaluateSchedulerOutcome({ invalidScheduleCount: 0, errors: [] }), { ok: true });
  assert.equal(service.evaluateSchedulerOutcome({ invalidScheduleCount: 1, errors: [] }).ok, false);
});

test("poster escalation treats no expired reviews as normal", () => {
  const service = seeded(ExternalPosterReviewEscalatorService);
  assert.deepEqual(service.evaluateSchedulerOutcome({ errors: [], candidateCount: 0 }), { ok: true });
});

test("upstream poller treats an empty/final-only set as normal", () => {
  const service = seeded(UpstreamStatusPollerService);
  assert.deepEqual(service.evaluateSchedulerOutcome({ errors: [], checked: 0 }), { ok: true });
});

test("bootstrap self-report never calls a skipped send successful", () => {
  const service = seeded(BootstrapSelfReportSchedulerService);
  const result = service.evaluateSchedulerOutcome({
    status: "skipped",
    errors: [],
    skipped: [{ reason: "missing_recipients" }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, "self_report_skipped");
});

function seeded(Type, fields = {}) {
  return Object.assign(Object.create(Type.prototype), {
    dryRun: false,
    consecutiveNoJobRuns: 0,
    ...fields
  });
}
