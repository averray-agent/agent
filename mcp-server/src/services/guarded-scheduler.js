const DEFAULT_MAX_RUN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MIN_RUN_TIMEOUT_MS = 30 * 1000;

export class GuardedSchedulerLoop {
  constructor({
    name,
    enabled,
    intervalMs,
    runOnce,
    evaluateOutcome = () => ({ ok: true }),
    runTimeoutMs = defaultRunTimeoutMs(intervalMs),
    logger = console,
    now = () => new Date()
  }) {
    this.name = name;
    this.enabled = enabled;
    this.intervalMs = intervalMs;
    this.runOnce = runOnce;
    this.evaluateOutcome = evaluateOutcome;
    this.runTimeoutMs = runTimeoutMs;
    this.logger = logger;
    this.now = now;
    this.running = false;
    this.startedAt = undefined;
    this.timer = undefined;
    this.nextRunAt = undefined;
    this.lastRunFinishedAt = undefined;
    this.lastSuccessfulRunAt = undefined;
    this.lastSchedulerError = undefined;
    this.consecutiveSchedulerFailures = 0;
    this.pendingRun = undefined;
  }

  start({ initialDelayMs = 0 } = {}) {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.startedAt = this.now().toISOString();
    if (initialDelayMs > 0) {
      this.scheduleNextRun(initialDelayMs);
      return;
    }
    void this.runOnceAndSchedule();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRunAt = undefined;
  }

  async runOnceAndSchedule(now = this.now()) {
    try {
      const summary = await this.runBounded(now);
      const outcome = this.evaluateOutcome(summary) ?? { ok: true };
      this.lastRunFinishedAt = summary?.finishedAt ?? this.now().toISOString();
      if (outcome.ok === false) {
        throw new SchedulerOutcomeError(outcome);
      }
      this.consecutiveSchedulerFailures = 0;
      this.lastSuccessfulRunAt = this.lastRunFinishedAt;
    } catch (error) {
      if (error?.code !== "run_timed_out" && error?.code !== "run_timeout_pending") {
        // A rejected run did finish; keep freshness evidence independent from
        // success while failure counters keep health red.
        this.lastRunFinishedAt = this.now().toISOString();
      }
      this.consecutiveSchedulerFailures += 1;
      this.lastSchedulerError = {
        at: this.now().toISOString(),
        code: error?.code ?? "scheduler_run_failed",
        message: error?.message ?? String(error)
      };
      this.logger.warn?.(
        { err: error, consecutiveFailures: this.consecutiveSchedulerFailures },
        `${this.name}.scheduler_run_failed`
      );
    } finally {
      this.scheduleNextRun();
    }
  }

  async runBounded(now) {
    if (this.pendingRun) {
      throw new SchedulerRunPendingError(this.name);
    }

    const entry = { timedOut: false, promise: undefined };
    const run = Promise.resolve()
      .then(() => this.runOnce(now))
      .then(
        (summary) => ({ status: "fulfilled", summary }),
        (error) => ({ status: "rejected", error })
      );
    entry.promise = run;
    this.pendingRun = entry;
    void run.then(() => {
      if (this.pendingRun === entry) this.pendingRun = undefined;
    });

    let timeout;
    const timed = new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ status: "timed_out" }), this.runTimeoutMs);
      timeout.unref?.();
    });
    const settled = await Promise.race([run, timed]);
    clearTimeout(timeout);

    if (settled.status === "timed_out") {
      entry.timedOut = true;
      throw new SchedulerRunTimeoutError(this.name, this.runTimeoutMs);
    }
    if (this.pendingRun === entry) this.pendingRun = undefined;
    if (settled.status === "rejected") throw settled.error;
    return settled.summary;
  }

  scheduleNextRun(delayMs = this.intervalMs) {
    if (!this.running) {
      this.nextRunAt = undefined;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, Number(delayMs) || 0);
    this.nextRunAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.nextRunAt = undefined;
      void this.runOnceAndSchedule();
    }, delay);
    this.timer.unref?.();
  }

  getStatus(now = new Date()) {
    return {
      nextRunAt: this.nextRunAt,
      lastRunFinishedAt: this.lastRunFinishedAt,
      lastSuccessfulRunAt: this.lastSuccessfulRunAt,
      lastSchedulerError: this.lastSchedulerError,
      consecutiveSchedulerFailures: this.consecutiveSchedulerFailures,
      schedulerRunTimeoutMs: this.runTimeoutMs,
      pendingTimedOutRun: this.pendingRun?.timedOut === true,
      liveness: this.resolveLiveness(now)
    };
  }

  getHealth(now = new Date()) {
    return {
      ...this.resolveLiveness(now),
      enabled: this.enabled,
      running: this.running,
      intervalMs: this.intervalMs,
      nextRunAt: this.nextRunAt,
      lastRunFinishedAt: this.lastRunFinishedAt,
      consecutiveSchedulerFailures: this.consecutiveSchedulerFailures,
      lastSchedulerError: this.lastSchedulerError,
      pendingTimedOutRun: this.pendingRun?.timedOut === true
    };
  }

  resolveLiveness(now = new Date()) {
    const staleAfterMs = Math.max(this.intervalMs * 3, this.runTimeoutMs + this.intervalMs);
    if (!this.enabled) return { ok: true, state: "disabled", staleAfterMs };
    if (!this.running) return { ok: false, state: "stopped", staleAfterMs };
    if (this.pendingRun?.timedOut) {
      return { ok: false, state: "run_timeout_pending", staleAfterMs };
    }
    if (this.consecutiveSchedulerFailures > 0) {
      return {
        ok: false,
        state: this.lastSchedulerError?.code ?? "run_failed",
        staleAfterMs
      };
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

class SchedulerRunTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`${name} did not finish within ${timeoutMs}ms.`);
    this.name = "SchedulerRunTimeoutError";
    this.code = "run_timed_out";
  }
}

class SchedulerRunPendingError extends Error {
  constructor(name) {
    super(`${name} still has a timed-out run pending; duplicate work was not started.`);
    this.name = "SchedulerRunPendingError";
    this.code = "run_timeout_pending";
  }
}

class SchedulerOutcomeError extends Error {
  constructor(outcome) {
    super(outcome.message ?? outcome.state ?? "scheduler outcome was unhealthy");
    this.name = "SchedulerOutcomeError";
    this.code = outcome.state ?? "unhealthy_outcome";
  }
}

function defaultRunTimeoutMs(intervalMs) {
  return Math.max(
    DEFAULT_MIN_RUN_TIMEOUT_MS,
    Math.min(Number(intervalMs) || DEFAULT_MAX_RUN_TIMEOUT_MS, DEFAULT_MAX_RUN_TIMEOUT_MS)
  );
}
