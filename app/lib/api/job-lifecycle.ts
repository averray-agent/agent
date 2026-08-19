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
  /** Open work. `claimable` is a subset of this, not a sibling. */
  open: number;
  claimable: number;
  stale: number;
  paused: number;
  archived: number;
  /**
   * Recurring reserve spent — the job is dead-ended, not open. Previously
   * these landed in `total` and no bucket at all, so a strip reading
   * STALE 0 / PAUSED 0 / ARCHIVED 0 told an operator nothing was stuck while
   * jobs sat exhausted.
   */
  exhausted: number | null;
  /**
   * Open work that nobody can pick up — `open` minus `claimable`. Derived
   * rather than matched on a reason string, so a new blocking reason is
   * counted the day it ships instead of silently reading as workable.
   *
   * This is the number that was missing entirely: ten of sixteen jobs were
   * waiting on reward funding while the room reported sixteen runs in motion
   * and a green treasury.
   *
   * `null` means the source did not report it — `/admin/status` emits neither
   * this nor `exhausted`. It must render as unknown, never as a zero the
   * endpoint never claimed.
   */
  blocked: number | null;
  /**
   * Dominant `reason` across the blocked rows, verbatim from the API. Shown
   * so the count names its own cause instead of leaving an operator to guess.
   */
  blockedReason?: string;
}

export const EMPTY_JOB_LIFECYCLE_SUMMARY: JobLifecycleSummary = {
  total: 0,
  open: 0,
  claimable: 0,
  stale: 0,
  paused: 0,
  archived: 0,
  exhausted: 0,
  blocked: 0,
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
    // /admin/status emits neither bucket today. They stay null — "not
    // reported" — so the strip renders unknown rather than a zero that would
    // read as a clean all-clear.
    exhausted: slice.exhausted === undefined ? null : nonNegInt(slice.exhausted),
    blocked: slice.blocked === undefined ? null : nonNegInt(slice.blocked),
  };
}

/**
 * Derive a public lifecycle summary from `/jobs` rows. This is intentionally
 * a fallback for signed-out overview pages: `/admin/status` remains the richer
 * operator source, but public jobs are enough to avoid showing an all-zero
 * lifecycle strip while the queue visibly contains open work.
 */
/**
 * How one `/jobs` row lands in the lifecycle buckets.
 *
 * This is the single definition of "open" for the operator surfaces. The
 * mission hero and the Runs-in-motion vital used to count `jobs.length`
 * instead, which reported the catalog total as open work — the overview showed
 * "16 open runs" beside a lifecycle strip reading OPEN 13, because three of
 * those jobs were exhausted.
 */
export interface JobRowClassification {
  exhausted: boolean;
  open: boolean;
  claimable: boolean;
  stale: boolean;
  paused: boolean;
  archived: boolean;
}

export function classifyJobRow(job: Record<string, unknown>): JobRowClassification {
  const lifecycle = asRecord(job.lifecycle);
  const status = text(lifecycle?.status) || text(job.status);
  const state = text(lifecycle?.state) || text(job.state) || status || "open";
  const effectiveState = text(job.effectiveState);
  // An exhausted job (recurring reserve spent) is not open work even
  // when its raw status still reads "open" — counting it inflated the
  // OPEN bucket past what agents can actually claim.
  const exhausted =
    status === "exhausted" || state === "exhausted" || effectiveState === "exhausted";
  const restricted = state === "restricted" || effectiveState === "restricted";

  return {
    exhausted,
    open:
      !exhausted &&
      !restricted &&
      (status === "open" ||
        state === "open" ||
        state === "ready" ||
        state === "claimable" ||
        effectiveState === "claimable"),
    // Note this is a SUBSET of `open`, not a sibling bucket.
    claimable:
      !exhausted &&
      !restricted &&
      (job.claimable === true ||
        effectiveState === "claimable" ||
        (!effectiveState && state === "open")),
    stale: state === "stale",
    paused: status === "paused" || state === "paused",
    archived: status === "archived" || state === "archived",
  };
}

/**
 * Count of rows that are genuinely open work. Use this anywhere the UI says
 * "open runs" — never `jobs.length`, which includes exhausted rows.
 */
export function countOpenJobs(payload: unknown): number {
  return extractJobRows(payload).reduce(
    (count, job) => (classifyJobRow(job).open ? count + 1 : count),
    0
  );
}

export function buildPublicJobLifecycleSummary(payload: unknown): JobLifecycleSummary {
  const jobs = extractJobRows(payload);
  if (!jobs.length) return EMPTY_JOB_LIFECYCLE_SUMMARY;

  const blockedReasons = new Map<string, number>();

  // Every bucket here is genuinely counted from rows, so `blocked` and
  // `exhausted` are real numbers rather than the "not reported" null that
  // /admin/status yields.
  type CountedSummary = JobLifecycleSummary & { blocked: number; exhausted: number };

  const summary = jobs.reduce<CountedSummary>((summary, job) => {
    const { exhausted, open, claimable, stale, paused, archived } = classifyJobRow(job);

    if (open && !claimable) {
      summary.blocked += 1;
      const reason = text(job.reason) || text(asRecord(job.claimStatus)?.reason);
      if (reason) blockedReasons.set(reason, (blockedReasons.get(reason) ?? 0) + 1);
    }

    summary.total += 1;
    if (exhausted) {
      summary.exhausted += 1;
    }
    if (open) {
      summary.open += 1;
    }
    if (claimable) {
      summary.claimable += 1;
    }
    if (stale) {
      summary.stale += 1;
    }
    if (paused) {
      summary.paused += 1;
    }
    if (archived) {
      summary.archived += 1;
    }
    return summary;
  }, { ...EMPTY_JOB_LIFECYCLE_SUMMARY, blocked: 0, exhausted: 0 });

  const dominant = [...blockedReasons.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dominant) summary.blockedReason = dominant[0];
  return summary;
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

function extractJobRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.map(asRecord).filter(Boolean) as Record<string, unknown>[];
  }
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.jobs)) return [];
  return root.jobs.map(asRecord).filter(Boolean) as Record<string, unknown>[];
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
