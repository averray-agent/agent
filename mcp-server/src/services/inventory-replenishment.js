const ACTIVE_SOURCE_STATES = new Set(["claimable", "claimed", "expired"]);

export async function buildInventorySnapshot(platformService, {
  sourceType,
  category = undefined,
  tier = undefined,
  sourceKeyForJob,
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
  const historicalSessionJobIds = await listHistoricalSessionJobIds(platformService);
  const sourceJobs = jobs
    .filter((job) => job?.source?.type === sourceType)
    .filter((job) => !job.recurring);
  const allSourceJobs = allJobs
    .filter((job) => job?.source?.type === sourceType)
    .filter((job) => !job.recurring);
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
  reason = "inventory_replenishment"
} = {}) {
  const normalizedId = normalizeJobId(job.id);
  const normalizedJob = normalizedId === job.id ? job : { ...job, id: normalizedId };
  if (!existingJobIds.has(normalizedId)) {
    existingJobIds.add(normalizedId);
    return normalizedJob;
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
      reissueNumber: index
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

async function listHistoricalSessionJobIds(platformService) {
  const stateStore = platformService?.stateStore;
  const sessions = typeof stateStore?.listRecentSessions === "function"
    ? await stateStore.listRecentSessions(10_000)
    : typeof platformService?.listRecentSessions === "function"
      ? await platformService.listRecentSessions(10_000)
      : [];
  return sessions.map((session) => session?.jobId).filter(Boolean);
}
