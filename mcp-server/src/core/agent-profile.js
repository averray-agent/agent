import { ValidationError } from "./errors.js";
import { describeSessionStatus } from "./session-state-machine.js";
import {
  DEFAULT_ESCROW_ASSET_SYMBOL,
  decimalsForAssetSymbol
} from "./assets.js";
import {
  ARBITRATOR_SLA_SECONDS,
  addSecondsIso,
  disputeIdForSession,
} from "./dispute-resolution.js";

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

export function buildAgentProfile({
  wallet,
  reputation,
  sessions,
  getJobDefinition,
  publicBaseUrl,
  fetchedAt,
  // Optional dispute-receipt lookup. The HTTP layer pre-fetches
  // `dispute_verdict` + `dispute_release` mutation receipts for every
  // session that's flagged as disputed (status === "disputed" or
  // disputedAt set), then passes a sync `(sessionId) → { verdict?,
  // release? } | undefined` so this builder can emit the
  // `disputes[]` block + dispute counts on the profile without
  // reaching into the store itself. Callers that don't need
  // dispute history can omit it.
  getDisputeReceipts,
  // Optional sub-contracting lineage lookup. The HTTP layer
  // pre-walks each session's parent (via `job.parentSessionId`) and
  // children (via `listJobsByParentSession(session.sessionId)`),
  // then passes a sync `(sessionId) → { parent?, children? } |
  // undefined` so this builder can emit the `lineage` block +
  // `stats.lineage` counters without reaching into the catalog
  // itself. Callers that don't need lineage can omit it. Roadmap §8.
  getLineage,
} = {}) {
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
  const rewardAsset = firstApprovedJob?.rewardAsset ?? DEFAULT_ESCROW_ASSET_SYMBOL;
  const decimals = Number.isInteger(firstApprovedJob?.rewardDecimals)
    ? firstApprovedJob.rewardDecimals
    : decimalsForAssetSymbol(rewardAsset);

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

    // Verification block — supports the public profile's
    // "one-click verification" affordance from spec §10. Each
    // field is optional, and the whole block is dropped when
    // nothing is computable so older sessions don't ship an
    // empty stub.
    const verification = buildBadgeVerification(session, job);
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
      ...(verification ? { verification } : {}),
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

  // Dispute history. Walks every session (not just approved /
  // rejected) so we surface in-flight disputes too. Sessions are
  // candidates for the disputes[] list when:
  //   - status === "disputed" (active dispute), or
  //   - they have any kind of dispute receipt registered against
  //     them (resolved or stake-released)
  // Sessions that are merely rejected without a contest don't
  // become disputes; the spec treats arbitration as the
  // contested-rejection path.
  const disputes = buildDisputeHistory(
    safeSessions,
    definitionOf,
    typeof getDisputeReceipts === "function" ? getDisputeReceipts : () => undefined
  );
  const disputeOutcomes = disputes.reduce(
    (acc, dispute) => {
      acc.total += 1;
      if (dispute.status === "open") acc.open += 1;
      else if (dispute.verdict === "upheld") acc.lost += 1;
      else if (dispute.verdict === "dismissed") acc.won += 1;
      else if (dispute.verdict === "split") acc.split += 1;
      else if (dispute.verdict === "timeout") acc.timeout += 1;
      else acc.resolved += 1;
      return acc;
    },
    { total: 0, open: 0, lost: 0, won: 0, split: 0, timeout: 0, resolved: 0 }
  );

  // Sub-contracting history. Each session can be a parent (this
  // wallet posted a sub-job from it), a child (this wallet worked
  // on a sub-job posted by another session), or both for a middle
  // node in a chain. Roadmap §8.
  const lineage = buildLineageHistory(
    safeSessions,
    normalizedWallet,
    definitionOf,
    typeof getLineage === "function" ? getLineage : () => undefined
  );
  const lineageOutcomes = {
    delegated: lineage.delegated.length,
    subcontracted: lineage.subcontracted.length
  };

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
      preferredCategories,
      disputes: disputeOutcomes,
      lineage: lineageOutcomes,
    },
    ...(currentActivity ? { currentActivity } : {}),
    categoryLevels,
    badges,
    disputes,
    lineage,
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

/**
 * Verification block attached to each approved-session badge entry.
 * Mirrors the structured fields the canonical badge JSON already
 * exposes (`agent-badge-v1` / `averray.*` namespace), plus a source
 * URL pulled off the job definition so the public profile page can
 * render a "one-click verification" affordance without a per-badge
 * fetch.
 *
 * Every field is optional. Older sessions that predate the chain
 * hash or evidence binding simply omit the missing keys so the
 * profile schema stays additive.
 */
