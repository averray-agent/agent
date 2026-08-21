import { randomUUID } from "node:crypto";

import { buildContentRecord } from "../core/content-addressed-store.js";
import { publicContentUri } from "../core/dispute-resolution.js";
import { ConfigError, ConflictError, ExternalServiceError } from "../core/errors.js";
import {
  PLATFORM_FAULT_REMEDIATION_KIND,
  PLATFORM_FAULT_REMEDIATION_ORIGIN,
  PLATFORM_FAULT_REMEDIATION_PENDING,
  PLATFORM_FAULT_REMEDIATION_REASON_CODE,
  platformFaultRemediationIdForSession,
} from "../core/platform-fault-remediation.js";

const ESCROW_JOB_STATE_SUBMITTED = 3;
const ESCROW_JOB_STATE_CLAIMED = 2;
const ESCROW_JOB_STATE_REJECTED = 4;
const ESCROW_JOB_STATE_DISPUTED = 5;
const ESCROW_JOB_STATE_CLOSED = 6;
const REMEDIATION_LOCK_TTL_SECONDS = 300;

export class PlatformFaultRemediationService {
  constructor({
    stateStore,
    gateway,
    eventBus,
    logger = console,
    publicBaseUrl = process.env.PUBLIC_BASE_URL,
    now = () => new Date(),
  } = {}) {
    this.stateStore = stateStore;
    this.gateway = gateway;
    this.eventBus = eventBus;
    this.logger = logger;
    this.publicBaseUrl = publicBaseUrl;
    this.now = now;
  }

  isEnabled() {
    return this.gateway?.isEnabled?.() === true;
  }

  async escalate({ session, verdict, reasoningHash }) {
    if (!this.isEnabled()) return undefined;
    this.requireRuntimeSurface();
    const id = platformFaultRemediationIdForSession(session?.sessionId);
    return this.withRemediationLock(id, async () => {
      const existing = await this.stateStore.getPlatformFaultRemediation?.(id);
      const chainJobId = session.chainJobId ?? session.jobId;
      let live = await this.gateway.getJob(chainJobId);
      this.assertWorkerBinding(session, live);
      const initialState = Number(live?.state);
      if (![ESCROW_JOB_STATE_SUBMITTED, ESCROW_JOB_STATE_REJECTED, ESCROW_JOB_STATE_DISPUTED, ESCROW_JOB_STATE_CLOSED].includes(initialState)) {
        throw new ConflictError(
          `Platform-fault remediation cannot start from escrow state ${initialState}.`,
          "platform_fault_remediation_state_invalid",
          { id, chainJobId, liveState: initialState }
        );
      }
      if (initialState !== ESCROW_JOB_STATE_SUBMITTED && !existing) {
        throw new ConflictError(
          "Refusing to adopt an existing rejection or dispute without a durable platform-fault checkpoint.",
          "platform_fault_remediation_checkpoint_missing",
          { id, chainJobId, liveState: initialState }
        );
      }

      let record = existing ?? await this.initializeRecord({
        id,
        session,
        verdict,
        reasoningHash,
        live
      });

      if (initialState === ESCROW_JOB_STATE_CLOSED) {
        return this.storeCheckpoint(record, {
          status: "resolved_on_chain",
          chainState: ESCROW_JOB_STATE_CLOSED,
          resolvedOnChainAt: this.timestamp()
        });
      }

      if (Number(live.state) === ESCROW_JOB_STATE_SUBMITTED) {
        record = await this.storeCheckpoint(record, {
          status: "rejecting",
          chainState: ESCROW_JOB_STATE_SUBMITTED
        });
        const rejectionTx = await this.gateway.resolveSinglePayout(
          chainJobId,
          false,
          PLATFORM_FAULT_REMEDIATION_REASON_CODE,
          record.resolution.metadataURI,
          reasoningHash
        );
        this.assertSuccessfulReceipt("reject", rejectionTx);
        record = await this.storeCheckpoint(record, {
          status: "rejected",
          chainState: ESCROW_JOB_STATE_REJECTED,
          escalation: {
            ...record.escalation,
            rejection: { ...rejectionTx, recovered: false }
          }
        });
        live = await this.gateway.getJob(chainJobId);
        this.assertState(live, [ESCROW_JOB_STATE_REJECTED, ESCROW_JOB_STATE_DISPUTED], "reject");
      }

      if (Number(live.state) === ESCROW_JOB_STATE_REJECTED) {
        if (!record.escalation?.rejection) {
          record = await this.storeCheckpoint(record, {
            status: "rejected",
            chainState: ESCROW_JOB_STATE_REJECTED,
            escalation: {
              ...record.escalation,
              rejection: { status: 1, recovered: true }
            }
          });
        }
        record = await this.storeCheckpoint(record, {
          status: "opening_dispute",
          chainState: ESCROW_JOB_STATE_REJECTED
        });
        const disputeTx = await this.gateway.openDispute(chainJobId, session.wallet);
        this.assertSuccessfulReceipt("openDispute", disputeTx);
        record = await this.storeCheckpoint(record, {
          status: "dispute_opened",
          chainState: ESCROW_JOB_STATE_DISPUTED,
          escalation: {
            ...record.escalation,
            dispute: { ...disputeTx, recovered: false, participant: session.wallet }
          }
        });
        live = await this.gateway.getJob(chainJobId);
        this.assertState(live, [ESCROW_JOB_STATE_DISPUTED], "openDispute");
      }

      if (Number(live.state) === ESCROW_JOB_STATE_DISPUTED && !record.escalation?.dispute) {
        record = await this.storeCheckpoint(record, {
          status: "dispute_opened",
          chainState: ESCROW_JOB_STATE_DISPUTED,
          escalation: {
            ...record.escalation,
            dispute: { status: 1, recovered: true, participant: session.wallet }
          }
        });
      }

      this.assertState(live, [ESCROW_JOB_STATE_DISPUTED], "queue");
      const firstQueueWrite = record.status !== PLATFORM_FAULT_REMEDIATION_PENDING;
      record = await this.storeCheckpoint(record, {
        status: PLATFORM_FAULT_REMEDIATION_PENDING,
        chainState: ESCROW_JOB_STATE_DISPUTED,
        queuedAt: record.queuedAt ?? this.timestamp()
      });
      if (firstQueueWrite) this.publishQueued(record);
      return record;
    });
  }

