import assert from "node:assert/strict";
import test from "node:test";
import {
  GuardedSchedulerLoop,
  ingestionSchedulerOutcome
} from "./guarded-scheduler-loop.js";

test("guarded scheduler times out a hung run, refuses duplicate work, and keeps scheduling", async () => {
  const host = { enabled: true, running: true, timer: undefined, nextRunAt: undefined };
  let launches = 0;
  const loop = new GuardedSchedulerLoop({
    host,
    name: "hung-test-loop",
    intervalMs: 10,
    runTimeoutMs: 5,
    runOnce: () => {
      launches += 1;
      return new Promise(() => undefined);
    },
    logger: { warn() {} }
  });

  await loop.runOnceAndSchedule();
  assert.equal(launches, 1);
  assert.equal(loop.lastSchedulerError.code, "scheduler_run_timeout");
  assert.ok(host.timer);

  await loop.runOnceAndSchedule();
  assert.equal(launches, 1, "the timed-out promise remains in flight and cannot be duplicated");
  assert.equal(loop.lastSchedulerError.code, "scheduler_previous_run_still_in_flight");
  assert.ok(host.timer, "a refused duplicate still leaves the next bounded tick scheduled");
  loop.stop();
});

test("guarded scheduler liveness degrades on time alone without waiting for backlog", () => {
  const host = { enabled: true, running: true, timer: undefined, nextRunAt: undefined };
  const loop = new GuardedSchedulerLoop({
    host,
    name: "stale-test-loop",
    intervalMs: 1_000,
    runTimeoutMs: 1_000,
    runOnce: async () => undefined,
    logger: { warn() {} }
  });
  loop.startedAt = "2026-08-11T12:00:00.000Z";
  loop.lastRunFinishedAt = "2026-08-11T12:00:01.000Z";

  assert.equal(loop.resolveLiveness(new Date("2026-08-11T12:00:03.999Z")).ok, true);
  assert.deepEqual(
    loop.resolveLiveness(new Date("2026-08-11T12:00:04.001Z")),
    { ok: false, state: "last_run_stale", staleAfterMs: 3_000, lastRunAgeMs: 3_001 }
  );
});
test("ingestion no-candidate outcome becomes unhealthy only after three meaningful repeats", () => {
  const host = { enabled: true, running: true, timer: undefined, nextRunAt: undefined };
  const loop = new GuardedSchedulerLoop({
    host,
    name: "ingestion-outcome-test-loop",
    intervalMs: 1_000,
    runTimeoutMs: 1_000,
    runOnce: async () => undefined,
    evaluateOutcome: ingestionSchedulerOutcome,
    logger: { warn() {} }
  });
  const empty = { candidateCount: 0, skipped: [], errors: [] };

  assert.equal(loop.resolveOutcome(empty).ok, true);
  assert.equal(loop.resolveOutcome(empty).ok, true);
  assert.deepEqual(loop.resolveOutcome(empty), {
    ok: false,
    key: "no_source_candidates",
    state: "no_source_candidates_repeated",
    unhealthyAfter: 3,
    outcomeStreak: 3,
    message: "The configured source produced no candidates for three consecutive runs."
  });
  assert.equal(
    loop.resolveOutcome({ candidateCount: 0, skipped: [{ reason: "max_open_jobs_reached" }], errors: [] }).ok,
    true,
    "an inventory-cap no-op is operationally healthy and resets the source-empty streak"
  );
});
