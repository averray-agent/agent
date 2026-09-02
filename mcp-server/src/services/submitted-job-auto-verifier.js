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

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_SCAN_LIMIT = 200;
const DEFAULT_MAX_PER_RUN = 25;

// Hard allowlist of machine-decidable verifier handlers. human_fallback and
// github_pr are intentionally excluded and cannot be re-enabled via config.
const AUTO_DECIDABLE_MODES = Object.freeze(["benchmark", "deterministic"]);

export class SubmittedJobAutoVerifierService {
  constructor(platformService, verifierService, gateway = undefined, eventBus = undefined, {
    enabled = false,
    dryRun = false,
    intervalMs = DEFAULT_INTERVAL_MS,
    scanLimit = DEFAULT_SCAN_LIMIT,
    maxPerRun = DEFAULT_MAX_PER_RUN,
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
    this.autoModes = normalizeAutoModes(autoModes);
    this.requireSettlementReady = requireSettlementReady;
    this.logger = logger;
    this.running = false;
    this.timer = undefined;
    this.inFlight = new Set();
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
      scanLimit: this.scanLimit,
      maxPerRun: this.maxPerRun,
      autoModes: [...this.autoModes],
      requireSettlementReady: this.requireSettlementReady,
      lastRun: this.lastRun
    };
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
      if (this.inFlight.has(sessionId)) {
        summary.skipped.push({ sessionId, reason: "in_flight" });
        continue;
      }
      // A submitted session should never already carry a verification result,
      // but if one is present treat it as resolved-in-flight and leave it alone.
      if (session.verification) {
        summary.skipped.push({ sessionId, reason: "already_verified" });
        continue;
      }
      let job;
      try {
        job = this.platformService.getJobDefinition(session.jobId);
      } catch (error) {
        summary.skipped.push({
          sessionId,
          jobId: session.jobId,
          reason: "job_not_found",
          message: error?.message ?? String(error)
        });
        continue;
      }
      const mode = job?.verifierConfig?.handler ?? job?.verifierMode;
      if (!this.autoModes.has(mode)) {
        summary.skipped.push({ sessionId, jobId: session.jobId, reason: "non_auto_mode", mode: mode ?? null });
        continue;
      }
      candidates.push({ sessionId, jobId: session.jobId, mode });
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
        summary.skipped.push({ sessionId: candidate.sessionId, jobId: candidate.jobId, reason: "dry_run", mode: candidate.mode });
        continue;
      }
      await this.verifyCandidate(candidate, summary);
    }

    return this.finishRun(summary);
  }

  async verifyCandidate(candidate, summary) {
    const { sessionId, jobId, mode } = candidate;
    this.inFlight.add(sessionId);
    try {
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
      const result = await this.verifierService.verifySubmission({ sessionId });
      const outcome = result?.outcome;
      summary.verifiedCount += 1;
      if (outcome === "approved") summary.approvedCount += 1;
      else if (outcome === "rejected") summary.rejectedCount += 1;
      this.logger.info?.(
        { principal: "system:auto-verifier", sessionId, jobId, mode, outcome, reasonCode: result?.reasonCode },
        "auto_verify.verified"
      );
      this.eventBus?.publish?.({
        id: `auto-verify-${sessionId}-${Date.now()}`,
        topic: "verifier.auto.resolved",
        jobId,
        timestamp: new Date().toISOString(),
        data: { sessionId, jobId, mode, outcome, reasonCode: result?.reasonCode }
      });
    } catch (error) {
      // A session that flipped out of `submitted` between scan and verify (e.g.
      // a manual /verifier/run ran first), or a settlement tx that reverted,
      // lands here. Both are safe to retry next tick: a verdict is committed
      // only after settlement succeeds, so a failed run leaves the session in
      // `submitted`.
      summary.errors.push({ sessionId, jobId, message: error?.message ?? String(error) });
      this.logger.warn?.({ sessionId, jobId, mode, err: error }, "auto_verify.verify_failed");
    } finally {
      this.inFlight.delete(sessionId);
    }
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

export function loadSubmittedJobAutoVerifierConfig(env = process.env) {
  return {
    enabled: parseBooleanEnv(env.AUTO_VERIFY_ENABLED),
    dryRun: parseBooleanEnv(env.AUTO_VERIFY_DRY_RUN),
    intervalMs: parsePositiveInt(env.AUTO_VERIFY_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    scanLimit: parsePositiveInt(env.AUTO_VERIFY_SCAN_LIMIT, DEFAULT_SCAN_LIMIT),
    maxPerRun: parsePositiveInt(env.AUTO_VERIFY_MAX_PER_RUN, DEFAULT_MAX_PER_RUN),
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