  async enqueueBrokeredSubmitExpiry({
    session,
    live: suppliedLive = undefined,
    evidenceHash,
    claimExpiresAt,
    attempts
  }) {
    if (!this.isEnabled()) return undefined;
    this.requireQueueSurface();
    const id = platformFaultRemediationIdForSession(session?.sessionId);
    return this.withRemediationLock(id, async () => {
      const existing = await this.stateStore.getPlatformFaultRemediation?.(id);
      if (existing?.status === PLATFORM_FAULT_REMEDIATION_PENDING) return existing;
      const chainJobId = session.chainJobId ?? session.jobId;
      const live = suppliedLive ?? await this.gateway.getJob(chainJobId);
      this.assertWorkerBinding(session, live);
      if (Number(live?.state) !== ESCROW_JOB_STATE_CLAIMED) {
        throw new ConflictError(
          `Brokered-submit expiry remediation requires escrow state ${ESCROW_JOB_STATE_CLAIMED}.`,
          "platform_fault_submit_expiry_state_invalid",
          { id, chainJobId, liveState: Number(live?.state) }
        );
      }

      const workerPayoutRaw = this.remainingRewardRaw(live);
      if (workerPayoutRaw === "0") {
        throw new ConflictError(
          "Brokered-submit expiry remediation requires a positive worker payout.",
          "platform_fault_remediation_zero_payout",
          { id, chainJobId }
        );
      }
      const createdAt = this.timestamp();
      const rationale = "Averray's brokered submit did not land before claim expiry. The worker supplied durable evidence and bears no consequence; the full remaining reward is an internal remediation obligation.";
      const contentRecord = buildContentRecord({
        payload: {
          disputeId: `internal-${id}`,
          sessionId: session.sessionId,
          verdict: "dismissed",
          rationale,
          decidedBy: "TreasuryPolicy.arbitrators (pending hardware decision)",
          decidedAt: createdAt,
          remediation: {
            kind: PLATFORM_FAULT_REMEDIATION_KIND,
            origin: PLATFORM_FAULT_REMEDIATION_ORIGIN,
            workerInitiated: false,
            workerConsequence: "none",
            platformFaultReasonCode: "BROKERED_SUBMIT_EXPIRED",
            workerPayoutRaw,
            submissionFailure: {
              jobId: session.jobId,
              chainJobId,
              evidenceHash,
              claimExpiresAt,
              attempts
            }
          }
        },
        contentType: "arbitrator_reasoning",
        ownerWallet: session.wallet,
        verdict: "pass",
        createdAt
      });
      await this.stateStore.upsertContent?.(contentRecord);
      const metadataURI = publicContentUri(contentRecord.hash, { publicBaseUrl: this.publicBaseUrl });
      const record = await this.stateStore.upsertPlatformFaultRemediation({
        id,
        kind: PLATFORM_FAULT_REMEDIATION_KIND,
        origin: PLATFORM_FAULT_REMEDIATION_ORIGIN,
        visibility: "internal",
        workerInitiated: false,
        workerConsequence: "none",
        status: PLATFORM_FAULT_REMEDIATION_PENDING,
        sessionId: session.sessionId,
        jobId: session.jobId,
        chainJobId,
        worker: session.wallet,
        asset: live.asset,
        chainState: Number(live.state),
        createdAt,
        updatedAt: createdAt,
        queuedAt: createdAt,
        escalation: {
          type: "brokered_submit_expired",
          submissionFailure: {
            jobId: session.jobId,
            chainJobId,
            evidenceHash,
            claimExpiresAt,
            attempts
          }
        },
        resolution: {
          verdict: "dismissed",
          authority: "TreasuryPolicy.arbitrators",
          signerMode: "out_of_band_hardware",
          method: "manual_platform_fault_compensation",
          executable: false,
          executionConstraint: "The escrow never reached Submitted, so resolveDispute calldata would be invalid and is deliberately not fabricated.",
          workerPayout: Math.max(Number(live.reward ?? 0) - Number(live.released ?? 0), 0),
          workerPayoutRaw,
          reasonCode: PLATFORM_FAULT_REMEDIATION_REASON_CODE,
          reasoningHash: contentRecord.hash,
          metadataURI,
          releasesClaimEconomics: false
        }
      });
      this.publishQueued(record);
      return record;
    });
  }

