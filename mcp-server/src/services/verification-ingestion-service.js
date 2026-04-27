import { transitionSession } from "../core/session-state-machine.js";
import { updateFundedJobFromSession } from "../core/funded-jobs.js";

export class VerificationIngestionService {
  constructor(stateStore, eventBus = undefined) {
    this.stateStore = stateStore;
    this.eventBus = eventBus;
  }

  async ingest(sessionId, verdict) {
    const session = sessionId
      ? await this.stateStore.getSession(sessionId)
      : await this.stateStore.findSessionByJobId(verdict.jobId);
    if (!session) {
      return undefined;
    }

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
        handlerVersion: verdict.handlerVersion
      }
    }, status, {
      reason: "verification_resolved",
      metadata: {
        outcome: verdict.outcome,
        reasonCode: verdict.reasonCode,
        handler: verdict.handler
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
        status
      }
    });
    return updatedSession;
  }
}
