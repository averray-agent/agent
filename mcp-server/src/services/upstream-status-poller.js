import {
  FUNDED_JOB_STATUSES,
  applyUpstreamStatus,
  isFinalFundedJob,
  summarizeFundedJobs
} from "../core/funded-jobs.js";

const DEFAULT_STATUS_RECORD_LIMIT = 10_000;
const UPSTREAM_STATUS_STATE_SCOPE = "upstream-status-poller";

export class UpstreamStatusPollerService {
  constructor(stateStore, eventBus = undefined, {
    enabled = false,
    intervalMs = 24 * 60 * 60 * 1000,
    batchSize = 50,
    statusRecordLimit = DEFAULT_STATUS_RECORD_LIMIT,
    stateScope = UPSTREAM_STATUS_STATE_SCOPE,
    githubToken = undefined,
    githubApiBaseUrl = "https://api.github.com",
    fetchImpl = fetch,
    logger = console
  } = {}) {
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.statusRecordLimit = statusRecordLimit;
    this.stateScope = stateScope;
    this.githubToken = githubToken;
    this.githubApiBaseUrl = githubApiBaseUrl;
    this.fetchImpl = fetchImpl;
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
    const persisted = await this.stateStore.getServiceState?.(this.stateScope) ?? {};
    const fundedJobs = await this.getFundedJobStatusSnapshot(new Date());
    return {
      enabled: this.enabled,
      running: this.running,
      intervalMs: this.intervalMs,
      batchSize: this.batchSize,
      lastRun: this.lastRun ?? persisted.lastRun,
      lastAttemptedAt: persisted.lastAttemptedAt,
      lastFinishedAt: persisted.lastFinishedAt,
      lastSuccessfulAt: persisted.lastSuccessfulAt,
      lastFailureReason: persisted.lastFailureReason,
      evidencePersistenceNote: typeof this.stateStore.upsertServiceState === "function"
        ? "durable_service_state"
        : "in_process_only",
      fundedJobs
    };
  }

  async getFundedJobStatusSnapshot(now = new Date()) {
    const records = await this.stateStore.listFundedJobs?.({ limit: this.statusRecordLimit }) ?? [];
    const finalRecords = records.filter(isFinalFundedJob);
    const pollableRecords = records.filter((record) => !isFinalFundedJob(record) && isPollableFundedJobRecord(record, now));
    const recordsWithUpstreamEvidence = records.filter(hasPollableUpstreamEvidence);
    return {
      totalRecords: records.length,
      openRecords: records.length - finalRecords.length,
      finalRecords: finalRecords.length,
      pollableRecords: pollableRecords.length,
      awaitingSubmissionRecords: records.filter((record) => !isFinalFundedJob(record) && record?.upstreamStatus === "not_submitted").length,
      recordsWithUpstreamEvidence: recordsWithUpstreamEvidence.length,
      byFinalStatus: countBy(records, (record) => record?.finalStatus ?? FUNDED_JOB_STATUSES.OPEN),
      bySourceType: countBy(records, (record) => record?.sourceType ?? "unknown"),
      lastFundedAt: maxIso(records.map((record) => record?.fundedAt)),
      lastUpdatedAt: maxIso(records.map((record) => record?.updatedAt)),
      recordLimit: this.statusRecordLimit
    };
  }

  async runOnce(now = new Date()) {
    const startedAt = now.toISOString();
    const records = await this.stateStore.listFundedJobs?.({ limit: this.batchSize }) ?? [];
    const summary = {
      startedAt,
      finishedAt: undefined,
      checked: 0,
      updated: 0,
      skipped: [],
      errors: []
    };

    for (const record of records) {
      if (isFinalFundedJob(record)) {
        summary.skipped.push({ jobId: record.jobId, reason: "final" });
        continue;
      }
      try {
        const upstreamStatus = await this.resolveUpstreamStatus(record, { now });
        if (!upstreamStatus) {
          summary.skipped.push({ jobId: record.jobId, reason: "no_pollable_upstream" });
          continue;
        }
        summary.checked += 1;
        const updated = applyUpstreamStatus(record, upstreamStatus, { now });
        await this.stateStore.upsertFundedJob?.(updated);
        summary.updated += 1;
        this.eventBus?.publish?.({
          id: `upstream-status-${updated.jobId}-${Date.now()}`,
          topic: "funded_jobs.upstream_status",
          jobId: updated.jobId,
          sessionId: updated.sessionId,
          wallet: updated.wallet,
          wallets: [updated.wallet].filter(Boolean),
          timestamp: now.toISOString(),
          data: {
            jobId: updated.jobId,
            finalStatus: updated.finalStatus,
            upstreamStatus: updated.upstreamStatus,
            closeReason: updated.closeReason
          }
        });
      } catch (error) {
        summary.errors.push({ jobId: record.jobId, message: error?.message ?? String(error) });
        this.logger.warn?.({ jobId: record.jobId, err: error }, "upstream_status.poll_failed");
      }
    }

    return this.finishRun(summary);
  }

