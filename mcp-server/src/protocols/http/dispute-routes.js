import { AuthorizationError, ValidationError } from "../../core/errors.js";
import {
  ARBITRATOR_SLA_SECONDS,
  addSecondsIso,
  buildDisputeArbitrationSemantics,
  buildDisputeReasoningReceipt,
  buildDisputeResolution,
  disputeIdForSession,
  normalizeDisputeReleaseRequestPayload,
  normalizeDisputeVerdictRequestPayload,
} from "../../core/dispute-resolution.js";
import { transitionSession } from "../../core/session-state-machine.js";

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
  );
}

export function createDisputeRoutes({
  authMiddleware,
  buildScopedIdempotentMutationContext,
  eventBus,
  gateway,
  getIdempotentMutationReplay,
  hasRole,
  parseLimit,
  persistContentRecord,
  publicBaseUrl,
  defaultVerifierAddress,
  readJsonBody,
  respond,
  respondWithMutationReceipt,
  service,
  stateStore,
}) {
  async function resolveRemainingPayout(session) {
    if (gateway?.isEnabled?.() && typeof gateway.getJob === "function") {
      const live = await gateway.getJob(session.chainJobId ?? session.jobId);
      return Math.max(Number(live.reward ?? 0) - Number(live.released ?? 0), 0);
    }
    try {
      const job = service.getJobDefinition(session.jobId);
      return Math.max(Number(job.rewardAmount ?? 0), 0);
    } catch {
      return 0;
    }
  }

  async function buildDisputeFromSession(session) {
    const id = disputeIdForSession(session.sessionId);
    const [verdictReceipt, releaseReceipt] = await Promise.all([
      stateStore.getMutationReceipt?.("dispute_verdict", id),
      stateStore.getMutationReceipt?.("dispute_release", id)
    ]);
    const openedAt = session.disputedAt ?? session.updatedAt ?? new Date().toISOString();
    const windowEndsAt = addSecondsIso(openedAt, ARBITRATOR_SLA_SECONDS);
    const timeline = (session.statusHistory ?? []).map((entry, index) => ({
      id: `${id}:session:${index}`,
      at: entry.at,
      actor: "system",
      action: entry.reason ?? `session_${entry.to}`,
      data: entry
    }));
    if (verdictReceipt) {
      timeline.push({
        id: `${id}:verdict`,
        at: verdictReceipt.decidedAt,
        actor: verdictReceipt.decidedBy,
        action: "verdict_submitted",
        data: verdictReceipt
      });
    }
    if (releaseReceipt) {
      timeline.push({
        id: `${id}:release`,
        at: releaseReceipt.releasedAt,
        actor: releaseReceipt.releasedBy,
        action: "stake_release_recorded",
        data: releaseReceipt
      });
    }

    let job;
    try {
      job = service.getJobDefinition(session.jobId);
    } catch {
      job = undefined;
    }

    return withDisputeArbitration({
      id,
      status: releaseReceipt || verdictReceipt ? "resolved" : "open",
      sessionId: session.sessionId,
      chainJobId: session.chainJobId,
      claimant: session.wallet,
      respondent: defaultVerifierAddress ?? "0x0000000000000000000000000000000000000000",
      openedAt,
      windowEndsAt,
      slaSeconds: ARBITRATOR_SLA_SECONDS,
      evidence: {
        before: compactObject({
          jobId: session.jobId,
          jobTitle: job?.title,
          requirements: job?.verifierTerms,
          claimStake: session.claimStake,
          claimFee: session.claimFee,
          totalClaimLock: session.totalClaimLock
        }),
        after: compactObject({
          submission: session.submission,
          verification: session.verification ?? session.verificationSummary
        })
      },
      verdict: verdictReceipt?.verdict ?? null,
      reasonCode: verdictReceipt?.reasonCode,
      reasoningHash: verdictReceipt?.reasoningHash,
      metadataURI: verdictReceipt?.metadataURI,
      txHash: verdictReceipt?.txHash,
      chainStatus: verdictReceipt?.chainStatus,
      workerPayout: verdictReceipt?.workerPayout,
      remainingPayout: verdictReceipt?.remainingPayout,
      stakedAmount: Number(session.claimStake ?? 0),
      claimFee: Number(session.claimFee ?? 0),
      totalClaimLock: Number(session.totalClaimLock ?? session.claimStake ?? 0),
      release: releaseReceipt ?? null,
      timeline: timeline.sort((left, right) => String(left.at ?? "").localeCompare(String(right.at ?? "")))
    });
  }

  function withDisputeArbitration(dispute) {
    return {
      ...dispute,
      arbitration: buildDisputeArbitrationSemantics(dispute)
    };
  }

  async function listDisputes(limit = 100) {
    const sessions = await service.listRecentSessions(limit);
    const candidates = await Promise.all(
      sessions.map(async (session) => {
        if (session.status === "disputed") {
          return session;
        }
        const id = disputeIdForSession(session.sessionId);
        const [verdictReceipt, releaseReceipt] = await Promise.all([
          stateStore.getMutationReceipt?.("dispute_verdict", id),
          stateStore.getMutationReceipt?.("dispute_release", id)
        ]);
        return verdictReceipt || releaseReceipt ? session : undefined;
      })
    );
    return Promise.all(candidates.filter(Boolean).map((session) => buildDisputeFromSession(session)));
  }

  async function findDispute(id, limit = 250) {
    const disputes = await listDisputes(limit);
    return disputes.find((dispute) => dispute.id === id);
  }

  async function handleDisputeRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/disputes") {
      await authMiddleware(request, url);
      respond(response, 200, await listDisputes(parseLimit(url, 100, 500)));
      return true;
    }

    if (request.method === "GET" && pathname.startsWith("/disputes/")) {
      await authMiddleware(request, url);
      const id = decodeURIComponent(pathname.slice("/disputes/".length));
      if (!id || id.includes("/")) {
        throw new ValidationError("dispute id path segment is required.");
      }
      const dispute = await findDispute(id);
      if (!dispute) {
        respond(response, 404, { status: "not_found", id });
        return true;
      }
      respond(response, 200, dispute);
      return true;
    }

    if (request.method === "POST" && /^\/disputes\/[^/]+\/verdict$/u.test(pathname)) {
      const auth = await authMiddleware(request, url);
      if (!hasRole(auth.claims, "admin") && !hasRole(auth.claims, "verifier")) {
        throw new AuthorizationError("Requires admin or verifier role.", "missing_role");
      }
      const id = decodeURIComponent(pathname.slice("/disputes/".length, -"/verdict".length));
      const dispute = await findDispute(id);
      if (!dispute) {
        respond(response, 404, { status: "not_found", id });
        return true;
      }
      const payload = await readJsonBody(request);
      const idempotency = buildScopedIdempotentMutationContext({
        route: "/disputes/:id/verdict",
        auth,
        scope: id,
        payload,
        normalizedPayload: normalizeDisputeVerdictRequestPayload(id, payload),
        bucket: "dispute_verdict_idempotency"
      });
      const replay = await getIdempotentMutationReplay(idempotency);
      if (replay) {
        respond(response, replay.statusCode, replay.body);
        return true;
      }
      if (dispute.verdict || dispute.reasonCode) {
        await respondWithMutationReceipt(response, idempotency, 200, dispute);
        return true;
      }
      const session = await service.resumeSession(dispute.sessionId);
      const decidedAt = new Date().toISOString();
      const remainingPayout = await resolveRemainingPayout(session);
      const resolution = buildDisputeResolution({
        verdict: payload?.verdict ?? payload?.outcome,
        remainingPayout,
        workerPayout: payload?.workerPayout ?? payload?.payoutAmount
      });
      const reasoning = buildDisputeReasoningReceipt({
        id,
        dispute,
        payload,
        auth,
        verdict: resolution.verdict,
        decidedAt,
        publicBaseUrl
      });
      await persistContentRecord(reasoning.contentRecord);
      const chainReceipt = gateway?.isEnabled?.() && typeof gateway.resolveDispute === "function"
        ? await gateway.resolveDispute(
            session.chainJobId ?? session.jobId,
            resolution.workerPayout,
            resolution.reasonCode,
            reasoning.metadataURI
          )
        : {
            txHash: undefined,
            blockNumber: undefined,
            status: undefined
          };
      const receipt = {
        id,
        disputeId: id,
        sessionId: dispute.sessionId,
        jobId: session.jobId,
        chainJobId: session.chainJobId,
        verdict: resolution.verdict,
        workerPayout: resolution.workerPayout,
        remainingPayout,
        reasonCode: resolution.reasonCode,
        reasoningHash: reasoning.reasoningHash,
        metadataURI: reasoning.metadataURI,
        rationale: reasoning.rationale || undefined,
        releaseAction: resolution.releaseAction,
        payoutSource: resolution.payoutSource,
        txHash: chainReceipt.txHash,
        blockNumber: chainReceipt.blockNumber,
        chainStatus: gateway?.isEnabled?.()
          ? (chainReceipt.status === 1 ? "confirmed" : "submitted")
          : "local_only",
        decidedBy: auth.wallet,
        decidedAt
      };
      await stateStore.upsertMutationReceipt?.("dispute_verdict", id, receipt);
      if (session.status === "disputed") {
        const transitioned = transitionSession(session, resolution.nextSessionStatus, {
          reason: resolution.reasonCode,
          timestamp: decidedAt,
          metadata: {
            disputeId: id,
            verdict: resolution.verdict,
            workerPayout: resolution.workerPayout,
            reasonCode: resolution.reasonCode,
            txHash: receipt.txHash
          }
        });
        await stateStore.upsertSession?.(transitioned);
      }
      eventBus?.publish({
        id: `dispute-verdict-${id}-${Date.now()}`,
        topic: "dispute.verdict_recorded",
        wallet: dispute.claimant,
        wallets: [dispute.claimant, auth.wallet],
        jobId: session.jobId,
        sessionId: dispute.sessionId,
        timestamp: receipt.decidedAt,
        correlationId: dispute.sessionId,
        txHash: receipt.txHash,
        blockNumber: receipt.blockNumber,
        source: "settlement",
        phase: "dispute",
        severity: resolution.verdict === "dismissed" ? "info" : "warn",
        data: {
          disputeId: id,
          jobId: session.jobId,
          chainJobId: session.chainJobId,
          openedAt: dispute.openedAt,
          windowEndsAt: dispute.windowEndsAt,
          slaSeconds: dispute.slaSeconds,
          verdict: resolution.verdict,
          workerPayout: resolution.workerPayout,
          reasonCode: resolution.reasonCode,
          reasoningHash: receipt.reasoningHash,
          metadataURI: receipt.metadataURI,
          txHash: receipt.txHash,
          blockNumber: receipt.blockNumber,
          chainStatus: receipt.chainStatus
        }
      });
      const body = withDisputeArbitration({
        ...dispute,
        status: "resolved",
        verdict: resolution.verdict,
        reasonCode: resolution.reasonCode,
        reasoningHash: reasoning.reasoningHash,
        metadataURI: reasoning.metadataURI,
        txHash: receipt.txHash,
        chainStatus: receipt.chainStatus,
        workerPayout: resolution.workerPayout,
        remainingPayout,
        timeline: [
          ...dispute.timeline,
          {
            id: `${id}:verdict`,
            at: receipt.decidedAt,
            actor: receipt.decidedBy,
            action: "verdict_submitted",
            data: receipt
          }
        ]
      });
      await respondWithMutationReceipt(response, idempotency, 200, body);
      return true;
    }

    if (request.method === "POST" && /^\/disputes\/[^/]+\/release$/u.test(pathname)) {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      const id = decodeURIComponent(pathname.slice("/disputes/".length, -"/release".length));
      const dispute = await findDispute(id);
      if (!dispute) {
        respond(response, 404, { status: "not_found", id });
        return true;
      }
      const payload = await readJsonBody(request);
      const idempotency = buildScopedIdempotentMutationContext({
        route: "/disputes/:id/release",
        auth,
        scope: id,
        payload,
        normalizedPayload: normalizeDisputeReleaseRequestPayload(id, dispute, payload),
        bucket: "dispute_release_idempotency"
      });
      const replay = await getIdempotentMutationReplay(idempotency);
      if (replay) {
        respond(response, replay.statusCode, replay.body);
        return true;
      }
      if (dispute.release) {
        await respondWithMutationReceipt(response, idempotency, 200, dispute);
        return true;
      }
      if (!dispute.arbitration?.release?.ready) {
        throw new ValidationError("dispute release requires a recorded arbitration verdict first.", {
          disputeId: id,
          reason: dispute.arbitration?.release?.reason ?? "awaiting_arbitrator_verdict"
        });
      }
      const session = await service.resumeSession(dispute.sessionId).catch(() => undefined);
      const receipt = {
        id,
        disputeId: id,
        sessionId: dispute.sessionId,
        jobId: session?.jobId,
        chainJobId: session?.chainJobId,
        action: typeof payload?.action === "string" && payload.action.trim() ? payload.action.trim() : "release",
        amount: Number(payload?.amount ?? dispute.stakedAmount ?? 0),
        chainStatus: dispute.txHash ? "settled_by_verdict" : "local_only",
        txHash: dispute.txHash,
        releasedBy: auth.wallet,
        releasedAt: new Date().toISOString()
      };
      await stateStore.upsertMutationReceipt?.("dispute_release", id, receipt);
      eventBus?.publish({
        id: `dispute-release-${id}-${Date.now()}`,
        topic: "settlement.stake_release_recorded",
        wallet: dispute.claimant,
        wallets: [dispute.claimant, auth.wallet],
        jobId: session?.jobId,
        sessionId: dispute.sessionId,
        timestamp: receipt.releasedAt,
        correlationId: dispute.sessionId,
        txHash: receipt.txHash,
        source: "settlement",
        phase: "settlement",
        severity: "info",
        data: {
          disputeId: id,
          jobId: session?.jobId,
          chainJobId: session?.chainJobId,
          openedAt: dispute.openedAt,
          windowEndsAt: dispute.windowEndsAt,
          amount: receipt.amount,
          action: receipt.action,
          chainStatus: receipt.chainStatus,
          txHash: receipt.txHash
        }
      });
      const body = withDisputeArbitration({
        ...dispute,
        status: "resolved",
        release: receipt,
        timeline: [
          ...dispute.timeline,
          {
            id: `${id}:release`,
            at: receipt.releasedAt,
            actor: receipt.releasedBy,
            action: "stake_release_recorded",
            data: receipt
          }
        ]
      });
      await respondWithMutationReceipt(response, idempotency, 200, body);
      return true;
    }

    return false;
  }

  return {
    findDispute,
    handleDisputeRoute,
    listDisputes,
  };
}
