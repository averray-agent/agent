import { randomUUID } from "node:crypto";

import { getAddress, isAddress } from "ethers";

import { hashCanonicalContent } from "./canonical-content.js";
import {
  AuthorizationError,
  ChainBackendRequiredError,
  ConflictError,
  NotFoundError,
  ValidationError
} from "./errors.js";
import { assertJobSnapshotIntegrity, requireJobSnapshot } from "./job-snapshot.js";

export const POSTER_REVIEW_REJECT_REASON_MIN_LENGTH = 10;
export const POSTER_REVIEW_REASON_CODES = Object.freeze({
  approve: "POSTER_APPROVED",
  reject: "POSTER_REJECTED",
  escalated: "POSTER_REVIEW_TIMEOUT"
});

const REVIEW_RECEIPT_BUCKET = "external_poster_review";
const REVIEW_LOCK_TTL_SECONDS = 5 * 60;
const ESCROW_JOB_STATE_SUBMITTED = 3;
const ESCROW_JOB_STATE_REJECTED = 4;
const ESCROW_JOB_STATE_DISPUTED = 5;
const ESCROW_JOB_STATE_CLOSED = 6;

export class PosterReviewService {
  constructor({
    platformService,
    stateStore,
    gateway,
    verifierService,
    eventBus = undefined,
    config,
    now = () => new Date(),
    logger = console
  } = {}) {
    if (!platformService || !stateStore || !gateway || !verifierService || !config) {
      throw new Error(
        "PosterReviewService requires platformService, stateStore, gateway, verifierService, and config."
      );
    }
    this.platformService = platformService;
    this.stateStore = stateStore;
    this.gateway = gateway;
    this.verifierService = verifierService;
    this.eventBus = eventBus;
    this.config = config;
    this.now = now;
    this.logger = logger;
  }

  get reviewWindowSeconds() {
    return Number(this.config.reviewWindowHours) * 60 * 60;
  }

  async getSubmissionForReview(jobIdInput, { wallet, isAdmin = false } = {}) {
    const context = await this.loadReviewContext(jobIdInput, {
      wallet,
      isAdmin,
      concealUnauthorized: true
    });
    this.assertAwaitingPosterDecision(context);
    const receipt = await this.getDecisionReceipt(context.submissionIdentity);
    if (receipt?.decision === "escalated") {
      throw this.disputeOwnsReviewError(context, receipt);
    }
    return {
      jobId: context.job.id,
      chainJobId: context.chainJobId,
      sessionId: context.session.sessionId,
      submissionIdentity: context.submissionIdentity,
      submittedAt: context.session.submittedAt,
      worker: context.liveJob.worker,
      deliverable: context.session.submission,
      review: {
        status: receipt?.status ?? "awaiting_decision",
        deadline: context.reviewDeadline,
        windowSeconds: this.reviewWindowSeconds,
        ...(receipt ? { decision: receipt.decision, receipt } : {})
      }
    };
  }

  async reviewSubmission(jobIdInput, {
    wallet,
    isAdmin = false,
    verdict,
    reason = ""
  } = {}) {
    const normalized = normalizePosterReviewDecision({ verdict, reason });
    const initial = await this.loadReviewContext(jobIdInput, { wallet, isAdmin });
    const existing = await this.getDecisionReceipt(initial.submissionIdentity);
    const replay = this.replayManualDecision(existing, initial, normalized.verdict);
    if (replay) return replay;

    return this.withDecisionLock(initial.submissionIdentity, async () => {
      const context = await this.loadReviewContext(jobIdInput, { wallet, isAdmin });
      const lockedExisting = await this.getDecisionReceipt(context.submissionIdentity);
      const lockedReplay = this.replayManualDecision(
        lockedExisting,
        context,
        normalized.verdict
      );
      if (lockedReplay) return lockedReplay;

      // The durable decision is written before any broker action. This is the
      // race winner for review-vs-review and review-vs-escalation; retries may
      // resume the SAME decision, but no later caller may replace it.
      let receipt = lockedExisting;
      if (!receipt) {
        this.assertAwaitingPosterDecision(context);
        receipt = this.buildRecordedReceipt(context, {
          decision: normalized.verdict,
          decidedBy: normalizeWallet(wallet),
          authority: isAdmin ? "admin" : "poster",
          reason: normalized.reason
        });
        await this.storeDecisionReceipt(context.submissionIdentity, receipt);
      }

      receipt = await this.executeManualDecision(context, receipt);
      await this.storeDecisionReceipt(context.submissionIdentity, receipt);
      this.publishDecisionEvent(context, receipt);
      return receipt;
    });
  }

