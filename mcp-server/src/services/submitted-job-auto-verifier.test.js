import test from "node:test";
import assert from "node:assert/strict";

import {
  SubmittedJobAutoVerifierService,
  loadSubmittedJobAutoVerifierConfig
} from "./submitted-job-auto-verifier.js";

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
  const store = sessions.map((session) => ({ ...session }));
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

test("skips a submitted session whose job has been removed", async () => {
  const harness = makeHarness({
    sessions: [{ sessionId: "s-ghost", jobId: "missing-001", status: "submitted" }]
  });
  const service = makeService(harness);

  const run = await service.runOnce();

  assert.equal(run.candidateCount, 0);
  assert.equal(harness.verifyCalls.length, 0);
  assert.equal(run.skipped[0].reason, "job_not_found");
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
    AUTO_VERIFY_MODES: "benchmark, human_fallback",
    AUTO_VERIFY_REQUIRE_SETTLEMENT_READY: "false"
  }), {
    enabled: true,
    dryRun: true,
    intervalMs: 30000,
    scanLimit: 500,
    maxPerRun: 5,
    autoModes: ["benchmark", "human_fallback"],
    requireSettlementReady: false
  });
});
