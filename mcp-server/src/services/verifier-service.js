import { VerifierRegistry } from "./verifier-handlers.js";
import { hashCanonicalContent } from "../core/canonical-content.js";
import {
  buildVerificationAuditFields,
  jobWithVerifierConfigSnapshot
} from "../core/verifier-contract.js";
import { assertSessionCanReceiveVerification } from "../core/session-state-machine.js";
import { normalizeSubmission } from "../core/submission.js";
import { getJobSchema, validateAgainstSchema } from "../core/job-schema-registry.js";
import { normalizeSubmitPayloadShape, validateSubmissionContract } from "../core/job-execution-service.js";
import {
  assertJobSnapshotIntegrity,
  requireJobSnapshot
} from "../core/job-snapshot.js";
import { buildPlatformFaultRemediationMarker } from "../core/platform-fault-remediation.js";
import { transitionSession } from "../core/session-state-machine.js";
import { classifyEscrowInvalidState } from "../blockchain/escrow-core-errors.js";
import { PlatformFaultRemediationService } from "./platform-fault-remediation-service.js";

// EscrowCore JobState enum: None=0, Open=1, Claimed=2, Submitted=3, Rejected=4,
// Disputed=5, Closed=6. resolveSinglePayout only runs from Submitted and reverts
// once the job has been resolved (approved→Closed, rejected→Rejected) — used to
// make verifySubmission idempotent across a post-payout persistence failure.
const ESCROW_JOB_STATE_REJECTED = 4;
const ESCROW_JOB_STATE_CLOSED = 6;
export const ESCROW_JOB_STATE_SUBMITTED = 3;
export const CHAIN_STATE_DIVERGED_STATUS = "chain_state_diverged";
export const BROKERED_SUBMIT_RETRY_PENDING_OUTCOME = "brokered_submit_retry_pending";
const ESCROW_JOB_STATE_LABELS = Object.freeze([
  "none",
  "open",
  "claimed",
  "submitted",
  "rejected",
  "disputed",
  "closed"
]);

export const POSTER_REVIEW_HANDLER = "poster_review";
export const POSTER_REVIEW_HANDLER_VERSION = 1;

export class VerifierService {
  constructor(
    platformService,
    stateStore,
    blockchainGateway = undefined,
    registry = new VerifierRegistry(),
    options = {}
  ) {
    this.platformService = platformService;
    this.stateStore = stateStore;
    this.blockchainGateway = blockchainGateway;
    this.registry = registry;
    this.creditBookKeeper = undefined;
    this.eventBus = options.eventBus ?? platformService?.eventBus;
    this.logger = options.logger ?? console;
    this.platformFaultRemediationService = options.platformFaultRemediationService
      ?? new PlatformFaultRemediationService({
        stateStore,
        gateway: blockchainGateway,
        eventBus: platformService?.eventBus,
        logger: platformService?.logger
      });
  }

  setCreditBookKeeper(creditBookKeeper) {
    this.creditBookKeeper = creditBookKeeper;
  }

