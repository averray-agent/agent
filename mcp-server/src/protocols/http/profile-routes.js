import { getAddress } from "ethers";

import { buildAgentProfile } from "../../core/agent-profile.js";
import { disputeIdForSession } from "../../core/dispute-resolution.js";
import { ValidationError } from "../../core/errors.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;

function safeChecksum(raw) {
  try {
    return getAddress(raw);
  } catch {
    return raw;
  }
}

function profileTierToOperatorTier(reputation = {}) {
  const skill = Number(reputation.skill ?? 0);
  if (skill >= 300) return "master";
  if (reputation.tier === "elite" || skill >= 200) return "expert";
  if (reputation.tier === "pro" || skill >= 100) return "journeyman";
  return "apprentice";
}

function handleForWallet(wallet) {
  const normalized = String(wallet ?? "").toLowerCase();
  return `agent-${normalized.slice(2, 6)}-${normalized.slice(-4)}`;
}

function buildAgentDirectoryRow(profile) {
  const reputation = profile.reputation ?? {};
  const approvedCount = Number(profile.stats?.approvedCount ?? 0);
  const rejectedCount = Number(profile.stats?.rejectedCount ?? 0);
  const totalJobs = approvedCount + rejectedCount;
  const slashEvents = (profile.disputes ?? [])
    .filter((dispute) => dispute.verdict === "upheld")
    .map((dispute) => ({
      disputeId: dispute.id ?? null,
      jobId: dispute.jobId,
      sessionId: dispute.sessionId,
      reasonCode: dispute.reasonCode ?? null,
      txHash: dispute.txHash ?? null,
      at: dispute.openedAt,
    }));
  return {
    wallet: profile.wallet,
    handle: handleForWallet(profile.wallet),
    tier: profileTierToOperatorTier(reputation),
    reputationScore:
      Number(reputation.skill ?? 0) +
      Number(reputation.reliability ?? 0) +
      Number(reputation.economic ?? 0),
    successRate: profile.stats?.completionRate ?? null,
    totalJobs,
    currentActivity: profile.currentActivity ?? null,
    activeStake: 0,
    badges: profile.badges ?? [],
    slashEvents,
  };
}

