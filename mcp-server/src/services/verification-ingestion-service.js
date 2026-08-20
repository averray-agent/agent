import {
  assertSessionCanReceiveVerification,
  transitionSession
} from "../core/session-state-machine.js";
import { updateFundedJobFromSession } from "../core/funded-jobs.js";
import { buildVerificationAuditFields } from "../core/verifier-contract.js";
import { disputeIdForSession } from "../core/dispute-resolution.js";
import { buildBadgeFromSession, buildBadgeJobSnapshot } from "../core/badge-metadata.js";
import { buildRunReceipt } from "../core/run-receipt.js";
import { buildWorkReceipt } from "../core/work-receipt.js";
import { requireJobSnapshot } from "../core/job-snapshot.js";
import { isInternalPlatformFaultRemediation } from "../core/platform-fault-remediation.js";

export class VerificationIngestionService {
  constructor(stateStore, eventBus = undefined, _legacyDefinitionResolver = undefined, logger = undefined, options = {}) {
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    // Reached by the autonomous (no-JWT) settlement path as well as the manual
    // route. Log under a synthetic principal so autonomous verdict ingestion is
    // auditable (audit B-11). Default to console so it logs even unwired.
    this.logger = logger || console;
    this.badgeReceiptSigner = options.badgeReceiptSigner;
    this.blockchainGateway = options.blockchainGateway;
    this.policyService = options.policyService;
    this.selfIdentityRegistry = options.selfIdentityRegistry;
  }

  setBadgeReceiptSigner(signer) {
    this.badgeReceiptSigner = signer;
  }

  setPolicyService(policyService) {
    this.policyService = policyService;
  }

  setSelfIdentityRegistry(selfIdentityRegistry) {
    this.selfIdentityRegistry = selfIdentityRegistry;
  }

  async ingest(sessionId, verdict, { payoutTx = verdict?.payoutTx } = {}) {
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
      : ["disputed", "inconclusive", "platform_fault"].includes(verdict.outcome)
        ? "disputed"
        : "rejected";

    const badgeSnapshot = session.badgeSnapshot ?? buildBadgeJobSnapshot(job);
    const internalRemediation = isInternalPlatformFaultRemediation(verdict)
      ? verdict.internalRemediation
      : undefined;
    const transitioned = transitionSession({
      ...session,
      // Money-path invariant: the first write that makes a session terminal
      // must carry the chain receipt. Persisting `resolved` first and adding
      // payoutTx in a later upsert made resolved-without-receipt reachable when
      // the second write failed.
      ...(payoutTx ? { payoutTx } : {}),
      ...(badgeSnapshot ? { badgeSnapshot } : {}),
      ...(internalRemediation ? { internalRemediation } : {}),
      verificationSummary: {
        outcome: verdict.outcome,
        reasonCode: verdict.reasonCode,
        handler: verdict.handler,
        ...(verdict.escalatedFrom ? { escalatedFrom: verdict.escalatedFrom } : {}),
        handlerVersion: auditFields.handlerVersion ?? verdict.handlerVersion,
        verifierPolicyVersion: auditFields.verifierPolicyVersion,
        verifierConfigVersion: auditFields.verifierConfigVersion
      }
    }, status, {
      reason: internalRemediation ? "platform_fault_internal_remediation" : "verification_resolved",
      metadata: {
        outcome: verdict.outcome,
        reasonCode: verdict.reasonCode,
        handler: verdict.handler,
        ...(verdict.escalatedFrom ? { escalatedFrom: verdict.escalatedFrom } : {}),
        handlerVersion: auditFields.handlerVersion ?? verdict.handlerVersion,
        verifierPolicyVersion: auditFields.verifierPolicyVersion,
        verifierConfigVersion: auditFields.verifierConfigVersion,
        ...(internalRemediation ? {
          internalRemediationId: internalRemediation.id,
          workerInitiated: false,
          workerConsequence: "none"
        } : {})
      }
    });
    const verificationRecord = {
      ...verdict,
      ...(payoutTx ? { payoutTx } : {}),
      ...auditFields,
      ...(badgeSnapshot ? { badgeSnapshot } : {})
    };
    if (status === "resolved" || status === "rejected" || ["inconclusive", "platform_fault"].includes(verdict.outcome)) {
      // Persist the signed verdict document before committing the terminal
      // session transition. If signing or durable storage fails, verification
      // refuses instead of silently producing a receipt-less final verdict.
      const workReceipt = await this.persistRunReceiptDocument(transitioned, job, verificationRecord);
      if (workReceipt?.receiptId) transitioned.workReceiptId = workReceipt.receiptId;
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
        escalatedFrom: verdict.escalatedFrom,
        handlerVersion: auditFields.handlerVersion ?? verdict.handlerVersion,
        verifierPolicyVersion: auditFields.verifierPolicyVersion,
        verifierConfigVersion: auditFields.verifierConfigVersion,
        ...(internalRemediation ? {
          internalRemediationId: internalRemediation.id,
          workerInitiated: false,
          workerConsequence: "none"
        } : {})
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
      if (typeof this.stateStore.putWorkReceiptDocument !== "function") return undefined;
      try {
        const workReceipt = buildWorkReceipt({ session, job, verification, context });
        const workDocument = this.badgeReceiptSigner
          ? { ...workReceipt, signature: await this.badgeReceiptSigner.signDocument(workReceipt) }
          : workReceipt;
        return await this.stateStore.putWorkReceiptDocument(session.sessionId, workDocument);
      } catch (error) {
        this.logger.warn?.(
          { sessionId: session.sessionId, jobId: session.jobId, error: error?.message },
          "work_receipt_document.persist_failed"
        );
        if (process.env.NODE_ENV === "production") throw error;
        return undefined;
      }
    } catch (error) {
      this.logger.warn?.(
        { sessionId: session.sessionId, jobId: session.jobId, error: error?.message },
        "run_receipt_document.persist_failed"
      );
      throw error;
    }
  }

