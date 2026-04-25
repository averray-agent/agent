import type { JobCardData } from "@/components/runs/JobCard";
import type { QueueFilterCount } from "@/components/runs/QueueBar";
import type { RunRow } from "@/components/runs/RunQueueTable";
import type { RunState, Tier } from "@/components/runs/StatePill";
import type {
  GitHubJobContext,
  JobSource,
  WikipediaJobContext,
} from "@/components/runs/types";

type RawRecord = Record<string, unknown>;

const RUN_STATES: RunState[] = ["ready", "claimed", "submitted", "disputed", "settled"];

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" ? (value as RawRecord) : {};
}

function asArray(value: unknown): RawRecord[] {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  for (const key of ["items", "jobs", "recommendations", "sessions"]) {
    if (Array.isArray(record[key])) return record[key].map(asRecord);
  }
  return [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function shortAddress(value: unknown): string {
  const raw = text(value);
  if (!raw) return "unclaimed";
  if (raw.length <= 12) return raw;
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function tierFromRaw(value: unknown): Tier {
  switch (text(value).toLowerCase()) {
    case "pro":
    case "t2":
      return "T2";
    case "elite":
    case "t3":
      return "T3";
    default:
      return "T1";
  }
}

function stateFromRaw(value: unknown): RunState {
  const raw = text(value).toLowerCase();
  if (RUN_STATES.includes(raw as RunState)) return raw as RunState;
  if (raw === "open" || raw === "none") return "ready";
  if (raw === "closed" || raw === "resolved") return "settled";
  if (raw === "rejected" || raw === "failed") return "disputed";
  return "ready";
}

function formatReward(value: unknown): string {
  const amount = numberValue(value);
  return amount.toLocaleString("en-US", {
    maximumFractionDigits: amount >= 100 ? 0 : 2,
    minimumFractionDigits: amount > 0 && amount < 10 ? 2 : 0,
  });
}

function formatWindow(seconds: unknown): string {
  const total = numberValue(seconds);
  if (!total) return "-";
  if (total < 3600) return `${Math.round(total / 60)} min`;
  return `${Math.round(total / 3600)} h`;
}

function verifierLabel(mode: unknown): string {
  const raw = text(mode, "benchmark");
  return raw.replace(/_/gu, " ");
}

function lookupJob(jobs: RawRecord[], id: unknown): RawRecord {
  const jobId = text(id);
  return jobs.find((job) => text(job.id) === jobId) ?? {};
}

/**
 * Pull a lightweight provenance block off a job record. GitHub- and
 * Wikipedia-ingested jobs carry a `source.type` discriminator plus the
 * upstream handle (repo + issue, or page title + revision). Native
 * platform jobs either omit `source` or emit `{ type: "native" }`;
 * those return undefined so the UI renders the generic layout.
 */
export function buildJobSource(job: unknown): JobSource | undefined {
  const src = asRecord(asRecord(job).source);
  const sourceType = text(src.type);
  if (sourceType === "github_issue") {
    const repo = text(src.repo);
    const issueNumber = numberValue(src.issueNumber);
    const issueUrl = text(src.issueUrl);
    if (!repo || !issueNumber || !issueUrl) return undefined;
    const labels = Array.isArray(src.labels)
      ? src.labels.filter((label): label is string => typeof label === "string")
      : undefined;
    const score = typeof src.score === "number" ? src.score : undefined;
    return {
      type: "github_issue",
      repo,
      issueNumber,
      issueUrl,
      ...(labels && labels.length ? { labels } : {}),
      ...(score !== undefined ? { score } : {}),
    };
  }
  if (sourceType === "wikipedia_article") {
    const pageTitle = text(src.pageTitle);
    const language = text(src.language, "en");
    const pageUrl = text(src.pageUrl);
    const revisionId = numberValue(src.revisionId);
    const taskType = text(src.taskType);
    if (!pageTitle || !pageUrl || !revisionId || !taskType) return undefined;
    const score = typeof src.score === "number" ? src.score : undefined;
    return {
      type: "wikipedia_article",
      pageTitle,
      language,
      pageUrl,
      revisionId,
      taskType,
      ...(score !== undefined ? { score } : {}),
    };
  }
  return undefined;
}

/**
 * Build the rich GitHubJobContext used by the Loaded-run panel when a
 * GitHub-ingested job is selected. Returns undefined for native jobs so
 * the panel falls back to the generic governance layout.
 */
export function buildGitHubContext(
  row: Pick<RunRow, "source" | "title">,
  job: unknown
): GitHubJobContext | undefined {
  if (row.source?.type !== "github_issue") return undefined;
  const record = asRecord(job);
  const verification = asRecord(record.verification);
  const verificationMethod = text(verification.method, "github_pr");
  const verificationSignals = Array.isArray(verification.signals)
    ? verification.signals.filter(
        (signal): signal is string => typeof signal === "string"
      )
    : ["PR opened", "CI green", "maintainer review"];
  const acceptance = Array.isArray(record.acceptanceCriteria)
    ? record.acceptanceCriteria.filter(
        (item): item is string => typeof item === "string"
      )
    : [];

  return {
    ...row.source,
    title: text(record.title, row.title),
    category: text(record.category, "work"),
    body: text(record.description, text(record.body, "")),
    acceptanceCriteria: acceptance,
    agentInstructions: text(record.agentInstructions),
    verification: { method: verificationMethod, signals: verificationSignals },
  };
}

/**
 * Mirror of `buildGitHubContext` for Wikipedia maintenance runs. Returns
 * undefined for any non-Wikipedia row so the panel falls back to the
 * generic layout. Defaults bake in the proposal-only verification path
 * since the platform never edits Wikipedia directly.
 */
export function buildWikipediaContext(
  row: Pick<RunRow, "source" | "title">,
  job: unknown
): WikipediaJobContext | undefined {
  if (row.source?.type !== "wikipedia_article") return undefined;
  const record = asRecord(job);
  const verification = asRecord(record.verification);
  const verificationMethod = text(
    verification.method,
    "wikipedia_proposal_review"
  );
  const verificationSignals = Array.isArray(verification.signals)
    ? verification.signals.filter(
        (signal): signal is string => typeof signal === "string"
      )
    : [
        "Proposal submitted to Averray",
        "Evidence verified",
        "Editor review · Averray-approved",
      ];
  const acceptance = Array.isArray(record.acceptanceCriteria)
    ? record.acceptanceCriteria.filter(
        (item): item is string => typeof item === "string"
      )
    : [];

  return {
    ...row.source,
    title: text(record.title, row.title),
    category: text(record.category, "wikipedia"),
    body: text(record.description, text(record.body, "")),
    acceptanceCriteria: acceptance,
    agentInstructions: text(record.agentInstructions),
    verification: { method: verificationMethod, signals: verificationSignals },
  };
}

export function extractRunJobs(payload: unknown): RawRecord[] {
  return asArray(payload);
}

export function buildRunRows(payload: unknown): RunRow[] {
  return asArray(payload).map((job) => {
    const id = text(job.id, "unknown-job");
    const title = text(job.title, text(job.description, titleFromId(id)));
    const state = stateFromRaw(job.state);
    const worker = text(job.claimedBy) || text(job.worker);

    const source = buildJobSource(job);
    // For ingested-source jobs the row already shows the upstream
    // identity (owner/repo #N for GitHub, lang.wikipedia/page for
    // Wikipedia) via the SourceBadge, so drop the redundant job-id
    // slug from jobMeta to keep the meta line scannable. Native jobs
    // keep the full `id · category · tier` because there's no other
    // provenance signal.
    const isIngested =
      source?.type === "github_issue" || source?.type === "wikipedia_article";
    const jobMeta = isIngested
      ? `${text(job.category, "work")} · ${tierFromRaw(job.tier)}`
      : `${id} · ${text(job.category, "work")} · ${tierFromRaw(job.tier)}`;
    return {
      id,
      sessionId: text(job.sessionId),
      title,
      jobMeta,
      ...(source ? { source } : {}),
      worker: {
        variant: worker ? "a" : "unclaimed",
        initials: worker ? "AG" : "-",
        label: worker ? shortAddress(worker) : "unclaimed",
      },
      state,
      stake: formatReward(job.stake ?? job.rewardAmount),
      age: formatWindow(job.claimTtlSeconds),
      lastEvent:
        source?.type === "github_issue"
          ? state === "ready"
            ? "Ingested from GitHub"
            : `State: ${state}`
          : source?.type === "wikipedia_article"
            ? state === "ready"
              ? "Ingested from Wikipedia · proposal-only"
              : `State: ${state}`
            : state === "ready"
              ? "Job listed"
              : `State: ${state}`,
      lastEventMeta:
        source?.type === "github_issue"
          ? `${source.repo} #${source.issueNumber} · verifier ${verifierLabel(job.verifierMode)}`
          : source?.type === "wikipedia_article"
            ? `${source.language}.wikipedia · rev ${source.revisionId} · ${source.taskType.replace(/_/g, " ")}`
            : `${text(job.rewardAsset, "DOT")} · verifier ${verifierLabel(job.verifierMode)}`,
    };
  });
}

export function buildRunFilters(rows: RunRow[]): QueueFilterCount[] {
  return [
    { id: "all", label: "All", count: rows.length },
    ...RUN_STATES.map((state) => ({
      id: state,
      label: `${state.slice(0, 1).toUpperCase()}${state.slice(1)}`,
      count: rows.filter((row) => row.state === state).length,
    })),
  ];
}

export function buildRecommendationCards(
  recommendationPayload: unknown,
  jobsPayload: unknown
): JobCardData[] {
  const jobs = asArray(jobsPayload);
  return asArray(recommendationPayload).map((recommendation, index) => {
    const job = lookupJob(jobs, recommendation.jobId);
    const id = text(recommendation.jobId, text(job.id, "unknown-job"));
    const fitScore = numberValue(recommendation.fitScore);
    const fit = Math.max(1, Math.min(5, Math.ceil(fitScore / 20)));

    const source = buildJobSource(job);
    const category = text(job.category, "work");
    return {
      id,
      title: text(job.title, text(job.description, titleFromId(id))),
      jobMeta: category,
      category,
      ...(source ? { source } : {}),
      rewardValue: formatReward(recommendation.netReward ?? job.rewardAmount),
      rewardCurrency: text(job.rewardAsset, "DOT"),
      rewardUsd: "live",
      tier: tierFromRaw(recommendation.tier ?? job.tier),
      modeLabel: verifierLabel(job.verifierMode),
      modeTone: recommendation.eligible === false ? "disputed" : "claimed",
      meta: [
        { label: "Reward", value: `${formatReward(job.rewardAmount)} ${text(job.rewardAsset, "DOT")}` },
        { label: "Verifier", value: verifierLabel(job.verifierMode) },
        { label: "Window", value: formatWindow(job.claimTtlSeconds), accent: true },
        {
          label:
            source?.type === "github_issue" ||
            source?.type === "wikipedia_article"
              ? "Fit score"
              : "Gas",
          value:
            source?.type === "github_issue" ||
            source?.type === "wikipedia_article"
              ? `${source.score ?? fitScore}/100`
              : job.requiresSponsoredGas
                ? "sponsored"
                : "worker",
        },
      ],
      fit,
      hot: index === 0,
    };
  });
}

export function sumReadyStake(rows: RunRow[]): string {
  const total = rows
    .filter((row) => row.state === "ready")
    .reduce((sum, row) => sum + numberValue(row.stake), 0);
  return `${formatReward(total)} DOT`;
}
