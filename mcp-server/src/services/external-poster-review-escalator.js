import { GuardedSchedulerLoop, schedulerRunTimeoutMs, summaryErrorsOutcome } from "./guarded-scheduler-loop.js";

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_PER_RUN = 25;

export class ExternalPosterReviewEscalatorService {
  constructor(platformService, stateStore, posterReviewService, eventBus = undefined, {
    enabled = false,
    intervalMs = DEFAULT_INTERVAL_MS,
    maxPerRun = DEFAULT_MAX_PER_RUN,
    logger = console
  } = {}) {
    this.platformService = platformService;
    this.stateStore = stateStore;
    this.posterReviewService = posterReviewService;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.intervalMs = intervalMs;
    this.maxPerRun = maxPerRun;
    this.logger = logger;
    this.running = false;
    this.timer = undefined;
    this.lastRun = undefined;
    this.schedulerLoop = new GuardedSchedulerLoop({
      host: this,
      name: "external-poster-review-escalator",
      intervalMs: this.intervalMs,
      runTimeoutMs: schedulerRunTimeoutMs(this.intervalMs),
      runOnce: (now) => this.runOnce(now),
      evaluateOutcome: (summary) => summaryErrorsOutcome(summary, "poster_review_escalation_errors"),
      logger: this.logger
    });
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    void this.runOnceAndSchedule();
  }

  stop() {
    this.running = false;
    this.schedulerLoop.stop();
  }

  async getStatus() {
    return {
      enabled: this.enabled,
      running: this.running,
      intervalMs: this.intervalMs,
      maxPerRun: this.maxPerRun,
      reviewWindowSeconds: this.posterReviewService.reviewWindowSeconds,
      lastRun: this.lastRun,
      ...this.schedulerLoop.getStatus()
    };
  }

  async runOnce(now = new Date()) {
    const summary = {
      startedAt: now.toISOString(),
      finishedAt: undefined,
      scanned: 0,
      candidateCount: 0,
      escalatedCount: 0,
      skipped: [],
      errors: []
    };
    if (!this.enabled) {
      summary.skipped.push({ reason: "disabled" });
      return this.finishRun(summary);
    }

    const jobs = this.platformService.listJobs({
      includeStale: true,
      includePaused: true,
      includeArchived: false,
      now
    }).filter((job) => job?.source === "external" || job?.source?.type === "external");
    summary.scanned = jobs.length;

    const candidates = [];
    for (const job of jobs) {
      const session = await this.stateStore.findSessionByJobId?.(job.id);
      if (session?.status !== "submitted" || !session.submittedAt) continue;
      const deadline = Date.parse(session.submittedAt)
        + (this.posterReviewService.reviewWindowSeconds * 1000);
      if (Number.isFinite(deadline) && now.getTime() >= deadline) {
        candidates.push({ jobId: job.id, sessionId: session.sessionId });
      }
    }
    summary.candidateCount = candidates.length;

    for (const candidate of candidates.slice(0, this.maxPerRun)) {
      try {
        const result = await this.posterReviewService.escalateExpiredSubmission(
          candidate.jobId,
          { now }
        );
        if (result?.decision === "escalated" && result?.replayed !== true) {
          summary.escalatedCount += 1;
        } else {
          summary.skipped.push({ ...candidate, reason: "decision_already_recorded" });
        }
      } catch (error) {
        summary.errors.push({
          ...candidate,
          code: error?.code,
          message: error?.message ?? String(error)
        });
        this.logger.warn?.(
          { ...candidate, err: error },
          "external_poster_review.escalation_failed"
        );
      }
    }
    if (candidates.length > this.maxPerRun) {
      summary.skipped.push({
        reason: "max_per_run_reached",
        deferred: candidates.length - this.maxPerRun
      });
    }
    return this.finishRun(summary);
  }

  async runOnceAndSchedule() {
    return this.schedulerLoop.runOnceAndSchedule();
  }

  finishRun(summary) {
    summary.finishedAt = new Date().toISOString();
    this.lastRun = summary;
    return summary;
  }
}

export function loadExternalPosterReviewEscalatorConfig(env = process.env, {
  gatewayEnabled = false
} = {}) {
  return {
    enabled: env.EXTERNAL_POSTER_REVIEW_ESCALATOR_ENABLED === undefined
      ? gatewayEnabled
      : parseBooleanEnv(env.EXTERNAL_POSTER_REVIEW_ESCALATOR_ENABLED),
    intervalMs: parsePositiveInt(
      env.EXTERNAL_POSTER_REVIEW_ESCALATOR_INTERVAL_MS,
      DEFAULT_INTERVAL_MS
    ),
    maxPerRun: parsePositiveInt(
      env.EXTERNAL_POSTER_REVIEW_ESCALATOR_MAX_PER_RUN,
      DEFAULT_MAX_PER_RUN
    )
  };
}

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseBooleanEnv(raw) {
  return ["1", "true", "yes", "on"].includes(String(raw ?? "").trim().toLowerCase());
}