  async verifySubmission({ sessionId, evidence = undefined, metadataURI = "ipfs://pending-badge" }) {
    const session = await this.platformService.resumeSession(sessionId);
    assertSessionCanReceiveVerification(session);
    // Capture the narrative boundary before any chain settlement can mint a
    // badge or advance reputation. This read is advisory: an unavailable
    // progression surface must never block the money path.
    const previousProgression = await this.platformService.getWorkerProgressionSafely?.(
      session.wallet
    );
    const { job, snapshot, liveJob: initialLiveJob } = await assertJobSnapshotIntegrity(
      session,
      this.blockchainGateway
    );
    let liveJob = initialLiveJob;
    const chainJobId = session.chainJobId ?? session.jobId;
    const reconciliation = await this.reconcileBrokeredSubmitDivergence({ session, liveJob });
    if (reconciliation.result) return reconciliation.result;
    liveJob = reconciliation.liveJob;
    const verificationInput = this.resolveVerificationInput(session, evidence);
    const validatedVerificationInput = this.validateVerificationInput(job, verificationInput, {
      pinnedSchema: snapshot.outputSchema?.schema
    });
    let verdict = await this.registry.evaluate(
      job,
      validatedVerificationInput,
      verificationClaimantContext(session)
    );
    const reasoningHash = hashCanonicalContent({
      handler: verdict.handler,
      handlerVersion: verdict.handlerVersion,
      outcome: verdict.outcome,
      reasonCode: verdict.reasonCode,
      details: verdict.details ?? null
    });
    let platformFaultRemediation;
    if (verdict.outcome === "platform_fault") {
      if (verdict.workerConsequence && verdict.workerConsequence !== "none") {
        throw new Error("A platform_fault verdict must carry workerConsequence none.");
      }
      verdict = { ...verdict, workerConsequence: "none" };
      // The claim-time custody marker keeps this decision independent of the
      // gateway's current availability. Backend-ledger claim stake + fee can be
      // returned through existing ledger authority in this flow. Chain-held
      // economics deliberately stay in EscrowCore: only the queued arbitrator
      // resolveDispute action may release them.
      try {
        await this.platformService.returnPlatformFaultClaimEconomics?.(session, job);
      } catch (error) {
        // Economics return is recoverable through the arbitrator remediation.
        // It must never prevent that remediation from being queued or wedge
        // this submitted session in every scheduler pass.
        try {
          this.platformFaultRemediationService.logger?.warn?.(
            { sessionId, jobId: session.jobId, err: error },
            "platform_fault.claim_economics_return_failed"
          );
        } catch {
          // A broken observer cannot become another scheduler-fatal path.
        }
      }
      platformFaultRemediation = await this.platformFaultRemediationService.escalate({
        session,
        verdict,
        reasoningHash
      });
      if (platformFaultRemediation) {
        verdict = {
          ...verdict,
          internalRemediation: buildPlatformFaultRemediationMarker(platformFaultRemediation)
        };
      }
    }

    // Idempotent settle. resolveSinglePayout mutates on-chain state BEFORE the
    // verdict is persisted below; if a prior attempt settled on-chain but then
    // failed to persist (e.g. a Redis blip), the session is left 'submitted'
    // while the reward was already paid, and a naive retry would call
    // resolveSinglePayout again and revert InvalidState (the contract only
    // settles from Submitted) — wedging the session forever. A retry therefore
    // reconstructs the exact chain receipt before any terminal local write. If
    // that proof is unavailable, the session remains submitted; it must never
    // converge to resolved/rejected without the evidence.
    let payoutTx;
    const settlementOutcome = verdict.outcome === "approved" || verdict.outcome === "rejected";
    if (settlementOutcome && this.blockchainGateway?.isEnabled()) {
      const observedState = normalizeEscrowJobState(liveJob?.state);
      const alreadySettled = observedState === ESCROW_JOB_STATE_REJECTED
        || observedState === ESCROW_JOB_STATE_CLOSED;
      if (alreadySettled) {
        if (typeof this.blockchainGateway.recoverSinglePayoutReceipt !== "function") {
          throw new Error(
            `Job ${chainJobId} is already settled on-chain, but the gateway cannot reconstruct its receipt.`
          );
        }
        payoutTx = await this.blockchainGateway.recoverSinglePayoutReceipt(chainJobId, {
          outcome: verdict.outcome,
          worker: session.wallet,
          submittedAt: session.submittedAt
        });
      } else if (observedState !== ESCROW_JOB_STATE_SUBMITTED) {
        return this.parkChainStateDivergence({
          session,
          chainJobId,
          observedState,
          stage: "pre_resolve"
        });
      } else if (this.blockchainGateway.resolveSinglePayout) {
        try {
          payoutTx = await this.blockchainGateway.resolveSinglePayout(
            chainJobId,
            verdict.outcome === "approved",
            verdict.reasonCode,
            metadataURI,
            reasoningHash
          );
        } catch (error) {
          const invalidState = classifyEscrowInvalidState(error);
          if (!invalidState) throw error;
          let racedJob;
          try {
            racedJob = await this.blockchainGateway.getJob(chainJobId);
          } catch (readError) {
            this.logger.warn?.(
              { sessionId, jobId: chainJobId, err: readError },
              "verifier.chain_state_reread_failed"
            );
          }
          return this.parkChainStateDivergence({
            session,
            chainJobId,
            observedState: normalizeEscrowJobState(racedJob?.state),
            stage: "resolve_invalid_state",
            customError: invalidState.name,
            selector: invalidState.selector
          });
        }
      }
    }
    this.assertTerminalChainEvidence({ chainJobId, verdict, payoutTx });

    return this.persistBrokeredDecision({
      session,
      job,
      verdict,
      verificationInput: validatedVerificationInput,
      metadataURI: platformFaultRemediation?.resolution?.metadataURI ?? metadataURI,
      payoutTx,
      previousProgression
    });
  }

