// Regression cases for stale local expiry versus authoritative escrow state.
import test from "node:test";
import assert from "node:assert/strict";
import { JobExecutionService } from "./job-execution-service.js";
import { MemoryStateStore } from "./state-store.js";

const JOB = "expired-reopen-regression";
const OLD_WORKER = `0x${"aa".repeat(20)}`;
const NEW_WORKER = `0x${"bb".repeat(20)}`;
const NOW = new Date("2026-10-20T16:00:00.000Z");
const EXPIRED = Math.floor(NOW.getTime() / 1000) - 60;
const session = {
  jobId: JOB,
  sessionId: `${JOB}:${OLD_WORKER}`,
  wallet: OLD_WORKER,
  status: "expired"
};

function fixture(initial, timeout) {
  let live = structuredClone(initial);
  const calls = [];
  const stateStore = new MemoryStateStore();
  const gateway = {
    isEnabled: () => true,
    async getJob(id) {
      assert.equal(id, JOB);
      calls.push("read");
      return structuredClone(live);
    },
    async handleClaimTimeout(id) {
      assert.equal(id, JOB);
      calls.push("timeout");
      if (timeout) return timeout((next) => { live = next; });
      live = { state: 1, worker: `0x${"00".repeat(20)}`, claimExpiry: 0 };
    }
  };
  const service = new JobExecutionService(stateStore, gateway, () => ({ id: JOB }));
  return {
    service, gateway, calls,
    run: () => service.reopenExpiredClaim(JOB, session, { now: NOW })
  };
}

test("stale expired session with an already Open chain job sends no timeout", async () => {
  const f = fixture({ state: 1, worker: `0x${"00".repeat(20)}`, claimExpiry: 0 });
  await f.run();
  assert.deepEqual(f.calls, ["read"]);
});

test("matching expired claim is timed out once and repeated calls observe Open", async () => {
  const f = fixture({ state: 2, worker: OLD_WORKER, claimExpiry: EXPIRED });
  await f.run();
  await f.run();
  assert.deepEqual(f.calls, ["read", "timeout", "read", "read"]);
});

test("an observed claim belonging to a different worker is never timed out", async () => {
  const f = fixture({ state: 2, worker: NEW_WORKER, claimExpiry: EXPIRED });
  await assert.rejects(f.run(), { code: "claim_reconciliation_worker_mismatch" });
  assert.deepEqual(f.calls, ["read"]);
});

test("future, exact-deadline, absent and invalid chain expiries cannot authorize timeout", async () => {
  for (const claimExpiry of [EXPIRED + 120, EXPIRED + 60, 0, undefined, "invalid", Infinity, 1.5]) {
    const f = fixture({ state: 2, worker: OLD_WORKER, claimExpiry });
    await assert.rejects(f.run(), { code: "claim_not_expired" });
    assert.deepEqual(f.calls, ["read"]);
  }
});

test("None, Submitted, Rejected, Disputed, Closed, Cancelled and unknown chain states are untouched", async () => {
  for (const state of [0, 3, 4, 5, 6, 7, undefined, "Draft", "Verified"]) {
    const f = fixture({ state, worker: OLD_WORKER, claimExpiry: EXPIRED });
    await assert.rejects(f.run(), { code: "job_not_claimable" });
    assert.deepEqual(f.calls, ["read"]);
  }
});

test("another caller can complete timeout without inducing a second broadcast", async () => {
  const original = new Error("simulated InvalidState");
  const f = fixture({ state: 2, worker: OLD_WORKER, claimExpiry: EXPIRED }, (set) => {
    set({ state: 1, worker: `0x${"00".repeat(20)}`, claimExpiry: 0 });
    throw original;
  });
  await f.run();
  assert.deepEqual(f.calls, ["read", "timeout", "read"]);
});

test("a competing new claim is preserved and the failed timeout is not retried", async () => {
  const original = new Error("simulated NOT_EXPIRED");
  const f = fixture({ state: 2, worker: OLD_WORKER, claimExpiry: EXPIRED }, (set) => {
    set({ state: 2, worker: NEW_WORKER, claimExpiry: EXPIRED + 3600 });
    throw original;
  });
  await assert.rejects(f.run(), (error) => error === original);
  assert.deepEqual(f.calls, ["read", "timeout", "read"]);
});

test("timeout failures without observed Open are preserved", async () => {
  const original = new Error("simulated provider transaction failure");
  const f = fixture({ state: 2, worker: OLD_WORKER, claimExpiry: EXPIRED }, () => {
    throw original;
  });
  await assert.rejects(f.run(), (error) => error === original);
  assert.deepEqual(f.calls, ["read", "timeout", "read"]);
});

test("a successful timeout response still requires Open read-back", async () => {
  const f = fixture({ state: 2, worker: OLD_WORKER, claimExpiry: EXPIRED }, (set) => {
    set({ state: 3, worker: OLD_WORKER, claimExpiry: EXPIRED });
  });
  await assert.rejects(f.run(), { code: "claim_timeout_not_reopened" });
  assert.deepEqual(f.calls, ["read", "timeout", "read"]);
});

test("unavailable authoritative reads never authorize timeout", async () => {
  const f = fixture({ state: 2, worker: OLD_WORKER, claimExpiry: EXPIRED });
  const unavailable = new Error("simulated read failure");
  f.gateway.getJob = async () => { throw unavailable; };
  await assert.rejects(f.run(), (error) => error === unavailable);
  assert.deepEqual(f.calls, []);
  delete f.gateway.getJob;
  await assert.rejects(f.run(), { code: "claim_timeout_unavailable" });
  assert.deepEqual(f.calls, []);
});

test("failed race read-back preserves the original transaction failure", async () => {
  const original = new Error("simulated timeout failure");
  const f = fixture({ state: 2, worker: OLD_WORKER, claimExpiry: EXPIRED }, () => {
    f.gateway.getJob = async () => { throw new Error("simulated read failure"); };
    throw original;
  });
  await assert.rejects(f.run(), (error) => error === original);
  assert.deepEqual(f.calls, ["read", "timeout"]);
});

test("disabled chain mode retains its no-op behavior", async () => {
  const f = fixture({ state: 2, worker: OLD_WORKER, claimExpiry: EXPIRED });
  f.gateway.isEnabled = () => false;
  await f.run();
  assert.deepEqual(f.calls, []);
});
