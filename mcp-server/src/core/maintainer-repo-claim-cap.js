import { isExpiredClaim } from "./claim-state.js";
import { normalizeRepo } from "./maintainer-surface-policy.js";
import { withPinnedRepositoryIdentity } from "../services/github-repository-identity-backfill.js";

export const DEFAULT_MAINTAINER_REPO_CAP_NO_MERGE = 2;
export const DEFAULT_MAINTAINER_REPO_CAP_MERGED = 3;
export const DEFAULT_MAINTAINER_REPO_CAP_OPTED_IN = 5;
export const DEFAULT_MAINTAINER_REPO_CLAIM_CAP_MODE = "log";
export const MAINTAINER_REPO_CLAIM_LOCK_TTL_SECONDS = 15 * 60;
export const MAINTAINER_REPO_CLAIM_LOCK_WAIT_MS = 400;
export const MAINTAINER_REPO_CLAIM_LOCK_POLL_MS = 40;
export const MAINTAINER_REPO_CLAIM_CAP_STATE_SCOPE = "maintainer-repo-claim-cap";

const OPEN_PR_EXCLUDED_STATUSES = new Set(["merged", "closed_unmerged", "open_stale", "reverted"]);
const MERGE_PROOF_STATUSES = new Set(["submitted", "resolved", "closed", "disputed"]);
const USAGE_PAGE_SIZE = 200;
const USAGE_MAX_ROWS = 10_000;

export async function acquireMaintainerRepoClaimLock(stateStore, lockId, owner, {
  ttlSeconds = MAINTAINER_REPO_CLAIM_LOCK_TTL_SECONDS,
  waitMs = MAINTAINER_REPO_CLAIM_LOCK_WAIT_MS,
  pollMs = MAINTAINER_REPO_CLAIM_LOCK_POLL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now()
} = {}) {
  const deadline = now() + waitMs;
  for (;;) {
    const acquired = await stateStore.acquireClaimLock?.(lockId, owner, ttlSeconds);
    if (acquired !== false) return true;
    if (now() >= deadline) return false;
    await sleep(pollMs);
  }
}

export function maintainerRepoClaimLockId(repoId) {
  return `maintainer-repo-claim:${repoId}`;
}

