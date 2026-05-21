import {
  assertSessionCanReceiveVerification,
  transitionSession
} from "../core/session-state-machine.js";
import { updateFundedJobFromSession } from "../core/funded-jobs.js";
import { buildVerificationAuditFields } from "../core/verifier-contract.js";
import { disputeIdForSession } from "../core/dispute-resolution.js";

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
        verifierPolicyVersion: auditFields.verifierPolicyVersion,
        verifierConfigVersion: auditFields.verifierConfigVersion
      }
    }, status, {
      reason: "verification_resolved",
      metadata: {
        outcome: verdict.outcome,
        reasonCode: verdict.reasonCode,
        handler: verdict.handler,
        handlerVersion: auditFields.handlerVersion ?? verdict.handlerVersion,
        verifierPolicyVersion: auditFields.verifierPolicyVersion,
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
    const eventTimestamp = new Date().toISOString();
    this.eventBus?.publish({
      id: `platform-verification-${updatedSession.sessionId}-${Date.now()}`,
      topic: "verification.resolved",
      wallet: updatedSession.wallet,
      wallets: [updatedSession.wallet],
      jobId: updatedSession.jobId,
      sessionId: updatedSession.sessionId,
      timestamp: eventTimestamp,
      correlationId: updatedSession.sessionId,
      data: {
        outcome: verdict.outcome,
        reasonCode: verdict.reasonCode,
        status,
        handler: verdict.handler,
        handlerVersion: auditFields.handlerVersion ?? verdict.handlerVersion,
        verifierPolicyVersion: auditFields.verifierPolicyVersion,
        verifierConfigVersion: auditFields.verifierConfigVersion
      }
    });
    this.publishWorkflowOutcomeEvent(updatedSession, verdict, auditFields, status, eventTimestamp);
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

  publishWorkflowOutcomeEvent(session, verdict, auditFields, status, timestamp) {
    if (!this.eventBus) {
      return;
    }

    const disputed = status === "disputed";
    const topic = disputed
      ? "dispute.opened"
      : status === "resolved"
        ? "settlement.session_resolved"
        : "settlement.session_rejected";

    this.eventBus.publish({
      id: `platform-${topic}-${session.sessionId}-${Date.now()}`,
      topic,
      wallet: session.wallet,
      wallets: [session.wallet],
      jobId: session.jobId,
      sessionId: session.sessionId,
      timestamp,
      correlationId: session.sessionId,
      data: {
        sessionId: session.sessionId,
        wallet: session.wallet,
        jobId: session.jobId,
        status,
        outcome: verdict.outcome,
        reasonCode: verdict.reasonCode,
        handler: verdict.handler,
        handlerVersion: auditFields.handlerVersion ?? verdict.handlerVersion,
        verifierPolicyVersion: auditFields.verifierPolicyVersion,
        verifierConfigVersion: auditFields.verifierConfigVersion,
        disputeId: disputed ? disputeIdForSession(session.sessionId) : undefined
      }
    });
  }
}
