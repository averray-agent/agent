const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_JOBS_PER_RUN = 25;
const VALID_SWEEP_ACTIONS = new Set(["mark_stale", "pause", "archive"]);
const TERMINAL_SESSION_STATUSES = new Set(["resolved", "rejected", "closed", "expired", "timed_out"]);

export class JobStaleSweeperService {
  constructor(platformService, stateStore, eventBus = undefined, {
    enabled = false,
    dryRun = true,
    intervalMs = DEFAULT_INTERVAL_MS,
    action = "archive",
    maxJobsPerRun = DEFAULT_MAX_JOBS_PER_RUN,
    reason = "automatic stale job cleanup",
    logger = console
  } = {}) {
    this.platformService = platformService;
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.dryRun = dryRun;
    this.intervalMs = intervalMs;
    this.action = normalizeSweepAction(action);
    this.maxJobsPerRun = maxJobsPerRun;
    this.reason = String(reason || "automatic stale job cleanup").trim();
    this.logger = logger;
    this.running = false;
    this.timer = undefined;
    this.lastRun = undefined;
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    void this.runOnceAndSchedule();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async getStatus() {
    return {
      enabled: this.enabled,
      running: this.running,
      dryRun: this.dryRun,
      mode: this.dryRun ? "dry_run" : "live",
      intervalMs: this.intervalMs,
      action: this.action,
      maxJobsPerRun: this.maxJobsPerRun,
      lastRun: this.lastRun
    };
  }

  async runOnce(now = new Date()) {
    const summary = {
      startedAt: now.toISOString(),
      finishedAt: undefined,
      dryRun: this.dryRun,
      action: this.action,
      candidateCount: 0,
      updatedCount: 0,
      skipped: [],
      errors: []
    };

    if (!this.enabled) {
      summary.skipped.push({ reason: "disabled" });
      return this.finishRun(summary);
    }

    const candidates = this.findStaleJobs(now).slice(0, this.maxJobsPerRun);
    summary.candidateCount = candidates.length;
    for (const job of candidates) {
      try {
        const activeSession = await this.findActiveSession(job.id);
        if (activeSession) {
          summary.skipped.push({
            id: job.id,
            reason: "active_session",
            sessionId: activeSession.sessionId,
            status: activeSession.status
          });
          continue;
        }
        if (!this.dryRun) {
          this.platformService.updateJobLifecycle(job.id, {
            action: this.action,
            reason: this.reason
          });
        }
        summary.updatedCount += 1;
        this.eventBus?.publish?.({
          id: `job-stale-sweeper-${job.id}-${Date.now()}`,
          topic: "jobs.lifecycle.swept",
          jobId: job.id,
          timestamp: new Date().toISOString(),
          data: {
            dryRun: this.dryRun,
            action: this.action,
            jobId: job.id,
            lifecycle: job.lifecycle
          }
        });
      } catch (error) {
        summary.errors.push({ id: job.id, message: error?.message ?? String(error) });
        this.logger.warn?.({ jobId: job.id, err: error }, "job_stale_sweeper.update_failed");
      }
    }

    return this.finishRun(summary);
  }

  findStaleJobs(now = new Date()) {
    return this.platformService.listJobs({
      includeStale: true,
      includePaused: false,
      includeArchived: false,
      now
    }).filter((job) => !job.recurring && job.lifecycle?.status === "open" && job.lifecycle?.state === "stale");
  }

  async findActiveSession(jobId) {
    const sessions = await this.stateStore?.listSessionsByJob?.(jobId, 10) ?? [];
    const activeFromHistory = sessions.find((session) => session && !TERMINAL_SESSION_STATUSES.has(session.status));
    if (activeFromHistory) return activeFromHistory;
    const current = await this.stateStore?.findSessionByJobId?.(jobId);
    if (current && !TERMINAL_SESSION_STATUSES.has(current.status)) return current;
    return undefined;
  }

  async runOnceAndSchedule() {
    await this.runOnce(new Date());
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.runOnceAndSchedule();
    }, this.intervalMs);
  }

  finishRun(summary) {
    summary.finishedAt = new Date().toISOString();
    this.lastRun = summary;
    return summary;
  }
}

export function loadJobStaleSweeperConfig(env = process.env) {
  return {
    enabled: parseBooleanEnv(env.JOB_STALE_SWEEPER_ENABLED),
    dryRun: env.JOB_STALE_SWEEPER_DRY_RUN === undefined
      ? true
      : parseBooleanEnv(env.JOB_STALE_SWEEPER_DRY_RUN),
    intervalMs: parsePositiveInt(env.JOB_STALE_SWEEPER_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    action: normalizeSweepAction(env.JOB_STALE_SWEEPER_ACTION ?? "archive"),
    maxJobsPerRun: parsePositiveInt(env.JOB_STALE_SWEEPER_MAX_JOBS_PER_RUN, DEFAULT_MAX_JOBS_PER_RUN),
    reason: env.JOB_STALE_SWEEPER_REASON?.trim() || "automatic stale job cleanup"
  };
}

function normalizeSweepAction(value) {
  const action = String(value ?? "archive").trim().toLowerCase();
  return VALID_SWEEP_ACTIONS.has(action) ? action : "archive";
}

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function parseBooleanEnv(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}