function buildBadgeVerification(session, job) {
  const verification = session?.verification ?? session?.verificationSummary;
  const verifierAddress = stringOrUndefined(verification?.verifier ?? verification?.signer ?? session?.verifierAddress);
  const evidenceHash = stringOrUndefined(
    session?.evidenceHash ?? session?.submission?.evidenceHash ?? verification?.evidenceHash
  );
  const chainJobId = stringOrUndefined(session?.chainJobId ?? job?.chainJobId);
  const verifierMode = stringOrUndefined(job?.verifierMode ?? session?.verifierMode);
  const sourceUrl = pickSourceUrl(job);
  const sourceKind = stringOrUndefined(job?.source?.type);
  const result = compact({
    chainJobId,
    evidenceHash,
    verifier: verifierAddress,
    verifierMode,
    sourceUrl,
    sourceKind,
  });
  return Object.keys(result).length === 0 ? undefined : result;
}

/**
 * Pick the most useful upstream URL for a job's source — the one a
 * human or browser agent should follow to inspect the original work.
 * GitHub issues link to the issue, Wikipedia jobs link to the
 * pinned revision so the diff is always reproducible, OSV jobs link
 * to the consumer repo's PR (recorded on the session if present)
 * with a fallback to the OSV advisory page, and open-data jobs link
 * to the dataset landing page.
 */
function pickSourceUrl(job) {
  const source = job?.source;
  if (!source || typeof source !== "object") return undefined;
  switch (source.type) {
    case "github_issue":
      return stringOrUndefined(source.issueUrl ?? source.pageUrl);
    case "wikipedia_article":
      return stringOrUndefined(source.pinnedRevisionUrl ?? source.articleUrl ?? source.pageUrl);
    case "osv_advisory":
      return stringOrUndefined(source.advisoryUrl ?? source.referenceUrl);
    case "open_data_dataset":
      return stringOrUndefined(source.resourceUrl ?? source.datasetUrl);
    case "openapi_spec":
      return stringOrUndefined(source.specUrl ?? source.finalUrl);
    case "standards_spec":
      return stringOrUndefined(source.canonicalUrl ?? source.specUrl);
    default:
      return undefined;
  }
}

function stringOrUndefined(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Walk session history and emit a slim dispute record per session
 * that's either currently disputed or has a verdict / release
 * receipt against it. Newest-first, capped at 25 entries to keep
 * the public profile payload bounded — the frontend's "Open full
 * dispute log" link routes to /disputes for the unbounded view.
 */
function buildDisputeHistory(sessions, definitionOf, getDisputeReceipts) {
  if (!Array.isArray(sessions) || sessions.length === 0) return [];
  const candidates = [];
  for (const session of sessions) {
    if (!session || typeof session !== "object") continue;
    const status = String(session.status ?? "").toLowerCase();
    const receipts = getDisputeReceipts(session.sessionId) ?? {};
    const verdictReceipt = receipts.verdict ?? receipts.verdictReceipt;
    const releaseReceipt = receipts.release ?? receipts.releaseReceipt;
    const hasDisputeMarker =
      status === "disputed" ||
      Boolean(session.disputedAt) ||
      Boolean(verdictReceipt) ||
      Boolean(releaseReceipt);
    if (!hasDisputeMarker) continue;
    candidates.push(buildProfileDispute(session, definitionOf, verdictReceipt, releaseReceipt));
  }
  candidates.sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  return candidates.slice(0, 25);
}

/**
 * Slim dispute record for the public profile. Mirrors the shape
 * `/disputes/<id>` returns but trimmed to the fields a profile
 * reader cares about — id, sessionId, jobId, status, openedAt,
 * windowEndsAt, verdict, reasonCode, workerPayout, txHash. Heavy
 * fields (full evidence blob, signed receipt body) live behind
 * `/disputes/<id>` and require auth.
 */
/**
 * Walk session history and split each entry into the wallet's two
 * sub-contracting roles:
 *
 *   - delegated:   sessions where THIS wallet posted at least one
 *                  child job (parent role).
 *   - subcontracted: sessions where THIS wallet worked on a job
 *                  that was itself a child of another session
 *                  (child role).
 *
 * Both lists are newest-first and capped at 25 entries to keep the
 * public profile bounded. The frontend can deep-link to /runs for
 * the unbounded view. Each entry stays slim: id, jobId, jobTitle?,
 * status, completedAt, plus a compact counterparty + lineage
 * summary. Heavy lineage payloads (full child timelines, budget
 * accounting) live behind /admin/jobs/timeline.
 *
 * Skips any session whose lineage lookup returns nothing — the
 * common case for a wallet that hasn't done any sub-contracting.
 */
function buildLineageHistory(sessions, normalizedWallet, definitionOf, getLineage) {
  const delegated = [];
  const subcontracted = [];
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return { delegated, subcontracted };
  }

  for (const session of sessions) {
    if (!session || typeof session !== "object") continue;
    const lineage = getLineage(session.sessionId);
    if (!lineage || typeof lineage !== "object") continue;

    const job = (() => {
      try {
        return definitionOf(session.jobId);
      } catch {
        return undefined;
      }
    })();

    if (Array.isArray(lineage.children) && lineage.children.length > 0) {
      delegated.push(buildDelegatedEntry(session, job, lineage.children));
    }
    if (lineage.parent && typeof lineage.parent === "object") {
      subcontracted.push(buildSubcontractedEntry(session, job, lineage.parent, normalizedWallet));
    }
  }

  delegated.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
  subcontracted.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
  return {
    delegated: delegated.slice(0, 25),
    subcontracted: subcontracted.slice(0, 25)
  };
}

