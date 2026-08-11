import test from "node:test";
import assert from "node:assert/strict";

import {
  SubmittedJobAutoVerifierService,
  loadSubmittedJobAutoVerifierConfig
} from "./submitted-job-auto-verifier.js";
import { buildJobSnapshot } from "../core/job-snapshot.js";

const JOBS = {
  "bench-001": { id: "bench-001", verifierMode: "benchmark", verifierConfig: { handler: "benchmark" } },
  "det-001": { id: "det-001", verifierMode: "deterministic", verifierConfig: { handler: "deterministic" } },
  "human-001": { id: "human-001", verifierMode: "human_fallback", verifierConfig: { handler: "human_fallback" } },
  "gh-001": { id: "gh-001", verifierMode: "github_pr", verifierConfig: { handler: "github_pr" } }
};

// Builds a harness with a shared session store. The fake verifierService mutates
// session.status the way the real one does (submitted -> resolved/rejected via
// ingestVerification), so re-listing on the next tick proves idempotency.
function makeHarness({ sessions = [], jobs = JOBS, outcomeFor = () => "approved", gateway } = {}) {
  const store = sessions.map((session) => ({
    ...session,
    ...(session.jobSnapshot || !jobs[session.jobId]
      ? {}
      : { jobSnapshot: buildJobSnapshot(jobs[session.jobId]) })
  }));
  const verifyCalls = [];
  const platformService = {
    async listRecentSessions() {
      return store.map((session) => ({ ...session }));
    },
    getJobDefinition(jobId) {
      const job = jobs[jobId];
      if (!job) throw new Error(`Unknown job: ${jobId}`);
      return job;
    }
  };
  const verifierService = {
    async verifySubmission({ sessionId }) {
      verifyCalls.push(sessionId);
      const session = store.find((entry) => entry.sessionId === sessionId);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      if (session.status !== "submitted") {
        throw new Error(`Session ${sessionId} cannot receive verification while ${session.status}.`);
      }
      const outcome = outcomeFor(session);
      session.status = outcome === "approved" ? "resolved" : "rejected";
      session.verification = { outcome };
      return { outcome, reasonCode: outcome === "approved" ? "OK" : "NO", sessionId };
    }
  };
  return { store, verifyCalls, platformService, verifierService, gateway };
}

function makeService(harness, options = {}) {
  return new SubmittedJobAutoVerifierService(
    harness.platformService,
    harness.verifierService,
    harness.gateway,
    undefined,
    { enabled: true, logger: { info() {}, warn() {} }, ...options }
  );
}