  /**
   * Persist a decision whose chain mutation was authorized by an existing
   * broker path rather than by a verifier handler. Poster review uses this
   * after resolveSinglePayout (or the reject+openDispute escalation pair) so
   * badges, run receipts, funded-job state, and verification results converge
   * through the same ingestion machinery as /verifier/run.
   */
  async ingestBrokeredDecision({
    sessionId,
    outcome,
    reasonCode,
    metadataURI,
    reasoningHash,
    payoutTx = undefined,
    details = undefined,
    handler = POSTER_REVIEW_HANDLER,
    handlerVersion = POSTER_REVIEW_HANDLER_VERSION,
    previousProgression = undefined
  }) {
    const session = await this.platformService.resumeSession(sessionId);
    assertSessionCanReceiveVerification(session, { reason: "brokered_review_decision" });
    const { job, snapshot } = await assertJobSnapshotIntegrity(session, this.blockchainGateway);
    const verificationInput = this.resolveVerificationInput(session);
    const verdict = {
      handler,
      handlerVersion,
      outcome,
      reasonCode,
      reasoningHash,
      ...(details?.decidingWallet ? { verifier: details.decidingWallet } : {}),
      details,
      verificationInput
    };
    return this.persistBrokeredDecision({
      session,
      job,
      verdict,
      verificationInput,
      metadataURI,
      payoutTx,
      previousProgression
    });
  }

  async persistBrokeredDecision({
    session,
    job,
    verdict,
    verificationInput,
    metadataURI,
    payoutTx,
    previousProgression = undefined
  }) {
    const sessionId = session.sessionId;
    const auditFields = buildVerificationAuditFields(job, { verdict, verificationInput });
    const persistedVerdict = {
      ...verdict,
      sessionId,
      metadataURI,
      environment: verdict.environment ?? {
        kind: "node",
        runtime: process.release.name,
        version: process.version
      },
      ...(payoutTx ? { payoutTx } : {}),
      ...(payoutTx?.settlement ? { settlement: payoutTx.settlement } : {}),
      ...auditFields
    };
    const settledSession = await this.platformService.ingestVerification(
      sessionId,
      persistedVerdict,
      { payoutTx, previousProgression }
    );
    if (payoutTx && settledSession?.payoutTx?.txHash !== payoutTx.txHash) {
      throw new Error(
        `Terminal session ${sessionId} was persisted without its payout receipt in the first write.`
      );
    }
    const result = {
      ...persistedVerdict,
      sessionId,
      metadataURI,
      ...(payoutTx ? { payoutTx } : {}),
      ...auditFields,
      session: settledSession,
      ...(settledSession?.progression ? { progression: settledSession.progression } : {})
    };

    // Collection is deliberately downstream of the terminal session write.
    // An expired/missing borrower authorization can pause amortization, but it
    // can never make a proven worker payout fail or revert its local receipt.
    if (verdict.outcome === "approved" && payoutTx?.settlement && this.creditBookKeeper) {
      result.creditSweep = await this.creditBookKeeper.afterSettlement({
        session: settledSession,
        payoutTx
      });
    }

    return result;
  }

  assertTerminalChainEvidence({ chainJobId, verdict, payoutTx }) {
    if (!this.blockchainGateway?.isEnabled?.()) return;
    if (verdict.outcome !== "approved" && verdict.outcome !== "rejected") return;
    if (!payoutTx?.txHash || Number(payoutTx.status) !== 1) {
      throw new Error(
        `Refusing terminal ${verdict.outcome} transition for ${chainJobId} without a successful chain receipt.`
      );
    }
    if (verdict.outcome === "approved" && !payoutTx.settlement) {
      throw new Error(
        `Refusing approved transition for ${chainJobId} without chain-verified payout settlement evidence.`
      );
    }
  }