function buildDelegatedEntry(session, job, children) {
  const childJobIds = [];
  const childSessionIds = [];
  const childWallets = new Set();
  for (const child of children) {
    if (!child || typeof child !== "object") continue;
    const jobId = stringOrUndefined(child.jobId);
    if (jobId) childJobIds.push(jobId);
    if (Array.isArray(child.sessionIds)) {
      for (const sid of child.sessionIds) {
        if (typeof sid === "string" && sid) childSessionIds.push(sid);
      }
    }
    const childWallet = stringOrUndefined(child.wallet);
    if (childWallet) childWallets.add(childWallet.toLowerCase());
  }
  return {
    sessionId: String(session.sessionId ?? ""),
    jobId: stringOrUndefined(session.jobId) ?? "unknown-job",
    ...(stringOrUndefined(job?.title) ? { jobTitle: job.title } : {}),
    status: stringOrUndefined(session.status) ?? "unknown",
    role: "parent",
    updatedAt: stringOrUndefined(session.updatedAt) ?? new Date().toISOString(),
    children: {
      count: childJobIds.length,
      ...(childJobIds.length ? { jobIds: childJobIds } : {}),
      ...(childSessionIds.length ? { sessionIds: childSessionIds } : {}),
      ...(childWallets.size ? { wallets: [...childWallets] } : {})
    }
  };
}

function buildSubcontractedEntry(session, job, parent, normalizedWallet) {
  const parentWallet = stringOrUndefined(parent.wallet);
  const parentSessionId = stringOrUndefined(parent.sessionId);
  const parentJobId = stringOrUndefined(parent.jobId);
  return {
    sessionId: String(session.sessionId ?? ""),
    jobId: stringOrUndefined(session.jobId) ?? "unknown-job",
    ...(stringOrUndefined(job?.title) ? { jobTitle: job.title } : {}),
    status: stringOrUndefined(session.status) ?? "unknown",
    role: "child",
    updatedAt: stringOrUndefined(session.updatedAt) ?? new Date().toISOString(),
    parent: {
      ...(parentSessionId ? { sessionId: parentSessionId } : {}),
      ...(parentJobId ? { jobId: parentJobId } : {}),
      ...(parentWallet
        ? {
            wallet: parentWallet.toLowerCase(),
            // Convenience flag so the renderer can mark "self-
            // delegation" (a wallet posting a sub-job to itself)
            // distinctly from a true cross-wallet subcontract.
            isSelf: parentWallet.toLowerCase() === normalizedWallet
          }
        : {})
    }
  };
}

function buildProfileDispute(session, definitionOf, verdictReceipt, releaseReceipt) {
  const sessionId = String(session.sessionId ?? "");
  const id = sessionId ? disputeIdForSession(sessionId) : undefined;
  const openedAt = stringOrUndefined(session.disputedAt)
    ?? stringOrUndefined(session.updatedAt)
    ?? new Date().toISOString();
  const windowEndsAt = addSecondsIso(openedAt, ARBITRATOR_SLA_SECONDS) ?? openedAt;
  const status = verdictReceipt || releaseReceipt ? "resolved" : "open";
  const job = (() => {
    try {
      return definitionOf(session.jobId);
    } catch {
      return undefined;
    }
  })();
  const verdict = stringOrUndefined(verdictReceipt?.verdict);
  const reasonCode = stringOrUndefined(verdictReceipt?.reasonCode);
  const workerPayout = verdictReceipt?.workerPayout;
  const txHash = stringOrUndefined(verdictReceipt?.txHash);
  return {
    ...(id ? { id } : {}),
    sessionId,
    jobId: stringOrUndefined(session.jobId) ?? "unknown-job",
    ...(stringOrUndefined(job?.title) ? { jobTitle: job.title } : {}),
    status,
    openedAt,
    windowEndsAt,
    slaSeconds: ARBITRATOR_SLA_SECONDS,
    ...(verdict ? { verdict } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...(workerPayout !== undefined && workerPayout !== null
      ? { workerPayout: String(workerPayout) }
      : {}),
    ...(txHash ? { txHash } : {}),
    ...(stringOrUndefined(releaseReceipt?.releasedAt)
      ? { releasedAt: releaseReceipt.releasedAt }
      : {}),
  };
}
