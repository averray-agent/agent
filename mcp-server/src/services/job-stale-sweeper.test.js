import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStateStore } from "../core/state-store.js";
import { JobStaleSweeperService, loadJobStaleSweeperConfig } from "./job-stale-sweeper.js";

const STALE_JOB = {
  id: "stale-open-001",
  source: { type: "open_data_dataset" },
  lifecycle: {
    status: "open",
    state: "stale",
    staleAt: "2026-04-01T00:00:00.000Z"
  }
};

function makePlatformService(initialJobs = [STALE_JOB]) {
  const jobs = initialJobs.map((job) => ({ ...job, lifecycle: { ...job.lifecycle } }));
  return {
    jobs,
    listJobs(options = {}) {
      return jobs.filter((job) => {
        if (job.lifecycle.status === "archived" && !options.includeArchived) return false;
        if (job.lifecycle.status === "paused" && !options.includePaused) return false;
        if (job.lifecycle.state === "stale" && !options.includeStale) return false;
        return true;
      });
    },
    updateJobLifecycle(jobId, patch = {}) {
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (!job) throw new Error(`Unknown job: ${jobId}`);
      const status = patch.action === "pause"
        ? "paused"
        : patch.action === "archive"
          ? "archived"
          : "open";
      job.lifecycle = {
        ...job.lifecycle,
        status,
        state: status,
        reason: patch.reason
      };
      return job;
    }
  };
}

test("JobStaleSweeperService dry-run reports stale candidates without mutating", async () => {
  const platform = makePlatformService();
  const sweeper = new JobStaleSweeperService(platform, new MemoryStateStore(), undefined, {
    enabled: true,
    dryRun: true,
    action: "archive"
  });

  const run = await sweeper.runOnce(new Date("2026-04-27T10:00:00.000Z"));
  assert.equal(run.candidateCount, 1);
  assert.equal(run.updatedCount, 1);
  assert.equal(platform.jobs[0].lifecycle.status, "open");
  assert.equal((await sweeper.getStatus()).lastRun.dryRun, true);
});

test("JobStaleSweeperService archives stale jobs when live", async () => {
  const platform = makePlatformService();
  const sweeper = new JobStaleSweeperService(platform, new MemoryStateStore(), undefined, {
    enabled: true,
    dryRun: false,
    action: "archive",
    reason: "aged out"
  });

  const run = await sweeper.runOnce(new Date("2026-04-27T10:00:00.000Z"));
  assert.equal(run.updatedCount, 1);
  assert.equal(platform.jobs[0].lifecycle.status, "archived");
  assert.equal(platform.jobs[0].lifecycle.reason, "aged out");
});

test("JobStaleSweeperService skips jobs with active sessions", async () => {
  const platform = makePlatformService();
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession({
    sessionId: "stale-open-001:0xagent",
    jobId: "stale-open-001",
    wallet: "0xagent",
    status: "claimed",
    idempotencyKey: "claim-1"
  });
  const sweeper = new JobStaleSweeperService(platform, stateStore, undefined, {
    enabled: true,
    dryRun: false,
    action: "archive"
  });

  const run = await sweeper.runOnce(new Date("2026-04-27T10:00:00.000Z"));
  assert.equal(run.updatedCount, 0);
  assert.equal(run.skipped[0].reason, "active_session");
  assert.equal(platform.jobs[0].lifecycle.status, "open");
});

test("JobStaleSweeperService only sweeps open stale non-recurring jobs", async () => {
  const platform = makePlatformService([
    STALE_JOB,
    {
      ...STALE_JOB,
      id: "paused-stale-001",
      lifecycle: { ...STALE_JOB.lifecycle, status: "paused", state: "paused" }
    },
    {
      ...STALE_JOB,
      id: "recurring-stale-001",
      recurring: true
    },
    {
      ...STALE_JOB,
      id: "fresh-open-001",
      lifecycle: { ...STALE_JOB.lifecycle, state: "open" }
    }
  ]);
  const sweeper = new JobStaleSweeperService(platform, new MemoryStateStore(), undefined, {
    enabled: true,
    dryRun: false,
    action: "pause"
  });

  const run = await sweeper.runOnce(new Date("2026-04-27T10:00:00.000Z"));
  assert.equal(run.candidateCount, 1);
  assert.equal(platform.jobs.find((job) => job.id === "stale-open-001").lifecycle.status, "paused");
  assert.equal(platform.jobs.find((job) => job.id === "paused-stale-001").lifecycle.status, "paused");
  assert.equal(platform.jobs.find((job) => job.id === "recurring-stale-001").lifecycle.status, "open");
  assert.equal(platform.jobs.find((job) => job.id === "fresh-open-001").lifecycle.status, "open");
});

test("loadJobStaleSweeperConfig parses safe defaults and live action", () => {
  assert.deepEqual(loadJobStaleSweeperConfig({}), {
    enabled: false,
    dryRun: true,
    intervalMs: 60 * 60 * 1000,
    action: "archive",
    maxJobsPerRun: 25,
    reason: "automatic stale job cleanup"
  });

  assert.deepEqual(loadJobStaleSweeperConfig({
    JOB_STALE_SWEEPER_ENABLED: "true",
    JOB_STALE_SWEEPER_DRY_RUN: "false",
    JOB_STALE_SWEEPER_INTERVAL_MS: "300000",
    JOB_STALE_SWEEPER_ACTION: "pause",
    JOB_STALE_SWEEPER_MAX_JOBS_PER_RUN: "5",
    JOB_STALE_SWEEPER_REASON: "ops rotation"
  }), {
    enabled: true,
    dryRun: false,
    intervalMs: 300000,
    action: "pause",
    maxJobsPerRun: 5,
    reason: "ops rotation"
  });
});
