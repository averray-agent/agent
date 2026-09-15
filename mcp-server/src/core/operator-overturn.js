// Original verifier evidence is immutable history; arbitration determines the
// current outcome. Keep this projection shared by results and wallet history.
export function projectOverturnedVerification(session, original) {
  if (!session?.operatorOverturn?.openedAt) return original;
  original = original?.originalVerdict ?? original;
  const resolution = session.operatorOverturn.resolution;
  return {
    ...original,
    sessionId: session.sessionId,
    sessionStatus: session.status,
    outcome: resolution ? (Number(resolution.workerPayout) > 0 ? "approved" : "rejected") : "disputed",
    status: resolution ? "resolved" : "awaiting_arbitration",
    workerPayout: resolution?.workerPayout,
    overturn: session.operatorOverturn,
    originalVerdict: original ?? null
  };
}
