const ACTIVE_SOURCE_STATES = new Set(["claimable", "claimed", "expired"]);
const COMPLETED_SOURCE_STATES = new Set(["exhausted", "completed", "resolved"]);
export const DEFAULT_COMPLETED_COOLDOWN_DAYS = 30;

export async function buildInventorySnapshot(platformService, {
  sourceType,
  category = undefined,
  tier = undefined,
  sourceKeyForJob,
  completedCooldownDays = DEFAULT_COMPLETED_COOLDOWN_DAYS,
  now = new Date()
} = {}) {
  const jobs = typeof platformService.listJobsWithSessions === "function"
    ? await platformService.listJobsWithSessions({ now })
    : platformService.listJobs();
  const allJobs = typeof platformService.listJobs === "function"
    ? platformService.listJobs({
      includeArchived: true,
      includePaused: true,
      includeStale: true,
      now
    })
    : jobs;
  const historicalSessions = await listInventorySessions(platformService);
  const historicalSessionJobIds = historicalSessions.map((session) => session?.jobId);
  const sourceJobs = jobs
    .filter((job) => job?.source?.type === sourceType)
    .filter((job) => !job.recurring);
  const allSourceJobs = allJobs
    .filter((job) => job?.source?.type === sourceType)
    .filter((job) => !job.recurring);
  // Archived catalogue rows and claim-time pins remain evidence even when they
  // are no longer listed. Do not let a lifecycle sweep erase a purchase.
  const sourceHistory = new Map(allSourceJobs.map((job) => [job.id, job]));
  for (const session of historicalSessions) {
    const job = session?.jobSnapshot?.definition;
    if (job?.source?.type === sourceType && !job.recurring) sourceHistory.set(job.id, job);
  }
  const completedByJob = new Map();
  const projectedById = new Map(jobs.map((job) => [job.id, job]));
  for (const job of sourceHistory.values()) {
    const projected = projectedById.get(job.id) ?? job;
    if (isCompletedSourceJob(projected)) completedByJob.set(job.id, completionTime(projected));
  }
  for (const session of historicalSessions) {
    const job = session?.jobSnapshot?.definition ?? sourceHistory.get(session?.jobId);
    if (job?.source?.type !== sourceType || job.recurring) continue;
    if (["resolved", "completed", "closed"].includes(session.status)) {
      const completedAt = completionTime(session);
      const previous = completedByJob.get(job.id);
      if (!completedByJob.has(job.id) || (completedAt && (!previous || completedAt > previous))) {
        completedByJob.set(job.id, completedAt);
      }
    }
  }
  const completedSources = new Map();
  for (const [jobId, completedAt] of completedByJob) {
    const key = sourceKeyForJob(sourceHistory.get(jobId));
    if (!key) continue;
    // Missing terminal timestamps are unknown, not proof that the cooldown
    // elapsed. Leave them blocked until a revision changes or history is repaired.
    const previous = completedSources.get(key);
    if (!previous || (!completedAt && previous.completedAt) || (previous.completedAt && completedAt > previous.completedAt)) {
      completedSources.set(key, { jobId, completedAt });
    }
  }
  const completedSourceKeys = new Set([...completedSources]
    .filter(([, record]) => !record.completedAt
      || now.getTime() - Date.parse(record.completedAt) < completedCooldownDays * 86_400_000)
    .map(([key]) => key));
  const scopedJobs = sourceJobs
    .filter((job) => category ? job.category === category : true)
    .filter((job) => tier ? job.tier === tier : true);
  const claimableJobs = scopedJobs.filter(isClaimableJob);
  const activeSourceKeys = new Set(
    sourceJobs
      .filter(isActiveSourceJob)
      .map(sourceKeyForJob)
      .filter(Boolean)
  );
  const allSourceKeys = new Set(allSourceJobs.map(sourceKeyForJob).filter(Boolean));
  const allJobIds = new Set(
    [
      ...allJobs.map((job) => job?.id),
      ...historicalSessionJobIds
    ].flatMap(normalizedJobIdEntries).filter(Boolean)
  );

  return {
    jobs,
    scopedJobs,
    claimableJobs,
    activeSourceKeys,
    completedSources,
    completedSourceKeys,
    seenSourceKeys: new Set([...activeSourceKeys, ...completedSourceKeys]),
    allSourceJobs: [...sourceHistory.values()],
    allSourceKeys,
    allJobIds,
    claimableCount: claimableJobs.length,
    totalCount: scopedJobs.length
  };
}

