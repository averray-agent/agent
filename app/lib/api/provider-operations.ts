/**
 * Provider operations adapter.
 *
 * Normalises the `providerOperations` slice of `/admin/status` (operator
 * app, authed) and `/status/providers` (public, sanitized) into a flat
 * `ProviderOperation[]` sorted by operator priority — the rows that need
 * attention float to the top.
 *
 * Both endpoints emit the same per-provider shape; the only difference is
 * that the public endpoint always returns empty `lastRun.skipped[]` and
 * `lastRun.errors[]`. The adapter doesn't care which one fed it.
 */

export type ProviderKey =
  | "github"
  | "wikipedia"
  | "osv"
  | "openData"
  | "standards"
  | "openApi";

export type ProviderHealth =
  | "healthy"
  | "dry_run"
  | "at_capacity"
  | "error"
  | "disabled";

export type ProviderMode = "live" | "dry_run" | "disabled";

export interface ProviderLastRun {
  startedAt?: string;
  finishedAt?: string;
  dryRun: boolean;
  candidateCount: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  /** Pre-formatted "X candidate(s), Y created, Z skipped, W error(s)". */
  summary: string;
}

export interface ProviderOperation {
  key: ProviderKey;
  label: string;
  mode: ProviderMode;
  health: ProviderHealth;
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  maxJobsPerRun: number;
  maxOpenJobs: number;
  currentOpenJobs: number;
  /** Upstream queries / categories / packages / datasets / specs scanned. */
  targetCount: number;
  lastRunAt?: string;
  lastRun?: ProviderLastRun;
}

const PROVIDER_ORDER: ProviderKey[] = [
  "github",
  "wikipedia",
  "osv",
  "openData",
  "standards",
  "openApi",
];

// Lower number = higher priority for the operator's eye. The first row
// the operator sees should be the one that wants attention.
const HEALTH_PRIORITY: Record<ProviderHealth, number> = {
  error: 0,
  at_capacity: 1,
  dry_run: 2,
  healthy: 3,
  disabled: 4,
};

/**
 * Extract `providerOperations` from either:
 *   - `/admin/status` (whose top level carries many other slices)
 *   - `/status/providers` (whose top level is just `{ providerOperations }`)
 *
 * Returns an empty array when the payload is missing/malformed so the
 * card can render a "no data" state instead of erroring out.
 */
export function buildProviderOperations(payload: unknown): ProviderOperation[] {
  const root = asRecord(payload);
  if (!root) return [];
  const providerOperations = asRecord(root.providerOperations);
  if (!providerOperations) return [];

  const ordered: ProviderOperation[] = [];
  for (const key of PROVIDER_ORDER) {
    const entry = asRecord(providerOperations[key]);
    if (!entry) continue;
    ordered.push(buildProvider(key, entry));
  }
  return ordered.sort(byOperatorPriority);
}

function buildProvider(
  key: ProviderKey,
  raw: Record<string, unknown>
): ProviderOperation {
  return {
    key,
    label: text(raw.label, defaultLabel(key)),
    mode: mode(raw.mode),
    health: health(raw.health),
    enabled: Boolean(raw.enabled),
    running: Boolean(raw.running),
    intervalMs: nonNegInt(raw.intervalMs),
    maxJobsPerRun: nonNegInt(raw.maxJobsPerRun),
    maxOpenJobs: nonNegInt(raw.maxOpenJobs),
    currentOpenJobs: nonNegInt(raw.currentOpenJobs),
    targetCount: nonNegInt(raw.targetCount),
    ...(text(raw.lastRunAt) ? { lastRunAt: text(raw.lastRunAt) } : {}),
    ...(buildLastRun(raw.lastRun)
      ? { lastRun: buildLastRun(raw.lastRun)! }
      : {}),
  };
}

function buildLastRun(raw: unknown): ProviderLastRun | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  return {
    ...(text(record.startedAt) ? { startedAt: text(record.startedAt) } : {}),
    ...(text(record.finishedAt) ? { finishedAt: text(record.finishedAt) } : {}),
    dryRun: record.dryRun !== false,
    candidateCount: nonNegInt(record.candidateCount),
    createdCount: nonNegInt(record.createdCount),
    skippedCount: nonNegInt(record.skippedCount),
    errorCount: nonNegInt(record.errorCount),
    summary: text(record.summary, ""),
  };
}

function byOperatorPriority(
  a: ProviderOperation,
  b: ProviderOperation
): number {
  const healthDelta = HEALTH_PRIORITY[a.health] - HEALTH_PRIORITY[b.health];
  if (healthDelta !== 0) return healthDelta;
  // Within the same health bucket, fall back to the canonical
  // PROVIDER_ORDER so the layout is stable across renders.
  return PROVIDER_ORDER.indexOf(a.key) - PROVIDER_ORDER.indexOf(b.key);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nonNegInt(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function mode(value: unknown): ProviderMode {
  return value === "live" || value === "dry_run" || value === "disabled"
    ? value
    : "disabled";
}

function health(value: unknown): ProviderHealth {
  return value === "healthy" ||
    value === "dry_run" ||
    value === "at_capacity" ||
    value === "error" ||
    value === "disabled"
    ? value
    : "disabled";
}

const PROVIDER_LABEL: Record<ProviderKey, string> = {
  github: "GitHub issues",
  wikipedia: "Wikipedia maintenance",
  osv: "OSV advisories",
  openData: "Open data",
  standards: "Standards freshness",
  openApi: "OpenAPI quality",
};

function defaultLabel(key: ProviderKey): string {
  return PROVIDER_LABEL[key];
}

/**
 * Per-provider unit label used next to `targetCount` in the card.
 * The backend already documents what each `targetCount` represents:
 *   - github → query count
 *   - wikipedia → category count
 *   - osv → package count
 *   - openData → dataset count
 *   - standards → spec count
 *   - openApi → spec count
 */
export const PROVIDER_TARGET_UNIT: Record<ProviderKey, string> = {
  github: "queries",
  wikipedia: "categories",
  osv: "packages",
  openData: "datasets",
  standards: "specs",
  openApi: "specs",
};

/**
 * Pretty-printed mode label for the chip.
 */
export const PROVIDER_MODE_LABEL: Record<ProviderMode, string> = {
  live: "Live",
  dry_run: "Dry run",
  disabled: "Disabled",
};

/**
 * Pretty-printed health label for the chip.
 */
export const PROVIDER_HEALTH_LABEL: Record<ProviderHealth, string> = {
  healthy: "Healthy",
  dry_run: "Dry run",
  at_capacity: "At capacity",
  error: "Error",
  disabled: "Disabled",
};
