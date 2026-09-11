import { randomUUID } from "node:crypto";
import { ConfigError, ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { approvedSettlement } from "./retained-workers.js";

export const QUALITY_STATE_SCOPE = "quality-review-sampling-v1";
const LOCK = "quality-review";

export function loadQualityReviewConfig(env = process.env) {
  const sampleEvery = Number(env.QUALITY_SAMPLE_EVERY ?? 5);
  const reputationWeight = Number(env.QUALITY_REVIEW_REPUTATION_WEIGHT ?? 20);
  if (!Number.isSafeInteger(sampleEvery) || sampleEvery < 1 || sampleEvery > 10_000) {
    throw new ConfigError("QUALITY_SAMPLE_EVERY must be an integer from 1 to 10000.");
  }
  if (!Number.isSafeInteger(reputationWeight) || reputationWeight < 0 || reputationWeight > 1000) {
    throw new ConfigError("QUALITY_REVIEW_REPUTATION_WEIGHT must be an integer from 0 to 1000.");
  }
  if (![undefined, "", "false"].includes(env.QUALITY_REVIEW_ONCHAIN_ENABLED)) {
    throw new ConfigError("quality_reputation_aggregate_not_cumulative: QUALITY_REVIEW_ONCHAIN_ENABLED must remain false until ReputationSBT is cumulative.");
  }
  return { sampleEvery, reputationWeight, onchainEnabled: false };
}

export function receiptReview(session) {
  const review = session?.qualityReview;
  return review?.sampled === true ? {
    sampled: true,
    ...(Number.isInteger(session.qualityScore) ? {
      score: session.qualityScore, reviewedAt: review.reviewedAt,
      reliabilityAdjustment: review.reliabilityAdjustment,
      reputationWeight: review.reputationWeight,
      onchainApplied: false
    } : {})
  } : { sampled: false };
}

export function walletQualitySummary(sessions, wallet) {
  const reviewed = new Map();
  for (const session of sessions ?? []) {
    if (String(session?.wallet).toLowerCase() !== String(wallet).toLowerCase()) continue;
    if (!approvedSettlement(session) || session.qualityReview?.sampled !== true
      || !session.qualityReview?.reviewedAt || !Number.isInteger(session.qualityScore)
      || session.qualityScore < 0 || session.qualityScore > 5) continue;
    reviewed.set(session.sessionId, session);
  }
  const records = [...reviewed.values()];
  return {
    qualityAverage: records.length ? records.reduce((sum, session) => sum + session.qualityScore, 0) / records.length : null,
    qualityReviewCount: records.length,
    qualityReliabilityAdjustment: records.reduce((sum, session) => sum + session.qualityReview.reliabilityAdjustment, 0),
    qualitySource: "offchain_sampled_human_reviews",
    qualityOnchainApplied: false
  };
}

export class QualityReviewService {
  constructor({ stateStore, config = loadQualityReviewConfig(), now = () => new Date() }) {
    this.stateStore = stateStore;
    this.config = config;
    this.now = now;
    this.pending = Promise.resolve();
  }

  // Serialize locally, and use the shared store's owner-token lock across
  // processes. An unavailable lease refuses; it never guesses an ordinal.
  async withLock(action) {
    const previous = this.pending;
    let release;
    this.pending = new Promise((resolve) => { release = resolve; });
    await previous;
    const owner = randomUUID();
    try {
      if (!await this.stateStore.acquireClaimLock(LOCK, owner, 300)) {
        throw new ConflictError("Quality review is busy; retry.", "quality_review_busy");
      }
      try { return await action(); }
      finally { await this.stateStore.releaseClaimLock(LOCK, owner); }
    } finally { release(); }
  }

  async assign(session, job) {
    if (session.qualityReview?.ordinal) return session.qualityReview;
    if (!approvedSettlement(session) || job?.verifierMode !== "benchmark") return { sampled: false };
    return this.withLock(async () => {
      const state = await this.stateStore.getServiceState(QUALITY_STATE_SCOPE) ?? { assignments: {} };
      const existing = state.assignments[session.sessionId];
      if (existing) return existing;
      const ordinal = Object.keys(state.assignments).length + 1;
      // A durable bounded journal makes retries after a terminal-write failure
      // reuse their ordinal. It must never silently wrap or prune the counter.
      if (ordinal > 100_000) throw new ConflictError("Quality sampling journal requires archival migration.", "quality_sampling_capacity");
      const assignment = {
        sampled: ordinal % this.config.sampleEvery === 0,
        ordinal, sampleEvery: this.config.sampleEvery, assignedAt: this.now().toISOString()
      };
      await this.stateStore.upsertServiceState(QUALITY_STATE_SCOPE, {
        assignments: { ...state.assignments, [session.sessionId]: assignment }
      });
      return assignment;
    });
  }

  async listPending() {
    const state = await this.stateStore.getServiceState(QUALITY_STATE_SCOPE);
    const result = [];
    for (const [sessionId, assignment] of Object.entries(state?.assignments ?? {})) {
      if (!assignment.sampled) continue;
      const session = await this.stateStore.getSession(sessionId);
      if (!approvedSettlement(session) || session.qualityReview?.reviewedAt) continue;
      result.push({ sessionId, jobId: session.jobId, wallet: session.wallet,
        ordinal: assignment.ordinal, sampled: true, receiptId: session.workReceiptId ?? null });
    }
    return { config: this.config, pending: result };
  }

  async record({ sessionId, qualityScore, note, reviewer }, persistReceipt) {
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 256) throw new ValidationError("A sessionId is required.");
    if (!Number.isInteger(qualityScore) || qualityScore < 0 || qualityScore > 5) {
      throw new ValidationError("qualityScore must be an integer from 0 to 5.");
    }
    if (typeof note !== "string" || !note.trim() || note.length > 4000) throw new ValidationError("A review note of 1–4000 characters is required.");
    return this.withLock(async () => {
      const session = await this.stateStore.getSession(sessionId);
      if (!session) throw new NotFoundError("Quality review session not found.");
      if (!approvedSettlement(session) || session.qualityReview?.sampled !== true) {
        throw new ConflictError("Only sampled approved settlements can be reviewed.", "quality_review_not_sampled");
      }
      if (session.qualityReview.reviewedAt) {
        if (session.qualityScore === qualityScore && session.qualityReview.note === note.trim()
          && session.qualityReview.reviewer === reviewer) return session;
        throw new ConflictError("This sample already has a human review.", "quality_review_already_recorded");
      }
      const reviewed = { ...session, qualityScore, qualityReview: {
        ...session.qualityReview, note: note.trim(), reviewer,
        reviewedAt: this.now().toISOString(), reputationWeight: this.config.reputationWeight,
        reliabilityAdjustment: (qualityScore - 3) * this.config.reputationWeight,
        onchainApplied: false
      } };
      // Store an immutable new receipt before exposing the review. The original
      // receipt ID/chain commitment remain valid; no payout or SBT call occurs.
      const receipt = await persistReceipt(reviewed);
      reviewed.qualityReview.receiptId = receipt.receiptId;
      return this.stateStore.upsertSession(reviewed);
    });
  }
}
