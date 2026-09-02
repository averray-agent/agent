const INGESTION_PROVIDER_DEFINITIONS = [
  ["github", "githubIngestion", "GitHub issues", "queryCount"],
  ["wikipedia", "wikipediaIngestion", "Wikipedia maintenance", "categoryCount"],
  ["osv", "osvIngestion", "OSV advisories", "targetCount"],
  ["openData", "openDataIngestion", "Open data", "targetCount"],
  ["standards", "standardsIngestion", "Standards freshness", "specCount"],
  ["openApi", "openApiIngestion", "OpenAPI quality", "specCount"]
];

/**
 * Default empty status used when an ingestion scheduler is not wired in
 * the current process. Matches the shape produced by every concrete
 * scheduler's `getStatus()` so `buildProviderOperations` can treat all
 * providers uniformly.
 */
export const PROVIDER_STATUS_FALLBACK = Object.freeze({
  enabled: false,
  running: false,
  dryRun: true,
  intervalMs: 0,
  maxJobsPerRun: 0,
  maxOpenJobs: 0,
  currentOpenJobs: 0,
  lastRun: undefined
});

export function buildProviderOperations(statuses) {
  const entries = INGESTION_PROVIDER_DEFINITIONS.map(([key, statusKey, label, targetCountField]) => {
    const status = statuses[statusKey] ?? {};
    return [key, buildProviderOperationStatus({
      label,
      status,
      targetCountField
    })];
  });
  return Object.fromEntries(entries);
}

/**
 * Strip `lastRun.errors[]` and `lastRun.skipped[]` from every provider in
 * a providerOperations object, preserving every other field including
 * `errorCount` and `skippedCount`. Used to derive the public sanitized
 * payload from the admin one.
 */
export function sanitizeProviderOperations(providerOperations) {
  const entries = Object.entries(providerOperations).map(([key, value]) => [
    key,
    sanitizeProviderOperationStatus(value)
  ]);
  return Object.fromEntries(entries);
}

function buildProviderOperationStatus({ label, status, targetCountField }) {
  const lastRun = summarizeProviderLastRun(status.lastRun);
  const currentOpenJobs = status.currentOpenJobs !== undefined
    ? toNonNegativeInteger(status.currentOpenJobs)
    : inferCurrentOpenJobs(status.lastRun);
  // queryCount/nextQuery describe the rotation pool — only meaningful
  // when the provider rotates a query list distinct from its
  // targetCount. github's queryCount IS its targetCount, so don't
  // duplicate it; openData rotates queries against a dataset list, so
  // queryCount and targetCount are genuinely different signals.
  const queryCount = status.queryCount !== undefined && targetCountField !== "queryCount"
    ? toNonNegativeInteger(status.queryCount)
    : undefined;
  const nextQuery = stringOrUndefined(status.nextQuery);
  return {
    label,
    enabled: Boolean(status.enabled),
    running: Boolean(status.running),
    dryRun: status.dryRun !== false,
    mode: !status.enabled ? "disabled" : (status.dryRun === false ? "live" : "dry_run"),
    intervalMs: toNonNegativeInteger(status.intervalMs),
    maxJobsPerRun: toNonNegativeInteger(status.maxJobsPerRun),
    ...(status.maxJobsPerQuery !== undefined ? { maxJobsPerQuery: toNonNegativeInteger(status.maxJobsPerQuery) } : {}),
    maxOpenJobs: toNonNegativeInteger(status.maxOpenJobs),
    currentOpenJobs,
    ...(status.minClaimableJobs !== undefined ? { minClaimableJobs: toNonNegativeInteger(status.minClaimableJobs) } : {}),
    ...(status.currentClaimableJobs !== undefined
      ? { currentClaimableJobs: toNonNegativeInteger(status.currentClaimableJobs) }
      : {}),
    targetCount: toNonNegativeInteger(status[targetCountField]),
    ...(queryCount !== undefined ? { queryCount } : {}),
    ...(nextQuery ? { nextQuery } : {}),
    lastRunAt: lastRun?.finishedAt ?? lastRun?.startedAt,
    lastRun,
    health: summarizeProviderHealth({
      enabled: Boolean(status.enabled),
      dryRun: status.dryRun !== false,
      currentOpenJobs,
      maxOpenJobs: toNonNegativeInteger(status.maxOpenJobs),
      lastRun
    })
  };
}

function sanitizeProviderOperationStatus(status) {
  if (!status?.lastRun) return status;
  return {
    ...status,
    lastRun: {
      ...status.lastRun,
      skipped: [],
      errors: []
    }
  };
}

function summarizeProviderLastRun(lastRun) {
  if (!lastRun || typeof lastRun !== "object") {
    return undefined;
  }
  const skippedCount = countSkipped(lastRun);
  const errorCount = Array.isArray(lastRun.errors) ? lastRun.errors.length : 0;
  const createdCount = toNonNegativeInteger(lastRun.createdCount);
  const candidateCount = toNonNegativeInteger(lastRun.candidateCount);
  const skipped = collectSkipped(lastRun);
  return {
    startedAt: stringOrUndefined(lastRun.startedAt),
    finishedAt: stringOrUndefined(lastRun.finishedAt),
    dryRun: lastRun.dryRun !== false,
    candidateCount,
    createdCount,
    skippedCount,
    errorCount,
    summary: summarizeLastRunText({ candidateCount, createdCount, skippedCount, errorCount }),
    skipped: skipped.slice(0, 5),
    errors: Array.isArray(lastRun.errors) ? lastRun.errors.slice(0, 5) : []
  };
}

function summarizeLastRunText({ candidateCount, createdCount, skippedCount, errorCount }) {
  return `${candidateCount} candidate(s), ${createdCount} created, ${skippedCount} skipped, ${errorCount} error(s)`;
}

function summarizeProviderHealth({ enabled, dryRun, currentOpenJobs, maxOpenJobs, lastRun }) {
  if (!enabled) {
    return "disabled";
  }
  if (lastRun?.errorCount > 0) {
    return "error";
  }
  if (maxOpenJobs > 0 && currentOpenJobs >= maxOpenJobs) {
    return "at_capacity";
  }
  if (dryRun) {
    return "dry_run";
  }
  return "healthy";
}

function countSkipped(lastRun) {
  return collectSkipped(lastRun).length;
}

function collectSkipped(lastRun) {
  const topLevel = Array.isArray(lastRun.skipped) ? lastRun.skipped : [];
  const queryLevel = Array.isArray(lastRun.queries)
    ? lastRun.queries.flatMap((query) => Array.isArray(query.skipped) ? query.skipped : [])
    : [];
  return [...topLevel, ...queryLevel];
}

function inferCurrentOpenJobs(lastRun) {
  if (!lastRun || typeof lastRun !== "object") {
    return 0;
  }
  for (const key of ["openGithubJobs", "openWikipediaJobs", "openOsvJobs", "openDataJobs", "openStandardsJobs", "openApiJobs"]) {
    if (lastRun[key] !== undefined) {
      return toNonNegativeInteger(lastRun[key]);
    }
  }
  return 0;
}

function toNonNegativeInteger(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) {
    return 0;
  }
  return Math.trunc(number);
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
