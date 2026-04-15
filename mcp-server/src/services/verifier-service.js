import { VerifierRegistry } from "./verifier-handlers.js";

export class VerifierService {
  constructor(platformService, stateStore, blockchainGateway = undefined, registry = new VerifierRegistry()) {
    this.platformService = platformService;
    this.stateStore = stateStore;
    this.blockchainGateway = blockchainGateway;
    this.registry = registry;
  }

  async verifySubmission({ sessionId, evidence = "", metadataURI = "ipfs://pending-badge" }) {
    const session = await this.platformService.resumeSession(sessionId);
    const job = this.platformService.getJobDefinition(session.jobId);
    const chainJobId = session.chainJobId ?? session.jobId;
    const verdict = this.registry.evaluate(job, evidence);

    if (this.blockchainGateway?.isEnabled() && this.blockchainGateway.resolveSinglePayout) {
      await this.blockchainGateway.resolveSinglePayout(
        chainJobId,
        verdict.outcome === "approved",
        verdict.reasonCode,
        metadataURI
      );
    }

    const updatedSession = await this.platformService.ingestVerification(verdict);
    const result = {
      ...verdict,
      sessionId,
      metadataURI,
      session: updatedSession ?? session
    };

    return this.stateStore.upsertVerificationResult(sessionId, result);
  }

  async getResult(sessionId) {
    return this.stateStore.getVerificationResult(sessionId);
  }

  listHandlers() {
    return this.registry.listHandlers();
  }
}
