import { ValidationError } from "./errors.js";
import { describeSessionStatus } from "./session-state-machine.js";

/**
 * Build a v1 agent profile document from in-memory platform state.
 *
 * Separation of concerns mirrors `badge-metadata.js`: the function takes
 * only plain data (already-fetched reputation, sessions with verifications
 * attached, a job-definition lookup) and returns a schema-shaped object.
 * The HTTP layer is responsible for actually fetching the inputs.
 *
 * When the caller is the same HTTP handler that serves `GET /agents/:wallet`,
 * the sessions array should come from `listSessionHistory({ wallet, limit })`
 * so each session already has its `verification` field populated.
 *
 * @param {object} input
 * @param {string} input.wallet                Lowercase 0x EVM address.
 * @param {object} input.reputation            { skill, reliability, economic, tier }
 * @param {Array}  input.sessions              Session history with verification attached
 * @param {Function} input.getJobDefinition    (jobId) → job or undefined
 * @param {string} [input.publicBaseUrl]       Prefix for badge URLs; omit if unknown
 * @param {string} [input.fetchedAt]           Override the freshness stamp (tests)
 * @returns {object} profile
 */
export const AGENT_PROFILE_SCHEMA_VERSION = "v1";

export function buildAgentProfile({ wallet, reputation, sessions, getJobDefinition, publicBaseUrl, fetchedAt }) {
  requireAddress(wallet, "wallet");
  const normalizedWallet = wallet.toLowerCase();
  const rep = normaliseReputation(reputation);
  const definitionOf = typeof getJobDefinition === "function" ? getJobDefinition : () => undefined;
  const safeSessions = Array.isArray(sessions) ? sessions : [];

  // Split sessions into approved + rejected + other so the numerator and
  // denominator of completionRate are unambiguous.
  const approved = [];
  const rejected = [];
  for (const session of safeSessions) {
    const outcome = session?.verification?.outcome;
    if (outcome === "approved") {
      approved.push(session);
    } else if (outcome === "rejected") {
      rejected.push(session);
    }
  }

  // Assume all rewards share a single asset + decimal configuration within
  // a platform; the first approved session's job defines it for totals.
  // If the reward asset ever diverges per session we'll need a per-asset
  // totals map — not needed for v1.
  const firstApprovedJob = approved
    .map((s) => definitionOf(s.jobId))
    .find((j) => j);
  const rewardAsset = firstApprovedJob?.rewardAsset ?? "DOT";
  const decimals = Number.isInteger(firstApprovedJob?.rewardDecimals) ? firstApprovedJob.rewardDecimals : 18;

  let totalRewardBase = 0n;
  const categoryCounts = new Map();
  const categoryMaxLevel = new Map();
  const badges = [];
  let activeSinceMs;
  let lastActiveMs = maxTimestamp(safeSessions);

  // Walk approved sessions to accumulate totals + badge entries. Sort by
  // completedAt DESC so the badges array is newest-first.
  const approvedSorted = approved.slice().sort((a, b) => timestampOf(b) - timestampOf(a));
  for (const session of approvedSorted) {
    const job = definitionOf(session.jobId);
    const category = String(job?.category ?? "unknown").trim().toLowerCase();
    const level = inferLevel(job);
    const completedAt = new Date(session.updatedAt ?? Date.now()).toISOString();
    const rewardAmount = job?.rewardAmount ?? 0;

    totalRewardBase += toBaseUnits(rewardAmount, decimals);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    categoryMaxLevel.set(category, Math.max(categoryMaxLevel.get(category) ?? 0, level));

    const ts = timestampOf(session);
    if (!activeSinceMs || ts < activeSinceMs) {
      activeSinceMs = ts;
    }

    badges.push({
      sessionId: session.sessionId,
      jobId: session.jobId,
      category,
      level,
      completedAt,
      reward: {
        asset: job?.rewardAsset ?? rewardAsset,
        amount: toBaseUnits(rewardAmount, decimals).toString(),
        decimals
      },
      ...(publicBaseUrl
        ? { badgeUrl: `${stripTrailingSlash(publicBaseUrl)}/badges/${encodeURIComponent(session.sessionId)}` }
        : {})
    });
  }

  const githubSignals = aggregateGithubSignals(safeSessions);
  const currentActivity = buildCurrentActivity(safeSessions, definitionOf);

  const preferredCategories = Array.from(categoryCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));

  const categoryLevels = Object.fromEntries(categoryMaxLevel.entries());

  const totalTerminal = approved.length + rejected.length;
  const completionRate = totalTerminal === 0 ? null : approved.length / totalTerminal;

  return {
    schemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
    wallet: normalizedWallet,
    fetchedAt: fetchedAt ?? new Date().toISOString(),
    reputation: rep,
    stats: {
      totalBadges: approved.length,
      approvedCount: approved.length,
      rejectedCount: rejected.length,
      completionRate,
      totalEarned: {
        asset: rewardAsset,
        amount: totalRewardBase.toString(),
        decimals
      },
      githubSignals,
      activeSince: activeSinceMs ? new Date(activeSinceMs).toISOString() : null,
      lastActive: lastActiveMs ? new Date(lastActiveMs).toISOString() : null,
      preferredCategories
    },
    ...(currentActivity ? { currentActivity } : {}),
    categoryLevels,
    badges
  };
}

