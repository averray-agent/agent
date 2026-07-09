import {
  assertSessionCanReceiveVerification,
  transitionSession
} from "../core/session-state-machine.js";
import { updateFundedJobFromSession } from "../core/funded-jobs.js";
import { buildVerificationAuditFields } from "../core/verifier-contract.js";
import { disputeIdForSession } from "../core/dispute-resolution.js";
import { buildBadgeFromSession, buildBadgeJobSnapshot } from "../core/badge-metadata.js";

export class VerificationIngestionService {
  constructor(stateStore, eventBus = undefined, getJobDefinition = undefined, logger = undefined) {
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    this.getJobDefinition = getJobDefinition;
    // Reached by the autonomous (no-JWT) settlement path as well as the manual
    // route. Log under a synthetic principal so autonomous verdict ingestion is
    // auditable (audit B-11). Default to console so it logs even unwired.
    this.logger = logger || console;
  }

  async ingest(sessionId, verdict) {
    const session = sessionId
      ? await this.stateStore.getSession(sessionId)
      : await this.stateStore.findSessionByJobId(verdict.jobId);
    if (!session) {
      return undefined;
    }
    assertSessionCanReceiveVerification(session);
    this.logger.info?.(
      { principal: "system:auto-verifier", sessionId: session.sessionId, jobId: session.jobId, outcome: verdict.outcome },
      "verification_ingest.autonomous"
    );
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

    const badgeSnapshot = session.badgeSnapshot ?? buildBadgeJobSnapshot(job);
    const transitioned = transitionSession({
      ...session,
      ...(badgeSnapshot ? { badgeSnapshot } : {}),
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
    const storedVerification = await this.stateStore.upsertVerificationResult(updatedSession.sessionId, {
      ...verdict,
      ...auditFields,
      ...(badgeSnapshot ? { badgeSnapshot } : {}),
      session: {
        sessionId: updatedSession.sessionId,
        jobId: updatedSession.jobId,
        wallet: updatedSession.wallet,
        status: updatedSession.status,
        updatedAt: updatedSession.updatedAt,
        resolvedAt: updatedSession.resolvedAt
      }
    });
    if (status === "resolved") {
      await this.persistBadgeDocument(updatedSession, job, storedVerification);
    }
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

  async persistBadgeDocument(session, job, verification) {
    if (typeof this.stateStore.putBadgeDocument !== "function") return;
    try {
      const badge = buildBadgeFromSession({
        session,
        job,
        verification,
        context: {
          publicBaseUrl: process.env.PUBLIC_BASE_URL,
          posterAddress: process.env.DEFAULT_POSTER_ADDRESS,
          verifierAddress: process.env.DEFAULT_VERIFIER_ADDRESS
        }
      });
      await this.stateStore.putBadgeDocument(session.sessionId, badge);
    } catch (error) {
      this.logger.warn?.(
        { sessionId: session.sessionId, jobId: session.jobId, error: error?.message },
        "badge_document.persist_failed"
      );
    }
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
