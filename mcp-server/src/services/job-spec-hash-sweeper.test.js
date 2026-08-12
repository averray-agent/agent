import assert from "node:assert/strict";
import test from "node:test";

import { hashCanonicalContent } from "../core/canonical-content.js";
import {
  JobSpecHashSweeperService,
  loadJobSpecHashSweeperConfig,
  SPEC_HASH_DRIFT_RECOVERY,
  sweepServedJobSpecHashes
} from "./job-spec-hash-sweeper.js";

const NOW = new Date("2026-08-12T14:00:00.000Z");

function makePlatform({ jobs, liveById, alreadyDrifted = [] }) {
  const drifted = new Map(alreadyDrifted.map((jobId) => [jobId, { jobId }]));
  return {
    blockchainGateway: {
      isEnabled: () => true,
      getJob: async (jobId) => liveById[jobId] ?? { state: 0 }
    },
    listJobs: () => jobs.filter((job) => !drifted.has(job.id)),
    markJobSpecHashDrift(jobId, details) {
      drifted.set(jobId, details);
    },
    drifted
  };
}

function committed(job, override = undefined) {
  return { state: 1, specHash: override ?? hashCanonicalContent(job) };
}

test("sweep reports {total, matching, drifted} for the served committed remainder", async () => {
  const jobs = [{ id: "match-a" }, { id: "drift-b" }, { id: "known-drift" }, { id: "local-only" }];
  const platform = makePlatform({
    jobs,
    alreadyDrifted: ["known-drift"],
    liveById: {
      "match-a": committed(jobs[0]),
      "drift-b": committed(jobs[1], `0x${"ab".repeat(32)}`),
      "known-drift": committed(jobs[2], `0x${"cd".repeat(32)}`),
      "local-only": { state: 0, specHash: `0x${"00".repeat(32)}` }
    }
  });

  const summary = await sweepServedJobSpecHashes(platform, { now: NOW });

  assert.deepEqual(
    { total: summary.total, matching: summary.matching, drifted: summary.drifted },
    { total: 2, matching: 1, drifted: 1 }
  );
  assert.equal(summary.markedUnclaimable, 1);
  assert.equal(platform.drifted.get("drift-b").recovery, SPEC_HASH_DRIFT_RECOVERY);
  assert.match(platform.drifted.get("drift-b").recoveryReference, /~7-day operator tombstone rescue; PR #877/u);
  assert.equal(platform.drifted.has("known-drift"), true);
});

test("strict-majority first-run guard stops before marking any remainder", async () => {
  const jobs = [{ id: "match-a" }, { id: "drift-b" }, { id: "drift-c" }];
  const platform = makePlatform({
    jobs,
    liveById: {
      "match-a": committed(jobs[0]),
      "drift-b": committed(jobs[1], `0x${"ab".repeat(32)}`),
      "drift-c": committed(jobs[2], `0x${"cd".repeat(32)}`)
    }
  });
  const sweeper = new JobSpecHashSweeperService(platform, undefined, {
    enabled: true,
    intervalMs: 60_000,
    initialDelayMs: 1_000
  });
  sweeper.running = true;

  const summary = await sweeper.runOnce(NOW);

  assert.deepEqual(
    { total: summary.total, matching: summary.matching, drifted: summary.drifted },
    { total: 3, matching: 1, drifted: 2 }
  );
  assert.equal(summary.guardTriggered, true);
  assert.equal(summary.action, "operator_handback_required");
  assert.equal(summary.markedUnclaimable, 0);
  assert.equal(platform.drifted.size, 0);
  assert.equal(sweeper.running, false);
  assert.equal(sweeper.pausedForOperator, true);
});

test("chain-read errors make the sweep non-mutating", async () => {
  const job = { id: "unreadable" };
  const platform = makePlatform({ jobs: [job], liveById: {} });
  platform.blockchainGateway.getJob = async () => {
    throw new Error("rpc unavailable");
  };

  const sweeper = new JobSpecHashSweeperService(platform, undefined, { enabled: true });
  const summary = await sweeper.runOnce(NOW);

  assert.equal(summary.action, "chain_read_errors");
  assert.equal(summary.errors.length, 1);
  assert.equal(platform.drifted.size, 0);
  assert.equal(sweeper.firstRunPending, true);
});

test("sweeper config defaults live with a configured gateway and delays the first pass", () => {
  assert.deepEqual(loadJobSpecHashSweeperConfig({}, { gatewayEnabled: true }), {
    enabled: true,
    intervalMs: 60 * 60 * 1000,
    initialDelayMs: 5 * 60 * 1000
  });
  assert.equal(
    loadJobSpecHashSweeperConfig({ JOB_SPEC_HASH_SWEEP_ENABLED: "false" }, { gatewayEnabled: true }).enabled,
    false
  );
});
