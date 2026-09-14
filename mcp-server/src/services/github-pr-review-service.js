import { createHash } from "node:crypto";
import { requireJobSnapshot } from "../core/job-snapshot.js";
import { AUTO_DECIDABLE_MODES } from "./submitted-job-auto-verifier.js";
import { GuardedSchedulerLoop, summaryErrorsOutcome } from "./guarded-scheduler-loop.js";

export class GithubPrReviewService {
  constructor({ stateStore, verifierService, githubToken = process.env.GITHUB_TOKEN,
    slaHours = positive(process.env.GITHUB_PR_REVIEW_SLA_HOURS, 48),
    intervalMs = positive(process.env.GITHUB_PR_REVIEW_POLL_MINUTES, 30) * 60_000, logger = console }) {
    Object.assign(this, { stateStore, verifierService, slaHours, intervalMs, logger });
    this.enabled = Boolean(githubToken?.trim());
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
        let githubLookup;
        if (upstream && mode === "github_pr") {
          try { githubLookup = (await this.verifierService.previewSubmission({ sessionId: session.sessionId })).githubLookup; }
          catch (error) { githubLookup = { status: "unavailable", reason: error.code ?? error.message }; }
        }
        const submittedAt = session.submittedAt ?? null;
        const ageMs = submittedAt && Number.isFinite(Date.parse(submittedAt)) ? Math.max(0, now - Date.parse(submittedAt)) : null;
        const submission = session.submission?.structured ?? session.submission;
        items.push({ sessionId: session.sessionId, jobId: session.jobId, jobTitle: job?.title,
          wallet: session.wallet, reward: { amount: job?.rewardAmount ?? null, asset: job?.rewardAsset ?? null },
          verifierMode: mode, submittedAt, ageMs, ageHours: ageMs === null ? null : ageMs / 3_600_000,
          prUrl: githubLookup?.htmlUrl ?? submission?.prUrl ?? null,
          upstream: githubLookup ?? { status: "not_checked" }, ...(integrityError ? { integrityError } : {}) });
      }
      if (page.length < 100) break;
    }
    items.sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1) || a.sessionId.localeCompare(b.sessionId));
    return { items, count: items.length, oldestAgeMs: items[0]?.ageMs ?? null, slaHours: this.slaHours };
  }

  async getStatus(now = new Date()) {
    const queue = await this.pending({ now, upstream: false });
    const github = queue.items.filter((item) => item.verifierMode === "github_pr");
    const oldestGithubAgeMs = github[0]?.ageMs ?? null;
    return { enabled: this.enabled, running: this.running, intervalMs: this.intervalMs,
      count: queue.count, oldestAgeMs: queue.oldestAgeMs, githubPrCount: github.length,
      oldestGithubAgeMs, slaHours: this.slaHours,
      warnings: oldestGithubAgeMs > this.slaHours * 3_600_000 ? [{
        code: "github_pr_review_overdue", severity: "warning", oldestAgeMs: oldestGithubAgeMs,
        sessionId: github[0].sessionId, message: "GitHub PR review is overdue; operator review required."
      }] : [], ...this.schedulerLoop.getStatus(now) };
  }

  async runOnce(now = new Date()) {
    const summary = { startedAt: now.toISOString(), reviewed: [], observed: [], errors: [] };
    if (!this.enabled) return summary;
    const queue = await this.pending({ now });
    for (const item of queue.items.filter((entry) => entry.verifierMode === "github_pr")) {
      try {
        const upstream = item.upstream;
        if (upstream.status !== "verified" || Object.values(upstream.partial ?? {}).includes("unavailable")) continue;
        const fingerprint = createHash("sha256").update(JSON.stringify({
          merged: upstream.merged, state: upstream.state, headSha: upstream.headSha,
          checks: upstream.checkState ?? { ciStatus: upstream.ciStatus, policyGates: upstream.policyGates, ciExclusions: upstream.ciExclusions }
        })).digest("hex");
        const previous = await this.stateStore.getMutationReceipt("github_pr_review_observation", item.sessionId);
        if (previous?.fingerprint === fingerprint) continue;
        if (previous && (await this.stateStore.getSession(item.sessionId))?.status === "submitted") {
          // This is the SAME handler + settlement path as an operator run, not
          // an approval inferred from a change. Ambiguity still needs arbitration.
          const verdict = await this.verifierService.verifySubmission({ sessionId: item.sessionId });
          summary.reviewed.push({ sessionId: item.sessionId, outcome: verdict.outcome });
        }
        await this.stateStore.upsertMutationReceipt("github_pr_review_observation", item.sessionId, { fingerprint, observedAt: now.toISOString() });
        summary.observed.push(item.sessionId);
      } catch (error) { summary.errors.push({ sessionId: item.sessionId, message: error.message }); }
    }
    this.lastRun = { ...summary, finishedAt: new Date().toISOString() };
    return this.lastRun;
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    void this.schedulerLoop.runOnceAndSchedule();
  }
  stop() { this.running = false; this.schedulerLoop.stop(); }
}

function positive(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
