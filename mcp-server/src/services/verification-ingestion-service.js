import {
  assertSessionCanReceiveVerification,
  transitionSession
} from "../core/session-state-machine.js";
import { updateFundedJobFromSession } from "../core/funded-jobs.js";
import { buildVerificationAuditFields } from "../core/verifier-contract.js";
import { disputeIdForSession } from "../core/dispute-resolution.js";
import { buildBadgeFromSession, buildBadgeJobSnapshot } from "../core/badge-metadata.js";
import { buildRunReceipt } from "../core/run-receipt.js";

export class VerificationIngestionService {
  constructor(stateStore, eventBus = undefined, getJobDefinition = undefined, logger = undefined, options = {}) {
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    this.getJobDefinition = getJobDefinition;
    // Reached by the autonomous (no-JWT) settlement path as well as the manual
    // route. Log under a synthetic principal so autonomous verdict ingestion is
    // auditable (audit B-11). Default to console so it logs even unwired.
    this.logger = logger || console;
    this.badgeReceiptSigner = options.badgeReceiptSigner;
    this.blockchainGateway = options.blockchainGateway;
    this.policyService = options.policyService;
  }

  setBadgeReceiptSigner(signer) {
    this.badgeReceiptSigner = signer;
  }

  setPolicyService(policyService) {
    this.policyService = policyService;
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
    const verificationRecord = {
      ...verdict,
      ...auditFields,
      ...(badgeSnapshot ? { badgeSnapshot } : {})
    };
    if (status === "resolved" || status === "rejected") {
      // Persist the signed verdict document before committing the terminal
      // session transition. If signing or durable storage fails, verification
      // refuses instead of silently producing a receipt-less final verdict.
      await this.persistRunReceiptDocument(transitioned, job, verificationRecord);
    }
    const updatedSession = await this.stateStore.upsertSession(transitioned);
    const fundedJob = await this.stateStore.getFundedJob?.(updatedSession.jobId);
    await this.stateStore.upsertFundedJob?.(updateFundedJobFromSession(fundedJob, {
      session: updatedSession,
      verification: verdict
    }));
    const storedVerification = await this.stateStore.upsertVerificationResult(updatedSession.sessionId, {
      ...verificationRecord,
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
      const context = await this.resolveReceiptSignerContext(job);
      const badge = buildBadgeFromSession({
        session,
        job,
        verification,
        context
      });
      const document = this.badgeReceiptSigner
        ? { ...badge, signature: await this.badgeReceiptSigner.signDocument(badge) }
        : badge;
      await this.stateStore.putBadgeDocument(session.sessionId, document);
    } catch (error) {
      this.logger.warn?.(
        { sessionId: session.sessionId, jobId: session.jobId, error: error?.message },
        "badge_document.persist_failed"
      );
      if (this.badgeReceiptSigner) throw error;
    }
  }

  async persistRunReceiptDocument(session, job, verification) {
    if (typeof this.stateStore.putRunReceiptDocument !== "function") return;
    try {
      const context = await this.resolveReceiptSignerContext(job);
      const receipt = buildRunReceipt({ session, job, verification, context });
      const document = this.badgeReceiptSigner
        ? { ...receipt, signature: await this.badgeReceiptSigner.signDocument(receipt) }
        : receipt;
      await this.stateStore.putRunReceiptDocument(session.sessionId, document);
    } catch (error) {
      this.logger.warn?.(
        { sessionId: session.sessionId, jobId: session.jobId, error: error?.message },
        "run_receipt_document.persist_failed"
      );
      throw error;
    }
  }

  async resolveReceiptSignerContext(job) {
    const context = { publicBaseUrl: process.env.PUBLIC_BASE_URL };
    const policyRef = job?.verification?.receiptPolicyTag;
    if (typeof policyRef !== "string" || !policyRef.trim()) return context;

    const policy = this.policyService?.findByTagOrId?.(policyRef.trim());
    if (policy?.scope !== "co-sign" || String(policy?.state ?? "").toLowerCase() !== "active") {
      this.logger.warn?.(
        { jobId: job?.id, policyRef },
        "badge_document.co_sign_policy_unavailable"
      );
      return context;
    }

    try {
      const status = await this.blockchainGateway?.getTreasuryPolicyStatus?.();
      const roles = status?.roles ?? {};
      const signerAddress = roles.signerAddress;
      return {
        ...context,
        ...(roles.signerIsSettlementBroker === true && signerAddress
          ? { posterAddress: signerAddress }
          : {}),
        ...(roles.signerIsVerifier === true && signerAddress
          ? { verifierAddress: signerAddress }
          : {})
      };
    } catch (error) {
      this.logger.warn?.(
        { jobId: job?.id, policyRef, error: error?.message },
        "badge_document.co_sign_identity_unavailable"
      );
      return context;
    }
  }

  // Compatibility for focused callers/tests that predate run receipts.
  async resolveBadgeSignerContext(job) {
    return this.resolveReceiptSignerContext(job);
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
