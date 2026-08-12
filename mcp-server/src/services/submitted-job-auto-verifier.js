import { GuardedSchedulerLoop, summaryErrorsOutcome } from "./guarded-scheduler-loop.js";

// Auto-verify submitted jobs whose verifier mode is machine-decidable, so an
// external worker's submission settles on its own instead of sitting in
// `submitted` forever waiting for an operator to call POST /verifier/run.
//
// This is the backend counterpart to the manual `/verifier/run` route
// (protocols/http/verifier-routes.js): both ultimately call the same
// `verifierService.verifySubmission({ sessionId })`. The HTTP route gates that
// call behind `requireRole: "verifier"`; this scheduler is an in-process caller
// and so needs no JWT principal — exactly how the manual route reaches the
// service after its auth check. On an `approved`/`rejected` verdict
// verifySubmission also brokers the on-chain settlement (resolveSinglePayout)
// using the gateway's configured signer, which holds the on-chain verifier role
// (see BlockchainGateway.getTreasuryPolicyStatus → settlementReady). So a single
// verifySubmission call takes a job from `submitted` all the way to settled.
//
// Only `benchmark` and `deterministic` modes are auto-decidable. `human_fallback`
// and `github_pr` legitimately need a human or external trigger, so they are
// never auto-verified here — the allowlist below is enforced even against
// operator misconfiguration.

import { isJobSnapshotIntegrityError, requireJobSnapshot } from "../core/job-snapshot.js";
import { isHostedCanaryClaimant } from "../core/claimant-attribution.js";

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_SCAN_LIMIT = 200;
const DEFAULT_MAX_PER_RUN = 25;
const DEFAULT_CANDIDATE_TIMEOUT_MS = 3 * 60 * 1000;

// Hard allowlist of machine-decidable verifier handlers. human_fallback and
// github_pr are intentionally excluded and cannot be re-enabled via config.
const AUTO_DECIDABLE_MODES = Object.freeze(["benchmark", "deterministic"]);
const BY_DESIGN_SUBMITTED_SKIP_REASONS = new Set([
  "non_auto_mode",
  "already_verified",
  "dry_run"
]);

export class SubmittedJobAutoVerifierService {
  constructor(platformService, verifierService, gateway = undefined, eventBus = undefined, {
    enabled = false,
    dryRun = false,
    intervalMs = DEFAULT_INTERVAL_MS,
    scanLimit = DEFAULT_SCAN_LIMIT,
    maxPerRun = DEFAULT_MAX_PER_RUN,
    candidateTimeoutMs = DEFAULT_CANDIDATE_TIMEOUT_MS,
    autoModes = AUTO_DECIDABLE_MODES,
    requireSettlementReady = true,
    logger = console
  } = {}) {
    this.platformService = platformService;
    this.verifierService = verifierService;
    this.gateway = gateway;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.dryRun = dryRun;
    this.intervalMs = intervalMs;
    this.scanLimit = scanLimit;
    this.maxPerRun = maxPerRun;
    this.candidateTimeoutMs = candidateTimeoutMs;
    this.autoModes = normalizeAutoModes(autoModes);
    this.requireSettlementReady = requireSettlementReady;
    this.logger = logger;
    this.running = false;
    this.startedAt = undefined;
    this.timer = undefined;
    this.nextRunAt = undefined;
    this.inFlight = new Set();
    this.pendingVerifications = new Map();
    this.lastRun = undefined;
    this.lastSuccessfulRunAt = undefined;
    this.lastSchedulerError = undefined;
    this.consecutiveSchedulerFailures = 0;
    this.submittedFailureStreaks = new Map();
    this.schedulerLoop = new GuardedSchedulerLoop({
      host: this,
      name: "submitted-job-auto-verifier",
      intervalMs: this.intervalMs,
      runTimeoutMs: Math.max(this.candidateTimeoutMs, this.intervalMs),
      runOnce: (now) => this.runOnce(now),
      evaluateOutcome: (summary) => summaryErrorsOutcome(summary, "auto_verification_errors"),
      logger: this.logger,
      failureLogEvent: "auto_verify.scheduler_run_failed"
    });
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.schedulerLoop.startedAt = this.startedAt;
    void this.runOnceAndSchedule();
  }