export function createProfileRoutes({
  authMiddleware,
  env = process.env,
  logger,
  parseLimit,
  respond,
  service,
  stateStore,
}) {
  async function preloadDisputeReceipts(sessions) {
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return () => undefined;
    }
    const candidates = sessions.filter((session) => {
      if (!session || typeof session !== "object") return false;
      const status = String(session.status ?? "").toLowerCase();
      return status === "disputed" || Boolean(session.disputedAt);
    });
    if (candidates.length === 0) return () => undefined;
    const receiptsBySession = new Map();
    await Promise.all(
      candidates.map(async (session) => {
        const id = disputeIdForSession(session.sessionId);
        const [verdict, release] = await Promise.all([
          stateStore.getMutationReceipt?.("dispute_verdict", id),
          stateStore.getMutationReceipt?.("dispute_release", id),
        ]);
        if (verdict || release) {
          receiptsBySession.set(session.sessionId, {
            ...(verdict ? { verdict } : {}),
            ...(release ? { release } : {}),
          });
        } else {
          receiptsBySession.set(session.sessionId, {});
        }
      })
    );
    return (sessionId) => receiptsBySession.get(sessionId);
  }

  function preloadLineage(sessions) {
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return () => undefined;
    }
    const lookup = new Map();
    for (const session of sessions) {
      if (!session || typeof session !== "object") continue;
      const sessionId = String(session.sessionId ?? "");
      if (!sessionId) continue;

      const entry = {};
      let job;
      try {
        job = service.getJobDefinition(session.jobId);
      } catch {
        job = undefined;
      }
      if (job?.parentSessionId) {
        const parent = {
          sessionId: String(job.parentSessionId),
          ...(job.lineage?.parentJobId ? { jobId: String(job.lineage.parentJobId) } : {}),
          ...(typeof job.lineage?.parentWallet === "string"
            ? { wallet: job.lineage.parentWallet }
            : {})
        };
        if (Object.keys(parent).length > 0) entry.parent = parent;
      }
      let childJobs;
      try {
        childJobs = service.listChildJobsByParentSession?.(sessionId) ?? [];
      } catch {
        childJobs = [];
      }
      if (childJobs.length > 0) {
        entry.children = childJobs.map((childJob) => ({
          jobId: String(childJob.id ?? ""),
          ...(typeof childJob.lineage?.parentWallet === "string"
            ? { parentWallet: childJob.lineage.parentWallet }
            : {})
        })).filter((child) => child.jobId);
      }

      if (entry.parent || (entry.children && entry.children.length > 0)) {
        lookup.set(sessionId, entry);
      }
    }
    if (lookup.size === 0) return () => undefined;
    return (sessionId) => lookup.get(sessionId);
  }

  async function buildAgentDirectory(limit = 50) {
    const sessions = await service.listRecentSessions(limit);
    const wallets = [...new Set(sessions.map((session) => session.wallet).filter(Boolean))];
    const rows = await Promise.all(wallets.map(async (wallet) => {
      const checksummed = safeChecksum(wallet);
      const [reputation, history] = await Promise.all([
        service.getReputation(checksummed),
        service.collectSessionHistory(checksummed, { logger })
      ]);
      const getDisputeReceipts = await preloadDisputeReceipts(history);
      const getLineage = preloadLineage(history);
      const profile = buildAgentProfile({
        wallet: wallet.toLowerCase(),
        reputation,
        sessions: history,
        getJobDefinition: (jobId) => {
          try {
            return service.getJobDefinition(jobId);
          } catch {
            return undefined;
          }
        },
        publicBaseUrl: env.PUBLIC_BASE_URL,
        getDisputeReceipts,
        getLineage,
      });
      return buildAgentDirectoryRow(profile);
    }));
    return rows.sort((left, right) => {
      if (right.reputationScore !== left.reputationScore) {
        return right.reputationScore - left.reputationScore;
      }
      return String(left.wallet).localeCompare(String(right.wallet));
    });
  }

  return async function handleProfileRoute({ request, response, url, pathname, requestLogger }) {
    if (request.method === "GET" && pathname === "/agents") {
      respond(response, 200, await buildAgentDirectory(parseLimit(url, 50, 250)), {
        "cache-control": "public, max-age=30"
      });
      return true;
    }

    if (request.method === "GET" && pathname.startsWith("/agents/")) {
      const rawWallet = decodeURIComponent(pathname.slice("/agents/".length));
      if (!ADDRESS_RE.test(rawWallet)) {
        throw new ValidationError("wallet path segment must be a 0x-prefixed 20-byte hex address.");
      }
      const checksummed = safeChecksum(rawWallet);
      const [reputation, sessions] = await Promise.all([
        service.getReputation(checksummed),
        service.collectSessionHistory(checksummed, { logger: requestLogger })
      ]);
      const getDisputeReceipts = await preloadDisputeReceipts(sessions);
      const getLineage = preloadLineage(sessions);
      const profile = buildAgentProfile({
        wallet: rawWallet.toLowerCase(),
        reputation,
        sessions,
        getJobDefinition: (jobId) => {
          try {
            return service.getJobDefinition(jobId);
          } catch {
            return undefined;
          }
        },
        publicBaseUrl: env.PUBLIC_BASE_URL,
        getDisputeReceipts,
        getLineage,
      });
      respond(response, 200, profile, { "cache-control": "public, max-age=30" });
      return true;
    }

    if (request.method === "GET" && pathname === "/reputation") {
      const auth = await authMiddleware(request, url);
      respond(response, 200, await service.getReputation(auth.wallet));
      return true;
    }

    return false;
  };
}
