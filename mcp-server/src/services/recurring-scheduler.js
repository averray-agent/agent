import { ConflictError } from "../core/errors.js";
import { GuardedSchedulerLoop } from "./guarded-scheduler.js";

export class RecurringSchedulerService {
  constructor(platformService, eventBus = undefined, {
    enabled = false,
    intervalMs = 60_000,
    logger = console,
    schedulerRunTimeoutMs = undefined
  } = {}) {
    this.platformService = platformService;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.runtime = new Map();
    this.lastRun = undefined;
    this.scheduler = new GuardedSchedulerLoop({
      name: "recurring_scheduler",
      enabled,
      intervalMs,
      runTimeoutMs: schedulerRunTimeoutMs,
      runOnce: (now) => this.runSchedulerOnce(now),
      evaluateOutcome: (summary) => this.evaluateSchedulerOutcome(summary),
      logger
    });
  }

  start() {
    this.scheduler.start();
  }

  stop() {
    this.scheduler.stop();
  }

  async getStatus(now = new Date()) {
    const recurring = this.platformService.getRecurringTemplateStatus();
    return {
      enabled: this.enabled,
      running: this.scheduler.running,
      intervalMs: this.intervalMs,
      lastRun: this.lastRun,
      ...this.scheduler.getStatus(now),
      templates: recurring.templates.map((template) => {
        const runtime = {
          paused: template.paused,
          lastFiredAt: template.lastFiredAt,
          nextFireAt: template.nextFireAt,
          lastResult: template.lastResult,
          ...(this.runtime.get(template.templateId) ?? {})
        };
        const exhausted = Boolean(runtime.exhausted ?? template.exhausted ?? template.reserve?.exhausted);
        const nextFireAt = exhausted
          ? undefined
          : (runtime.nextFireAt ?? computeNextFireAt(template.schedule, now)?.toISOString());
        return {
          templateId: template.templateId,
          paused: Boolean(runtime.paused),
          exhausted,
          reserve: runtime.reserve ?? template.reserve,
          lastFiredAt: runtime.lastFiredAt ?? template.lastFiredAt,
          nextFireAt,
          lastResult: runtime.lastResult
        };
      })
    };
  }

  async pauseTemplate(templateId) {
    const current = this.runtime.get(templateId) ?? {};
    this.runtime.set(templateId, { ...current, paused: true });
    this.platformService.pauseRecurringTemplate?.(templateId);
  }

  async resumeTemplate(templateId) {
    const current = this.runtime.get(templateId) ?? {};
    this.runtime.set(templateId, { ...current, paused: false });
    this.platformService.resumeRecurringTemplate?.(templateId);
    if (this.scheduler.running) {
      this.scheduler.scheduleNextRun(0);
    }
  }