export function positiveGithubRepoId(value) {
  const id = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function normalizeMaintainerRepoClaimCapConfig(config = {}) {
  return {
    mode: config.mode === "enforce" ? "enforce" : DEFAULT_MAINTAINER_REPO_CLAIM_CAP_MODE,
    capNoMerge: positiveInt(config.capNoMerge, DEFAULT_MAINTAINER_REPO_CAP_NO_MERGE),
    capMerged: positiveInt(config.capMerged, DEFAULT_MAINTAINER_REPO_CAP_MERGED),
    capOptedIn: positiveInt(config.capOptedIn, DEFAULT_MAINTAINER_REPO_CAP_OPTED_IN)
  };
}

export function loadMaintainerRepoClaimCapConfig(env = process.env) {
  return normalizeMaintainerRepoClaimCapConfig({
    mode: env?.MAINTAINER_REPO_CLAIM_CAP_MODE,
    capNoMerge: env?.MAINTAINER_REPO_CAP_NO_MERGE,
    capMerged: env?.MAINTAINER_REPO_CAP_MERGED,
    capOptedIn: env?.MAINTAINER_REPO_CAP_OPTED_IN
  });
}

export function maintainerRepoClaimCap({ hasMerged = false, optedIn = false, caps } = {}) {
  if (optedIn === true) return caps.capOptedIn;
  if (hasMerged === true) return caps.capMerged;
  return caps.capNoMerge;
}

export function isOpenAverrayPullRequest(record) {
  return record?.upstream?.kind === "github_pull_request"
    && !OPEN_PR_EXCLUDED_STATUSES.has(record?.finalStatus);
}

// A verifier rejection is not a merge, even when a merged flag was copied onto
// the same record. Funded-job finalStatus remains a separate observation.
export function verificationShowsMerged(verification) {
  if (!verification || typeof verification !== "object" || verification.outcome === "rejected") {
    return false;
  }
  return verification.signals?.merged === true
    || verification.checks?.merged === true
    || verification.reputationSignals?.merged === 1
    || verification.githubLookup?.merged === true;
}

export function isActiveUnsubmittedClaim(session, job, now = new Date()) {
  return session?.status === "claimed" && !isExpiredClaim(session, job, now);
}

function sessionCouldProveMerge(session) {
  return MERGE_PROOF_STATUSES.has(session?.status);
}

function memoizedPinStore(stateStore) {
  const cache = new Map();
  return {
    getGithubRepositoryPin: async (key) => {
      if (cache.has(key)) return cache.get(key);
      const pin = await stateStore.getGithubRepositoryPin?.(key);
      cache.set(key, pin);
      return pin;
    }
  };
}

export async function resolveJobRepoIdentity(job, stateStore) {
  if (job?.source?.type !== "github_issue") {
    return { status: "not_github", repoId: null, repo: null };
  }
  const repo = normalizeRepo(job.source.repo) || null;
  const direct = positiveGithubRepoId(job.source.githubRepoId);
  if (direct) return { status: "known", repoId: direct, repo };
  if (typeof stateStore?.getGithubRepositoryPin !== "function") {
    return { status: "ambiguous", repoId: null, repo };
  }
  try {
    const pinned = await withPinnedRepositoryIdentity(job, stateStore);
    const repoId = positiveGithubRepoId(pinned?.source?.githubRepoId);
    if (repoId) return { status: "known", repoId, repo, origin: "pin" };
  } catch {
    return { status: "ambiguous", repoId: null, repo };
  }
  return { status: "ambiguous", repoId: null, repo };
}

function jobForSession(session, getJobDefinition) {
  const snapshot = session?.jobSnapshot?.definition;
  if (snapshot && typeof snapshot === "object") return snapshot;
  if (typeof getJobDefinition !== "function" || !session?.jobId) return undefined;
  try {
    return getJobDefinition(session.jobId);
  } catch {
    return undefined;
  }
}

function looksLikeGithubRecord(record, job) {
  return job?.source?.type === "github_issue"
    || record?.source?.type === "github_issue"
    || record?.upstream?.kind === "github_pull_request";
}

async function resolveFundedRecordIdentity(record, stateStore, getJobDefinition) {
  const direct = positiveGithubRepoId(record?.source?.githubRepoId);
  if (direct) {
    return {
      status: "known",
      repoId: direct,
      repo: normalizeRepo(record?.source?.repo ?? record?.upstream?.repo) || null,
      optedIn: record?.source?.maintainerPolicy?.optedIn === true
    };
  }
  let catalogueJob;
  if (typeof getJobDefinition === "function" && record?.jobId) {
    try {
      catalogueJob = getJobDefinition(record.jobId);
    } catch {
      catalogueJob = undefined;
    }
  }
  const job = catalogueJob ?? (looksLikeGithubRecord(record, undefined)
    ? {
        id: record.jobId,
        source: record.source?.type === "github_issue"
          ? record.source
          : { type: "github_issue", repo: record?.upstream?.repo ?? record?.source?.repo },
        lifecycle: record.lifecycle
      }
    : undefined);
  if (!job) return { status: "not_github", repoId: null, repo: null };
  const identity = await resolveJobRepoIdentity(job, stateStore);
  return {
    ...identity,
    optedIn: job.source?.maintainerPolicy?.optedIn === true || record?.source?.maintainerPolicy?.optedIn === true
  };
}

async function listPaged(maxRows, fetchPage) {
  if (typeof fetchPage !== "function") return null;
  const rows = [];
  for (let offset = 0; rows.length < maxRows; offset += USAGE_PAGE_SIZE) {
    const limit = Math.min(USAGE_PAGE_SIZE, maxRows - rows.length);
    const page = await fetchPage(limit, offset);
    if (!Array.isArray(page)) return null;
    if (page.length === 0) return { rows, truncated: false };
    rows.push(...page.slice(0, limit));
    if (page.length < limit) return { rows, truncated: false };
    if (rows.length >= maxRows) {
      const probe = await fetchPage(1, rows.length);
      return { rows, truncated: Array.isArray(probe) && probe.length > 0 };
    }
  }
  return { rows, truncated: false };
}

async function listAllSessions(stateStore, maxRows) {
  if (typeof stateStore?.listRecentSessions !== "function") return null;
  return listPaged(maxRows, (limit, offset) => stateStore.listRecentSessions(limit, offset));
}

async function listAllFundedJobs(stateStore, maxRows) {
  if (typeof stateStore?.listFundedJobs !== "function") return null;
  return listPaged(maxRows, (limit, offset) => stateStore.listFundedJobs({ limit, offset }));
}

function unmeasuredUsage(optedIn) {
  return {
    measured: false,
    openPrs: "not reported",
    activeClaims: "not reported",
    ambiguous: "not reported",
    hasMerged: "not reported",
    optedIn,
    cap: "not reported"
  };
}

export async function measureMaintainerRepoClaimUsage({
  stateStore,
  repoId,
  getJobDefinition,
  claimingJob,
  now = new Date(),
  caps,
  maxRows = USAGE_MAX_ROWS
} = {}) {
  const optedInFromClaim = claimingJob?.source?.maintainerPolicy?.optedIn === true;
  let sessions;
  let fundedJobs;
  try {
    sessions = await listAllSessions(stateStore, maxRows);
    fundedJobs = await listAllFundedJobs(stateStore, maxRows);
  } catch {
    return unmeasuredUsage(optedInFromClaim);
  }
  if (sessions === null || fundedJobs === null || sessions.truncated || fundedJobs.truncated) {
    // A truncated scan must not be reported as a complete count. Dropping an
    // older merged PR would silently lower the tier from 3 to 2.
    return unmeasuredUsage(optedInFromClaim);
  }

  const pinStore = memoizedPinStore(stateStore);
  let openPrs = 0;
  let activeClaims = 0;
  let ambiguous = 0;
  let hasMerged = false;
  let optedIn = optedInFromClaim;

  for (const record of fundedJobs.rows) {
    const identity = await resolveFundedRecordIdentity(record, pinStore, getJobDefinition);
    if (identity.status === "ambiguous") {
      ambiguous += 1;
      continue;
    }
    if (identity.status !== "known" || identity.repoId !== repoId) continue;
    if (identity.optedIn === true) optedIn = true;
    if (record?.finalStatus === "merged") hasMerged = true;
    if (isOpenAverrayPullRequest(record)) openPrs += 1;
  }

  // Pending brokered-claim:* service state is not an active claim until it
  // converges into a session. It is not counted here.
  for (const session of sessions.rows) {
    const preliminary = session?.jobSnapshot?.definition;
    const preliminaryJob = preliminary && typeof preliminary === "object" ? preliminary : undefined;
    if (preliminaryJob?.source?.type && preliminaryJob.source.type !== "github_issue") continue;
    const active = isActiveUnsubmittedClaim(session, preliminaryJob, now);
    const mergeCandidate = !hasMerged && sessionCouldProveMerge(session);
    if (!active && !mergeCandidate) continue;
    const job = preliminaryJob ?? jobForSession(session, getJobDefinition);
    if (job?.source?.type !== "github_issue") continue;
    const identity = await resolveJobRepoIdentity(job, pinStore);
    if (identity.status === "ambiguous") {
      ambiguous += 1;
      continue;
    }
    if (identity.status !== "known" || identity.repoId !== repoId) continue;
    if (job.source?.maintainerPolicy?.optedIn === true) optedIn = true;
    if (active) activeClaims += 1;
    if (!mergeCandidate) continue;
    const verification = await stateStore.getVerificationResult?.(session.sessionId);
    if (verificationShowsMerged(verification)) hasMerged = true;
  }

  return {
    measured: true,
    openPrs,
    activeClaims,
    ambiguous,
    hasMerged,
    optedIn,
    cap: maintainerRepoClaimCap({ hasMerged, optedIn, caps })
  };
}