function buildCurrentActivity(sessions, definitionOf) {
  const active = sessions
    .filter((session) => {
      const status = describeSessionStatus(session?.status);
      return !status.terminal && status.status !== "__new__";
    })
    .sort((a, b) => timestampOf(b) - timestampOf(a))[0];
  if (!active) return null;

  const status = describeSessionStatus(active.status);
  const job = definitionOf(active.jobId);
  const deadlineAt = computeDeadlineAt(active, job);
  return compact({
    sessionId: active.sessionId,
    jobId: active.jobId,
    status: status.status,
    label: status.label,
    phase: status.phase,
    outcome: status.outcome,
    claimedAt: isoOrUndefined(active.claimedAt),
    submittedAt: isoOrUndefined(active.submittedAt),
    updatedAt: isoOrUndefined(active.updatedAt),
    deadlineAt,
    canSubmit: status.status === "claimed",
    awaitingVerification: status.status === "submitted" || status.status === "disputed"
  });
}

function aggregateGithubSignals(sessions) {
  const totals = {
    attempted: 0,
    prOpened: 0,
    checksPassed: 0,
    maintainerApproved: 0,
    merged: 0
  };
  for (const session of sessions) {
    const signals = session?.verification?.reputationSignals;
    if (!signals || typeof signals !== "object") {
      continue;
    }
    for (const key of Object.keys(totals)) {
      totals[key] += Number.isInteger(signals[key]) ? signals[key] : 0;
    }
  }
  return totals;
}

function normaliseReputation(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const skill = Number.isInteger(source.skill) ? source.skill : 0;
  const reliability = Number.isInteger(source.reliability) ? source.reliability : 0;
  const economic = Number.isInteger(source.economic) ? source.economic : 0;
  const tier =
    source.tier === "elite" || source.tier === "pro" || source.tier === "starter"
      ? source.tier
      : deriveTier(skill);
  return { skill, reliability, economic, tier };
}

function deriveTier(skill) {
  if (skill >= 200) return "elite";
  if (skill >= 100) return "pro";
  return "starter";
}

function inferLevel(job) {
  return job?.payoutMode === "milestone" ? 2 : 1;
}

function timestampOf(session) {
  const parsed = Date.parse(session?.updatedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function maxTimestamp(sessions) {
  let max;
  for (const session of sessions) {
    const ts = timestampOf(session);
    if (ts > 0 && (!max || ts > max)) {
      max = ts;
    }
  }
  return max;
}

function computeDeadlineAt(session, job) {
  const claimed = Date.parse(session?.claimedAt ?? "");
  if (!Number.isFinite(claimed)) return undefined;
  const ttl = Number(job?.claimTtlSeconds);
  if (!Number.isFinite(ttl) || ttl <= 0) return undefined;
  return new Date(claimed + ttl * 1000).toISOString();
}

function isoOrUndefined(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function toBaseUnits(amount, decimals) {
  if (amount === undefined || amount === null || amount === "") {
    return 0n;
  }
  const asString = typeof amount === "string" ? amount : String(amount);
  const [whole, fraction = ""] = asString.split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/u, "");
  if (!/^[0-9]+$/u.test(combined)) {
    throw new ValidationError(`reward amount must be numeric; got ${asString}`);
  }
  return BigInt(combined);
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

function requireAddress(raw, label) {
  if (typeof raw !== "string" || !/^0x[a-fA-F0-9]{40}$/u.test(raw)) {
    throw new ValidationError(`${label} must be a 0x-prefixed 20-byte EVM address`);
  }
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}
