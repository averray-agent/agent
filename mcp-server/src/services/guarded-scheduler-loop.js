const DEFAULT_STALE_INTERVALS = 3;

/**
 * Mechanical scheduler safety extracted from submitted-job-auto-verifier.
 *
 * This owns only the facts common to every loop: bounded execution,
 * unconditional rescheduling, failure evidence, and time-based liveness.
 * Whether a successful run did meaningful work is deliberately delegated to
 * each component through evaluateOutcome; a generic "zero work" counter would
 * turn normal no-op runs into fake incidents.
 */
export class GuardedSchedulerLoop {
  constructor({
    host,
    name,
    intervalMs,
    runTimeoutMs = Math.max(intervalMs * 2, 1_000),
    runOnce,
    evaluateOutcome = undefined,
    logger = console,
    failureLogEvent = "guarded_scheduler.run_failed",
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.host = host;
    this.name = name;
    this.intervalMs = positiveInteger(intervalMs, "intervalMs");
    this.runTimeoutMs = positiveInteger(runTimeoutMs, "runTimeoutMs");
    this.runOnce = runOnce;
    this.evaluateOutcome = evaluateOutcome;
    this.logger = logger;
    this.failureLogEvent = failureLogEvent;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.startedAt = undefined;
    this.lastRunFinishedAt = undefined;
    this.lastSuccessfulRunAt = undefined;
    this.lastSchedulerError = undefined;
    this.consecutiveSchedulerFailures = 0;
    this.inFlight = undefined;
    this.outcomeKey = undefined;
    this.outcomeStreak = 0;
  }

  markStarted() {
    this.startedAt ??= this.now().toISOString();
  }

  stop() {
    if (this.host.timer) this.clearTimer(this.host.timer);
    this.host.timer = undefined;
    this.host.nextRunAt = undefined;
  }

  async runOnceAndSchedule(nowOverride = undefined) {
    this.markStarted();
    try {
      if (this.inFlight) {
        throw schedulerError(
          "scheduler_previous_run_still_in_flight",
          `${this.name} refused to launch duplicate work while its previous run is still in flight.`
        );
      }

      const runPromise = Promise.resolve().then(() => this.runOnce(nowOverride ?? this.now()));
      this.inFlight = runPromise;
      void runPromise.finally(() => {
        if (this.inFlight === runPromise) this.inFlight = undefined;
      }).catch(() => undefined);

      const summary = await withTimeout(runPromise, this.runTimeoutMs, this.name, this.setTimer, this.clearTimer);
      const outcome = this.resolveOutcome(summary);
      if (!outcome.ok) {
        throw schedulerError(outcome.state, outcome.message ?? `${this.name} reported an unhealthy run outcome.`, {
          outcome
        });
      }
      this.consecutiveSchedulerFailures = 0;
      this.lastSuccessfulRunAt = summary?.finishedAt ?? this.now().toISOString();
      return summary;
    } catch (error) {
      this.consecutiveSchedulerFailures += 1;
      this.lastSchedulerError = {
        at: this.now().toISOString(),
        code: error?.code ?? "scheduler_run_failed",
        message: error?.message ?? String(error)
      };
      this.logger.warn?.(
        { err: error, component: this.name, consecutiveFailures: this.consecutiveSchedulerFailures },
        this.failureLogEvent
      );
      return undefined;
    } finally {
      this.lastRunFinishedAt = this.now().toISOString();
      this.scheduleNextRun();
    }
  }

  resolveOutcome(summary) {
    if (typeof this.evaluateOutcome !== "function") {
      this.outcomeKey = undefined;
      this.outcomeStreak = 0;
      return { ok: true };
    }
    const opinion = this.evaluateOutcome(summary) ?? { ok: true };
    if (opinion.ok !== false) {
      this.outcomeKey = undefined;
      this.outcomeStreak = 0;
      return { ok: true };
    }
    const key = String(opinion.key ?? opinion.state ?? "unhealthy_outcome");
    this.outcomeStreak = key === this.outcomeKey ? this.outcomeStreak + 1 : 1;
    this.outcomeKey = key;
    const unhealthyAfter = positiveInteger(opinion.unhealthyAfter ?? 1, "unhealthyAfter");
    if (this.outcomeStreak < unhealthyAfter) return { ok: true };
    return { ...opinion, key, outcomeStreak: this.outcomeStreak, unhealthyAfter, ok: false };
  }

  scheduleNextRun(delayMs = this.intervalMs) {
    if (!this.host.running) {
      this.host.nextRunAt = undefined;
      return;
    }
    if (this.host.timer) this.clearTimer(this.host.timer);
    const delay = Math.max(0, Number(delayMs) || 0);
    this.host.nextRunAt = new Date(this.now().getTime() + delay).toISOString();
    this.host.timer = this.setTimer(() => {
      this.host.timer = undefined;
      this.host.nextRunAt = undefined;
      void this.runOnceAndSchedule();
    }, delay);
    this.host.timer?.unref?.();
  }

  getStatus(now = this.now()) {
    return {
      runTimeoutMs: this.runTimeoutMs,
      nextRunAt: this.host.nextRunAt,
      lastRunFinishedAt: this.lastRunFinishedAt,
      lastSuccessfulRunAt: this.lastSuccessfulRunAt,
      lastSchedulerError: this.lastSchedulerError,
      consecutiveSchedulerFailures: this.consecutiveSchedulerFailures,
      runInFlight: Boolean(this.inFlight),
      liveness: this.resolveLiveness(now)
    };
  }

  resolveLiveness(now = this.now()) {
    const staleAfterMs = Math.max(this.intervalMs * DEFAULT_STALE_INTERVALS, this.runTimeoutMs + this.intervalMs);
    if (!this.host.enabled) return { ok: true, state: "disabled", staleAfterMs };
    if (!this.host.running) return { ok: false, state: "stopped", staleAfterMs };
    if (this.consecutiveSchedulerFailures > 0) {
      return { ok: false, state: this.lastSchedulerError?.code ?? "run_failed", staleAfterMs };
    }
    const reference = this.lastRunFinishedAt ?? this.startedAt;
    const referenceMs = Date.parse(reference ?? "");
    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const lastRunAgeMs = Number.isFinite(referenceMs) && Number.isFinite(nowMs)
      ? Math.max(0, nowMs - referenceMs)
      : null;
    if (lastRunAgeMs === null || lastRunAgeMs > staleAfterMs) {
      return {
        ok: false,
        state: this.lastRunFinishedAt ? "last_run_stale" : "never_completed",
        staleAfterMs,
        lastRunAgeMs
      };
    }
    return { ok: true, state: "running", staleAfterMs, lastRunAgeMs };
  }
}

export function schedulerRunTimeoutMs(intervalMs) {
  return Math.min(Math.max(Number(intervalMs), 30_000), 5 * 60_000);
}

export function ingestionSchedulerOutcome(summary, {
  noInputReasons = [],
  emptySourceState,
  emptySourceMessage
} = {}) {
  if ((summary?.errors?.length ?? 0) > 0) {
    return { ok: false, state: "ingestion_run_errors", message: `${summary.errors.length} ingestion operation(s) failed.` };
  }
  const topLevelReasons = new Set((summary?.skipped ?? []).map((entry) => entry?.reason).filter(Boolean));
  const missingInput = noInputReasons.find((reason) => topLevelReasons.has(reason));
  if (missingInput) {
    return { ok: false, state: missingInput, message: `Enabled ingestion cannot run: ${missingInput}.` };
  }
  if (
    Number(summary?.candidateCount) === 0
    && !topLevelReasons.has("max_open_jobs_reached")
    && !topLevelReasons.has("disabled")
  ) {
    return {
      ok: false,
      key: emptySourceState ?? "no_source_candidates",
      state: emptySourceState ?? "no_source_candidates_repeated",
      unhealthyAfter: 3,
      message: emptySourceMessage ?? "The configured source produced no candidates for three consecutive runs."
    };
  }
  return { ok: true };
}

export function summaryErrorsOutcome(summary, state) {
  const count = summary?.errors?.length ?? 0;
  return count > 0
    ? { ok: false, state, message: `${count} operation(s) failed in the completed run.` }
    : { ok: true };
}

async function withTimeout(promise, timeoutMs, name, setTimer, clearTimer) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimer(() => reject(schedulerError(
          "scheduler_run_timeout",
          `${name} did not finish within ${timeoutMs}ms.`
        )), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimer(timer);
  }
}

function schedulerError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return parsed;
}