async function waitFor(predicate, { timeoutMs = 500, pollMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  assert.fail(`Condition was not met within ${timeoutMs}ms.`);
}

test("verifies submitted benchmark and deterministic jobs and settles each", async () => {
  const harness = makeHarness({
    sessions: [
      { sessionId: "s-bench", jobId: "bench-001", status: "submitted" },
      { sessionId: "s-det", jobId: "det-001", status: "submitted" }
    ],
    outcomeFor: (session) => (session.jobId === "bench-001" ? "approved" : "rejected")
  });
  const service = makeService(harness);

  const run = await service.runOnce(new Date("2026-06-13T10:00:00.000Z"));

  assert.equal(run.candidateCount, 2);
  assert.equal(run.verifiedCount, 2);
  assert.equal(run.approvedCount, 1);
  assert.equal(run.rejectedCount, 1);
  assert.deepEqual(harness.verifyCalls.sort(), ["s-bench", "s-det"]);
  assert.equal(harness.store.find((s) => s.sessionId === "s-bench").status, "resolved");
  assert.equal(harness.store.find((s) => s.sessionId === "s-det").status, "rejected");
});

test("never auto-verifies human_fallback or github_pr", async () => {
  const harness = makeHarness({
    sessions: [
      { sessionId: "s-human", jobId: "human-001", status: "submitted" },
      { sessionId: "s-gh", jobId: "gh-001", status: "submitted" }
    ]
  });
  const service = makeService(harness);

  const run = await service.runOnce();

  assert.equal(run.candidateCount, 0);
  assert.equal(run.verifiedCount, 0);
  assert.equal(harness.verifyCalls.length, 0);
  const reasons = run.skipped.filter((s) => s.reason === "non_auto_mode").map((s) => s.mode).sort();
  assert.deepEqual(reasons, ["github_pr", "human_fallback"]);
});

test("ignores sessions that are not in submitted state", async () => {
  const harness = makeHarness({
    sessions: [
      { sessionId: "s-claimed", jobId: "bench-001", status: "claimed" },
      { sessionId: "s-resolved", jobId: "bench-001", status: "resolved" },
      { sessionId: "s-disputed", jobId: "bench-001", status: "disputed" }
    ]
  });
  const service = makeService(harness);

  const run = await service.runOnce();

  assert.equal(run.candidateCount, 0);
  assert.equal(harness.verifyCalls.length, 0);
});

test("is idempotent across ticks — a settled session is not re-verified", async () => {
  const harness = makeHarness({
    sessions: [{ sessionId: "s-bench", jobId: "bench-001", status: "submitted" }]
  });
  const service = makeService(harness);

  const first = await service.runOnce();
  const second = await service.runOnce();

  assert.equal(first.verifiedCount, 1);
  assert.equal(second.verifiedCount, 0);
  assert.deepEqual(harness.verifyCalls, ["s-bench"]);
});

test("skips a submitted session that already carries a verification result", async () => {
  const harness = makeHarness({
    sessions: [{ sessionId: "s-bench", jobId: "bench-001", status: "submitted", verification: { outcome: "approved" } }]
  });
  const service = makeService(harness);

  const run = await service.runOnce();

  assert.equal(run.candidateCount, 0);
  assert.equal(harness.verifyCalls.length, 0);
  assert.equal(run.skipped[0].reason, "already_verified");
});

test("fails closed when a submitted session has no pinned snapshot", async () => {
  const harness = makeHarness({
    sessions: [{ sessionId: "s-ghost", jobId: "missing-001", status: "submitted" }]
  });
  const service = makeService(harness);

  const run = await service.runOnce();

  assert.equal(run.candidateCount, 0);
  assert.equal(harness.verifyCalls.length, 0);
  assert.equal(run.skipped[0].reason, "job_snapshot_missing");
});

test("persistent submitted-session integrity skips degrade verifier health", async () => {
  const harness = makeHarness({
    sessions: [{ sessionId: "s-legacy", jobId: "missing-001", status: "submitted" }]
  });
  const service = makeService(harness);
  service.running = true;
  service.startedAt = new Date().toISOString();

  await service.runOnce();
  assert.equal((await service.getHealth()).ok, true);

  await service.runOnce();
  const health = await service.getHealth();
  assert.equal(health.ok, false);
  assert.equal(health.state, "submitted_session_persistently_skipped");
  assert.equal(health.persistentSubmittedFailureCount, 1);
  assert.equal(health.persistentSubmittedFailures[0].reason, "job_snapshot_missing");
});

test("persistent submitted-session skips degrade health regardless of reason", async () => {
  const harness = makeHarness({
    sessions: [
      { sessionId: "s-human", jobId: "human-001", status: "submitted" },
      { sessionId: "s-in-flight", jobId: "bench-001", status: "submitted" }
    ]
  });
  const service = makeService(harness);
  service.running = true;
  service.startedAt = new Date().toISOString();
  service.inFlight.add("s-in-flight");

  await service.runOnce();
  await service.runOnce();
  const health = await service.getHealth();

  assert.equal(health.ok, false);
  assert.equal(health.state, "submitted_session_persistently_skipped");
  assert.deepEqual(
    health.persistentSubmittedFailures.map(({ sessionId, reason }) => ({ sessionId, reason })),
    [
      { sessionId: "s-human", reason: "non_auto_mode" },
      { sessionId: "s-in-flight", reason: "in_flight" }
    ]
  );
});

test("a submitted-session failure remains persistent when its reason changes", () => {
  const service = makeService(makeHarness());
  service.running = true;
  service.startedAt = new Date().toISOString();

  service.updateSubmittedFailureStreaks({
    finishedAt: "2026-08-11T20:00:00.000Z",
    skipped: [{ sessionId: "s-legacy", jobId: "legacy-job", reason: "job_not_found" }],
    errors: []
  });
  service.updateSubmittedFailureStreaks({
    finishedAt: "2026-08-11T20:01:00.000Z",
    skipped: [{ sessionId: "s-legacy", jobId: "legacy-job", reason: "future_skip_reason" }],
    errors: []
  });

  assert.deepEqual(service.listPersistentSubmittedFailures(), [{
    sessionId: "s-legacy",
    jobId: "legacy-job",
    reason: "future_skip_reason",
    consecutiveRuns: 2,
    lastSeenAt: "2026-08-11T20:01:00.000Z"
  }]);
});

test("persistent worker-canary snapshot skips do not degrade payout-queue health", async () => {
  const harness = makeHarness({
    sessions: [{
      sessionId: "worker-canary-1786453506586:0xcanary",
      jobId: "worker-canary-1786453506586",
      status: "submitted"
    }]
  });
  const service = makeService(harness);
  service.running = true;
  service.startedAt = new Date().toISOString();

  const first = await service.runOnce();
  const second = await service.runOnce();
  const health = await service.getHealth();

  // The integrity skip remains visible in each run; only the health-degrading
  // streak excludes an operator-owned canary that is not an unpaid user.
  assert.equal(first.skipped[0].reason, "job_snapshot_missing");
  assert.equal(second.skipped[0].reason, "job_snapshot_missing");
  assert.equal(health.ok, true);
  assert.equal(health.state, "running");
  assert.deepEqual(health.persistentSubmittedFailures, []);
});

test("worker-canary exclusion applies to non-snapshot skip reasons", async () => {
  const harness = makeHarness({
    sessions: [{
      sessionId: "worker-canary-1786453506586:0xcanary",
      jobId: "worker-canary-1786453506586",
      status: "submitted"
    }]
  });
  const service = makeService(harness);
  service.running = true;
  service.startedAt = new Date().toISOString();
  service.inFlight.add("worker-canary-1786453506586:0xcanary");

  const first = await service.runOnce();
  await service.runOnce();
  const health = await service.getHealth();

  assert.equal(first.skipped[0].reason, "in_flight");
  assert.equal(first.skipped[0].jobId, "worker-canary-1786453506586");
  assert.equal(health.ok, true);
  assert.deepEqual(health.persistentSubmittedFailures, []);
});

test("canary exclusion does not hide a persistent external-worker skip", async () => {
  const harness = makeHarness({
    sessions: [
      {
        sessionId: "worker-canary-1786453506586:0xcanary",
        jobId: "worker-canary-1786453506586",
        status: "submitted"
      },
      { sessionId: "external-unpaid:0xworker", jobId: "missing-external-job", status: "submitted" }
    ]
  });
  const service = makeService(harness);
  service.running = true;
  service.startedAt = new Date().toISOString();

  await service.runOnce();
  await service.runOnce();
  const health = await service.getHealth();

  assert.equal(health.ok, false);
  assert.equal(health.state, "submitted_session_persistently_skipped");
  assert.equal(health.persistentSubmittedFailureCount, 1);
  assert.equal(health.persistentSubmittedFailures[0].sessionId, "external-unpaid:0xworker");
});

test("does nothing when disabled", async () => {
  const harness = makeHarness({
    sessions: [{ sessionId: "s-bench", jobId: "bench-001", status: "submitted" }]
  });
  const service = makeService(harness, { enabled: false });

  const run = await service.runOnce();

  assert.equal(run.skipped[0].reason, "disabled");
  assert.equal(harness.verifyCalls.length, 0);
});

test("dry-run reports candidates without verifying", async () => {
  const harness = makeHarness({
    sessions: [{ sessionId: "s-bench", jobId: "bench-001", status: "submitted" }]
  });
  const service = makeService(harness, { dryRun: true });

  const run = await service.runOnce();

  assert.equal(run.candidateCount, 1);
  assert.equal(run.verifiedCount, 0);
  assert.equal(harness.verifyCalls.length, 0);
  assert.ok(run.skipped.some((s) => s.reason === "dry_run"));
});

test("caps work per run and defers the remainder to the next tick", async () => {
  const harness = makeHarness({
    sessions: [
      { sessionId: "s1", jobId: "bench-001", status: "submitted" },
      { sessionId: "s2", jobId: "bench-001", status: "submitted" },
      { sessionId: "s3", jobId: "bench-001", status: "submitted" }
    ]
  });
  const service = makeService(harness, { maxPerRun: 2 });

  const run = await service.runOnce();

  assert.equal(run.candidateCount, 3);
  assert.equal(run.verifiedCount, 2);
  assert.equal(run.deferredCount, 1);
  assert.ok(run.skipped.some((s) => s.reason === "max_per_run_reached" && s.deferred === 1));
});

test("reschedules after an unexpected scan failure instead of silently stopping", async () => {
  const harness = makeHarness({
    sessions: [{ sessionId: "s-bench", jobId: "bench-001", status: "submitted" }]
  });
  const originalList = harness.platformService.listRecentSessions;
  let scans = 0;
  harness.platformService.listRecentSessions = async (...args) => {
    scans += 1;
    if (scans === 1) throw new Error("temporary session-store failure");
    return originalList(...args);
  };
  const warnings = [];
  const service = makeService(harness, {
    intervalMs: 5,
    logger: {
      info() {},
      warn(fields, message) { warnings.push({ fields, message }); }
    }
  });

  service.start();
  try {
    await waitFor(async () => {
      const status = await service.getStatus();
      return harness.verifyCalls.length === 1 && Boolean(status.lastSuccessfulRunAt);
    });
  } finally {
    service.stop();
  }

  const status = await service.getStatus();
  assert.ok(scans >= 2);
  assert.deepEqual(harness.verifyCalls, ["s-bench"]);
  assert.equal(status.running, false);
  assert.equal(status.nextRunAt, undefined);
  assert.equal(status.consecutiveSchedulerFailures, 0);
  assert.match(status.lastSchedulerError.message, /temporary session-store failure/u);
  assert.ok(warnings.some((entry) => entry.message === "auto_verify.scheduler_run_failed"));
});

test("times out without allowing duplicate settlement and does not block later jobs", async () => {
  const harness = makeHarness({
    sessions: [
      { sessionId: "s-hung", jobId: "bench-001", status: "submitted" },
      { sessionId: "s-next", jobId: "bench-001", status: "submitted" }
    ]
  });
  const originalVerify = harness.verifierService.verifySubmission;
  let releaseHung;
  const hung = new Promise((resolve) => { releaseHung = resolve; });
  let hungSettlements = 0;
  harness.verifierService.verifySubmission = async ({ sessionId }) => {
    if (sessionId !== "s-hung") return originalVerify({ sessionId });
    harness.verifyCalls.push(sessionId);
    await hung;
    hungSettlements += 1;
    const session = harness.store.find((entry) => entry.sessionId === sessionId);
    session.status = "resolved";
    session.verification = { outcome: "approved" };
    return { outcome: "approved", reasonCode: "OK", sessionId };
  };
  const service = makeService(harness, { candidateTimeoutMs: 10 });

  const first = await service.runOnce();

  assert.equal(first.verifiedCount, 1);
  assert.ok(first.errors.some((entry) => (
    entry.sessionId === "s-hung" && entry.code === "verification_timeout"
  )));
  assert.deepEqual(harness.verifyCalls, ["s-hung", "s-next"]);
  assert.equal(service.inFlight.has("s-hung"), false);
  assert.equal((await service.getStatus()).inFlightCount, 0);
  assert.equal((await service.getStatus()).pendingTimeoutCount, 1);
  assert.equal((await service.getHealth()).ok, false);

  const second = await service.runOnce();
  assert.ok(second.skipped.some((entry) => (
    entry.sessionId === "s-hung" && entry.reason === "verification_timeout_pending"
  )));
  assert.deepEqual(harness.verifyCalls, ["s-hung", "s-next"]);
  assert.equal(hungSettlements, 0);

  releaseHung();
  await waitFor(() => !service.pendingVerifications.has("s-hung"));
  assert.equal((await service.getStatus()).inFlightCount, 0);
  assert.equal((await service.getStatus()).pendingTimeoutCount, 0);
  assert.equal(harness.store.find((entry) => entry.sessionId === "s-hung").status, "resolved");
  assert.equal(hungSettlements, 1);

  await service.runOnce();
  assert.deepEqual(harness.verifyCalls, ["s-hung", "s-next"]);
  assert.equal(hungSettlements, 1);
});

test("reports stale scheduler liveness relative to its configured interval", async () => {
  const harness = makeHarness();
  const service = makeService(harness, {
    intervalMs: 1_000,
    candidateTimeoutMs: 1_000
  });
  service.running = true;
  service.startedAt = "2026-08-11T12:00:00.000Z";
  service.lastRun = { finishedAt: "2026-08-11T12:00:01.000Z" };

  const healthy = await service.getHealth(new Date("2026-08-11T12:00:03.999Z"));
  const stale = await service.getHealth(new Date("2026-08-11T12:00:04.001Z"));

  assert.equal(healthy.ok, true);
  assert.equal(healthy.staleAfterMs, 3_000);
  assert.equal(stale.ok, false);
  assert.equal(stale.state, "last_run_stale");
});

test("honors HALT — skips the whole run while the protocol is paused", async () => {
  const harness = makeHarness({
    sessions: [{ sessionId: "s-bench", jobId: "bench-001", status: "submitted" }],
    gateway: {
      isEnabled: () => true,
      getTreasuryPolicyStatus: async () => ({ enabled: true, paused: true, settlementReady: false })
    }
  });
  const service = makeService(harness);

  const run = await service.runOnce();

  assert.equal(run.skipped[0].reason, "protocol_paused");
  assert.equal(harness.verifyCalls.length, 0);
});

test("skips the run when settlement is not ready", async () => {
  const harness = makeHarness({
    sessions: [{ sessionId: "s-bench", jobId: "bench-001", status: "submitted" }],
    gateway: {
      isEnabled: () => true,
      getTreasuryPolicyStatus: async () => ({ enabled: true, paused: false, settlementReady: false })
    }
  });
  const service = makeService(harness);

  const run = await service.runOnce();

  assert.equal(run.skipped[0].reason, "settlement_not_ready");
  assert.equal(harness.verifyCalls.length, 0);
});

test("fails closed when protocol posture cannot be read", async () => {
  const harness = makeHarness({
    sessions: [{ sessionId: "s-bench", jobId: "bench-001", status: "submitted" }],
    gateway: {
      isEnabled: () => true,
      getTreasuryPolicyStatus: async () => { throw new Error("rpc down"); }
    }
  });
  const service = makeService(harness);

  const run = await service.runOnce();

  assert.equal(run.skipped[0].reason, "policy_status_unavailable");
  assert.equal(harness.verifyCalls.length, 0);
});

test("verifies when the chain is enabled, unpaused and settlement-ready", async () => {
  const harness = makeHarness({
    sessions: [{ sessionId: "s-bench", jobId: "bench-001", status: "submitted" }],
    gateway: {
      isEnabled: () => true,
      getTreasuryPolicyStatus: async () => ({ enabled: true, paused: false, settlementReady: true })
    }
  });
  const service = makeService(harness);

  const run = await service.runOnce();

  assert.equal(run.verifiedCount, 1);
  assert.deepEqual(harness.verifyCalls, ["s-bench"]);
});

test("settlement-readiness gate can be relaxed for non-chain testnets", async () => {
  const harness = makeHarness({
    sessions: [{ sessionId: "s-bench", jobId: "bench-001", status: "submitted" }],
    gateway: {
      isEnabled: () => true,
      getTreasuryPolicyStatus: async () => ({ enabled: true, paused: false, settlementReady: false })
    }
  });
  const service = makeService(harness, { requireSettlementReady: false });

  const run = await service.runOnce();

  assert.equal(run.verifiedCount, 1);
});

test("constructor drops non-auto modes from the requested allowlist", () => {
  const harness = makeHarness();
  const service = makeService(harness, { autoModes: ["benchmark", "human_fallback", "github_pr"] });
  assert.deepEqual([...service.autoModes].sort(), ["benchmark"]);
});

test("constructor falls back to the full allowlist when no valid mode is requested", () => {
  const harness = makeHarness();
  const service = makeService(harness, { autoModes: ["github_pr"] });
  assert.deepEqual([...service.autoModes].sort(), ["benchmark", "deterministic"]);
});

test("loadSubmittedJobAutoVerifierConfig parses conservative defaults", () => {
  assert.deepEqual(loadSubmittedJobAutoVerifierConfig({}), {
    enabled: false,
    dryRun: false,
    intervalMs: 60 * 1000,
    scanLimit: 200,
    maxPerRun: 25,
    candidateTimeoutMs: 3 * 60 * 1000,
    autoModes: ["benchmark", "deterministic"],
    requireSettlementReady: true
  });
});

test("loadSubmittedJobAutoVerifierConfig honors env overrides", () => {
  assert.deepEqual(loadSubmittedJobAutoVerifierConfig({
    AUTO_VERIFY_ENABLED: "true",
    AUTO_VERIFY_DRY_RUN: "1",
    AUTO_VERIFY_INTERVAL_MS: "30000",
    AUTO_VERIFY_SCAN_LIMIT: "500",
    AUTO_VERIFY_MAX_PER_RUN: "5",
    AUTO_VERIFY_CANDIDATE_TIMEOUT_MS: "15000",
    AUTO_VERIFY_MODES: "benchmark, human_fallback",
    AUTO_VERIFY_REQUIRE_SETTLEMENT_READY: "false"
  }), {
    enabled: true,
    dryRun: true,
    intervalMs: 30000,
    scanLimit: 500,
    maxPerRun: 5,
    candidateTimeoutMs: 15000,
    autoModes: ["benchmark", "human_fallback"],
    requireSettlementReady: false
  });
});