  async parkChainStateDivergence({
    session,
    chainJobId,
    observedState,
    stage,
    customError = undefined,
    selector = undefined,
    details = undefined,
    sessionPatch = undefined
  }) {
    const current = await this.stateStore.getSession(session.sessionId) ?? session;
    if (current.status === CHAIN_STATE_DIVERGED_STATUS) {
      return chainStateDivergenceResult(current);
    }
    const parkedAt = new Date().toISOString();
    const divergence = {
      reason: CHAIN_STATE_DIVERGED_STATUS,
      expectedState: ESCROW_JOB_STATE_SUBMITTED,
      expectedStateLabel: escrowJobStateLabel(ESCROW_JOB_STATE_SUBMITTED),
      observedState,
      observedStateLabel: escrowJobStateLabel(observedState),
      stage,
      ...(customError ? { customError } : {}),
      ...(selector ? { selector } : {}),
      ...(details ?? {}),
      observedAt: parkedAt
    };
    const transitioned = transitionSession(current, CHAIN_STATE_DIVERGED_STATUS, {
      reason: CHAIN_STATE_DIVERGED_STATUS,
      timestamp: parkedAt,
      metadata: divergence
    });
    const parked = await this.stateStore.upsertSession({
      ...transitioned,
      chainJobId,
      chainStateDivergence: divergence,
      ...(sessionPatch ?? {})
    });
    this.eventBus?.publish?.({
      id: `chain-state-diverged-${session.sessionId}-${Date.parse(parkedAt)}`,
      topic: "verifier.chain_state_diverged",
      source: "chain",
      phase: "settlement",
      severity: "warn",
      sessionId: session.sessionId,
      jobId: chainJobId,
      wallet: session.wallet,
      wallets: [session.wallet].filter(Boolean),
      correlationId: session.sessionId,
      timestamp: parkedAt,
      data: divergence
    });
    this.logger.warn?.(
      { sessionId: session.sessionId, jobId: chainJobId, ...divergence },
      "verifier.chain_state_diverged"
    );
    return chainStateDivergenceResult(parked);
  }

  async parkExpiredBrokeredSubmit({ session, recovery }) {
    const remediation = await this.platformFaultRemediationService.enqueueBrokeredSubmitExpiry({
      session,
      live: recovery.liveJob,
      evidenceHash: recovery.evidenceHash,
      claimExpiresAt: recovery.claimExpiresAt,
      attempts: recovery.attempts
    });
    const restoredAt = new Date().toISOString();
    return this.parkChainStateDivergence({
      session,
      chainJobId: session.chainJobId ?? session.jobId,
      observedState: normalizeEscrowJobState(recovery.liveJob?.state),
      stage: "brokered_submit_expired",
      details: {
        evidenceHash: recovery.evidenceHash,
        claimExpiresAt: recovery.claimExpiresAt,
        attempts: recovery.attempts,
        workerConsequence: "none",
        remediationId: remediation?.id
      },
      sessionPatch: {
        workerConsequence: "none",
        onboardingWaiverConsumptionExemptedAt: restoredAt,
        onboardingWaiverConsumptionExemption: {
          reason: "brokered_submit_expired_platform_fault",
          source: "state_store",
          restoredAt
        },
        ...(remediation
          ? { internalRemediation: buildPlatformFaultRemediationMarker(remediation) }
          : {})
      }
    });
  }

  async reconcileSubmittedChainState({ sessionId }) {
    const session = await this.platformService.resumeSession(sessionId);
    assertSessionCanReceiveVerification(session);
    const { liveJob } = await assertJobSnapshotIntegrity(session, this.blockchainGateway);
    const reconciliation = await this.reconcileBrokeredSubmitDivergence({ session, liveJob });
    return reconciliation.result ?? {
      outcome: "brokered_submit_ready",
      sessionId,
      jobId: session.chainJobId ?? session.jobId,
      observedState: normalizeEscrowJobState(reconciliation.liveJob?.state)
    };
  }

  async reconcileBrokeredSubmitDivergence({ session, liveJob }) {
    if (
      !this.blockchainGateway?.isEnabled?.()
      || typeof this.platformService.reconcileBrokeredSubmit !== "function"
      || normalizeEscrowJobState(liveJob?.state) !== 2
    ) {
      return { liveJob };
    }
    const sessionId = session.sessionId;
    const chainJobId = session.chainJobId ?? session.jobId;
    const recovery = await this.platformService.reconcileBrokeredSubmit(sessionId);
    const reconciledLiveJob = recovery.liveJob ?? liveJob;
    if (recovery.status === "expired") {
      return {
        liveJob: reconciledLiveJob,
        result: await this.parkExpiredBrokeredSubmit({
          session: recovery.session ?? session,
          recovery
        })
      };
    }
    if (recovery.status === "deferred") {
      return {
        liveJob: reconciledLiveJob,
        result: {
          outcome: BROKERED_SUBMIT_RETRY_PENDING_OUTCOME,
          reasonCode: recovery.reason ?? "BROKERED_SUBMIT_RETRY_PENDING",
          sessionId,
          jobId: chainJobId,
          retryAt: recovery.retryAt,
          attempts: recovery.attempts
        }
      };
    }
    if (recovery.status === "diverged") {
      return {
        liveJob: reconciledLiveJob,
        result: await this.parkChainStateDivergence({
          session,
          chainJobId,
          observedState: normalizeEscrowJobState(reconciledLiveJob?.state),
          stage: "brokered_submit_reconcile"
        })
      };
    }
    return { liveJob: reconciledLiveJob };
  }

