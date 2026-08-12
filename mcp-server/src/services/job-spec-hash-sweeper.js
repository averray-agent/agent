import { hashCanonicalContent } from "../core/canonical-content.js";
import { GuardedSchedulerLoop, schedulerRunTimeoutMs, summaryErrorsOutcome } from "./guarded-scheduler-loop.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 5 * 60 * 1000;
const ZERO_SPEC_HASH = `0x${"00".repeat(32)}`;

export const SPEC_HASH_DRIFT_RECOVERY = "operator_tombstone_rescue_after_review_window";
export const SPEC_HASH_DRIFT_RECOVERY_REFERENCE =
  "scripts/ops/rescue-open-job.mjs (~7-day operator tombstone rescue; PR #877)";

export class JobSpecHashSweeperService {
  constructor(platformService, eventBus = undefined, {
    enabled = false,
    intervalMs = DEFAULT_INTERVAL_MS,
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    logger = console
  } = {}) {
    this.platformService = platformService;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.intervalMs = intervalMs;
    this.initialDelayMs = initialDelayMs;
    this.logger = logger;
    this.running = false;
    this.timer = undefined;
    this.nextRunAt = undefined;
    this.lastRun = undefined;
    this.firstRunPending = true;
    this.pausedForOperator = false;
    this.schedulerLoop = new GuardedSchedulerLoop({
      host: this,
      name: "job-spec-hash-sweeper",
      intervalMs: this.intervalMs,
      runTimeoutMs: schedulerRunTimeoutMs(this.intervalMs),
      runOnce: (now) => this.runOnce(now),
      evaluateOutcome: (summary) => summaryErrorsOutcome(summary, "job_spec_hash_sweep_errors"),
      logger: this.logger
    });
  }

  start() {
    if (!this.enabled || this.running || this.pausedForOperator) return;
    this.running = true;
    // Ingestion schedulers run immediately at boot. Delay this first sweep so
    // F2 can remove incremental drift before F3 counts the served remainder.
    this.schedulerLoop.markStarted();
    this.schedulerLoop.scheduleNextRun(this.initialDelayMs);
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
      initialDelayMs: this.initialDelayMs,
      firstRunPending: this.firstRunPending,
      pausedForOperator: this.pausedForOperator,
      lastRun: this.lastRun,
      ...this.schedulerLoop.getStatus()
    };
  }

  async runOnce(now = new Date()) {
    if (!this.enabled) {
      return this.finishRun(disabledSummary(now));
    }
    return this.runSweep(now, { guardMajority: this.firstRunPending });
  }

  async runOnDemand(now = new Date()) {
    return this.runSweep(now, { guardMajority: true });
  }

  async runSweep(now, { guardMajority }) {
    const summary = await sweepServedJobSpecHashes(this.platformService, {
      now,
      guardMajority
    });
    // A partial or empty read cannot consume the first-run safety gate. The
    // next complete committed-board scan must still enforce the >50% handback.
    if (summary.errors.length === 0 && summary.total > 0) {
      this.firstRunPending = false;
    }
    if (summary.guardTriggered) {
      // A strict majority is a product decision. Stop recurrence and leave all
      // rows untouched until the operator has reviewed the headline count.
      this.pausedForOperator = true;
      this.running = false;
      this.schedulerLoop.stop();
    }
    this.eventBus?.publish?.({
      id: `job-spec-hash-sweep-${Date.now()}`,
      topic: "jobs.spec_hash.swept",
      timestamp: new Date().toISOString(),
      data: summary
    });
    return this.finishRun(summary);
  }

  async runOnceAndSchedule() {
    return this.schedulerLoop.runOnceAndSchedule();
  }

  finishRun(summary) {
    summary.finishedAt ??= new Date().toISOString();
    this.lastRun = summary;
    return summary;
  }
}

export async function sweepServedJobSpecHashes(platformService, {
  now = new Date(),
  guardMajority = true
} = {}) {
  const startedAt = now.toISOString();
  const summary = {
    total: 0,
    matching: 0,
    drifted: 0,
    markedUnclaimable: 0,
    guardTriggered: false,
    action: "no_committed_jobs",
    startedAt,
    finishedAt: undefined,
    driftedJobs: [],
    errors: []
  };
  const gateway = platformService?.blockchainGateway;
  if (!gateway?.isEnabled?.()) {
    summary.action = "chain_disabled";
    return summary;
  }

  // listJobs() is deliberately the public served remainder. F2-marked rows are
  // already excluded, so the first F3 headline does not recount known drift.
  const servedJobs = platformService.listJobs({ now });
  for (const job of servedJobs) {
    let live;
    try {
      live = await gateway.getJob(job.id);
    } catch (error) {
      summary.errors.push({
        jobId: job.id,
        reason: "chain_read_unavailable",
        message: error?.message ?? String(error)
      });
      continue;
    }
    const committedSpecHash = normalizeSpecHash(live?.specHash);
    if (Number(live?.state ?? 0) === 0 || !committedSpecHash) continue;

    const servedSpecHash = hashCanonicalContent(job);
    summary.total += 1;
    if (servedSpecHash === committedSpecHash) {
      summary.matching += 1;
      continue;
    }
    summary.drifted += 1;
    summary.driftedJobs.push({
      jobId: job.id,
      committedSpecHash,
      servedSpecHash,
      candidateSpecHash: servedSpecHash,
      servedDefinitionRetained: true,
      legacyDrift: true,
      detectedAt: startedAt,
      recovery: SPEC_HASH_DRIFT_RECOVERY,
      recoveryReference: SPEC_HASH_DRIFT_RECOVERY_REFERENCE
    });
  }

  summary.guardTriggered = guardMajority
    && summary.total > 0
    && summary.drifted * 2 > summary.total;
  if (summary.errors.length > 0) {
    summary.action = "chain_read_errors";
    return summary;
  }
  if (summary.guardTriggered) {
    summary.action = "operator_handback_required";
    return summary;
  }

  for (const record of summary.driftedJobs) {
    platformService.markJobSpecHashDrift(record.jobId, record);
    summary.markedUnclaimable += 1;
  }
  summary.action = summary.drifted > 0
    ? "drifted_jobs_marked_unclaimable"
    : (summary.total > 0 ? "all_matching" : "no_committed_jobs");
  return summary;
}

export function loadJobSpecHashSweeperConfig(env = process.env, { gatewayEnabled = false } = {}) {
  return {
    enabled: env.JOB_SPEC_HASH_SWEEP_ENABLED === undefined
      ? gatewayEnabled
      : parseBooleanEnv(env.JOB_SPEC_HASH_SWEEP_ENABLED),
    intervalMs: parsePositiveInt(env.JOB_SPEC_HASH_SWEEP_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    initialDelayMs: parsePositiveInt(
      env.JOB_SPEC_HASH_SWEEP_INITIAL_DELAY_MS,
      DEFAULT_INITIAL_DELAY_MS
    )
  };
}

function disabledSummary(now) {
  return {
    total: 0,
    matching: 0,
    drifted: 0,
    markedUnclaimable: 0,
    guardTriggered: false,
    action: "disabled",
    startedAt: now.toISOString(),
    finishedAt: undefined,
    driftedJobs: [],
    errors: []
  };
}

function normalizeSpecHash(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/u.test(normalized) && normalized !== ZERO_SPEC_HASH
    ? normalized
    : undefined;
}

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseBooleanEnv(raw) {
  return ["1", "true", "yes", "on"].includes(String(raw ?? "").trim().toLowerCase());
}