  async generateWeeklyReport({ now = new Date(), from = undefined, to = undefined } = {}) {
    const end = to ? new Date(to) : now;
    const start = from ? new Date(from) : new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    const records = await this.stateStore.listFundedJobs?.({ limit: 10_000 }) ?? [];
    return summarizeFundedJobs(records, { from: start, to: end, now });
  }

  async runOnceAndSchedule() {
    await this.runOnce(new Date());
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.runOnceAndSchedule();
    }, this.intervalMs);
  }

  async finishRun(summary) {
    summary.finishedAt = new Date().toISOString();
    this.lastRun = summary;
    const previous = await this.stateStore.getServiceState?.(this.stateScope) ?? {};
    await this.stateStore.upsertServiceState?.(this.stateScope, {
      lastAttemptedAt: summary.startedAt,
      lastFinishedAt: summary.finishedAt,
      lastSuccessfulAt: summary.errors.length === 0
        ? summary.finishedAt
        : previous.lastSuccessfulAt,
      lastFailureReason: summary.errors.length === 0
        ? null
        : `${summary.errors.length} upstream status poll error${summary.errors.length === 1 ? "" : "s"}`,
      lastRun: summary
    });
    return summary;
  }

  async resolveUpstreamStatus(record, { now = new Date() } = {}) {
    if (record?.upstream?.kind === "github_pull_request") {
      return pollGithubPullRequest(record, {
        now,
        fetchImpl: this.fetchImpl,
        githubToken: this.githubToken,
        githubApiBaseUrl: this.githubApiBaseUrl
      });
    }
    if (record?.upstream?.kind === "mediawiki_revision") {
      return pollMediaWikiRevision(record, {
        now,
        fetchImpl: this.fetchImpl
      });
    }
    if (isPastDeadline(record, now)) {
      return {
        finalStatus: FUNDED_JOB_STATUSES.OPEN_STALE,
        upstreamStatus: "deadline_elapsed",
        closeReason: "no_upstream_submission",
        checkedAt: now.toISOString()
      };
    }
    return undefined;
  }
}

export async function pollGithubPullRequest(record, {
  now = new Date(),
  fetchImpl = fetch,
  githubToken = undefined,
  githubApiBaseUrl = "https://api.github.com"
} = {}) {
  const upstream = record?.upstream;
  if (!upstream?.owner || !upstream?.name || !upstream?.pullNumber) return undefined;
  const baseUrl = String(githubApiBaseUrl ?? "https://api.github.com").replace(/\/+$/u, "");
  const url = `${baseUrl}/repos/${encodeURIComponent(upstream.owner)}/${encodeURIComponent(upstream.name)}/pulls/${upstream.pullNumber}`;
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "averray-upstream-status-poller"
  };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub pull request lookup failed (${response.status}): ${body}`);
  }
  const pull = await response.json();
  const merged = Boolean(pull.merged || pull.merged_at);
  if (merged) {
    return {
      finalStatus: FUNDED_JOB_STATUSES.MERGED,
      upstreamStatus: "merged",
      closeReason: undefined,
      checkedAt: now.toISOString(),
      upstream: {
        ...upstream,
        mergedAt: pull.merged_at ?? now.toISOString(),
        state: pull.state
      }
    };
  }
  if (pull.state === "closed") {
    return {
      finalStatus: FUNDED_JOB_STATUSES.CLOSED_UNMERGED,
      upstreamStatus: "closed_unmerged",
      closeReason: "closed_unmerged",
      checkedAt: now.toISOString(),
      upstream: {
        ...upstream,
        closedAt: pull.closed_at ?? now.toISOString(),
        state: pull.state
      }
    };
  }
  if (isPastDeadline(record, now)) {
    return {
      finalStatus: FUNDED_JOB_STATUSES.OPEN_STALE,
      upstreamStatus: "open_stale",
      closeReason: "deadline_elapsed",
      checkedAt: now.toISOString(),
      upstream: {
        ...upstream,
        state: pull.state
      }
    };
  }
  return {
    finalStatus: FUNDED_JOB_STATUSES.OPEN,
    upstreamStatus: "open",
    checkedAt: now.toISOString(),
    upstream: {
      ...upstream,
      state: pull.state
    }
  };
}

export async function pollMediaWikiRevision(record, {
  now = new Date(),
  fetchImpl = fetch
} = {}) {
  const upstream = record?.upstream;
  if (!upstream || upstream.proposalOnly || !upstream.editRevisionId || !upstream.language) {
    return undefined;
  }
  const url = new URL(`https://${upstream.language}.wikipedia.org/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("prop", "revisions");
  url.searchParams.set("revids", String(upstream.editRevisionId));
  url.searchParams.set("rvprop", "ids|timestamp|tags");
  url.searchParams.set("origin", "*");
  const headers = {
    accept: "application/json",
    "user-agent": "AverrayUpstreamStatusPoller/0.1 (https://averray.com; operator@averray.com)"
  };
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MediaWiki revision lookup failed (${response.status}): ${body}`);
  }
  const payload = await response.json();
  const page = Object.values(payload?.query?.pages ?? {})[0];
  const revision = page?.revisions?.[0];
  if (!revision) {
    return {
      finalStatus: FUNDED_JOB_STATUSES.REVERTED,
      upstreamStatus: "revision_missing",
      closeReason: "revision_not_found",
      checkedAt: now.toISOString(),
      upstream
    };
  }
  if (hasRevertSignal(revision, upstream.editRevisionId)) {
    return {
      finalStatus: FUNDED_JOB_STATUSES.REVERTED,
      upstreamStatus: "reverted",
      closeReason: "revision_tagged_reverted",
      checkedAt: now.toISOString(),
      upstream: {
        ...upstream,
        revisionTimestamp: revision.timestamp
      }
    };
  }
  const revisionAt = Date.parse(revision.timestamp);
  const survivedSevenDays = Number.isFinite(revisionAt)
    && now.getTime() >= revisionAt + 7 * 24 * 60 * 60 * 1000;
  if (survivedSevenDays) {
    const newer = await fetchNewerMediaWikiRevisions({
      language: upstream.language,
      pageId: upstream.pageId ?? page?.pageid,
      since: revision.timestamp,
      fetchImpl,
      headers
    });
    const revertRevision = newer.find((entry) =>
      String(entry.revid) !== String(upstream.editRevisionId) && hasRevertSignal(entry, upstream.editRevisionId)
    );
    if (revertRevision) {
      return {
        finalStatus: FUNDED_JOB_STATUSES.REVERTED,
        upstreamStatus: "reverted",
        closeReason: "later_revert_detected",
        checkedAt: now.toISOString(),
        upstream: {
          ...upstream,
          revisionTimestamp: revision.timestamp,
          revertRevisionId: String(revertRevision.revid ?? "")
        }
      };
    }
  }
  return {
    finalStatus: survivedSevenDays ? FUNDED_JOB_STATUSES.MERGED : FUNDED_JOB_STATUSES.OPEN,
    upstreamStatus: survivedSevenDays ? "survived_7_days" : "pending_survival_window",
    checkedAt: now.toISOString(),
    upstream: {
      ...upstream,
      revisionTimestamp: revision.timestamp
    }
  };
}

async function fetchNewerMediaWikiRevisions({ language, pageId, since, fetchImpl, headers }) {
  if (!pageId || !since) return [];
  const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("prop", "revisions");
  url.searchParams.set("pageids", String(pageId));
  url.searchParams.set("rvprop", "ids|timestamp|comment|tags");
  url.searchParams.set("rvlimit", "50");
  url.searchParams.set("rvdir", "newer");
  url.searchParams.set("rvstart", since);
  url.searchParams.set("origin", "*");
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MediaWiki newer revision lookup failed (${response.status}): ${body}`);
  }
  const payload = await response.json();
  const page = Object.values(payload?.query?.pages ?? {})[0];
  return Array.isArray(page?.revisions) ? page.revisions : [];
}