  async replayVerification(sessionId) {
    const session = await this.platformService.resumeSession(sessionId);
    const { job, snapshot } = await assertJobSnapshotIntegrity(session, this.blockchainGateway);
    const existing = await this.stateStore.getVerificationResult(sessionId);
    const verificationInput = existing?.verificationInput ?? this.resolveVerificationInput(session);
    const replayJob = jobWithVerifierConfigSnapshot(job, existing?.verifierConfigSnapshot);
    const validatedVerificationInput = this.validateVerificationInput(replayJob, verificationInput, {
      pinnedSchema: snapshot.outputSchema?.schema
    });
    const verdict = await this.registry.evaluate(
      replayJob,
      validatedVerificationInput,
      verificationClaimantContext(session)
    );
    const auditFields = buildVerificationAuditFields(replayJob, { verdict, verificationInput: validatedVerificationInput });
    const replayResult = {
      ...verdict,
      sessionId,
      replay: true,
      originalOutcome: existing?.outcome,
      ...auditFields
    };

    const drift = detectReplayDrift({ existing, verdict, auditFields });
    if (drift) {
      replayResult.replayDrift = drift;
    }

    return replayResult;
  }

  async getResult(sessionId) {
    const result = await this.stateStore.getVerificationResult(sessionId);
    if (result) {
      return result;
    }
    // No verdict persisted yet. If the session exists and is awaiting
    // verification (submitted, or disputed pending human resolution), report a
    // distinct "verifying" status with the timestamp it has been waiting since,
    // so a worker who just submitted sees in-progress + elapsed latency instead
    // of an indistinguishable not_found. Any other state falls through to
    // not_found (the route maps a null return to { status: "not_found" }).
    const session = await this.stateStore.getSession(sessionId);
    if (session && (session.status === "submitted" || session.status === "disputed")) {
      return {
        status: "verifying",
        sessionId,
        sessionStatus: session.status,
        awaitingSince: session.disputedAt ?? session.submittedAt ?? null
      };
    }
    return null;
  }

  // Verifier-scoped discovery of submissions awaiting verification. Scans the
  // recent-session window for sessions still in `submitted` (no verdict yet) and
  // returns a lightweight queue tagged with each job's verifier mode, so a
  // verifier can find pending work without the admin-only /admin/sessions view.
  // `scanned`/`window` are surfaced so the recent-window bound isn't silent.
  async listPendingVerifications({ limit = 50 } = {}) {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 50;
    const window = Math.min(Math.max(safeLimit * 4, 200), 500);
    const sessions = (await this.platformService.listRecentSessions?.(window)) ?? [];
    const pending = [];
    for (const session of sessions) {
      if (session?.status !== "submitted" || session.verification) continue;
      let verifierMode = null;
      let integrityFailure = null;
      try {
        const { job } = requireJobSnapshot(session);
        verifierMode = job?.verifierConfig?.handler ?? job?.verifierMode ?? null;
      } catch (error) {
        verifierMode = null;
        integrityFailure = {
          code: error?.code ?? "job_snapshot_invalid",
          message: error?.message ?? String(error)
        };
      }
      pending.push({
        sessionId: session.sessionId,
        jobId: session.jobId,
        wallet: session.wallet,
        verifierMode,
        ...(integrityFailure ? { integrityFailure } : {}),
        submittedAt: session.submittedAt ?? null,
        awaitingSince: session.submittedAt ?? null
      });
      if (pending.length >= safeLimit) break;
    }
    return { pending, count: pending.length, scanned: sessions.length, window };
  }

  listHandlers() {
    return this.registry.listHandlers();
  }

  listHandlerMetadata() {
    return this.registry.listHandlerMetadata?.() ?? this.listHandlers().map((id) => ({ id }));
  }

