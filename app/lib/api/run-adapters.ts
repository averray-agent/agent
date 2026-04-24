import type { JobCardData } from "@/components/runs/JobCard";
import type { QueueFilterCount } from "@/components/runs/QueueBar";
import type { RunRow } from "@/components/runs/RunQueueTable";
import type { RunState, Tier } from "@/components/runs/StatePill";

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

export function extractRunJobs(payload: unknown): RawRecord[] {
  return asArray(payload);
}

export function buildRunRows(payload: unknown): RunRow[] {
  return asArray(payload).map((job) => {
    const id = text(job.id, "unknown-job");
    const title = text(job.title, text(job.description, titleFromId(id)));
    const state = stateFromRaw(job.state);
    const worker = text(job.claimedBy) || text(job.worker);

    return {
      id,
      title,
      jobMeta: `${id} · ${text(job.category, "work")} · ${tierFromRaw(job.tier)}`,
      worker: {
        variant: worker ? "a" : "unclaimed",
        initials: worker ? "AG" : "-",
        label: worker ? shortAddress(worker) : "unclaimed",
      },
      state,
      stake: formatReward(job.stake ?? job.rewardAmount),
      age: formatWindow(job.claimTtlSeconds),
      lastEvent: state === "ready" ? "Job listed" : `State: ${state}`,
      lastEventMeta: `${text(job.rewardAsset, "DOT")} · verifier ${verifierLabel(job.verifierMode)}`,
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

    return {
      id,
      title: text(job.title, text(job.description, titleFromId(id))),
      jobMeta: text(job.category, "work"),
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
        { label: "Gas", value: job.requiresSponsoredGas ? "sponsored" : "worker" },
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