  async escalateExpiredSubmission(jobIdInput, { now = this.currentTime() } = {}) {
    const initial = await this.loadReviewContext(jobIdInput, {
      systemEscalation: true
    });
    const existing = await this.getDecisionReceipt(initial.submissionIdentity);
    if (existing && (
      existing.decision !== "escalated"
      || existing.status === "escalated"
    )) {
      return { ...existing, replayed: true };
    }
    if (now.getTime() < Date.parse(initial.reviewDeadline)) {
      throw new ConflictError(
        `Poster review window is still active for ${initial.job.id}.`,
        "poster_review_window_active",
        {
          jobId: initial.job.id,
          submittedAt: initial.session.submittedAt,
          reviewDeadline: initial.reviewDeadline,
          reviewWindowSeconds: this.reviewWindowSeconds
        }
      );
    }

    return this.withDecisionLock(initial.submissionIdentity, async () => {
      const context = await this.loadReviewContext(jobIdInput, {
        systemEscalation: true
      });
      const lockedExisting = await this.getDecisionReceipt(context.submissionIdentity);
      if (lockedExisting && (
        lockedExisting.decision !== "escalated"
        || lockedExisting.status === "escalated"
      )) {
        return { ...lockedExisting, replayed: true };
      }
      let receipt = lockedExisting;
      if (!receipt) {
        this.assertAwaitingPosterDecision(context);
        receipt = this.buildRecordedReceipt(context, {
          decision: "escalated",
          decidedBy: "system:poster-review-timeout",
          authority: "system_escalation",
          reason: "Poster review window expired without a decision."
        });
        await this.storeDecisionReceipt(context.submissionIdentity, receipt);
      }

      receipt = await this.executeEscalation(context, receipt);
      await this.storeDecisionReceipt(context.submissionIdentity, receipt);
      this.publishDecisionEvent(context, receipt);
      return receipt;
    });
  }

  async executeManualDecision(context, recordedReceipt) {
    // Re-read immediately before the money-path call. If claim timeout/reopen,
    // another decision, or a dispute advanced the job, the chain wins.
    let live = await this.requireLiveJob(context.chainJobId);
    this.assertStaticBindings(context, live);
    const approved = recordedReceipt.decision === "approve";
    const expectedFinalState = approved
      ? ESCROW_JOB_STATE_CLOSED
      : ESCROW_JOB_STATE_REJECTED;
    const protocolFeeConfig = approved
      ? await this.gateway.getProtocolFeeConfig()
      : undefined;
    let payoutTx = recordedReceipt.payoutTx;

    // Persist the pre-settlement progression beside the durable decision
    // before the broker mutates chain state. A retry after a receipt-write
    // interruption can then narrate the same threshold change without
    // re-settling or mistaking the post-settlement tier for the old tier.
    if (!recordedReceipt.previousProgression && Number(live.state) === ESCROW_JOB_STATE_SUBMITTED) {
      const previousProgression = await this.platformService.getWorkerProgressionSafely?.(
        context.session.wallet
      );
      if (previousProgression) {
        recordedReceipt = { ...recordedReceipt, previousProgression };
        await this.storeDecisionReceipt(context.submissionIdentity, recordedReceipt);
      }
    }

    if (Number(live.state) === ESCROW_JOB_STATE_SUBMITTED) {
      payoutTx = await this.gateway.resolveSinglePayout(
        context.chainJobId,
        approved,
        recordedReceipt.reasonCode,
        recordedReceipt.metadataURI,
        recordedReceipt.rationaleHash
      );
      const chainConfirmed = {
        ...recordedReceipt,
        status: "chain_confirmed",
        payoutTx
      };
      await this.storeDecisionReceipt(context.submissionIdentity, chainConfirmed);
      recordedReceipt = chainConfirmed;
      live = await this.requireLiveJob(context.chainJobId);
    } else if (Number(live.state) === expectedFinalState) {
      this.assertRecordedChainConfirmation(context, recordedReceipt, { approved });
    }

    if (Number(live.state) !== expectedFinalState) {
      throw this.stateChangedError(context, live, recordedReceipt.decision);
    }

    const decision = {
      outcome: approved ? "approved" : "rejected",
      reasonCode: recordedReceipt.reasonCode,
      rationaleHash: recordedReceipt.rationaleHash,
      metadataURI: recordedReceipt.metadataURI,
      payoutTx,
      previousProgression: recordedReceipt.previousProgression,
      decidedBy: recordedReceipt.decidedBy,
      authority: recordedReceipt.authority,
      recordedDecision: recordedReceipt.decision
    };

    if (approved) {
      const settlement = payoutTx?.settlement;
      this.assertSettlementBoundToEscrow(
        context,
        live,
        settlement,
        protocolFeeConfig?.treasuryAccount,
        recordedReceipt
      );
      const result = await this.convergeLocalDecision(context, decision);
      return {
        ...recordedReceipt,
        status: "settled",
        payoutTx: payoutTx ?? result?.payoutTx,
        settlement,
        completedAt: this.currentTime().toISOString()
      };
    }

    const result = await this.convergeLocalDecision(context, decision);
    const disputeWindowSeconds = await this.gateway.getDisputeWindowSeconds();
    const rejectedAt = Number(live.rejectedAt ?? 0);
    if (!Number.isInteger(rejectedAt) || rejectedAt <= 0) {
      throw new ConflictError(
        "Rejected escrow is missing its on-chain rejection timestamp.",
        "poster_review_rejection_timestamp_missing",
        { jobId: context.job.id, chainJobId: context.chainJobId }
      );
    }
    return {
      ...recordedReceipt,
      status: "rejected",
      payoutTx: payoutTx ?? result?.payoutTx,
      disputeWindow: {
        rejectedAt: new Date(rejectedAt * 1000).toISOString(),
        seconds: disputeWindowSeconds,
        endsAt: new Date((rejectedAt + disputeWindowSeconds) * 1000).toISOString()
      },
      completedAt: this.currentTime().toISOString()
    };
  }

