import test from "node:test";
import assert from "node:assert/strict";

import { ConflictError } from "../core/errors.js";
import { computeNextFireAt, RecurringSchedulerService } from "./recurring-scheduler.js";

test("computeNextFireAt resolves the next matching minute", () => {
  const next = computeNextFireAt(
    { cron: "5 9 * * 1" },
    new Date("2026-04-19T09:04:00.000Z")
  );
  assert.equal(next?.toISOString(), "2026-04-20T09:05:00.000Z");
});

test("RecurringSchedulerService fires due templates and records runtime status", async () => {
  const fired = [];
  const templateRuntime = {};
  const platformService = {
    getRecurringTemplateStatus() {
      return {
        templates: [
          {
            templateId: "weekly-digest",
            schedule: { cron: "0 9 * * 1" },
            paused: Boolean(templateRuntime.paused),
            lastFiredAt: templateRuntime.lastFiredAt,
            nextFireAt: templateRuntime.nextFireAt,
            lastResult: templateRuntime.lastResult
          }
        ]
      };
    },
    fireRecurringJob(templateId, { firedAt }) {
      const derivative = {
        id: `${templateId}-run-${firedAt.toISOString()}`,
        templateId
      };
      fired.push(derivative);
      return derivative;
    },
    jobCatalogService: {
      updateRecurringTemplateRuntime(templateId, patch) {
        assert.equal(templateId, "weekly-digest");
        Object.assign(templateRuntime, patch);
      }
    },
    pauseRecurringTemplate(templateId) {
      assert.equal(templateId, "weekly-digest");
      templateRuntime.paused = true;
    },
    resumeRecurringTemplate(templateId) {
      assert.equal(templateId, "weekly-digest");
      templateRuntime.paused = false;
    }
  };

  const scheduler = new RecurringSchedulerService(platformService, undefined, {
    enabled: true,
    logger: { warn() {} }
  });
  await scheduler.runDueTemplates(new Date("2026-04-20T09:00:00.000Z"));
  assert.equal(fired.length, 1);

  const status = await scheduler.getStatus(new Date("2026-04-20T09:01:00.000Z"));
  assert.equal(status.templates[0].lastResult.status, "fired");
  assert.ok(status.templates[0].nextFireAt);
});

test("RecurringSchedulerService pause/resume updates template runtime", async () => {
  const platformService = {
    getRecurringTemplateStatus() {
      return {
        templates: [
          {
            templateId: "weekly-digest",
            schedule: { cron: "0 9 * * 1" }
          }
        ]
      };
    },
    pauseRecurringTemplate(templateId) {
      assert.equal(templateId, "weekly-digest");
    },
    resumeRecurringTemplate(templateId) {
      assert.equal(templateId, "weekly-digest");
    }
  };
  const scheduler = new RecurringSchedulerService(platformService, undefined, {
    enabled: true,
    logger: { warn() {} }
  });
  await scheduler.pauseTemplate("weekly-digest");
  let status = await scheduler.getStatus(new Date("2026-04-20T09:01:00.000Z"));
  assert.equal(status.templates[0].paused, true);

  await scheduler.resumeTemplate("weekly-digest");
  status = await scheduler.getStatus(new Date("2026-04-20T09:01:00.000Z"));
  assert.equal(status.templates[0].paused, false);
});

test("RecurringSchedulerService records reserve exhaustion and stops rescheduling", async () => {
  const initialReserve = {
    mode: "finite",
    rewardAsset: "DOT",
    rewardAmount: 5,
    reserveAmount: 5,
    consumedAmount: 0,
    remainingAmount: 5,
    remainingRuns: 1,
    exhausted: false
  };
  const exhaustedReserve = {
    ...initialReserve,
    consumedAmount: 5,
    remainingAmount: 0,
    remainingRuns: 0,
    exhausted: true
  };
  const templateRuntime = {};
  const platformService = {
    getRecurringTemplateStatus() {
      return {
        templates: [
          {
            templateId: "weekly-digest",
            schedule: { cron: "0 9 * * 1" },
            reserve: initialReserve,
            ...templateRuntime
          }
        ]
      };
    },
    fireRecurringJob() {
      throw new ConflictError("Recurring reserve exhausted for weekly-digest", "recurring_reserve_exhausted", {
        templateId: "weekly-digest",
        reserve: exhaustedReserve
      });
    },
    jobCatalogService: {
      updateRecurringTemplateRuntime(templateId, patch) {
        assert.equal(templateId, "weekly-digest");
        Object.assign(templateRuntime, patch);
      }
    }
  };

  const scheduler = new RecurringSchedulerService(platformService, undefined, {
    enabled: true,
    logger: { warn() {} }
  });
  await scheduler.runDueTemplates(new Date("2026-04-20T09:00:00.000Z"));

  const status = await scheduler.getStatus(new Date("2026-04-20T09:01:00.000Z"));
  assert.equal(status.templates[0].exhausted, true);
  assert.equal(status.templates[0].nextFireAt, undefined);
  assert.equal(status.templates[0].lastResult.status, "reserve_exhausted");
  assert.equal(status.templates[0].reserve.remainingRuns, 0);
});