  stop() {
    this.running = false;
    this.schedulerLoop.stop();
  }

  async getStatus(now = new Date()) {
    return {
      enabled: this.enabled,
      running: this.running,
      dryRun: this.dryRun,
      mode: this.dryRun ? "dry_run" : "live",
      intervalMs: this.intervalMs,
      scanLimit: this.scanLimit,
      maxPerRun: this.maxPerRun,
      candidateTimeoutMs: this.candidateTimeoutMs,
      inFlightCount: this.inFlight.size,
      pendingTimeoutCount: this.countPendingTimeouts(),
      persistentSubmittedFailures: this.listPersistentSubmittedFailures(),
      autoModes: [...this.autoModes],
      requireSettlementReady: this.requireSettlementReady,
      lastRun: this.lastRun,
      ...this.schedulerLoop.getStatus(now),
      liveness: this.resolveLiveness(now)
    };
  }

  async getHealth(now = new Date()) {
    const schedulerStatus = this.schedulerLoop.getStatus(now);
    const liveness = this.resolveLiveness(now);
    return {
      ...liveness,
      enabled: this.enabled,
      running: this.running,
      mode: this.dryRun ? "dry_run" : "live",
      intervalMs: this.intervalMs,
      nextRunAt: schedulerStatus.nextRunAt,
      lastRunFinishedAt: schedulerStatus.lastRunFinishedAt,
      consecutiveSchedulerFailures: schedulerStatus.consecutiveSchedulerFailures,
      pendingTimeoutCount: this.countPendingTimeouts(),
      persistentSubmittedFailures: this.listPersistentSubmittedFailures()
    };
  }

  resolveLiveness(now = new Date()) {
    this.schedulerLoop.startedAt ??= this.startedAt;
    this.schedulerLoop.lastRunFinishedAt ??= this.lastRun?.finishedAt;
    const base = this.schedulerLoop.resolveLiveness(now);
    if (this.countPendingTimeouts() > 0) {
      return {
        ok: false,
        state: "verification_timeout_pending",
        staleAfterMs: base.staleAfterMs
      };
    }
    const persistentSubmittedFailures = this.listPersistentSubmittedFailures();
    if (persistentSubmittedFailures.length > 0) {
      return {
        ok: false,
        state: "submitted_session_persistently_skipped",
        staleAfterMs: base.staleAfterMs,
        persistentSubmittedFailureCount: persistentSubmittedFailures.length,
        persistentSubmittedFailures
      };
    }
    return base;
  }

  countPendingTimeouts() {
    let count = 0;
    for (const entry of this.pendingVerifications.values()) {
      if (entry.timedOut) count += 1;
    }
    return count;
  }

