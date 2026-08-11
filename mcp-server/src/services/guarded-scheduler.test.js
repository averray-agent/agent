import test from "node:test";
import assert from "node:assert/strict";

import { GuardedSchedulerLoop } from "./guarded-scheduler.js";

async function waitFor(predicate, { timeoutMs = 500, pollMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  assert.fail(`Condition was not met within ${timeoutMs}ms.`);
}

test("a thrown run is visible and the next tick still fires", async () => {
  let calls = 0;
  const loop = new GuardedSchedulerLoop({
    name: "throwing_test",
    enabled: true,
    intervalMs: 5,
    runTimeoutMs: 50,
    runOnce: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary failure");
      return { finishedAt: new Date().toISOString() };
    },
    logger: { warn() {} }
  });

  loop.start();
  try {
    await waitFor(() => calls >= 2 && loop.lastSuccessfulRunAt);
  } finally {
    loop.stop();
  }

  assert.ok(calls >= 2);
  assert.match(loop.lastSchedulerError.message, /temporary failure/u);
  assert.ok(loop.lastRunFinishedAt);
  assert.equal(loop.consecutiveSchedulerFailures, 0);
});

test("an explicit tick time is forwarded to the component run", async () => {
  const tick = new Date("2026-08-11T12:34:56.000Z");
  let received;
  const loop = new GuardedSchedulerLoop({
    name: "tick_time_test",
    enabled: true,
    intervalMs: 1_000,
    runTimeoutMs: 1_000,
    runOnce: async (now) => {
      received = now;
      return { finishedAt: now.toISOString() };
    }
  });

  await loop.runOnceAndSchedule(tick);
  assert.equal(received, tick);
});

test("a hung run times out, later ticks continue, and duplicate work is quarantined", async () => {
  let calls = 0;
  const never = new Promise(() => {});
  const loop = new GuardedSchedulerLoop({
    name: "hung_test",
    enabled: true,
    intervalMs: 5,
    runTimeoutMs: 10,
    runOnce: async () => {
      calls += 1;
      return never;
    },
    logger: { warn() {} }
  });

  loop.start();
  let health;
  try {
    await waitFor(() => loop.consecutiveSchedulerFailures >= 2);
    health = loop.getHealth();
  } finally {
    loop.stop();
  }

  assert.equal(calls, 1);
  assert.equal(loop.pendingRun.timedOut, true);
  assert.equal(health.ok, false);
  assert.equal(health.state, "run_timeout_pending");
});

test("liveness degrades from elapsed time without a downstream backlog", () => {
  const loop = new GuardedSchedulerLoop({
    name: "stale_test",
    enabled: true,
    intervalMs: 1_000,
    runTimeoutMs: 1_000,
    runOnce: async () => ({ finishedAt: "2026-08-11T12:00:01.000Z" })
  });
  loop.running = true;
  loop.startedAt = "2026-08-11T12:00:00.000Z";
  loop.lastRunFinishedAt = "2026-08-11T12:00:01.000Z";

  assert.equal(loop.getHealth(new Date("2026-08-11T12:00:03.999Z")).ok, true);
  const stale = loop.getHealth(new Date("2026-08-11T12:00:04.001Z"));
  assert.equal(stale.ok, false);
  assert.equal(stale.state, "last_run_stale");
});

test("a component outcome can mark a completed no-op unhealthy", async () => {
  const loop = new GuardedSchedulerLoop({
    name: "outcome_test",
    enabled: true,
    intervalMs: 1_000,
    runTimeoutMs: 1_000,
    runOnce: async () => ({ finishedAt: new Date().toISOString(), createdCount: 0 }),
    evaluateOutcome: () => ({
      ok: false,
      state: "repeated_no_production",
      message: "no jobs produced for three eligible runs"
    }),
    logger: { warn() {} }
  });

  await loop.runOnceAndSchedule();

  assert.equal(loop.consecutiveSchedulerFailures, 1);
  assert.equal(loop.lastSchedulerError.code, "repeated_no_production");
});

test("a broken scheduler reports red before any downstream symptom is needed", async () => {
  const loop = new GuardedSchedulerLoop({
    name: "early_failure_test",
    enabled: true,
    intervalMs: 1_000,
    runTimeoutMs: 1_000,
    runOnce: async () => { throw new Error("source unavailable"); },
    logger: { warn() {} }
  });
  loop.running = true;
  loop.startedAt = new Date().toISOString();

  await loop.runOnceAndSchedule();
  const health = loop.getHealth();
  loop.stop();

  assert.equal(health.ok, false);
  assert.equal(health.state, "scheduler_run_failed");
  assert.match(health.lastSchedulerError.message, /source unavailable/u);
});
