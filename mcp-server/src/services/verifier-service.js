import { VerifierRegistry } from "./verifier-handlers.js";
import { hashCanonicalContent } from "../core/canonical-content.js";
import {
  buildVerificationAuditFields,
  jobWithVerifierConfigSnapshot
} from "../core/verifier-contract.js";
import { assertSessionCanReceiveVerification } from "../core/session-state-machine.js";
import { normalizeSubmission } from "../core/submission.js";
import { getJobSchema } from "../core/job-schema-registry.js";
import { normalizeSubmitPayloadShape, validateSubmissionContract } from "../core/job-execution-service.js";

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
    const job = this.platformService.getJobDefinition(session.jobId);
    const chainJobId = session.chainJobId ?? session.jobId;
    const verificationInput = this.resolveVerificationInput(session, evidence);
    const validatedVerificationInput = this.validateVerificationInput(job, verificationInput);
    const verdict = await this.registry.evaluate(job, validatedVerificationInput);
    const reasoningHash = hashCanonicalContent({
      handler: verdict.handler,
      handlerVersion: verdict.handlerVersion,
      outcome: verdict.outcome,
      reasonCode: verdict.reasonCode,
      details: verdict.details ?? null
    });

    let payoutTx;
    if (this.blockchainGateway?.isEnabled() && this.blockchainGateway.resolveSinglePayout) {
      payoutTx = await this.blockchainGateway.resolveSinglePayout(
        chainJobId,
        verdict.outcome === "approved",
        verdict.reasonCode,
        metadataURI,
        reasoningHash
      );
    }

    const updatedSession = await this.platformService.ingestVerification(sessionId, verdict);
    // Surface the on-chain settle/payout tx (when settled here) so the worker can
    // see the actual payout — both via /session (stamped on the session record)
    // and /verifier/result (on the verification result) — instead of it being
    // discarded. Guarded on a real txHash so disabled-chain flows are unchanged.
    let settledSession = updatedSession ?? session;
    if (payoutTx?.txHash && typeof this.stateStore.upsertSession === "function") {
      settledSession = await this.stateStore.upsertSession({ ...settledSession, payoutTx });
    }
    const result = {
      ...verdict,
      sessionId,
      metadataURI,
      ...(payoutTx ? { payoutTx } : {}),
      ...buildVerificationAuditFields(job, { verdict, verificationInput: validatedVerificationInput }),
      session: settledSession
    };

    return this.stateStore.upsertVerificationResult(sessionId, result);
  }

  async replayVerification(sessionId) {
    const session = await this.platformService.resumeSession(sessionId);
    const job = this.platformService.getJobDefinition(session.jobId);
    const existing = await this.stateStore.getVerificationResult(sessionId);
    const verificationInput = existing?.verificationInput ?? this.resolveVerificationInput(session);
    const replayJob = jobWithVerifierConfigSnapshot(job, existing?.verifierConfigSnapshot);
    const validatedVerificationInput = this.validateVerificationInput(replayJob, verificationInput);
    const verdict = await this.registry.evaluate(replayJob, validatedVerificationInput);
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
      try {
        const job = this.platformService.getJobDefinition(session.jobId);
        verifierMode = job?.verifierConfig?.handler ?? job?.verifierMode ?? null;
      } catch {
        verifierMode = null;
      }
      pending.push({
        sessionId: session.sessionId,
        jobId: session.jobId,
        wallet: session.wallet,
        verifierMode,
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

  validateVerificationInput(job, verificationInput) {
    if (!getJobSchema(job?.outputSchemaRef, { registrations: job?.schemaRegistrations })) {
      return verificationInput;
    }

    const normalized = isNormalizedSubmission(verificationInput)
      ? verificationInput
      : normalizeSubmission(normalizeSubmitPayloadShape(job.outputSchemaRef, verificationInput, {
        registrations: job.schemaRegistrations
      }));
    validateSubmissionContract(job.outputSchemaRef, normalized, {
      path: "verificationInput",
      registrations: job.schemaRegistrations
    });
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