export function desiredInventoryCreates({
  claimableCount,
  minClaimableJobs = 0,
  maxJobsPerRun = 0,
  maxOpenJobs = Number.POSITIVE_INFINITY,
  activeCount = claimableCount
} = {}) {
  const needed = minClaimableJobs > 0
    ? Math.max(0, minClaimableJobs - claimableCount)
    : maxJobsPerRun;
  const openCapacity = Math.max(0, maxOpenJobs - activeCount);
  return Math.max(0, Math.min(maxJobsPerRun, needed, openCapacity));
}

export function withReissueJobId(job, existingJobIds, {
  now = new Date(),
  reason = "inventory_replenishment",
  sourceHistory = [],
  sourceKeyForJob = undefined,
  maxReissues = Number.POSITIVE_INFINITY
} = {}) {
  const normalizedId = normalizeJobId(job.id);
  const normalizedJob = normalizedId === job.id ? job : { ...job, id: normalizedId };
  const key = sourceKeyForJob?.(job);
  const previous = key ? sourceHistory.filter((entry) => sourceKeyForJob(entry) === key) : [];
  const lastNumber = Math.max(0, previous.length,
    ...previous.map((entry) => Number(entry.source?.reissueNumber) || 1));
  const reissueNumber = lastNumber + 1;
  if (reissueNumber > maxReissues) return undefined;
  if (!existingJobIds.has(normalizedId)) {
    existingJobIds.add(normalizedId);
    return sourceKeyForJob
      ? { ...normalizedJob, source: { ...job.source, reissueNumber } }
      : normalizedJob;
  }
  const base = truncateJobId(normalizedId, 108);
  let index = 2;
  let id = `${base}-r${index}`;
  while (existingJobIds.has(id)) {
    index += 1;
    id = `${base}-r${index}`;
  }
  existingJobIds.add(id);
  return {
    ...normalizedJob,
    id,
    source: {
      ...job.source,
      reissueOf: normalizedId,
      reissueReason: reason,
      reissuedAt: now.toISOString(),
      reissueNumber: sourceKeyForJob ? reissueNumber : index
    }
  };
}

export function parseNonNegativeInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value;
}

function isClaimableJob(job) {
  if (job?.claimable === true || job?.effectiveState === "claimable") {
    return true;
  }
  if (job?.claimable === false || job?.effectiveState) {
    return false;
  }
  const lifecycleState = job?.lifecycle?.state ?? job?.lifecycle?.status ?? job?.state ?? "open";
  return lifecycleState === "open";
}

function isActiveSourceJob(job) {
  if (ACTIVE_SOURCE_STATES.has(job?.effectiveState) || job?.claimable === true) {
    return true;
  }
  if (job?.effectiveState || job?.claimable === false) {
    return false;
  }
  const lifecycleState = job?.lifecycle?.state ?? job?.lifecycle?.status ?? job?.state ?? "open";
  return lifecycleState === "open";
}

function truncateJobId(jobId, maxLength) {
  return String(jobId ?? "").slice(0, maxLength).replace(/-+$/u, "");
}

function normalizedJobIdEntries(jobId) {
  const raw = String(jobId ?? "").trim();
  const normalized = normalizeJobId(raw);
  return raw && raw !== normalized ? [raw, normalized] : [normalized];
}

function normalizeJobId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isCompletedSourceJob(job) {
  return [job?.effectiveState, job?.claimState, job?.state, job?.lifecycle?.state, job?.lifecycle?.status]
    .some((state) => COMPLETED_SOURCE_STATES.has(state));
}

function completionTime(record) {
  const times = [record.resolvedAt, record.completedAt, record.closedAt,
    ...(record.statusHistory ?? []).filter((entry) => ["resolved", "completed", "closed"].includes(entry.to))
      .map((entry) => entry.at)].map((value) => Date.parse(value)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : undefined;
}

async function listInventorySessions(platformService) {
  const stateStore = platformService?.stateStore;
  if (typeof stateStore?.listRecentSessions !== "function") {
    const sessions = await platformService?.listRecentSessions?.(10_001) ?? [];
    if (!Array.isArray(sessions) || sessions.length > 10_000) throw new Error("inventory_history_incomplete");
    return sessions;
  }
  const sessions = [];
  for (let offset = 0; offset <= 10_000; offset += 200) {
    const page = await stateStore.listRecentSessions(200, offset);
    if (!Array.isArray(page) || sessions.length + page.length > 10_000) throw new Error("inventory_history_incomplete");
    sessions.push(...page);
    if (page.length < 200) return sessions;
  }
  throw new Error("inventory_history_incomplete");
}
