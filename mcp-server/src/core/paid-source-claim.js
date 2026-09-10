import { ConflictError } from "./errors.js";

export const SOURCE_ALREADY_PAID = "source_already_paid";
const HISTORY_UNAVAILABLE = "source_payment_history_unavailable";
const PAGE_SIZE = 64;
const MAX_SESSIONS = 10_000;

// A title, task type or reissue id is not new inventory. Only a new upstream
// revision creates a new unit of Wikipedia work.
export function wikipediaRevisionKey(job) {
  const source = job?.source;
  if (source?.type !== "wikipedia_article") return undefined;
  const language = String(source.language ?? source.lang ?? "").trim().toLowerCase();
  const pageId = String(source.pageId ?? "").trim();
  const revisionId = String(source.revisionId ?? "").trim();
  if (!language || !/^\d+$/u.test(pageId) || !/^\d+$/u.test(revisionId)) return undefined;
  return `${language}:${pageId}:${revisionId}`;
}

export async function assessPaidSourceClaim({ stateStore, getJobDefinition, job, wallet }) {
  if (job?.source?.type !== "wikipedia_article") return { eligible: true };
  const sourceKey = wikipediaRevisionKey(job);
  if (!sourceKey || typeof stateStore?.listSessionsByWallet !== "function") return unavailable();
  try {
    for (let offset = 0; offset < MAX_SESSIONS; offset += PAGE_SIZE) {
      const sessions = await stateStore.listSessionsByWallet(wallet, PAGE_SIZE, offset);
      if (!Array.isArray(sessions)) return unavailable();
      for (const session of sessions) {
        if (String(session?.wallet).toLowerCase() !== String(wallet).toLowerCase()) continue;
        // A resolved session alone is not a payment (e.g. zero worker payout).
        // Read older separately stored receipts as well as the atomic modern pin.
        const verification = session.payoutTx?.settlement
          ? undefined
          : await stateStore.getVerificationResult?.(session.sessionId);
        const settlement = session.payoutTx?.settlement ?? verification?.payoutTx?.settlement
          ?? verification?.settlement;
        const amount = settlement?.workerAmountRaw ?? settlement?.workerAmount;
        if (amount !== undefined && Number(amount) === 0) continue;
        if (session.payoutTx?.status === 0) continue;
        if (amount === undefined && session.status !== "resolved") continue;
        let priorJob = session.jobSnapshot?.definition;
        if (!priorJob) {
          try { priorJob = getJobDefinition(session.jobId); } catch { /* Fail closed below. */ }
        }
        if (!priorJob || (priorJob.source?.type === "wikipedia_article" && !wikipediaRevisionKey(priorJob))) {
          return unavailable();
        }
        if (wikipediaRevisionKey(priorJob) === sourceKey) {
          if (amount === undefined || !Number.isFinite(Number(amount)) || Number(amount) < 0) return unavailable();
          return {
            eligible: false,
            reason: SOURCE_ALREADY_PAID,
            message: "This wallet has already been paid for this source revision; a reissue is not new work.",
            sourceKey,
            paidJobId: session.jobId,
            paidSessionId: session.sessionId
          };
        }
      }
      if (sessions.length < PAGE_SIZE) return { eligible: true, sourceKey };
    }
    // Never turn a truncated or unavailable history into permission to pay twice.
    return unavailable();
  } catch {
    return unavailable();
  }
}

export async function requireUnpaidSourceClaim(options) {
  const decision = await assessPaidSourceClaim(options);
  if (!decision.eligible) throw new ConflictError(decision.message, decision.reason, decision);
}

function unavailable() {
  return {
    eligible: false,
    reason: HISTORY_UNAVAILABLE,
    message: "The source payment history could not be proved complete. Retry after it is available."
  };
}