  listPersistentSubmittedFailures() {
    return [...this.submittedFailureStreaks.values()]
      .filter((entry) => entry.consecutiveRuns >= 2)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  async runOnce(now = new Date()) {
    const summary = {
      startedAt: now.toISOString(),
      finishedAt: undefined,
      dryRun: this.dryRun,
      scanned: 0,
      candidateCount: 0,
      verifiedCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
      deferredCount: 0,
      skipped: [],
      errors: []
    };

    if (!this.enabled) {
      summary.skipped.push({ reason: "disabled" });
      return this.finishRun(summary);
    }

    // Honor pause/HALT before touching any session. When the chain is wired we
    // refuse to auto-verify while the protocol is paused (the on-chain
    // whenNotPaused kill-switch) or while settlement is not ready — auto-verifying
    // then would either revert on-chain (spamming failed txs) or, worse, advance
    // a session to a "resolved" state without a real payout, breaking the
    // truth boundary between settled and not-settled.
    const gate = await this.checkSettlementGate();
    if (!gate.ok) {
      summary.skipped.push({ reason: gate.reason, ...(gate.detail ? { detail: gate.detail } : {}) });
      return this.finishRun(summary);
    }

    const sessions = await this.platformService.listRecentSessions?.(this.scanLimit) ?? [];
    summary.scanned = sessions.length;

    const candidates = [];
    for (const session of sessions) {
      if (session?.status !== "submitted") continue;
      const sessionId = session.sessionId;
      const diagnostic = sessionDiagnostic(session);
      if (this.inFlight.has(sessionId)) {
        summary.skipped.push({ ...diagnostic, reason: "in_flight" });
        continue;
      }
      // A timed-out operation cannot be cancelled safely after it may have
      // submitted a payout transaction. Quarantine it until the original
      // promise settles; unlike the old inFlight leak this state is explicit,
      // health-degrading, and cannot launch a duplicate settlement.
      if (this.pendingVerifications.has(sessionId)) {
        summary.skipped.push({ ...diagnostic, reason: "verification_timeout_pending" });
        continue;
      }
      // A submitted session should never already carry a verification result,
      // but if one is present treat it as resolved-in-flight and leave it alone.
      if (session.verification) {
        summary.skipped.push({ ...diagnostic, reason: "already_verified" });
        continue;
      }
      let job;
      try {
        ({ job } = requireJobSnapshot(session));
      } catch (error) {
        summary.skipped.push({
          ...diagnostic,
          reason: error?.code ?? "job_snapshot_invalid",
          message: error?.message ?? String(error)
        });
        continue;
      }
      const mode = job?.verifierConfig?.handler ?? job?.verifierMode;
      if (!this.autoModes.has(mode)) {
        summary.skipped.push({ ...diagnostic, reason: "non_auto_mode", mode: mode ?? null });
        continue;
      }
      candidates.push({ ...diagnostic, mode });
    }
    summary.candidateCount = candidates.length;

    const actionable = candidates.slice(0, this.maxPerRun);
    summary.deferredCount = candidates.length - actionable.length;
    if (summary.deferredCount > 0) {
      // Surface the cap rather than silently dropping the tail — the remainder
      // is picked up on the next tick.
      summary.skipped.push({ reason: "max_per_run_reached", deferred: summary.deferredCount });
    }

    for (const candidate of actionable) {
      if (this.dryRun) {
        summary.skipped.push({ ...candidate, reason: "dry_run" });
        continue;
      }
      await this.verifyCandidate(candidate, summary);
    }

    return this.finishRun(summary);
  }

  async verifyCandidate(candidate, summary) {
    const { sessionId, jobId, mode } = candidate;
    this.inFlight.add(sessionId);
    // Autonomous settlement entry point. Runs in-process with NO JWT principal —
    // the manual /verifier/run route reaches the same verifySubmission (which
    // brokers resolveSinglePayout on-chain). Logged under a synthetic principal so
    // every autonomous settlement is attributable in the audit trail (audit B-01).
    // Trust boundary: a process compromise is the threat; damage is bounded by
    // requireChainBackedMutation + the hard {benchmark, deterministic} mode
    // allowlist + HALT-awareness. See docs/MAINNET_AUDIT_REMEDIATION.md.
    this.logger.info?.(
      { principal: "system:auto-verifier", sessionId, jobId, mode },
      "auto_verify.settlement_triggered"
    );

    // Convert both resolution and rejection into data before racing the timeout.
    // That suppresses an unhandled rejection if the original operation finishes
    // after this run has already moved on.
    const entry = { candidate, timedOut: false, promise: undefined };
    const verification = Promise.resolve()
      .then(() => this.verifierService.verifySubmission({ sessionId }))
      .then(
        (result) => ({ status: "fulfilled", result }),
        (error) => ({ status: "rejected", error })
      );
    entry.promise = verification;
    this.pendingVerifications.set(sessionId, entry);

    // One completion hook owns quarantine cleanup and late-result reporting.
    // It is installed once, so later scheduler ticks can never publish a
    // second resolution or start another payout for this session.
    void verification
      .then((late) => {
        if (this.pendingVerifications.get(sessionId) === entry) {
          this.pendingVerifications.delete(sessionId);
        }
        this.inFlight.delete(sessionId);
        if (!entry.timedOut) return;
        if (late.status === "fulfilled") {
          this.recordVerificationSuccess(candidate, late.result, undefined, { late: true });
          return;
        }
        this.recordVerificationFailure(candidate, late.error, undefined, { late: true });
      })
      .catch((error) => {
        // Observability hooks must never turn a safely-contained late result
        // into an unhandled process rejection.
        this.logger.warn?.({ sessionId, jobId, mode, err: error }, "auto_verify.late_result_hook_failed");
      });
    let timeout;
    const timed = new Promise((resolve) => {
      timeout = setTimeout(
        () => resolve({ status: "timed_out" }),
        this.candidateTimeoutMs
      );
    });
    const settled = await Promise.race([verification, timed]);
    clearTimeout(timeout);

    if (settled.status === "timed_out") {
      entry.timedOut = true;
      this.inFlight.delete(sessionId);
      summary.errors.push({
        ...candidate,
        code: "verification_timeout",
        message: `Verification did not finish within ${this.candidateTimeoutMs}ms.`
      });
      this.logger.warn?.(
        { sessionId, jobId, mode, timeoutMs: this.candidateTimeoutMs },
        "auto_verify.verify_timeout"
      );

      // The active inFlight ownership is released immediately so later jobs
      // and scheduler ticks are not wedged. The pendingVerifications quarantine
      // remains until the uncancellable call settles, preventing a duplicate
      // payout and making a permanent hang visible through /health.
      return;
    }

    if (this.pendingVerifications.get(sessionId) === entry) {
      this.pendingVerifications.delete(sessionId);
    }
    this.inFlight.delete(sessionId);
    if (settled.status === "rejected") {
      this.recordVerificationFailure(candidate, settled.error, summary);
      return;
    }
    this.recordVerificationSuccess(candidate, settled.result, summary);
  }

  recordVerificationSuccess(candidate, result, summary = undefined, { late = false } = {}) {
    const { sessionId, jobId, mode } = candidate;
    const outcome = result?.outcome;
    if (summary) {
      summary.verifiedCount += 1;
      if (outcome === "approved") summary.approvedCount += 1;
      else if (outcome === "rejected") summary.rejectedCount += 1;
    }
    this.logger.info?.(
      {
        principal: "system:auto-verifier",
        sessionId,
        jobId,
        mode,
        outcome,
        reasonCode: result?.reasonCode,
        late
      },
      "auto_verify.verified"
    );
    this.eventBus?.publish?.({
      id: `auto-verify-${sessionId}-${Date.now()}`,
      topic: "verifier.auto.resolved",
      jobId,
      timestamp: new Date().toISOString(),
      data: { sessionId, jobId, mode, outcome, reasonCode: result?.reasonCode, late }
    });
  }

  recordVerificationFailure(candidate, error, summary = undefined, { late = false } = {}) {
    const { sessionId, jobId, mode } = candidate;
    // A session that flipped out of `submitted` between scan and verify (e.g.
    // a manual /verifier/run ran first), or a settlement tx that reverted,
    // lands here. Both are safe to retry next tick: a verdict is committed
    // only after settlement succeeds, so a failed run leaves the session in
    // `submitted`.
    const failure = {
      ...candidate,
      ...(error?.code ? { code: error.code } : {}),
      ...(isJobSnapshotIntegrityError(error) ? { integrityFailure: true } : {}),
      message: error?.message ?? String(error)
    };
    if (summary) {
      if (failure.integrityFailure) {
        summary.skipped.push({
          ...failure,
          reason: failure.code ?? "job_snapshot_integrity_hold",
          integrityHold: true
        });
      } else {
        summary.errors.push(failure);
      }
    }
    this.logger.warn?.({ sessionId, jobId, mode, late, err: error }, "auto_verify.verify_failed");
  }

  // Returns { ok: true } when it is safe to settle, otherwise { ok: false,
  // reason, detail? }. When no chain gateway is wired (memory backend / dev)
  // there is no on-chain HALT to honor, so the gate passes and verifySubmission
  // advances session state without an on-chain payout (the simulated path).
  async checkSettlementGate() {
    if (!this.gateway?.isEnabled?.()) {
      return { ok: true };
    }
    let status;
    try {
      status = await this.gateway.getTreasuryPolicyStatus();
    } catch (error) {
      // Fail closed: if we cannot read protocol posture we must not move value.
      return { ok: false, reason: "policy_status_unavailable", detail: error?.message ?? String(error) };
    }
    if (status?.paused === true) {
      return { ok: false, reason: "protocol_paused" };
    }
    if (this.requireSettlementReady && status?.settlementReady === false) {
      return { ok: false, reason: "settlement_not_ready" };
    }
    return { ok: true };
  }

  async runOnceAndSchedule() {
    return this.schedulerLoop.runOnceAndSchedule();
  }

  scheduleNextRun() {
    this.schedulerLoop.scheduleNextRun();
  }

  finishRun(summary) {
    summary.finishedAt = new Date().toISOString();
    this.updateSubmittedFailureStreaks(summary);
    this.lastRun = summary;
    return summary;
  }

  updateSubmittedFailureStreaks(summary) {
    const failures = [
      ...(summary.skipped ?? []),
      ...(summary.errors ?? [])
    ].filter((entry) => {
      if (!entry?.sessionId) return false;
      const reason = entry.reason ?? entry.code;
      if (BY_DESIGN_SUBMITTED_SKIP_REASONS.has(reason)) return false;
      // The exemption follows positive claimant proof captured at claim time,
      // never the job id. A public worker who wins a race for a canary-posted
      // job has no wallet-bound marker attribution and remains alarmable.
      if (isHostedCanaryClaimant(entry)) return false;
      return true;
    });
    const next = new Map();
    for (const failure of failures) {
      // The health invariant is session-scoped: a submitted session that is
      // skipped or errors on consecutive runs still represents an unpaid
      // worker even if the reported cause changes between runs. Unknown future
      // reasons must fail visible instead of disappearing from health.
      const reason = failure.reason ?? failure.code ?? "unknown";
      const key = failure.sessionId;
      const previous = this.submittedFailureStreaks.get(key);
      next.set(key, {
        sessionId: failure.sessionId,
        jobId: failure.jobId,
        reason,
        consecutiveRuns: Number(previous?.consecutiveRuns ?? 0) + 1,
        lastSeenAt: summary.finishedAt
      });
    }
    this.submittedFailureStreaks = next;
  }
}

function sessionDiagnostic(session) {
  return {
    sessionId: session.sessionId,
    jobId: session.jobId,
    ...(isHostedCanaryClaimant(session)
      ? { claimantAttribution: session.claimantAttribution }
      : {})
  };
}

export function loadSubmittedJobAutoVerifierConfig(env = process.env) {
  return {
    enabled: parseBooleanEnv(env.AUTO_VERIFY_ENABLED),
    dryRun: parseBooleanEnv(env.AUTO_VERIFY_DRY_RUN),
    intervalMs: parsePositiveInt(env.AUTO_VERIFY_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    scanLimit: parsePositiveInt(env.AUTO_VERIFY_SCAN_LIMIT, DEFAULT_SCAN_LIMIT),
    maxPerRun: parsePositiveInt(env.AUTO_VERIFY_MAX_PER_RUN, DEFAULT_MAX_PER_RUN),
    candidateTimeoutMs: parsePositiveInt(
      env.AUTO_VERIFY_CANDIDATE_TIMEOUT_MS,
      DEFAULT_CANDIDATE_TIMEOUT_MS
    ),
    autoModes: parseAutoModesEnv(env.AUTO_VERIFY_MODES),
    requireSettlementReady: env.AUTO_VERIFY_REQUIRE_SETTLEMENT_READY === undefined
      ? true
      : parseBooleanEnv(env.AUTO_VERIFY_REQUIRE_SETTLEMENT_READY)
  };
}

// Intersect the requested modes with the hard allowlist. An empty or
// fully-invalid configuration falls back to the full allowlist so the feature
// is never silently turned into a no-op; human_fallback/github_pr requests are
// dropped regardless.
function normalizeAutoModes(requested) {
  const allow = new Set(AUTO_DECIDABLE_MODES);
  const list = Array.isArray(requested) ? requested : [...(requested ?? [])];
  const filtered = list
    .map((mode) => String(mode ?? "").trim().toLowerCase())
    .filter((mode) => allow.has(mode));
  return new Set(filtered.length > 0 ? filtered : AUTO_DECIDABLE_MODES);
}

function parseAutoModesEnv(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return [...AUTO_DECIDABLE_MODES];
  }
  return String(raw)
    .split(",")
    .map((mode) => mode.trim().toLowerCase())
    .filter(Boolean);
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
