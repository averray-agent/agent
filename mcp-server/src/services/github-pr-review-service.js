import { createHash } from "node:crypto";
import { githubReviewDisposition } from "../core/github-review-disposition.js";
import { requireJobSnapshot } from "../core/job-snapshot.js";
import { AUTO_DECIDABLE_MODES } from "./submitted-job-auto-verifier.js";
import { GuardedSchedulerLoop, summaryErrorsOutcome } from "./guarded-scheduler-loop.js";

export class GithubPrReviewService {
  constructor({ stateStore, verifierService, githubToken = process.env.GITHUB_TOKEN,
    slaHours = positive(process.env.GITHUB_PR_REVIEW_SLA_HOURS, 48),
    intervalMs = positive(process.env.GITHUB_PR_REVIEW_POLL_MINUTES, 30) * 60_000, logger = console }) {
    Object.assign(this, { stateStore, verifierService, slaHours, intervalMs, logger });
    this.enabled = Boolean(githubToken?.trim());
    this.githubUpstream = { ok: false, lastSuccessAt: null,
      lastError: this.enabled ? "github_not_checked" : "github_token_unconfigured" };
    this.running = false;
    this.schedulerLoop = new GuardedSchedulerLoop({ host: this, name: "github-pr-review", intervalMs,
      runTimeoutMs: Math.max(intervalMs, 180_000), runOnce: (now) => this.runOnce(now),
      evaluateOutcome: (summary) => summaryErrorsOutcome(summary, "github_pr_review_errors"), logger });
  }