  resolveVerificationInput(session, overrideEvidence = undefined) {
    if (overrideEvidence !== undefined) {
      return session?.submission && typeof overrideEvidence === "string" && !overrideEvidence.length
        ? session.submission
        : overrideEvidence;
    }
    if (session?.submission) {
      return session.submission;
    }
    return "";
  }

  validateVerificationInput(job, verificationInput, { pinnedSchema = undefined } = {}) {
    const schema = pinnedSchema ?? getJobSchema(job?.outputSchemaRef, { registrations: job?.schemaRegistrations });
    if (!schema) {
      return verificationInput;
    }

    const normalized = isNormalizedSubmission(verificationInput)
      ? verificationInput
      : normalizeSubmission(normalizeSubmitPayloadShape(job.outputSchemaRef, verificationInput, {
        registrations: job.schemaRegistrations
      }));
    if (normalized.kind !== "structured") {
      validateSubmissionContract(job.outputSchemaRef, normalized, {
        path: "verificationInput",
        registrations: job.schemaRegistrations
      });
    } else {
      validateAgainstSchema(normalized.structured, schema, "verificationInput");
    }
    return normalized;
  }
}

function normalizeEscrowJobState(value) {
  const state = Number(value);
  return Number.isInteger(state) && state >= 0 ? state : null;
}

function escrowJobStateLabel(state) {
  return state === null
    ? "unknown"
    : ESCROW_JOB_STATE_LABELS[state] ?? `unknown_${state}`;
}

function chainStateDivergenceResult(session) {
  return {
    outcome: CHAIN_STATE_DIVERGED_STATUS,
    reasonCode: "CHAIN_STATE_DIVERGED",
    sessionId: session.sessionId,
    jobId: session.chainJobId ?? session.jobId,
    chainStateDivergence: session.chainStateDivergence,
    session
  };
}

function detectReplayDrift({ existing, verdict, auditFields }) {
  if (!existing) {
    return undefined;
  }
  const drift = {};

  const capturedHandler = existing.handler;
  const liveHandler = verdict?.handler;
  if (capturedHandler && liveHandler && capturedHandler !== liveHandler) {
    drift.handler = { captured: capturedHandler, live: liveHandler };
  }

  const capturedHandlerVersion = existing.handlerVersion;
  const liveHandlerVersion = verdict?.handlerVersion;
  if (
    capturedHandlerVersion !== undefined
    && liveHandlerVersion !== undefined
    && capturedHandlerVersion !== liveHandlerVersion
  ) {
    drift.handlerVersion = { captured: capturedHandlerVersion, live: liveHandlerVersion };
  }

  const capturedEvidenceSchemaRef = existing.evidenceSchemaRef;
  const liveEvidenceSchemaRef = auditFields?.evidenceSchemaRef;
  if (
    capturedEvidenceSchemaRef
    && liveEvidenceSchemaRef
    && capturedEvidenceSchemaRef !== liveEvidenceSchemaRef
  ) {
    drift.evidenceSchemaRef = { captured: capturedEvidenceSchemaRef, live: liveEvidenceSchemaRef };
  }

  const capturedPolicyVersion = existing.verifierPolicyVersion;
  const livePolicyVersion = auditFields?.verifierPolicyVersion;
  if (
    capturedPolicyVersion !== undefined
    && livePolicyVersion !== undefined
    && capturedPolicyVersion !== livePolicyVersion
  ) {
    drift.verifierPolicyVersion = { captured: capturedPolicyVersion, live: livePolicyVersion };
  }

  // verifierConfigHash drift means the stored snapshot disagrees with the
  // snapshot we just hashed -- snapshot corruption, not config evolution.
  const capturedConfigHash = existing.verifierConfigHash;
  const liveConfigHash = auditFields?.verifierConfigHash;
  if (capturedConfigHash && liveConfigHash && capturedConfigHash !== liveConfigHash) {
    drift.verifierConfigHash = { captured: capturedConfigHash, live: liveConfigHash };
  }

  return Object.keys(drift).length > 0 ? drift : undefined;
}

function isNormalizedSubmission(input) {
  if (!input || typeof input !== "object") {
    return false;
  }
  if (input.kind === "structured" && "structured" in input) {
    return true;
  }
  return input.kind === "text" && typeof input.evidenceText === "string";
}

function verificationClaimantContext(session) {
  return {
    claimantWallet: session?.wallet,
    claimSessionId: session?.sessionId
  };
}
