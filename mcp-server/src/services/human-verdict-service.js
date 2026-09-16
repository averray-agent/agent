import { randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors.js";
import { assertJobSnapshotIntegrity } from "../core/job-snapshot.js";
import { buildContentRecord } from "../core/content-addressed-store.js";
import { hashCanonicalContent } from "../core/canonical-content.js";
import { publicContentUri } from "../core/dispute-resolution.js";
import { requireReviewRationale } from "./dispute-arbitration-service.js";

export class HumanVerdictService {
  constructor({ stateStore, gateway, platformService, verifierService, persistContentRecord, publicBaseUrl }) {
    Object.assign(this, { stateStore, gateway, platformService, verifierService, persistContentRecord, publicBaseUrl });
  }

  async decide({ sessionId, verdict, rationale, operator }) {
    rationale = requireReviewRationale(rationale);
    if (!["approve", "reject"].includes(verdict)) throw new ValidationError("verdict must be approve or reject.");
    const key = `verifier-settlement:${sessionId}`;
    const owner = randomUUID();
    const locked = await this.stateStore.acquireClaimLock(key, owner, 300);
    if (!locked) throw new ConflictError("This session already has a decision in progress.", "verification_in_progress");
    try {
      let session = await this.stateStore.getSession(sessionId);
      if (!session) throw new NotFoundError("Unknown session.", "session_not_found");
      const inputHash = hashCanonicalContent({ sessionId, verdict, rationale, operator });
      let review = session.humanReview;
      if (review && review.inputHash !== inputHash) throw new ConflictError("A different human decision is already recorded.", "human_verdict_conflict");
      if (review?.resolution && ["resolved", "rejected"].includes(session.status)) return this.verifierService.getResult(sessionId);
      const original = review?.originalVerdict ?? await this.stateStore.getVerificationResult(sessionId);
      if (session.status !== "disputed" || original?.handler !== "human_fallback" || original?.outcome !== "disputed" || session.operatorOverturn || session.internalRemediation) {
        throw new ConflictError("Only a human_fallback-disputed session can receive a human verdict.", "human_verdict_not_eligible");
      }
      if (!this.gateway?.isEnabled?.()) throw new ConflictError("A live escrow is required.", "human_verdict_chain_required");
      const { job, liveJob } = await assertJobSnapshotIntegrity(session, this.gateway);
      const chainJobId = session.chainJobId ?? session.jobId;
      const approved = verdict === "approve";
      const finalState = approved ? 6 : 4;
      // A Disputed escrow belongs exclusively to the hardware arbitrator.
      // Only a durable retry of our own decision may reconcile Closed/Rejected.
      if (Number(liveJob.state) !== 3 && !(review && Number(liveJob.state) === finalState)) {
        throw new ConflictError("Human review requires a Submitted escrow; Disputed belongs to the arbitrator.", "human_verdict_escrow_not_submitted", { state: Number(liveJob.state) });
      }
      if (liveJob.worker?.toLowerCase() !== session.wallet.toLowerCase()) throw new ConflictError("Escrow worker mismatch.", "human_verdict_worker_mismatch");
      if (!review) {
        const decidedAt = new Date().toISOString();
        const content = buildContentRecord({ payload: { sessionId, verdict, rationale, decidedBy: operator, decidedAt },
          contentType: "verifier_reasoning", ownerWallet: session.wallet, verdict: approved ? "pass" : "fail", createdAt: decidedAt, publishedAt: decidedAt });
        const metadataURI = publicContentUri(content.hash, { publicBaseUrl: this.publicBaseUrl });
        if (!/^https?:\/\//u.test(metadataURI)) throw new ConflictError("Public reasoning requires PUBLIC_BASE_URL.", "human_verdict_content_unavailable");
        await this.persistContentRecord(content);
        review = { inputHash, verdict, outcome: approved ? "approved" : "rejected", rationale, rationaleHash: content.hash,
          metadataURI, decidedBy: operator, decidedAt, originalVerdict: original,
          reasonCode: approved ? "HUMAN_REVIEW_APPROVED" : "HUMAN_REVIEW_REJECTED",
          previousProgression: await this.platformService.getWorkerProgressionSafely?.(session.wallet) };
        session = { ...session, humanReview: review };
        await this.stateStore.upsertSession(session);
      }
      const decision = { handler: "human_review", handlerVersion: 1, outcome: review.outcome, reasonCode: review.reasonCode,
        verifier: operator, decidedBy: operator, rationaleHash: review.rationaleHash, reasoningHash: review.rationaleHash,
        originalVerdict: original, details: { decidingWallet: operator, rationale, rationaleHash: review.rationaleHash } };
      const prepared = await this.verifierService.prepareNonDisputeSettlement({ session, job, verdict: decision,
        verificationInput: session.submission, metadataURI: review.metadataURI });
      let payoutTx = review.resolution?.payoutTx;
      if (!payoutTx && Number(liveJob.state) === 3) {
        payoutTx = await this.gateway.resolveSinglePayout(chainJobId, approved, review.reasonCode, review.metadataURI, prepared.commitment);
      } else if (!payoutTx) {
        payoutTx = await this.gateway.recoverSinglePayoutReceipt(chainJobId, { outcome: review.outcome,
          worker: session.wallet, submittedAt: session.submittedAt, reasoningHash: prepared.commitment });
      }
      this.verifierService.assertTerminalChainEvidence({ chainJobId, verdict: decision, payoutTx, commitment: prepared.commitment });
      const live = await this.gateway.getJob(chainJobId);
      if (Number(live.state) !== finalState) throw new ConflictError("Human verdict is not confirmed in escrow.", "human_verdict_unconfirmed");
      review = { ...review, resolution: { outcome: review.outcome, workerPayout: Number(payoutTx.settlement?.workerAmount ?? 0),
        chainStatus: "confirmed", txHash: payoutTx.txHash, payoutTx, decidedBy: operator, decidedAt: review.decidedAt, rationaleHash: review.rationaleHash } };
      await this.stateStore.upsertSession({ ...await this.stateStore.getSession(sessionId), humanReview: review });
      return this.verifierService.ingestBrokeredDecision({ sessionId, ...decision, metadataURI: review.metadataURI, payoutTx,
        previousProgression: review.previousProgression, preparedVerdict: prepared.preparedVerdict, receiptContext: prepared.receiptContext });
    } finally {
      await this.stateStore.releaseClaimLock(key, owner);
    }
  }
}
