import { PlatformService } from "../core/platform-service.js";
import { VerificationVerdict } from "../schemas/types.js";
import { VerifierRegistry } from "./verifier-handlers.js";

export interface VerifySubmissionInput {
  sessionId: string;
  evidence?: string;
  metadataURI?: string;
}

export interface VerificationResult extends VerificationVerdict {
  sessionId: string;
  metadataURI: string;
  session: unknown;
}

export class VerifierService {
  constructor(
    private readonly platformService: PlatformService,
    private readonly blockchainGateway?: {
      isEnabled(): boolean;
      resolveSinglePayout?(jobId: string, approved: boolean, reasonCode: string, metadataURI: string): Promise<void>;
    },
    private readonly registry = new VerifierRegistry()
  ) {}

  async verifySubmission({ sessionId, evidence = "", metadataURI = "ipfs://pending-badge" }: VerifySubmissionInput): Promise<VerificationResult> {
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

    return this.platformService.stateStore.upsertVerificationResult(sessionId, result);
  }

  async getResult(sessionId: string): Promise<VerificationResult | undefined> {
    return this.platformService.stateStore.getVerificationResult(sessionId);
  }

  listHandlers(): string[] {
    return this.registry.listHandlers();
  }
}
