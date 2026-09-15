import { randomUUID } from "node:crypto";
import { ConflictError } from "./errors.js";
import { transitionSession } from "./session-state-machine.js";

// Shared by the signed-event listener and manual receipt convergence. Write
// the receipt first so a retry repairs a failed session write without another
// transition or any second chain transaction.
export async function persistDisputeResolution({ stateStore, session, receipt }) {
  const key = `dispute-resolution:${session.sessionId}`;
  const owner = randomUUID();
  const locked = await stateStore.acquireClaimLock?.(key, owner, 60);
  if (locked === false) throw new ConflictError("Dispute convergence is in progress.", "dispute_convergence_busy");
  try {
    const current = await stateStore.getSession(session.sessionId) ?? session;
    const existing = await stateStore.getMutationReceipt("dispute_verdict", receipt.disputeId);
    // A confirmed chain receipt must never be replaced by a manual proposal.
    const final = existing?.chainStatus === "confirmed" && existing.txHash ? existing : receipt;
    if (current.operatorOverturn && final.chainStatus !== "confirmed") {
      throw new ConflictError("Overturn arbitration has not confirmed on chain.", "overturn_resolution_unconfirmed");
    }
    if (final !== existing) await stateStore.upsertMutationReceipt("dispute_verdict", receipt.disputeId, final);
    if (current.status === "disputed") {
      await stateStore.upsertSession(transitionSession({
        ...current,
        disputeResolution: final,
        ...(current.operatorOverturn ? { operatorOverturn: { ...current.operatorOverturn, resolution: final } } : {})
      }, Number(final.workerPayout) > 0 ? "resolved" : "rejected", {
        reason: final.reasonCode, timestamp: final.decidedAt,
        metadata: { disputeId: final.disputeId, verdict: final.verdict, workerPayout: final.workerPayout,
          reasonCode: final.reasonCode, txHash: final.txHash, ...(current.operatorOverturn ? { origin: "operator_overturn" } : {}) }
      }));
    } else if (final !== existing && current.disputeResolution) {
      // A manual already-Closed convergence can precede the event and lack
      // its tx hash. Enrich the receipt without another status transition.
      await stateStore.upsertSession({ ...current, disputeResolution: final,
        ...(current.operatorOverturn ? { operatorOverturn: { ...current.operatorOverturn, resolution: final } } : {}) });
    }
    return final;
  } finally {
    if (locked) await stateStore.releaseClaimLock?.(key, owner);
  }
}
