import assert from "node:assert/strict";
import test from "node:test";
import { BootstrapSelfReportSchedulerService } from "./bootstrap-self-report-scheduler.js";
import { ExternalPosterReviewEscalatorService } from "./external-poster-review-escalator.js";
import { GithubIssueIngestionScheduler } from "./github-issue-ingestion-scheduler.js";
import { JobStaleSweeperService } from "./job-stale-sweeper.js";
import { OpenDataIngestionScheduler } from "./open-data-ingestion-scheduler.js";
import { OpenApiSpecIngestionScheduler } from "./openapi-spec-ingestion-scheduler.js";
import { OsvAdvisoryIngestionScheduler } from "./osv-advisory-ingestion-scheduler.js";
import { RecurringSchedulerService } from "./recurring-scheduler.js";
import { StandardsSpecIngestionScheduler } from "./standards-spec-ingestion-scheduler.js";
import { SubmittedJobAutoVerifierService } from "./submitted-job-auto-verifier.js";
import { UpstreamStatusPollerService } from "./upstream-status-poller.js";

const platform = {
  listJobs: () => [],
  getRecurringTemplateStatus: () => ({ templates: [] })
};
const stateStore = {};
const quietLogger = { info() {}, warn() {} };

const CASES = [
  ["submitted-job auto-verifier reference", () => new SubmittedJobAutoVerifierService(platform, {}, undefined, undefined, options())],
  ["open-data ingestion", () => new OpenDataIngestionScheduler(platform, undefined, options())],
  ["github-issue ingestion", () => new GithubIssueIngestionScheduler(platform, undefined, options())],
  ["OpenAPI ingestion", () => new OpenApiSpecIngestionScheduler(platform, undefined, options())],
  ["OSV ingestion", () => new OsvAdvisoryIngestionScheduler(platform, undefined, options())],
  ["standards ingestion", () => new StandardsSpecIngestionScheduler(platform, undefined, options())],
  ["job-stale sweeper", () => new JobStaleSweeperService(platform, stateStore, undefined, options())],
  ["poster-review escalator", () => new ExternalPosterReviewEscalatorService(platform, stateStore, { reviewWindowSeconds: 60 }, undefined, options())],
  ["upstream-status poller", () => new UpstreamStatusPollerService(stateStore, undefined, options())],
  ["bootstrap self-report", () => new BootstrapSelfReportSchedulerService({}, undefined, options())],
  ["recurring scheduler", () => new RecurringSchedulerService(platform, undefined, { enabled: true, logger: quietLogger })]
];

const INGESTION_OUTCOMES = [
  ["open-data ingestion", () => new OpenDataIngestionScheduler(platform, undefined, options()), "open_data_queries_empty_repeated"],
  ["github-issue ingestion", () => new GithubIssueIngestionScheduler(platform, undefined, options()), "github_issue_queries_empty_repeated"],
  ["OpenAPI ingestion", () => new OpenApiSpecIngestionScheduler(platform, undefined, options()), "openapi_specs_empty_repeated"],
  ["OSV ingestion", () => new OsvAdvisoryIngestionScheduler(platform, undefined, options()), "osv_targets_empty_repeated"],
  ["standards ingestion", () => new StandardsSpecIngestionScheduler(platform, undefined, options()), "standards_specs_empty_repeated"]
];

for (const [name, makeService] of CASES) {
  test(`${name} cannot die before scheduling its next tick`, async () => {
    const service = makeService();
    service.running = true;
    const injected = new Error(`${name} injected failure`);
    let escaped;
    try {
      if (name === "recurring scheduler") {
        service.runScheduledTick = async () => { throw injected; };
        await service.scheduleNextTick();
      } else {
        service.runOnce = async () => { throw injected; };
        await service.runOnceAndSchedule();
      }
    } catch (error) {
      escaped = error;
    }

    const status = service.schedulerLoop?.getStatus();
    const nextTickScheduled = Boolean(service.timer);
    service.stop();

    assert.equal(escaped, undefined, "a run failure must be contained by the scheduler guard");
    assert.ok(status, "the migrated component must expose guarded scheduler status");
    assert.equal(status.consecutiveSchedulerFailures, 1);
    assert.match(status.lastSchedulerError.message, /injected failure/u);
    assert.equal(nextTickScheduled, true, "the next tick must be scheduled unconditionally");
  });
}

for (const [name, makeService, expectedState] of INGESTION_OUTCOMES) {
  test(`${name} gives repeated empty-source work its own unhealthy meaning`, () => {
    const service = makeService();
    const summary = { candidateCount: 0, skipped: [], errors: [] };
    assert.equal(service.schedulerLoop.resolveOutcome(summary).ok, true);
    assert.equal(service.schedulerLoop.resolveOutcome(summary).ok, true);
    assert.equal(service.schedulerLoop.resolveOutcome(summary).state, expectedState);
  });
}

function options() {
  return { enabled: true, intervalMs: 10, candidateTimeoutMs: 5, logger: quietLogger };
}
