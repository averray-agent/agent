import { randomUUID } from "node:crypto";
import { decodeBytes32String, encodeBytes32String } from "ethers";
import { ConflictError, ValidationError } from "../core/errors.js";
import { hashCanonicalContent } from "../core/canonical-content.js";
import { assertJobSnapshotIntegrity } from "../core/job-snapshot.js";
import { buildDisputeReasoningReceipt, buildDisputeResolution, DISPUTE_VERDICTS, disputeIdForSession } from "../core/dispute-resolution.js";
import { persistDisputeResolution } from "../core/dispute-convergence.js";

export function requireReviewRationale(rationale) {
  if (typeof rationale !== "string" || rationale.trim().length < 20) {
    throw new ValidationError("rationale must contain at least 20 characters.");
  }
  return rationale.trim();
}

export class DisputeArbitrationService {
  constructor({ stateStore, gateway, eventBus, persistContentRecord, publicBaseUrl }) {
    Object.assign(this, { stateStore, gateway, eventBus, persistContentRecord, publicBaseUrl });
  }

  async liveState(session) {
    const [live, authority] = await Promise.all([
      this.gateway.getJob(session.chainJobId ?? session.jobId), this.gateway.getArbitrationAuthority()
    ]);
    const remainingRaw = BigInt(live.rewardRaw) - BigInt(live.releasedRaw);
    const asset = this.gateway.assetForAddress(live.asset);
    return { ...authority, state: Number(live.state), escrow: live.escrowAddress,
      remainingPayout: this.gateway.toDisplayUnits(remainingRaw, asset),
      remainingPayoutRaw: remainingRaw.toString(), asset: asset.symbol,
      preparationId: (await this.stateStore.getMutationReceipt("dispute_preparation", disputeIdForSession(session.sessionId)))?.preparationId };
  }