  async executeEscalation(context, recordedReceipt) {
    // This intentionally does NOT call requireArbitratorSigner. Opening a
    // dispute is safe under out_of_band_hardware because the contract has a
    // permissionless timeout terminal. Verdict recording remains fail-closed
    // in dispute-routes.js.
    let live = await this.requireLiveJob(context.chainJobId);
    this.assertStaticBindings(context, live);
    let rejectionTx = recordedReceipt.rejectionTx;
    let disputeTx = recordedReceipt.disputeTx;

    if (Number(live.state) === ESCROW_JOB_STATE_SUBMITTED) {
      rejectionTx = await this.gateway.resolveSinglePayout(
        context.chainJobId,
        false,
        recordedReceipt.reasonCode,
        recordedReceipt.metadataURI,
        recordedReceipt.rationaleHash
      );
      recordedReceipt = {
        ...recordedReceipt,
        status: "rejection_confirmed",
        rejectionTx
      };
      await this.storeDecisionReceipt(context.submissionIdentity, recordedReceipt);
      live = await this.requireLiveJob(context.chainJobId);
    }

    if (Number(live.state) === ESCROW_JOB_STATE_REJECTED) {
      disputeTx = await this.gateway.openDispute(context.chainJobId, context.liveJob.worker);
      recordedReceipt = {
        ...recordedReceipt,
        status: "dispute_opened",
        rejectionTx,
        disputeTx
      };
      await this.storeDecisionReceipt(context.submissionIdentity, recordedReceipt);
      live = await this.requireLiveJob(context.chainJobId);
    }

    if (Number(live.state) !== ESCROW_JOB_STATE_DISPUTED) {
      throw this.stateChangedError(context, live, "escalated");
    }

    await this.convergeLocalDecision(context, {
      outcome: "disputed",
      reasonCode: recordedReceipt.reasonCode,
      rationaleHash: recordedReceipt.rationaleHash,
      metadataURI: recordedReceipt.metadataURI,
      payoutTx: rejectionTx,
      decidedBy: recordedReceipt.decidedBy,
      authority: recordedReceipt.authority,
      recordedDecision: recordedReceipt.decision
    });
    return {
      ...recordedReceipt,
      status: "escalated",
      rejectionTx,
      disputeTx,
      escalatedAt: this.currentTime().toISOString(),
      disputeOwnsDecision: true
    };
  }

