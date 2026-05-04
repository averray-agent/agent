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

test("createJob preserves finite recurring reserve policy", () => {
  const service = makeService();
  const record = service.createJob({
    ...TEMPLATE,
    recurringPolicy: { reserveAmount: 15, reserveAsset: "DOT" }
  });
  assert.deepEqual(record.recurringPolicy, { reserveAmount: 15, reserveAsset: "DOT" });
});

test("createJob rejects recurring reserve that cannot cover one run", () => {
  const service = makeService();
  assert.throws(
    () => service.createJob({
      ...TEMPLATE,
      recurringPolicy: { reserveAmount: 4 }
    }),
    (err) => err instanceof ValidationError && /cover at least one run/.test(err.message)
  );
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
  service.createJob({ ...TEMPLATE, recurringPolicy: { reserveAmount: 10 } });
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
  assert.equal(derivative.recurringPolicy, undefined);

  const status = service.getRecurringTemplateStatus();
  assert.equal(status.templates[0].reserve.remainingAmount, 5);
  assert.equal(status.templates[0].reserve.remainingRuns, 1);
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

test("fireRecurringJob stops when a finite recurring reserve is exhausted", () => {
  const service = makeService();
  service.createJob({ ...TEMPLATE, recurringPolicy: { reserveAmount: 10 } });
  service.fireRecurringJob("weekly-digest", { firedAt: new Date("2026-04-20T09:00:00.000Z") });
  service.updateRecurringTemplateRuntime("weekly-digest", { nextFireAt: "2026-04-27T09:00:00.000Z" });
  service.fireRecurringJob("weekly-digest", { firedAt: new Date("2026-04-27T09:00:00.000Z") });

  const depleted = service.getRecurringTemplateStatus();
  assert.equal(depleted.templates[0].exhausted, true);
  assert.equal(depleted.templates[0].nextFireAt, undefined);
  assert.equal(depleted.templates[0].lastResult.status, "fired");

  assert.throws(
    () => service.fireRecurringJob("weekly-digest", { firedAt: new Date("2026-05-04T09:00:00.000Z") }),
    (err) => err.code === "recurring_reserve_exhausted"
      && err.details.reserve.remainingAmount === 0
  );

  const status = service.getRecurringTemplateStatus();
  assert.equal(status.templates[0].exhausted, true);
  assert.equal(status.templates[0].reserve.exhausted, true);
  assert.equal(status.templates[0].lastResult.status, "reserve_exhausted");
});

test("getRecurringTemplateStatus summarizes templates and latest derivatives", () => {
  const service = makeService();
  service.createJob(TEMPLATE);
  service.fireRecurringJob("weekly-digest", { firedAt: new Date("2026-04-20T09:00:00.000Z") });
  service.fireRecurringJob("weekly-digest", { firedAt: new Date("2026-04-27T09:00:00.000Z") });

  const status = service.getRecurringTemplateStatus();
  assert.equal(status.count, 1);
  assert.equal(status.templates[0].templateId, "weekly-digest");
  assert.equal(status.templates[0].derivativeCount, 2);
  assert.equal(status.templates[0].lastFiredAt, "2026-04-27T09:00:00.000Z");
  assert.equal(status.templates[0].lastDerivativeId, "weekly-digest-run-2026-04-27t09-00-00");
  assert.deepEqual(status.templates[0].schedule, { cron: "0 9 * * 1", timezone: "Europe/Zurich" });
});
