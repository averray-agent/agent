import test from "node:test";
import assert from "node:assert/strict";

import { JobCatalogService } from "./job-catalog-service.js";
import { ValidationError } from "./errors.js";

function makeService() {
  const jobs = [];
  const profiles = new Map();
  const account = async () => ({ liquid: { DOT: 100 } });
  const reputation = async () => ({ skill: 0, reliability: 0, economic: 0, tier: "starter" });
  const bps = async () => 500;
  return new JobCatalogService(jobs, profiles, account, reputation, bps);
}

const TEMPLATE = {
  id: "weekly-digest",
  category: "coding",
  tier: "starter",
  rewardAmount: 5,
  verifierMode: "benchmark",
  verifierTerms: ["complete", "output"],
  verifierMinimumMatches: 1,
  recurring: true,
  schedule: { cron: "0 9 * * 1", timezone: "Europe/Zurich" }
};

test("createJob preserves recurring + schedule fields", () => {
  const service = makeService();
  const record = service.createJob(TEMPLATE);
  assert.equal(record.recurring, true);
  assert.deepEqual(record.schedule, { cron: "0 9 * * 1", timezone: "Europe/Zurich" });
});

test("createJob rejects recurring: true without a schedule", () => {
  const service = makeService();
  assert.throws(
    () => service.createJob({ ...TEMPLATE, schedule: undefined }),
    (err) => err instanceof ValidationError && /schedule/.test(err.message)
  );
});

test("createJob rejects schedule.cron that isn't 5 fields", () => {
  const service = makeService();
  assert.throws(
    () => service.createJob({ ...TEMPLATE, schedule: { cron: "not a cron" } }),
    (err) => err instanceof ValidationError && /5 fields/.test(err.message)
  );
});

test("createJob rejects malformed schedule.startAt", () => {
  const service = makeService();
  assert.throws(
    () =>
      service.createJob({
        ...TEMPLATE,
        schedule: { cron: "0 9 * * 1", startAt: "not-a-date" }
      }),
    (err) => err instanceof ValidationError && /startAt/.test(err.message)
  );
});

test("non-recurring jobs work without a schedule", () => {
  const service = makeService();
  const record = service.createJob({ ...TEMPLATE, recurring: false, schedule: undefined });
  assert.equal(record.recurring, undefined);
  assert.equal(record.schedule, undefined);
});

test("fireRecurringJob produces a derivative with deterministic id", () => {
  const service = makeService();
  service.createJob(TEMPLATE);
  const derivative = service.fireRecurringJob("weekly-digest", {
    firedAt: new Date("2026-04-20T09:00:00.000Z")
  });
  assert.equal(derivative.templateId, "weekly-digest");
  assert.equal(derivative.recurring, false);
  assert.equal(derivative.firedAt, "2026-04-20T09:00:00.000Z");
  // Derivative id pattern: <template>-run-<timestamp>
  assert.match(derivative.id, /^weekly-digest-run-2026-04-20t09-00-00$/);
  // Template metadata carries over (category, reward, verifier)
  assert.equal(derivative.category, "coding");
  assert.equal(derivative.rewardAmount, 5);
  // Schedule is stripped from the derivative (it's a one-shot run)
  assert.equal(derivative.schedule, undefined);
});

test("fireRecurringJob rejects non-recurring templates", () => {
  const service = makeService();
  service.createJob({ ...TEMPLATE, recurring: false, schedule: undefined });
  assert.throws(
    () => service.fireRecurringJob("weekly-digest"),
    (err) => err instanceof ValidationError && /not a recurring template/.test(err.message)
  );
});

test("fireRecurringJob rejects collisions (same template + same second)", () => {
  const service = makeService();
  service.createJob(TEMPLATE);
  const when = new Date("2026-04-27T09:00:00.000Z");
  service.fireRecurringJob("weekly-digest", { firedAt: when });
  assert.throws(
    () => service.fireRecurringJob("weekly-digest", { firedAt: when }),
    (err) => err.code === "recurring_job_collision"
  );
});