  async convergeLocalDecision(context, decision) {
    const current = await this.platformService.resumeSession(context.session.sessionId);
    const expectedStatus = decision.outcome === "approved"
      ? "resolved"
      : decision.outcome === "rejected"
        ? "rejected"
        : "disputed";
    if (current.status === expectedStatus) {
      return this.stateStore.getVerificationResult?.(current.sessionId);
    }
    if (current.status !== "submitted") {
      throw new ConflictError(
        `Submission session advanced to ${current.status}; poster review cannot overwrite it.`,
        "poster_review_session_state_changed",
        {
          jobId: context.job.id,
          sessionId: current.sessionId,
          currentStatus: current.status,
          expectedStatus
        }
      );
    }
    return this.verifierService.ingestBrokeredDecision({
      sessionId: current.sessionId,
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      metadataURI: decision.metadataURI,
      reasoningHash: decision.rationaleHash,
      payoutTx: decision.payoutTx,
      previousProgression: decision.previousProgression,
      details: {
        authority: decision.authority ?? "external_poster_review",
        submissionIdentity: context.submissionIdentity,
        decision: decision.recordedDecision,
        decidingWallet: decision.decidedBy,
        rationaleHash: decision.rationaleHash
      }
    });
  }

  async loadReviewContext(jobIdInput, {
    wallet = undefined,
    isAdmin = false,
    concealUnauthorized = false,
    systemEscalation = false
  } = {}) {
    const jobId = String(jobIdInput ?? "").trim();
    if (!jobId) throw new ValidationError("job id path segment is required.");
    if (!this.gateway?.isEnabled?.() || typeof this.gateway.getJob !== "function") {
      throw new ChainBackendRequiredError("poster_review_requires_live_escrow");
    }

    const sessions = await this.stateStore.listSessionsByJob?.(jobId, 100) ?? [];
    const current = await this.stateStore.findSessionByJobId?.(jobId);
    if (current && !sessions.some((session) => session.sessionId === current.sessionId)) {
      sessions.unshift(current);
    }
    const submissions = sessions.filter((session) => session?.submission !== undefined);
    if (submissions.length !== 1) {
      throw new ConflictError(
        `External job ${jobId} must have exactly one recorded submission before review.`,
        "poster_review_submission_cardinality",
        { jobId, submissionCount: submissions.length }
      );
    }
    const session = submissions[0];
    const { job } = requireJobSnapshot(session);
    if (!isExternalJob(job)) {
      if (concealUnauthorized) throw this.notFound(jobId);
      throw new AuthorizationError(
        "Poster review authority applies only to external-source jobs.",
        "poster_review_external_job_required"
      );
    }
    const chainJobId = session.chainJobId ?? job.id;
    const liveJob = await this.requireLiveJob(chainJobId);
    await assertJobSnapshotIntegrity(session, this.gateway, { liveJob });
    const catalogPoster = normalizeOptionalWallet(job.poster?.wallet ?? job.source?.poster?.wallet);
    const chainPoster = normalizeOptionalWallet(liveJob.poster);
    if (!catalogPoster || !chainPoster || catalogPoster !== chainPoster) {
      throw new ConflictError(
        "External catalog poster does not match the live escrow poster.",
        "poster_review_poster_binding_mismatch",
        { jobId: job.id, catalogPoster, chainPoster }
      );
    }
    if (!systemEscalation && !isAdmin && normalizeWallet(wallet) !== chainPoster) {
      if (concealUnauthorized) throw this.notFound(job.id);
      throw new AuthorizationError(
        "Authenticated wallet is not the recorded on-chain poster for this job.",
        "poster_review_not_job_poster"
      );
    }
    this.assertStaticBindings({ job, session, chainJobId, liveJob }, liveJob);
    const submittedAtMs = Date.parse(session.submittedAt);
    if (!Number.isFinite(submittedAtMs)) {
      throw new ConflictError(
        "Submission is missing a durable submitted-at timestamp.",
        "poster_review_submitted_at_missing",
        { jobId: job.id, sessionId: session.sessionId }
      );
    }
    const submissionIdentity = hashCanonicalContent({
      domain: "averray.external-poster-review.submission.v1",
      jobId: job.id,
      sessionId: session.sessionId,
      submittedAt: session.submittedAt,
      worker: normalizeWallet(session.wallet),
      submission: session.submission
    });
    return {
      job,
      session,
      chainJobId,
      liveJob,
      submissionIdentity,
      reviewDeadline: new Date(
        submittedAtMs + (this.reviewWindowSeconds * 1000)
      ).toISOString()
    };
  }

