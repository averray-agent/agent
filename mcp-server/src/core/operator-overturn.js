// Original verifier evidence is immutable history; arbitration determines the
// current outcome. Keep this projection shared by results and wallet history.
export function projectOverturnedVerification(session, original) {
  if (session?.humanReview?.resolution && !session.disputeResolution && !session.operatorOverturn
    && ["resolved", "rejected"].includes(session.status)) {
    return { ...original, sessionId: session.sessionId, sessionStatus: session.status,
      outcome: session.humanReview.resolution.outcome, status: "resolved",
      handler: "human_review", reasonCode: session.humanReview.reasonCode,
      decidedBy: session.humanReview.decidedBy, rationaleHash: session.humanReview.rationaleHash,
      metadataURI: session.humanReview.metadataURI, payoutTx: session.humanReview.resolution.payoutTx,
      workerPayout: session.humanReview.resolution.workerPayout,
      humanReview: session.humanReview, originalVerdict: session.humanReview.originalVerdict };
  }
  if (session?.disputeResolution && !session?.operatorOverturn) {
    return { ...original, sessionId: session.sessionId, sessionStatus: session.status,
      outcome: Number(session.disputeResolution.workerPayout) > 0 ? "approved" : "rejected", status: "resolved",
      workerPayout: session.disputeResolution.workerPayout, disputeResolution: session.disputeResolution,
      originalVerdict: original?.originalVerdict ?? original ?? null };
  }
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