  async initializeRecord({ id, session, verdict, reasoningHash, live }) {
    const workerPayoutRaw = this.remainingRewardRaw(live);
    if (workerPayoutRaw === "0") {
      throw new ConflictError(
        "Platform-fault remediation requires a positive worker payout so claim economics release instead of slash.",
        "platform_fault_remediation_zero_payout",
        { id, chainJobId: session.chainJobId ?? session.jobId }
      );
    }
    const createdAt = this.timestamp();
    const disputeId = `internal-${id}`;
    const rationale = "Averray platform infrastructure failed after submission. The worker bears no consequence; release the full remaining reward and claim economics.";
    const contentRecord = buildContentRecord({
      payload: {
        disputeId,
        sessionId: session.sessionId,
        verdict: "dismissed",
        rationale,
        decidedBy: "TreasuryPolicy.arbitrators (pending hardware signature)",
        decidedAt: createdAt,
        remediation: {
          kind: PLATFORM_FAULT_REMEDIATION_KIND,
          origin: PLATFORM_FAULT_REMEDIATION_ORIGIN,
          workerInitiated: false,
          workerConsequence: "none",
          platformFaultReasonCode: verdict.reasonCode,
          platformFaultReasoningHash: reasoningHash,
          workerPayoutRaw
        }
      },
      contentType: "arbitrator_reasoning",
      ownerWallet: session.wallet,
      verdict: "pass",
      createdAt
    });
    await this.stateStore.upsertContent?.(contentRecord);
    const metadataURI = publicContentUri(contentRecord.hash, { publicBaseUrl: this.publicBaseUrl });
    const transaction = await this.gateway.prepareResolveDispute(
      session.chainJobId ?? session.jobId,
      workerPayoutRaw,
      PLATFORM_FAULT_REMEDIATION_REASON_CODE,
      metadataURI
    );
    const workerPayout = Math.max(Number(live.reward ?? 0) - Number(live.released ?? 0), 0);
    const record = {
      id,
      kind: PLATFORM_FAULT_REMEDIATION_KIND,
      origin: PLATFORM_FAULT_REMEDIATION_ORIGIN,
      visibility: "internal",
      workerInitiated: false,
      workerConsequence: "none",
      status: "escalating",
      sessionId: session.sessionId,
      jobId: session.jobId,
      chainJobId: session.chainJobId ?? session.jobId,
      worker: session.wallet,
      asset: live.asset,
      chainState: Number(live.state),
      createdAt,
      updatedAt: createdAt,
      escalation: {
        rejectionReasonCode: PLATFORM_FAULT_REMEDIATION_REASON_CODE,
        disputeParticipant: session.wallet
      },
      resolution: {
        verdict: "dismissed",
        authority: "TreasuryPolicy.arbitrators",
        signerMode: "out_of_band_hardware",
        method: "resolveDispute",
        workerPayout,
        workerPayoutRaw,
        reasonCode: PLATFORM_FAULT_REMEDIATION_REASON_CODE,
        reasoningHash: contentRecord.hash,
        metadataURI,
        releasesClaimEconomics: true,
        transaction
      }
    };
    return this.stateStore.upsertPlatformFaultRemediation(record);
  }

