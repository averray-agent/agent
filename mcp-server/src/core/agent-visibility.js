export const SYNTHETIC_CANARY_JOB_PREFIX = "worker-canary-";

export function isSyntheticCanaryJobId(jobId) {
  return normalizeJobId(jobId).startsWith(SYNTHETIC_CANARY_JOB_PREFIX);
}

export function isExternalAgentJobId(jobId) {
  const normalized = normalizeJobId(jobId);
  return Boolean(normalized) && !isSyntheticCanaryJobId(normalized);
}

/**
 * Canary workers use fresh wallets, so wallet identity cannot classify them.
 * A profile is synthetic only while every observed session belongs to the
 * hosted worker canary. Any non-canary activity promotes it to a real agent.
 */
export function isSyntheticAgentSessions(sessions) {
  const safeSessions = Array.isArray(sessions)
    ? sessions.filter((session) => normalizeJobId(session?.jobId))
    : [];
  return safeSessions.length > 0
    && safeSessions.every((session) => isSyntheticCanaryJobId(session.jobId));
}

function normalizeJobId(value) {
  return typeof value === "string" ? value.trim() : "";
}
