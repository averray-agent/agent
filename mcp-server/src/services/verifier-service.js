import { VerifierRegistry } from "./verifier-handlers.js";
import { hashCanonicalContent } from "../core/canonical-content.js";
import {
  buildVerificationAuditFields,
  jobWithVerifierConfigSnapshot
} from "../core/verifier-contract.js";
import { assertSessionCanReceiveVerification } from "../core/session-state-machine.js";

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
    const verdict = await this.registry.evaluate(job, verificationInput);
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
      ...buildVerificationAuditFields(job, { verdict, verificationInput }),
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
    const verdict = await this.registry.evaluate(replayJob, verificationInput);
    return {
      ...verdict,
      sessionId,
      replay: true,
      originalOutcome: existing?.outcome,
      ...buildVerificationAuditFields(replayJob, { verdict, verificationInput })
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
}