  requireRuntimeSurface() {
    const required = [
      "getJob",
      "resolveSinglePayout",
      "openDispute",
      "prepareResolveDispute"
    ];
    const missing = required.filter((name) => typeof this.gateway?.[name] !== "function");
    if (missing.length > 0) {
      throw new ConfigError("Platform-fault remediation runtime is incomplete.", {
        missing
      });
    }
    if (
      typeof this.stateStore?.getPlatformFaultRemediation !== "function"
      || typeof this.stateStore?.upsertPlatformFaultRemediation !== "function"
      || typeof this.stateStore?.acquireClaimLock !== "function"
      || typeof this.stateStore?.releaseClaimLock !== "function"
    ) {
      throw new ConfigError("Platform-fault remediation requires durable queue storage and locking.");
    }
  }

  requireQueueSurface() {
    if (
      typeof this.stateStore?.getPlatformFaultRemediation !== "function"
      || typeof this.stateStore?.upsertPlatformFaultRemediation !== "function"
      || typeof this.stateStore?.acquireClaimLock !== "function"
      || typeof this.stateStore?.releaseClaimLock !== "function"
    ) {
      throw new ConfigError("Platform-fault remediation requires durable queue storage and locking.");
    }
  }

  remainingRewardRaw(live) {
    const reward = BigInt(live?.rewardRaw ?? 0);
    const released = BigInt(live?.releasedRaw ?? 0);
    if (released > reward) {
      throw new ExternalServiceError(
        "Live escrow released amount exceeds its reward.",
        "platform_fault_remediation_invalid_escrow",
        { rewardRaw: reward.toString(), releasedRaw: released.toString() }
      );
    }
    return (reward - released).toString();
  }

  assertWorkerBinding(session, live) {
    if (
      typeof live?.worker !== "string"
      || live.worker.toLowerCase() !== String(session?.wallet ?? "").toLowerCase()
    ) {
      throw new ConflictError(
        "Platform-fault remediation worker does not match the live escrow claimant.",
        "platform_fault_remediation_worker_mismatch",
        { sessionWorker: session?.wallet, chainWorker: live?.worker }
      );
    }
  }

  assertSuccessfulReceipt(step, receipt) {
    if (!receipt?.txHash || Number(receipt.status) !== 1) {
      throw new ExternalServiceError(
        `Platform-fault remediation ${step} did not return a successful chain receipt.`,
        "platform_fault_remediation_receipt_missing",
        { step }
      );
    }
  }

  assertState(live, expected, step) {
    const state = Number(live?.state);
    if (!expected.includes(state)) {
      throw new ConflictError(
        `Platform-fault remediation ${step} ended in escrow state ${state}; expected ${expected.join(" or ")}.`,
        "platform_fault_remediation_state_mismatch",
        { step, liveState: state, expectedStates: expected }
      );
    }
  }

  async storeCheckpoint(record, patch) {
    const updated = {
      ...record,
      ...patch,
      updatedAt: this.timestamp()
    };
    return this.stateStore.upsertPlatformFaultRemediation(updated);
  }

  async withRemediationLock(id, operation) {
    const owner = randomUUID();
    const lockId = `platform-fault-remediation:${id}`;
    const acquired = await this.stateStore.acquireClaimLock?.(
      lockId,
      owner,
      REMEDIATION_LOCK_TTL_SECONDS
    );
    if (acquired === false) {
      const existing = await this.stateStore.getPlatformFaultRemediation?.(id);
      if (existing?.status === PLATFORM_FAULT_REMEDIATION_PENDING) {
        return existing;
      }
      throw new ConflictError(
        "Platform-fault remediation is already in progress.",
        "platform_fault_remediation_in_progress",
        { id }
      );
    }
    try {
      return await operation();
    } finally {
      await this.stateStore.releaseClaimLock?.(lockId, owner);
    }
  }

  publishQueued(record) {
    this.logger.info?.(
      { remediationId: record.id, sessionId: record.sessionId, chainJobId: record.chainJobId },
      "platform_fault.remediation_queued"
    );
    this.eventBus?.publish?.({
      id: `platform-fault-remediation-${record.id}-${Date.now()}`,
      topic: "platform.remediation_queued",
      wallet: record.worker,
      wallets: [record.worker],
      jobId: record.jobId,
      sessionId: record.sessionId,
      timestamp: record.queuedAt,
      correlationId: record.id,
      source: "platform",
      phase: "remediation",
      severity: "warn",
      data: {
        remediationId: record.id,
        origin: PLATFORM_FAULT_REMEDIATION_ORIGIN,
        workerInitiated: false,
        workerConsequence: "none",
        status: record.status
      }
    });
  }

  timestamp() {
    return this.now().toISOString();
  }
}
