import { isExternalJob } from "./external-job-lifecycle.js";

/**
 * Terminal settlement documents span several durable eras. Current sessions
 * embed verificationSummary; profile reads attach the separately stored
 * verification result; the earliest records used status on that result.
 */
export function isApprovedSettlement(session) {
  return session?.status === "resolved" && settlementOutcome(session) === "approved";
}

export function settlementOutcome(session) {
  const candidates = [
    session?.verificationSummary?.outcome,
    session?.verification?.outcome,
    session?.verificationSummary?.status,
    session?.verification?.status,
    session?.verdict?.outcome,
    session?.runReceipt?.verdict?.outcome
  ];
  return candidates
    .map((value) => String(value ?? "").trim().toLowerCase())
    .find((value) => ["approved", "rejected", "disputed", "inconclusive", "platform_fault"].includes(value));
}

export function isExternalSettlement(session) {
  const candidates = [
    session?.jobSnapshot?.definition,
    session?.jobSnapshot?.specDefinition,
    session?.jobSnapshot,
    session?.jobDefinition,
    session?.job,
    session
  ];
  return candidates.some((candidate) => isExternalJob(candidate));
}

export function isApprovedCatalogueSettlement(session) {
  return isApprovedSettlement(session) && !isExternalSettlement(session);
}

export async function attachStoredVerificationResults(stateStore, sessions) {
  if (typeof stateStore?.getVerificationResult !== "function") return sessions;
  return Promise.all(sessions.map(async (session) => {
    if (session?.verification !== undefined || session?.verificationSummary?.outcome !== undefined) {
      return session;
    }
    const verification = await stateStore.getVerificationResult(session?.sessionId);
    return verification ? { ...session, verification } : session;
  }));
}