function hasRevertSignal(revision, targetRevisionId) {
  const tags = new Set((revision?.tags ?? []).map((tag) => String(tag).toLowerCase()));
  if (tags.has("mw-reverted") || tags.has("mw-rollback") || tags.has("mw-manual-revert") || tags.has("mw-undo")) {
    return true;
  }
  const comment = String(revision?.comment ?? "").toLowerCase();
  return comment.includes(`revision ${String(targetRevisionId).toLowerCase()}`)
    && /\b(revert|reverted|undo|undid|rollback)\b/u.test(comment);
}

export function loadUpstreamStatusPollerConfig(env = process.env) {
  return {
    enabled: parseBooleanEnv(env.UPSTREAM_STATUS_POLLER_ENABLED),
    intervalMs: parsePositiveInt(env.UPSTREAM_STATUS_POLLER_INTERVAL_MS, 24 * 60 * 60 * 1000),
    batchSize: parsePositiveInt(env.UPSTREAM_STATUS_POLLER_BATCH_SIZE, 50),
    githubToken: env.GITHUB_TOKEN?.trim() || undefined,
    githubApiBaseUrl: env.GITHUB_API_BASE_URL?.trim() || "https://api.github.com"
  };
}

function isPastDeadline(record, now) {
  const deadline = Date.parse(record?.deadlineAt ?? "");
  return Number.isFinite(deadline) && now.getTime() > deadline;
}

function hasPollableUpstreamEvidence(record) {
  const upstream = record?.upstream;
  if (upstream?.kind === "github_pull_request") {
    return Boolean(upstream.owner && upstream.name && upstream.pullNumber);
  }
  if (upstream?.kind === "mediawiki_revision") {
    return Boolean(!upstream.proposalOnly && upstream.editRevisionId && upstream.language);
  }
  return false;
}

function isPollableFundedJobRecord(record, now) {
  return hasPollableUpstreamEvidence(record) || isPastDeadline(record, now);
}

function countBy(records, selector) {
  return records.reduce((accumulator, record) => {
    const key = selector(record);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

function maxIso(values) {
  return values
    .filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1);
}

function parseBooleanEnv(raw) {
  if (raw === undefined || raw === null || raw === "") return false;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