  async runDueTemplates(now = new Date(), schedulerSummary = undefined) {
    const recurring = this.platformService.getRecurringTemplateStatus();
    const fired = [];
    for (const template of recurring.templates) {
      const runtime = this.runtime.get(template.templateId) ?? {};
      if (runtime.paused) {
        if (schedulerSummary) schedulerSummary.pausedCount += 1;
        continue;
      }
      if (runtime.exhausted || template.exhausted || template.reserve?.exhausted) {
        if (schedulerSummary) schedulerSummary.exhaustedCount += 1;
        this.runtime.set(template.templateId, {
          ...runtime,
          exhausted: true,
          nextFireAt: undefined,
          reserve: runtime.reserve ?? template.reserve,
          lastResult: runtime.lastResult ?? template.lastResult ?? {
            status: "reserve_exhausted",
            at: now.toISOString()
          }
        });
        continue;
      }
      const nextFireAt = runtime.nextFireAt
        ? new Date(runtime.nextFireAt)
        : computeNextFireAt(template.schedule, now, runtime.lastFiredAt);
      if (!nextFireAt) {
        if (schedulerSummary) schedulerSummary.invalidScheduleCount += 1;
        this.runtime.set(template.templateId, {
          ...runtime,
          lastResult: { status: "invalid_schedule", at: now.toISOString() }
        });
        continue;
      }
      if (nextFireAt.getTime() > now.getTime()) {
        if (schedulerSummary) schedulerSummary.notDueCount += 1;
        this.runtime.set(template.templateId, {
          ...runtime,
          nextFireAt: nextFireAt.toISOString()
        });
        continue;
      }

      try {
        const derivative = this.platformService.fireRecurringJob(template.templateId, { firedAt: now });
        const updatedTemplate = this.platformService
          .getRecurringTemplateStatus()
          .templates
          .find((candidate) => candidate.templateId === template.templateId);
        const reserve = updatedTemplate?.reserve;
        const exhausted = Boolean(updatedTemplate?.exhausted ?? reserve?.exhausted);
        const upcoming = exhausted
          ? undefined
          : computeNextFireAt(template.schedule, new Date(now.getTime() + 60_000), now.toISOString());
        this.runtime.set(template.templateId, {
          ...runtime,
          exhausted,
          reserve,
          lastFiredAt: now.toISOString(),
          nextFireAt: upcoming?.toISOString(),
          lastResult: {
            status: "fired",
            at: now.toISOString(),
            derivativeId: derivative.id,
            ...(reserve ? { reserve } : {})
          }
        });
        this.platformService.jobCatalogService?.updateRecurringTemplateRuntime?.(template.templateId, {
          exhausted,
          reserve,
          lastFiredAt: now.toISOString(),
          nextFireAt: upcoming?.toISOString(),
          lastResult: {
            status: "fired",
            at: now.toISOString(),
            derivativeId: derivative.id,
            ...(reserve ? { reserve } : {})
          }
        });
        this.eventBus?.publish({
          id: `platform-recurring-fired-${template.templateId}-${Date.now()}`,
          topic: "recurring.fired",
          jobId: derivative.id,
          timestamp: now.toISOString(),
          data: {
            templateId: template.templateId,
            derivativeId: derivative.id,
            firedAt: now.toISOString()
          }
        });
        fired.push(derivative);
        if (schedulerSummary) schedulerSummary.firedCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = error?.code === "recurring_reserve_exhausted"
          ? "reserve_exhausted"
          : (error instanceof ConflictError ? "conflict" : "failed");
        const reserve = error?.details?.reserve;
        const exhausted = status === "reserve_exhausted";
        if (schedulerSummary && !exhausted) {
          schedulerSummary.errors.push({
            templateId: template.templateId,
            status,
            message
          });
        }
        this.runtime.set(template.templateId, {
          ...runtime,
          exhausted,
          reserve: reserve ?? runtime.reserve,
          nextFireAt: exhausted
            ? undefined
            : computeNextFireAt(template.schedule, new Date(now.getTime() + 60_000), runtime.lastFiredAt)?.toISOString(),
          lastResult: {
            status,
            at: now.toISOString(),
            message,
            ...(reserve ? { reserve } : {})
          }
        });
        this.platformService.jobCatalogService?.updateRecurringTemplateRuntime?.(template.templateId, {
          exhausted,
          reserve,
          nextFireAt: exhausted
            ? undefined
            : computeNextFireAt(template.schedule, new Date(now.getTime() + 60_000), runtime.lastFiredAt)?.toISOString(),
          lastResult: {
            status,
            at: now.toISOString(),
            message,
            ...(reserve ? { reserve } : {})
          }
        });
        this.logger.warn?.({ templateId: template.templateId, err: error }, "recurring_scheduler.fire_failed");
      }
    }
    return fired;
  }

  async scheduleNextTick(now = new Date()) {
    return this.scheduler.runOnceAndSchedule(now);
  }

  async runSchedulerOnce(now = new Date()) {
    const summary = {
      startedAt: now.toISOString(),
      finishedAt: undefined,
      templateCount: 0,
      firedCount: 0,
      pausedCount: 0,
      exhaustedCount: 0,
      notDueCount: 0,
      invalidScheduleCount: 0,
      errors: []
    };
    summary.templateCount = this.platformService.getRecurringTemplateStatus().templates.length;
    await this.runDueTemplates(now, summary);
    summary.finishedAt = new Date().toISOString();
    this.lastRun = summary;
    return summary;
  }

  evaluateSchedulerOutcome(summary) {
    // No due templates is normal; invalid schedules and failed fires are not.
    if (summary.invalidScheduleCount > 0) {
      return {
        ok: false,
        state: "invalid_recurring_schedule",
        message: `${summary.invalidScheduleCount} recurring template(s) have invalid schedules`
      };
    }
    if (summary.errors.length > 0) {
      return {
        ok: false,
        state: "recurring_fire_errors",
        message: `${summary.errors.length} recurring template fire(s) failed`
      };
    }
    return { ok: true };
  }

  async getHealth(now = new Date()) {
    return { ...this.scheduler.getHealth(now), component: "recurring_scheduler" };
  }
}

export function computeNextFireAt(schedule, now = new Date(), lastFiredAt = undefined) {
  if (!schedule?.cron) {
    return undefined;
  }
  const [minuteField, hourField, dayField, monthField, weekdayField] = String(schedule.cron).trim().split(/\s+/u);
  if (!minuteField || !hourField || !dayField || !monthField || !weekdayField) {
    return undefined;
  }
  const start = new Date(now);
  start.setSeconds(0, 0);
  const from = lastFiredAt ? new Date(Math.max(start.getTime(), new Date(lastFiredAt).getTime() + 60_000)) : start;
  const limit = new Date(from.getTime() + (366 * 24 * 60 * 60 * 1000));
  const candidate = new Date(from);
  while (candidate <= limit) {
    if (
      fieldMatches(minuteField, candidate.getUTCMinutes()) &&
      fieldMatches(hourField, candidate.getUTCHours()) &&
      fieldMatches(dayField, candidate.getUTCDate()) &&
      fieldMatches(monthField, candidate.getUTCMonth() + 1) &&
      fieldMatches(weekdayField, candidate.getUTCDay())
    ) {
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
  }
  return undefined;
}

function fieldMatches(field, value) {
  if (field === "*") {
    return true;
  }
  return Number(field) === value;
}
