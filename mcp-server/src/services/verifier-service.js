import { VerifierRegistry } from "./verifier-handlers.js";
import { hashCanonicalContent } from "../core/canonical-content.js";
import {
  buildVerificationAuditFields,
  jobWithVerifierConfigSnapshot
} from "../core/verifier-contract.js";
import { assertSessionCanReceiveVerification } from "../core/session-state-machine.js";
import { normalizeSubmission } from "../core/submission.js";
import { getBuiltinJobSchema } from "../core/job-schema-registry.js";
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

    if (this.blockchainGateway?.isEnabled() && this.blockchainGateway.resolveSinglePayout) {
      await this.blockchainGateway.resolveSinglePayout(
        chainJobId,
        verdict.outcome === "approved",
        verdict.reasonCode,
        metadataURI,
        reasoningHash
      );
    }

    const updatedSession = await this.platformService.ingestVerification(sessionId, verdict);
    const result = {
      ...verdict,
      sessionId,
      metadataURI,
      ...buildVerificationAuditFields(job, { verdict, verificationInput: validatedVerificationInput }),
      session: updatedSession ?? session
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
    return {
      ...verdict,
      sessionId,
      replay: true,
      originalOutcome: existing?.outcome,
      ...buildVerificationAuditFields(replayJob, { verdict, verificationInput: validatedVerificationInput })
    };
  }

  async getResult(sessionId) {
    return this.stateStore.getVerificationResult(sessionId);
  }

  listHandlers() {
    return this.registry.listHandlers();
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
    if (!getBuiltinJobSchema(job?.outputSchemaRef)) {
      return verificationInput;
    }

    const normalized = isNormalizedSubmission(verificationInput)
      ? verificationInput
      : normalizeSubmission(normalizeSubmitPayloadShape(job.outputSchemaRef, verificationInput));
    validateSubmissionContract(job.outputSchemaRef, normalized, { path: "verificationInput" });
    return normalized;
  }
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