  assertAwaitingPosterDecision(context) {
    if (
      context.session.status !== "submitted"
      || Number(context.liveJob.state) !== ESCROW_JOB_STATE_SUBMITTED
    ) {
      throw this.stateChangedError(context, context.liveJob, "decide");
    }
  }

  assertStaticBindings(context, live) {
    const expectedEscrow = normalizeOptionalWallet(this.config.escrowCoreAddress);
    const actualEscrow = normalizeOptionalWallet(live?.escrowAddress);
    if (expectedEscrow && actualEscrow && expectedEscrow !== actualEscrow) {
      throw new ConflictError(
        "Live job is not served by the configured EscrowCore.",
        "poster_review_escrow_binding_mismatch",
        { expectedEscrow, actualEscrow, chainJobId: context.chainJobId }
      );
    }
    const sessionWorker = normalizeOptionalWallet(context.session?.wallet);
    const chainWorker = normalizeOptionalWallet(live?.worker);
    if (!sessionWorker || !chainWorker || sessionWorker !== chainWorker) {
      throw new ConflictError(
        "Recorded submitter does not match the live escrow worker.",
        "poster_review_worker_binding_mismatch",
        { sessionWorker, chainWorker, chainJobId: context.chainJobId }
      );
    }
    for (const [field, value] of [
      ["rewardRaw", live?.rewardRaw],
      ["releasedRaw", live?.releasedRaw],
      ["protocolFeeRaw", live?.protocolFeeRaw],
      ["protocolFeeReleasedRaw", live?.protocolFeeReleasedRaw]
    ]) {
      if (!/^\d+$/u.test(String(value ?? ""))) {
        throw new ConflictError(
          `Live escrow is missing exact ${field} economics.`,
          "poster_review_economics_binding_missing",
          { field, chainJobId: context.chainJobId }
        );
      }
    }
    if (!normalizeOptionalWallet(live?.asset)) {
      throw new ConflictError(
        "Live escrow is missing its exact settlement asset.",
        "poster_review_economics_binding_missing",
        { field: "asset", chainJobId: context.chainJobId }
      );
    }
    if (!Number.isInteger(Number(live?.protocolFeeBps)) || Number(live.protocolFeeBps) < 0) {
      throw new ConflictError(
        "Live escrow is missing its snapshotted protocol fee bps.",
        "poster_review_economics_binding_missing",
        { field: "protocolFeeBps", chainJobId: context.chainJobId }
      );
    }
    if (live?.protocolFeeWaived !== false) {
      throw new ConflictError(
        "External poster review requires the non-waived protocol-fee path.",
        "poster_review_fee_snapshot_invalid",
        { protocolFeeWaived: live?.protocolFeeWaived, chainJobId: context.chainJobId }
      );
    }
  }

  assertRecordedChainConfirmation(context, recordedReceipt, { approved }) {
    const payoutTx = recordedReceipt?.payoutTx;
    const confirmed = recordedReceipt?.status === "chain_confirmed"
      && typeof payoutTx?.txHash === "string"
      && payoutTx.txHash.trim().length > 0
      && Number.isInteger(Number(payoutTx?.blockNumber))
      && Number(payoutTx.blockNumber) > 0
      && Number(payoutTx?.status) === 1
      && (!approved || payoutTx?.settlement);
    if (!confirmed) {
      throw new ConflictError(
        "Live escrow is already final, but this review has no durable proof that its broker action landed.",
        "poster_review_foreign_final_state",
        {
          jobId: context.job.id,
          chainJobId: context.chainJobId,
          decision: recordedReceipt?.decision,
          receiptStatus: recordedReceipt?.status,
          liveState: approved ? ESCROW_JOB_STATE_CLOSED : ESCROW_JOB_STATE_REJECTED
        }
      );
    }
  }