  async prepare({ session, payload, auth }) {
    const rationale = requireReviewRationale(payload?.rationale);
    if (!DISPUTE_VERDICTS.includes(payload?.verdict)) throw new ValidationError("verdict must be one of DISPUTE_VERDICTS.");
    if (!this.gateway?.isEnabled?.()) throw new ConflictError("A live chain is required to prepare arbitration.", "arbitration_unavailable");
    const key = `dispute-prepare:${session.sessionId}`;
    const owner = randomUUID();
    const locked = await this.stateStore.acquireClaimLock?.(key, owner, 60);
    if (locked === false) throw new ConflictError("Arbitration preparation is in progress.", "arbitration_preparing");
    try {
      session = await this.stateStore.getSession(session.sessionId);
      if (session?.status !== "disputed") throw new ConflictError("The session is not disputed.", "arbitration_session_not_disputed");
      const { liveJob: live } = await assertJobSnapshotIntegrity(session, this.gateway);
      if (Number(live.state) !== 5) throw new ConflictError("Arbitration requires a Disputed escrow.", "arbitration_escrow_not_disputed", { state: Number(live.state) });
      const authority = await this.gateway.getArbitrationAuthority();
      const asset = this.gateway.assetForAddress(live.asset);
      const remainingRaw = BigInt(live.rewardRaw) - BigInt(live.releasedRaw);
      const remainingPayout = this.gateway.toDisplayUnits(remainingRaw, asset);
      if (payload.workerPayout !== undefined && this.gateway.toBaseUnits(payload.workerPayout, asset, "workerPayout") > remainingRaw) {
        throw new ValidationError("workerPayout exceeds reward minus released.");
      }
      const resolution = buildDisputeResolution({ verdict: payload.verdict, workerPayout: payload.workerPayout, remainingPayout });
      const workerPayoutRaw = this.gateway.toBaseUnits(resolution.workerPayout, asset, "workerPayout");
      if (workerPayoutRaw > remainingRaw) throw new ValidationError("workerPayout exceeds reward minus released.");
      const id = disputeIdForSession(session.sessionId);
      const inputHash = hashCanonicalContent({ verdict: resolution.verdict, rationale, workerPayoutRaw: workerPayoutRaw.toString(),
        remainingRaw: remainingRaw.toString(), operator: auth.wallet, ...authority, escrow: live.escrowAddress });
      const existing = await this.stateStore.getMutationReceipt("dispute_preparation", id);
      if (existing?.inputHash === inputHash) return existing;
      const preparedAt = new Date().toISOString();
      const reasoning = buildDisputeReasoningReceipt({ id, dispute: { sessionId: session.sessionId, claimant: session.wallet },
        payload: { rationale }, auth, verdict: resolution.verdict, decidedAt: preparedAt, publicBaseUrl: this.publicBaseUrl });
      if (!/^https?:\/\//u.test(reasoning.metadataURI)) throw new ConflictError("Public reasoning requires PUBLIC_BASE_URL.", "arbitration_public_content_unavailable");
      const transaction = await this.gateway.prepareResolveDispute(session.chainJobId ?? session.jobId,
        workerPayoutRaw.toString(), encodeBytes32String(resolution.reasonCode), reasoning.metadataURI);
      const prepared = { ...transaction, ...authority, decoded: { jobId: transaction.args[0], workerPayout: transaction.args[1],
        reasonCode: transaction.args[2], metadataURI: transaction.args[3] }, inputHash,
        preparationId: hashCanonicalContent({ inputHash, data: transaction.data }), preparedAt,
        verdict: resolution.verdict, workerPayout: resolution.workerPayout, remainingPayout,
        remainingPayoutRaw: remainingRaw.toString(), liveState: Number(live.state), asset: asset.symbol,
        rationale, reasoningHash: reasoning.reasoningHash, decidedBy: auth.wallet };
      // Even an upheld (failed) verdict must have publicly fetchable rationale
      // before signing; default failed-content privacy must not hide this URI.
      await this.persistContentRecord({ ...reasoning.contentRecord, publishedAt: preparedAt });
      await this.stateStore.upsertMutationReceipt("dispute_preparation", id, prepared);
      return prepared;
    } finally {
      if (locked) await this.stateStore.releaseClaimLock?.(key, owner);
    }
  }

  async converge(event) {
    const session = await this.stateStore.findSessionByChainJobId?.(event.data.chainJobId)
      ?? await this.stateStore.getSession(event.sessionId);
    if (!session || (session.status !== "disputed" && !session.disputeResolution)) return;
    const id = disputeIdForSession(session.sessionId);
    const live = await this.gateway.getJob(session.chainJobId ?? session.jobId);
    if (Number(live.state) !== 6) throw new ConflictError("Resolved event has no Closed escrow.", "arbitration_not_confirmed");
    if (event.data.escrowAddress?.toLowerCase() !== live.escrowAddress?.toLowerCase()) {
      throw new ConflictError("Resolved event belongs to a different escrow.", "arbitration_escrow_mismatch");
    }
    const prepared = await this.stateStore.getMutationReceipt("dispute_preparation", id);
    const raw = BigInt(event.data.workerPayout);
    const workerPayout = this.gateway.toDisplayUnits(raw, this.gateway.assetForAddress(live.asset));
    const remainingPayout = prepared?.remainingPayout ?? session.operatorOverturn?.remainingPayout ?? Number(live.reward);
    let reasonCode;
    try { reasonCode = decodeBytes32String(event.data.reasonCode); } catch { reasonCode = event.data.reasonCode; }
    const mismatch = prepared && prepared.decoded.workerPayout !== raw.toString()
      ? { code: "arbitration_prepared_payout_mismatch", expected: prepared.decoded.workerPayout, actual: raw.toString() } : undefined;
    const sameReasoning = prepared?.decoded.metadataURI === event.data.metadataURI;
    const verdict = raw === 0n ? "upheld" : workerPayout >= remainingPayout ? "dismissed" : "split";
    const receipt = await persistDisputeResolution({ stateStore: this.stateStore, session, receipt: {
      id, disputeId: id, sessionId: session.sessionId, jobId: session.jobId, chainJobId: session.chainJobId,
      verdict, workerPayout, workerPayoutRaw: raw.toString(), remainingPayout, reasonCode,
      metadataURI: event.data.metadataURI, reasoningHash: sameReasoning ? prepared.reasoningHash : undefined,
      rationale: sameReasoning ? prepared.rationale : undefined,
      releaseAction: raw > 0n ? "return-to-depositor" : "slash-to-treasury",
      txHash: event.txHash, blockNumber: event.blockNumber, chainStatus: "confirmed",
      decidedAt: event.timestamp, decidedBy: event.data.arbitrator, ...(mismatch ? { warning: mismatch } : {})
    } });
    if (mismatch) this.eventBus?.publish({ ...event, id: `${event.id}:payout-mismatch`,
      topic: "dispute.preparation_payout_mismatch", severity: "warn", sessionId: session.sessionId, data: { disputeId: id, ...mismatch } });
    return receipt;
  }
}
