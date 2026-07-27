export const SYNTHETIC_CANARY_JOB_PREFIX = "worker-canary-";

export function isExternalAgentJobId(jobId) {
  const normalized = normalizeJobId(jobId);
  return Boolean(normalized) && !normalized.startsWith(SYNTHETIC_CANARY_JOB_PREFIX);
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
    && safeSessions.every((session) => (
      normalizeJobId(session.jobId).startsWith(SYNTHETIC_CANARY_JOB_PREFIX)
    ));
}

function normalizeJobId(value) {
  return typeof value === "string" ? value.trim() : "";
}