  assertSettlementBoundToEscrow(context, live, settlement, treasuryAccount, recordedReceipt) {
    if (!settlement) {
      throw new ConflictError(
        "Approved poster review did not return a SettlementSplit receipt.",
        "poster_review_settlement_split_missing",
        { jobId: context.job.id, chainJobId: context.chainJobId }
      );
    }
    // A retry after the broker transaction landed sees an already-Closed live
    // job, whose released counters equal the full payout. Bind the receipt to
    // the durable pre-action snapshot rather than recomputing an expected zero.
    const snapshot = recordedReceipt?.escrowSnapshot ?? {};
    const rewardRaw = snapshot.rewardRaw ?? context.liveJob.rewardRaw;
    const releasedRaw = snapshot.releasedRaw ?? context.liveJob.releasedRaw;
    const protocolFeeRaw = snapshot.protocolFeeRaw ?? context.liveJob.protocolFeeRaw;
    const protocolFeeReleasedRaw = snapshot.protocolFeeReleasedRaw
      ?? context.liveJob.protocolFeeReleasedRaw;
    const expectedFeeRaw = (BigInt(protocolFeeRaw) - BigInt(protocolFeeReleasedRaw)).toString();
    const checks = {
      worker: [normalizeOptionalWallet(settlement.worker), normalizeOptionalWallet(recordedReceipt?.worker ?? context.liveJob.worker)],
      treasuryAccount: [normalizeOptionalWallet(settlement.treasuryAccount), normalizeOptionalWallet(treasuryAccount)],
      asset: [normalizeOptionalWallet(settlement.asset), normalizeOptionalWallet(snapshot.asset ?? context.liveJob.asset)],
      workerAmountRaw: [
        String(settlement.workerAmountRaw),
        (BigInt(rewardRaw) - BigInt(releasedRaw)).toString()
      ],
      protocolFeeAmountRaw: [String(settlement.protocolFeeAmountRaw), expectedFeeRaw],
      protocolFeeBps: [Number(settlement.protocolFeeBps), Number(snapshot.protocolFeeBps ?? context.liveJob.protocolFeeBps)]
    };
    for (const [field, [actual, expected]] of Object.entries(checks)) {
      if (actual !== expected) {
        throw new ConflictError(
          `SettlementSplit ${field} does not match the live escrow.`,
          "poster_review_settlement_binding_mismatch",
          { field, actual, expected, jobId: context.job.id }
        );
      }
    }
    if (Number(live.state) !== ESCROW_JOB_STATE_CLOSED) {
      throw this.stateChangedError(context, live, "approve");
    }
  }

  buildRecordedReceipt(context, { decision, decidedBy, authority, reason }) {
    const decidedAt = this.currentTime().toISOString();
    const rationaleHash = hashCanonicalContent({
      domain: "averray.external-poster-review.rationale.v1",
      decision,
      reason
    });
    return {
      receiptVersion: "external-poster-review-v1",
      jobId: context.job.id,
      chainJobId: context.chainJobId,
      sessionId: context.session.sessionId,
      submissionIdentity: context.submissionIdentity,
      decision,
      decidedBy,
      authority,
      rationaleHash,
      reasonCode: POSTER_REVIEW_REASON_CODES[decision],
      metadataURI: `urn:averray:poster-review:${context.submissionIdentity}`,
      decidedAt,
      submittedAt: context.session.submittedAt,
      reviewDeadline: context.reviewDeadline,
      reviewWindowSeconds: this.reviewWindowSeconds,
      worker: context.liveJob.worker,
      poster: context.liveJob.poster,
      escrowSnapshot: {
        escrowCore: context.liveJob.escrowAddress ?? this.config.escrowCoreAddress,
        state: Number(context.liveJob.state),
        rewardRaw: String(context.liveJob.rewardRaw),
        releasedRaw: String(context.liveJob.releasedRaw),
        protocolFeeRaw: String(context.liveJob.protocolFeeRaw),
        protocolFeeReleasedRaw: String(context.liveJob.protocolFeeReleasedRaw),
        asset: context.liveJob.asset,
        protocolFeeBps: Number(context.liveJob.protocolFeeBps)
      },
      status: "recorded"
    };
  }

  replayManualDecision(existing, context, attemptedDecision) {
    if (!existing) return undefined;
    if (existing.decision === "escalated") {
      throw this.disputeOwnsReviewError(context, existing);
    }
    if (
      existing.decision === attemptedDecision
      && existing.status !== "settled"
      && existing.status !== "rejected"
    ) {
      return undefined;
    }
    return { ...existing, replayed: true };
  }