  async pending({ now = new Date(), upstream = true } = {}) {
    const items = [];
    const seen = new Set();
    // No recent-window cutoff: an old worker waiting behind new claims is the
    // session the operator most needs to see.
    for (let offset = 0; ; offset += 100) {
      const page = await this.stateStore.listRecentSessions(100, offset);
      for (const session of page) {
        if (seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        if (session.status !== "submitted") continue;
        let job, integrityError;
        try { ({ job } = requireJobSnapshot(session)); } catch (error) { integrityError = error.code ?? error.message; }
        const mode = job?.verifierConfig?.handler ?? job?.verifierMode ?? null;
        if (AUTO_DECIDABLE_MODES.includes(mode)) continue;
        let githubLookup, previewOutcome, previewError = false;
        if (upstream && mode === "github_pr") {
          try {
            const preview = await this.verifierService.previewSubmission({ sessionId: session.sessionId });
            githubLookup = preview.githubLookup;
            previewOutcome = preview.outcome;
          }
          catch (error) {
            previewError = true;
            githubLookup = { status: "unavailable", reason: error.code ?? error.message };
          }
        }
        const submittedAt = session.submittedAt ?? null;
        const ageMs = submittedAt && Number.isFinite(Date.parse(submittedAt)) ? Math.max(0, now - Date.parse(submittedAt)) : null;
        const submission = session.submission?.structured ?? session.submission;
        items.push({ sessionId: session.sessionId, jobId: session.jobId, jobTitle: job?.title,
          wallet: session.wallet, reward: { amount: job?.rewardAmount ?? null, asset: job?.rewardAsset ?? null },
          verifierMode: mode, submittedAt, ageMs, ageHours: ageMs === null ? null : ageMs / 3_600_000,
          prUrl: githubLookup?.htmlUrl ?? submission?.prUrl ?? null,
          upstream: githubLookup ?? { status: "not_checked" }, previewOutcome, previewError,
          ...(integrityError ? { integrityError } : {}) });
      }
      if (page.length < 100) break;
    }
    items.sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1) || a.sessionId.localeCompare(b.sessionId));
    return { items, count: items.length, oldestAgeMs: items[0]?.ageMs ?? null, slaHours: this.slaHours };
  }

  async getStatus(now = new Date()) {
    await this.loadRunHistory();
    const queue = await this.pending({ now, upstream: false });
    const github = queue.items.filter((item) => item.verifierMode === "github_pr");
    const oldestGithubAgeMs = github[0]?.ageMs ?? null;
    const classified = await Promise.all(github.map(async (item) => ({ ...item,
      disposition: githubReviewDisposition(await this.stateStore.getMutationReceipt?.("github_pr_review_observation", item.sessionId))
    })));
    const overdue = classified.filter((item) => item.disposition === "operator_review" && item.ageMs > this.slaHours * 3_600_000);
    return { enabled: this.enabled, running: this.running, intervalMs: this.intervalMs,
      count: queue.count, oldestAgeMs: queue.oldestAgeMs, githubPrCount: github.length,
      githubUpstream: this.getUpstreamHealth(now, github.length),
      oldestGithubAgeMs, slaHours: this.slaHours,
      waitingForMerge: classified.filter((item) => item.disposition === "waiting_for_merge").length,
      overdueReview: overdue.length,
      warnings: [...(overdue.length > 0 ? [{
        code: "github_pr_review_overdue", severity: "warning", oldestAgeMs: overdue[0].ageMs,
        count: overdue.length, sessionIds: overdue.slice(0, 50).map((item) => item.sessionId),
        sessionId: overdue[0].sessionId, message: "GitHub PR review is overdue; operator review required."
      }] : []), ...this.runWarnings()],
      ...this.schedulerLoop.getStatus(now), lastRun: this.lastRun, recentRuns: this.recentRuns };
  }

  async runOnce(now = new Date()) {
    const summary = { startedAt: now.toISOString(), reviewed: [], observed: [], skipped: [], errors: [] };
    try {
      await this.loadRunHistory();
      return await this.reviewQueue(now, summary);
    } catch (error) {
      summary.errors.push(runError(error, "github_pr_review_run_failed"));
      throw error;
    } finally {
      await this.recordRun(summary);
    }
  }

  async reviewQueue(now, summary) {
    if (!this.enabled) return summary;
    const queue = await this.pending({ now });
    const githubItems = queue.items.filter((entry) => entry.verifierMode === "github_pr");
    const failedRead = githubItems.find((item) => !completeGithubRead(item.upstream));
    if (githubItems.some((item) => completeGithubRead(item.upstream))) {
      this.githubUpstream.lastSuccessAt = now.toISOString();
    }
    if (githubItems.length) {
      delete this.githubUpstream.state;
      this.githubUpstream.ok = !failedRead;
      // Public health gets fixed reason codes, never arbitrary upstream error text.
      this.githubUpstream.lastError = failedRead ? publicGithubError(failedRead.upstream) : null;
    } else {
      this.githubUpstream = { ...this.githubUpstream, ok: true, state: "idle", lastError: null };
    }
    for (const item of githubItems) {
      try {
        const upstream = item.upstream;
        if (!completeGithubRead(upstream)) {
          const unavailable = Object.entries(upstream.partial ?? {})
            .filter(([, value]) => value === "unavailable").map(([endpoint]) => endpoint);
          summary.skipped.push({ sessionId: item.sessionId, reason: item.previewError
            ? "preview_error" : "upstream_unavailable:" + (unavailable.join(",") || publicGithubError(upstream)) });
          continue;
        }
        const fingerprint = createHash("sha256").update(JSON.stringify({
          merged: upstream.merged, state: upstream.state, headSha: upstream.headSha,
          checks: upstream.checkState ?? { ciStatus: upstream.ciStatus, policyGates: upstream.policyGates, ciExclusions: upstream.ciExclusions }
        })).digest("hex");
        const previous = await this.stateStore.getMutationReceipt("github_pr_review_observation", item.sessionId);
        let observation = { ...previous,
          previousFingerprint: previous?.previousFingerprint ?? previous?.fingerprint ?? null,
          previousObservedAt: previous?.previousObservedAt ?? previous?.observedAt ?? null };
        // Dedupe observations, not admission to settlement: a first observation
        // (or an old receipt written before this fix) may already be approved.
        if (previous?.fingerprint !== fingerprint || previous?.previewOutcome !== item.previewOutcome || previous?.merged !== (upstream.merged === true) || previous?.upstreamState !== upstream.state) {
          observation = { ...previous, fingerprint, previewOutcome: item.previewOutcome,
            merged: upstream.merged === true, upstreamState: upstream.state, observedAt: now.toISOString(),
            previousFingerprint: previous?.fingerprint ?? null, previousObservedAt: previous?.observedAt ?? null };
          await this.stateStore.upsertMutationReceipt("github_pr_review_observation", item.sessionId, observation);
          summary.observed.push(item.sessionId);
        }
        if (upstream.merged === true && item.previewOutcome === "approved"
          && (await this.stateStore.getSession(item.sessionId))?.status === "submitted") {
          // Pascal's Option 1: only merged + approved may auto-settle.
          // Open green PRs and every other outcome stay with the operator.
          const verdict = await this.verifierService.verifySubmission({ sessionId: item.sessionId, expectOutcome: "approved" });
          const session = await this.stateStore.getSession(item.sessionId);
          if (verdict.outcome === "approved" || (session && session.status !== "submitted")) {
            summary.reviewed.push({ sessionId: item.sessionId, outcome: verdict.outcome });
            await this.stateStore.upsertMutationReceipt("github_pr_review_observation", item.sessionId, {
              ...observation, settledAt: new Date().toISOString()
            });
          } else {
            summary.skipped.push({ sessionId: item.sessionId,
              reason: "settlement_deferred:" + boundedCode(verdict.reasonCode, "unknown") });
          }
        } else {
          summary.skipped.push({ sessionId: item.sessionId, reason: upstream.merged !== true ? "not_merged"
            : item.previewOutcome !== "approved" ? "preview_not_approved" : "session_not_submitted" });
        }
      } catch (error) {
        summary.errors.push({ sessionId: item.sessionId, ...runError(error, "github_pr_review_failed") });
        summary.skipped.push({ sessionId: item.sessionId, reason: "review_error" });
      }
    }
    return summary;
  }

  async loadRunHistory() {
    if (!this.historyPromise) {
      this.historyPromise = Promise.resolve().then(async () => {
        const history = await this.stateStore.getMutationReceipt?.("github_pr_review_runs", "recent");
        this.recentRuns = (history?.runs ?? []).slice(0, 20).map(runCounts);
        this.lastRun = this.recentRuns[0];
      }).catch((error) => { this.historyPromise = undefined; throw error; });
    }
    return this.historyPromise;
  }

  async recordRun(summary) {
    summary.finishedAt = new Date().toISOString();
    summary.counts = { observed: summary.observed.length, reviewed: summary.reviewed.length,
      skipped: summary.skipped.length, errors: summary.errors.length,
      upstreamUnavailable: summary.skipped.filter((item) => item.reason.startsWith("upstream_unavailable:")).length,
      previewErrors: summary.skipped.filter((item) => item.reason === "preview_error").length };
    summary.skipReasons = {};
    for (const { reason } of summary.skipped) {
      const category = reason.split(":", 1)[0];
      summary.skipReasons[category] = (summary.skipReasons[category] ?? 0) + 1;
    }
    summary.consecutiveUpstreamUnavailableRuns = summary.counts.upstreamUnavailable > 0
      ? (this.lastRun?.consecutiveUpstreamUnavailableRuns ?? 0) + 1 : 0;
    summary.consecutivePreviewErrorRuns = summary.counts.previewErrors > 0
      ? (this.lastRun?.consecutivePreviewErrorRuns ?? 0) + 1 : 0;
    this.lastRun = runCounts(summary);
    this.recentRuns = [this.lastRun, ...(this.recentRuns ?? [])].slice(0, 20);
    try {
      await this.stateStore.upsertMutationReceipt?.("github_pr_review_runs", "recent", { runs: this.recentRuns });
    } catch (error) {
      summary.errors.push(runError(error, "github_pr_review_history_write_failed"));
      summary.counts.errors = summary.errors.length;
    } finally {
      // IDs are diagnostic samples, never an unbounded queue dump or persisted history.
      const samples = [...summary.skipped, ...summary.reviewed,
        ...summary.observed.map((sessionId) => ({ sessionId, reason: "observed" }))].slice(0, 25);
      this.logger.info?.({ ...runCounts(summary), samples, errors: summary.errors.slice(0, 25) }, "github_pr_review.run");
    }
  }

  runWarnings() {
    const run = this.lastRun;
    return run && (run.consecutiveUpstreamUnavailableRuns > 2 || run.consecutivePreviewErrorRuns > 2) ? [{
      code: "github_pr_review_read_failures", severity: "warning",
      message: "GitHub PR review reads failed repeatedly; inspect poller logs and upstream access.",
      upstreamUnavailableCount: run.counts.upstreamUnavailable, previewErrorCount: run.counts.previewErrors,
      consecutiveUpstreamUnavailableRuns: run.consecutiveUpstreamUnavailableRuns,
      consecutivePreviewErrorRuns: run.consecutivePreviewErrorRuns
    }] : [];
  }

  getUpstreamHealth(now = new Date(), pendingCount) {
    const health = { ...this.githubUpstream };
    if (this.lastRun && pendingCount === 0) return { ...health, ok: true, state: "idle", lastError: null };
    if (health.state === "idle" && pendingCount > 0) {
      return { ...health, ok: false, state: "pending", lastError: "github_pending_first_poll" };
    }
    if (health.ok && health.state !== "idle" && now - Date.parse(health.lastSuccessAt) > this.intervalMs * 2) {
      return { ...health, ok: false, lastError: "github_read_stale" };
    }
    return health;
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    void this.schedulerLoop.runOnceAndSchedule();
  }
  stop() { this.running = false; this.schedulerLoop.stop(); }
}

function positive(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }

function boundedCode(code, fallback) {
  return typeof code === "string" && /^[a-z0-9_]{1,80}$/u.test(code) ? code : fallback;
}

function runError(error, fallback) {
  return { code: boundedCode(error?.code, fallback), message: String(error?.message ?? fallback).slice(0, 256) };
}

function runCounts(run) {
  return { startedAt: run.startedAt, finishedAt: run.finishedAt, counts: run.counts,
    skipReasons: run.skipReasons ?? {},
    consecutiveUpstreamUnavailableRuns: run.consecutiveUpstreamUnavailableRuns,
    consecutivePreviewErrorRuns: run.consecutivePreviewErrorRuns };
}

function completeGithubRead(upstream) {
  return upstream?.status === "verified" && !Object.values(upstream.partial ?? {}).includes("unavailable");
}

function publicGithubError(upstream) {
  if (upstream?.status === "verified") return "github_lookup_partial";
  return /^github_api_(?:[1-5]\d{2}|error)$/u.test(upstream?.reason ?? "")
    ? upstream.reason : "github_lookup_unavailable";
}
