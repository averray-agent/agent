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

// EscrowCore JobState enum: None=0, Open=1, Claimed=2, Submitted=3, Rejected=4,
// Disputed=5, Closed=6. resolveSinglePayout only runs from Submitted and reverts
// once the job has been resolved (approved→Closed, rejected→Rejected) — used to
// make verifySubmission idempotent across a post-payout persistence failure.
const ESCROW_JOB_STATE_REJECTED = 4;
const ESCROW_JOB_STATE_CLOSED = 6;

export const POSTER_REVIEW_HANDLER = "poster_review";
export const POSTER_REVIEW_HANDLER_VERSION = 1;

export class VerifierService {
  constructor(platformService, stateStore, blockchainGateway = undefined, registry = new VerifierRegistry()) {
    this.platformService = platformService;
    this.stateStore = stateStore;
    this.blockchainGateway = blockchainGateway;
    this.registry = registry;
  }

  async verifySubmission({ sessionId, evidence = undefined, metadataURI = "ipfs://pending-badge" }) {
    const session = await this.platformService.resumeSession(sessionId);
    assertSessionCanReceiveVerification(session);
    const { job, snapshot } = await assertJobSnapshotIntegrity(session, this.blockchainGateway);
    const chainJobId = session.chainJobId ?? session.jobId;
    const verificationInput = this.resolveVerificationInput(session, evidence);
    const validatedVerificationInput = this.validateVerificationInput(job, verificationInput, {
      pinnedSchema: snapshot.outputSchema?.schema
    });
    const verdict = await this.registry.evaluate(
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
    const alreadySettled = await this.onChainAlreadySettled(chainJobId);
    if (alreadySettled && this.blockchainGateway?.isEnabled()) {
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
    } else if (!alreadySettled && this.blockchainGateway?.isEnabled() && this.blockchainGateway.resolveSinglePayout) {
      payoutTx = await this.blockchainGateway.resolveSinglePayout(
        chainJobId,
        verdict.outcome === "approved",
        verdict.reasonCode,
        metadataURI,
        reasoningHash
      );
    }
    this.assertTerminalChainEvidence({ chainJobId, verdict, payoutTx });

    return this.persistBrokeredDecision({
      session,
      job,
      verdict,
      verificationInput: validatedVerificationInput,
      metadataURI,
      payoutTx
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
    handlerVersion = POSTER_REVIEW_HANDLER_VERSION
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
      payoutTx
    });
  }

  async persistBrokeredDecision({
    session,
    job,
    verdict,
    verificationInput,
    metadataURI,
    payoutTx
  }) {
    const sessionId = session.sessionId;
    const auditFields = buildVerificationAuditFields(job, { verdict, verificationInput });
    const persistedVerdict = {
      ...verdict,
      sessionId,
      metadataURI,
      ...(payoutTx ? { payoutTx } : {}),
      ...(payoutTx?.settlement ? { settlement: payoutTx.settlement } : {}),
      ...auditFields
    };
    const settledSession = await this.platformService.ingestVerification(
      sessionId,
      persistedVerdict,
      { payoutTx }
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
      session: settledSession
    };

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

  // True if the on-chain job has already been resolved by a prior settle
  // (approved → Closed, rejected → Rejected), i.e. resolveSinglePayout must not
  // run again. Any read failure returns false (we cannot confirm), so the caller
  // falls back to attempting the settle rather than silently skipping a real one.
  async onChainAlreadySettled(jobId) {
    try {
      if (!this.blockchainGateway?.isEnabled?.() || typeof this.blockchainGateway.getJob !== "function") {
        return false;
      }
      const job = await this.blockchainGateway.getJob(jobId);
      const state = Number(job?.state);
      return state === ESCROW_JOB_STATE_REJECTED || state === ESCROW_JOB_STATE_CLOSED;
    } catch {
      return false;
    }
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
