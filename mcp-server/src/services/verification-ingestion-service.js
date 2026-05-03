import {
  assertSessionCanReceiveVerification,
  transitionSession
} from "../core/session-state-machine.js";
import { updateFundedJobFromSession } from "../core/funded-jobs.js";
import { buildVerificationAuditFields } from "../core/verifier-contract.js";

export class VerificationIngestionService {
  constructor(stateStore, eventBus = undefined, getJobDefinition = undefined) {
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    this.getJobDefinition = getJobDefinition;
  }

  async ingest(sessionId, verdict) {
    const session = sessionId
      ? await this.stateStore.getSession(sessionId)
      : await this.stateStore.findSessionByJobId(verdict.jobId);
    if (!session) {
      return undefined;
    }
    assertSessionCanReceiveVerification(session);
    const job = this.resolveJob(session, verdict);
    const verificationInput = verdict.verificationInput ?? session.submission ?? "";
    const auditFields = job
      ? buildVerificationAuditFields(job, { verdict, verificationInput })
      : {};

    const status = verdict.outcome === "approved"
      ? "resolved"
      : verdict.outcome === "disputed"
        ? "disputed"
        : "rejected";

    const transitioned = transitionSession({
      ...session,
      verificationSummary: {
        outcome: verdict.outcome,
        reasonCode: verdict.reasonCode,
        handler: verdict.handler,
        handlerVersion: auditFields.handlerVersion ?? verdict.handlerVersion,
        verifierConfigVersion: auditFields.verifierConfigVersion
      }
    }, status, {
      reason: "verification_resolved",
      metadata: {
        outcome: verdict.outcome,
        reasonCode: verdict.reasonCode,
        handler: verdict.handler,
        handlerVersion: auditFields.handlerVersion ?? verdict.handlerVersion,
        verifierConfigVersion: auditFields.verifierConfigVersion
      }
    });
    const updatedSession = await this.stateStore.upsertSession(transitioned);
    const fundedJob = await this.stateStore.getFundedJob?.(updatedSession.jobId);
    await this.stateStore.upsertFundedJob?.(updateFundedJobFromSession(fundedJob, {
      session: updatedSession,
      verification: verdict
    }));
    await this.stateStore.upsertVerificationResult(updatedSession.sessionId, {
      ...verdict,
      ...auditFields,
      session: {
        sessionId: updatedSession.sessionId,
        jobId: updatedSession.jobId,
        wallet: updatedSession.wallet,
        status: updatedSession.status,
        updatedAt: updatedSession.updatedAt,
        resolvedAt: updatedSession.resolvedAt
      }
    });
    this.eventBus?.publish({
      id: `platform-verification-${updatedSession.sessionId}-${Date.now()}`,
      topic: "verification.resolved",
      wallet: updatedSession.wallet,
      wallets: [updatedSession.wallet],
      jobId: updatedSession.jobId,
      sessionId: updatedSession.sessionId,
      timestamp: new Date().toISOString(),
      data: {
        outcome: verdict.outcome,
        reasonCode: verdict.reasonCode,
        status,
        handler: verdict.handler,
        handlerVersion: auditFields.handlerVersion ?? verdict.handlerVersion,
        verifierConfigVersion: auditFields.verifierConfigVersion
      }
    });
    return updatedSession;
  }

  resolveJob(session, verdict) {
    const jobId = session?.jobId ?? verdict?.jobId;
    if (!jobId || typeof this.getJobDefinition !== "function") {
      return undefined;
    }
    try {
      return this.getJobDefinition(jobId);
    } catch {
      return undefined;
    }
  }
}
