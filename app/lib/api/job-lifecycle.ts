/**
 * Adapters and types for the job-lifecycle slice introduced in PR #64.
 *
 * Two surfaces: the operator `/overview` page reads `jobLifecycle` from
 * `/admin/status` (counts only — total, open, claimable, stale, paused,
 * archived), and the `/runs` page reads the full job list from
 * `/admin/jobs` so it can show paused/archived/stale rows that the
 * public `/jobs` feed filters out.
 */

export type JobLifecycleStatus = "open" | "paused" | "archived";
/**
 * Computed state derived from status + age. "stale" means the job is
 * status: open but past its automatic stale-after window. "open" means
 * status: open and within the window. Paused/archived statuses surface
 * as the same string here.
 */
export type JobLifecycleState =
  | "open"
  | "stale"
  | "paused"
  | "archived";

export type JobLifecycleAction =
  | "pause"
  | "archive"
  | "reopen"
  | "mark_stale";

export interface JobLifecycle {
  status: JobLifecycleStatus;
  state: JobLifecycleState;
  reason?: string;
  staleAt?: string;
  staleReason?: string;
  pausedAt?: string;
  archivedAt?: string;
  reopenedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface JobLifecycleSummary {
  total: number;
  open: number;
  claimable: number;
  stale: number;
  paused: number;
  archived: number;
}

export const EMPTY_JOB_LIFECYCLE_SUMMARY: JobLifecycleSummary = {
  total: 0,
  open: 0,
  claimable: 0,
  stale: 0,
  paused: 0,
  archived: 0,
};

/** Read `jobLifecycle` from either `/admin/status` or `/admin/jobs` payload. */
export function buildJobLifecycleSummary(payload: unknown): JobLifecycleSummary {
  const root = asRecord(payload);
  if (!root) return EMPTY_JOB_LIFECYCLE_SUMMARY;
  const slice = asRecord(root.jobLifecycle);
  if (!slice) return EMPTY_JOB_LIFECYCLE_SUMMARY;
  return {
    total: nonNegInt(slice.total),
    open: nonNegInt(slice.open),
    claimable: nonNegInt(slice.claimable),
    stale: nonNegInt(slice.stale),
    paused: nonNegInt(slice.paused),
    archived: nonNegInt(slice.archived),
  };
}

/** Pull a single job's lifecycle block off a raw job object. */
export function buildJobLifecycle(raw: unknown): JobLifecycle | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const status = isStatus(record.status) ? record.status : undefined;
  const state = isState(record.state) ? record.state : undefined;
  if (!status || !state) return undefined;
  return {
    status,
    state,
    ...(text(record.reason) ? { reason: text(record.reason) } : {}),
    ...(text(record.staleAt) ? { staleAt: text(record.staleAt) } : {}),
    ...(text(record.staleReason) ? { staleReason: text(record.staleReason) } : {}),
    ...(text(record.pausedAt) ? { pausedAt: text(record.pausedAt) } : {}),
    ...(text(record.archivedAt) ? { archivedAt: text(record.archivedAt) } : {}),
    ...(text(record.reopenedAt) ? { reopenedAt: text(record.reopenedAt) } : {}),
    ...(text(record.createdAt) ? { createdAt: text(record.createdAt) } : {}),
    ...(text(record.updatedAt) ? { updatedAt: text(record.updatedAt) } : {}),
  };
}

/** Pretty label for the lifecycle pill. */
export function formatLifecycleLabel(state: JobLifecycleState): string {
  switch (state) {
    case "open":
      return "Open";
    case "stale":
      return "Stale";
    case "paused":
      return "Paused";
    case "archived":
      return "Archived";
  }
}

/**
 * Which actions are valid for a given current state. The backend is the
 * source of truth for what's allowed; this is a UI hint to disable
 * obviously-wrong transitions before the click round-trips.
 */
export function availableActions(state: JobLifecycleState): JobLifecycleAction[] {
  switch (state) {
    case "open":
      return ["pause", "archive", "mark_stale"];
    case "stale":
      return ["reopen", "pause", "archive"];
    case "paused":
      return ["reopen", "archive"];
    case "archived":
      return ["reopen"];
  }
}

export const LIFECYCLE_ACTION_LABEL: Record<JobLifecycleAction, string> = {
  pause: "Pause",
  archive: "Archive",
  reopen: "Reopen",
  mark_stale: "Mark stale",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function text(value: unknown): string | "" {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isStatus(value: unknown): value is JobLifecycleStatus {
  return value === "open" || value === "paused" || value === "archived";
}

function isState(value: unknown): value is JobLifecycleState {
  return value === "open" || value === "stale" || value === "paused" || value === "archived";
}

/**
 * Extract the array of jobs from `/admin/jobs` (`{ jobs: [...] }`) or
 * any payload that's already a bare array. Used by the runs page to
 * choose between the public and admin job feeds.
 */
export function extractAdminJobs(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = asRecord(payload);
  if (!root) return [];
  if (Array.isArray(root.jobs)) return root.jobs;
  return [];
}

/**
 * POST a lifecycle action against `/admin/jobs/lifecycle`. The caller
 * is responsible for triggering an SWR revalidate after success — this
 * helper is intentionally thin so the runs page owns the optimistic /
 * pessimistic strategy.
 */
export async function postJobLifecycleAction(
  fetcher: <T = unknown>(key: string | [string, RequestInit?]) => Promise<T>,
  jobId: string,
  action: JobLifecycleAction,
  reason?: string
): Promise<unknown> {
  return fetcher([
    "/admin/jobs/lifecycle",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId,
        action,
        ...(reason ? { reason } : {}),
      }),
    },
  ]);
}