  async resolveReceiptSignerContext(job) {
    const context = {
      publicBaseUrl: process.env.PUBLIC_BASE_URL,
      publicReceiptBaseUrl: process.env.PUBLIC_SITE_URL ?? "https://averray.com",
      posterAddress: process.env.DEFAULT_POSTER_ADDRESS,
      selfIdentityRegistry: this.selfIdentityRegistry
    };
    if (this.blockchainGateway?.isEnabled?.() && typeof this.blockchainGateway.getJob === "function") {
      try {
        const liveJob = await this.blockchainGateway.getJob(job?.id);
        if (liveJob?.poster) context.posterAddress = liveJob.poster;
      } catch (error) {
        this.logger.warn?.(
          { jobId: job?.id, error: error?.message },
          "work_receipt.poster_chain_read_unavailable"
        );
      }
    }
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
    return requireJobSnapshot(session).job;
  }

  publishWorkflowOutcomeEvent(session, verdict, auditFields, status, timestamp) {
    if (!this.eventBus) {
      return;
    }

    const internalRemediation = isInternalPlatformFaultRemediation(session);
    const disputed = status === "disputed" && !internalRemediation;
    const topic = internalRemediation
      ? "platform.remediation_session_linked"
      : disputed
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
        escalatedFrom: verdict.escalatedFrom,
        handlerVersion: auditFields.handlerVersion ?? verdict.handlerVersion,
        verifierPolicyVersion: auditFields.verifierPolicyVersion,
        verifierConfigVersion: auditFields.verifierConfigVersion,
        disputeId: disputed ? disputeIdForSession(session.sessionId) : undefined,
        internalRemediationId: internalRemediation ? session.internalRemediation.id : undefined,
        workerInitiated: internalRemediation ? false : undefined,
        workerConsequence: internalRemediation ? "none" : undefined
      }
    });
  }
}