  disputeOwnsReviewError(context, receipt) {
    return new ConflictError(
      "Poster review is closed because timeout escalation opened the dispute path.",
      "poster_review_owned_by_dispute",
      {
        jobId: context.job.id,
        sessionId: context.session.sessionId,
        submissionIdentity: context.submissionIdentity,
        decision: receipt.decision,
        status: receipt.status
      }
    );
  }

  stateChangedError(context, live, attemptedDecision) {
    return new ConflictError(
      `Live escrow state ${Number(live?.state)} is not reviewable from Submitted(3).`,
      "poster_review_state_changed",
      {
        jobId: context.job.id,
        chainJobId: context.chainJobId,
        sessionId: context.session.sessionId,
        sessionStatus: context.session.status,
        liveState: Number(live?.state),
        attemptedDecision
      }
    );
  }

  async withDecisionLock(submissionIdentity, operation) {
    const lockId = `poster-review:${submissionIdentity}`;
    const owner = randomUUID();
    const acquired = await this.stateStore.acquireClaimLock?.(
      lockId,
      owner,
      REVIEW_LOCK_TTL_SECONDS
    );
    if (acquired === false) {
      const existing = await this.getDecisionReceipt(submissionIdentity);
      if (existing) return { ...existing, replayed: true };
      throw new ConflictError(
        "Poster review decision is already in progress.",
        "poster_review_in_progress",
        { submissionIdentity }
      );
    }
    try {
      return await operation();
    } finally {
      await this.stateStore.releaseClaimLock?.(lockId, owner);
    }
  }

  async requireLiveJob(chainJobId) {
    return this.gateway.getJob(chainJobId);
  }

  getDecisionReceipt(submissionIdentity) {
    return this.stateStore.getMutationReceipt?.(REVIEW_RECEIPT_BUCKET, submissionIdentity);
  }

  storeDecisionReceipt(submissionIdentity, receipt) {
    return this.stateStore.upsertMutationReceipt?.(
      REVIEW_RECEIPT_BUCKET,
      submissionIdentity,
      receipt
    );
  }

  publishDecisionEvent(context, receipt) {
    this.eventBus?.publish?.({
      id: `poster-review-${context.submissionIdentity}-${Date.now()}`,
      topic: receipt.decision === "escalated"
        ? "external_posting.review_escalated"
        : "external_posting.review_decided",
      wallet: context.liveJob.poster,
      wallets: [context.liveJob.poster, context.liveJob.worker],
      jobId: context.job.id,
      sessionId: context.session.sessionId,
      timestamp: receipt.completedAt ?? receipt.escalatedAt ?? receipt.decidedAt,
      correlationId: context.submissionIdentity,
      txHash: receipt.payoutTx?.txHash ?? receipt.disputeTx?.txHash,
      blockNumber: receipt.payoutTx?.blockNumber ?? receipt.disputeTx?.blockNumber,
      source: "settlement",
      phase: receipt.decision === "escalated" ? "dispute" : "review",
      severity: receipt.decision === "reject" ? "warn" : "info",
      data: receipt
    });
  }

  currentTime() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error("PosterReviewService clock is invalid.");
    return date;
  }

  notFound(jobId) {
    return new NotFoundError(
      "Job submission not found.",
      "external_job_submission_not_found",
      { jobId }
    );
  }
}

export function normalizePosterReviewDecision(payload = {}) {
  const verdict = String(payload?.verdict ?? "").trim().toLowerCase();
  if (verdict !== "approve" && verdict !== "reject") {
    throw new ValidationError('verdict must be either "approve" or "reject".');
  }
  const reason = String(payload?.reason ?? "").trim();
  if (verdict === "reject" && reason.length < POSTER_REVIEW_REJECT_REASON_MIN_LENGTH) {
    throw new ValidationError(
      `reason must be at least ${POSTER_REVIEW_REJECT_REASON_MIN_LENGTH} characters when rejecting.`,
      { minimumLength: POSTER_REVIEW_REJECT_REASON_MIN_LENGTH }
    );
  }
  return { verdict, reason };
}

function isExternalJob(job) {
  return job?.source === "external" || job?.source?.type === "external";
}

function normalizeOptionalWallet(value) {
  if (!isAddress(String(value ?? ""))) return undefined;
  return getAddress(String(value)).toLowerCase();
}

function normalizeWallet(value) {
  const wallet = normalizeOptionalWallet(value);
  if (!wallet) throw new ValidationError("Authenticated wallet must be an EVM address.");
  return wallet;
}
