import { randomUUID } from "node:crypto";
import {
  ConflictError,
  NotFoundError
} from "./errors.js";
import { buildSessionLifecycle, describeSessionStatus, transitionSession } from "./session-state-machine.js";
import { hashSubmission, normalizeSubmission } from "./submission.js";
import { getBuiltinJobSchema, validateStructuredSubmission } from "./job-schema-registry.js";

export class JobExecutionService {
  constructor(
    stateStore,
    blockchainGateway = undefined,
    getJobDefinition,
    eventBus = undefined,
    accountMutationService = undefined,
    getDefaultClaimStakeBps = async () => 500
  ) {
    this.stateStore = stateStore;
    this.blockchainGateway = blockchainGateway;
    this.getJobDefinition = getJobDefinition;
    this.eventBus = eventBus;
    this.accountMutationService = accountMutationService;
    this.getDefaultClaimStakeBps = getDefaultClaimStakeBps;
  }

  async claimJob(wallet, jobId, protocol, idempotencyKey) {
    const existing = await this.stateStore.findSessionByIdempotencyKey(idempotencyKey);
    if (existing && !this.isTerminalSession(existing)) {
      return existing;
    }

    const job = this.getJobDefinition(jobId);
    const sessionId = `${jobId}:${wallet}`;
    const sessionLockId = sessionId;
    const lockOwner = randomUUID();
    const lockAcquired = await this.stateStore.acquireClaimLock?.(
      sessionLockId,
      lockOwner,
      this.getClaimLockTtlSeconds(job)
    );

    if (lockAcquired === false) {
      const racedSession = await this.stateStore.getSession(sessionId);
      if (racedSession) {
        return racedSession;
      }
      throw new ConflictError(`Claim already in progress for ${sessionId}`, "claim_in_progress");
    }

    try {
      const replay = await this.stateStore.findSessionByIdempotencyKey(idempotencyKey);
      if (replay && !this.isTerminalSession(replay)) {
        return replay;
      }

      const existingSession = await this.stateStore.getSession(sessionId);
      if (existingSession) {
        if (this.isTerminalSession(existingSession)) {
          throw new ConflictError(
            `Job ${jobId} already has a completed session for this wallet. Create or select a different job to run again.`,
            "job_session_completed"
          );
        }
        return existingSession;
      }

      const liveJobSession = await this.stateStore.findSessionByJobId(jobId);
      if (liveJobSession && liveJobSession.sessionId !== sessionId) {
        throw new ConflictError(`Job ${jobId} is already claimed by another wallet.`, "job_already_claimed");
      }

      const chainJobId = this.blockchainGateway?.isEnabled()
        ? this.blockchainGateway.toJobId(jobId)
        : jobId;
      const claimStakeBps = await this.getDefaultClaimStakeBps();
      const claimStake = Math.max((Number(job.rewardAmount ?? 0) * claimStakeBps) / 10_000, 0);
      if (this.blockchainGateway?.isEnabled()) {
        const live = await this.blockchainGateway.getJob(jobId);
        if (live.state !== 0 && live.state !== 1) {
          throw new ConflictError(`Job ${jobId} is not claimable in its current on-chain state.`, "job_not_claimable");
        }
        if (this.blockchainGateway.ensureJob) {
          await this.blockchainGateway.ensureJob(job, jobId, claimStake);
        }
        await this.blockchainGateway.ensureClaimStakeLiquidity?.(job.rewardAsset, claimStake);
        await this.blockchainGateway.claimJob(jobId);
      } else if (claimStake > 0) {
        await this.accountMutationService?.lockJobStake?.(wallet, job.rewardAsset, claimStake, undefined);
      }

      const baseSession = {
        sessionId,
        wallet,
        jobId,
        chainJobId,
        claimStake,
        claimStakeBps,
        idempotencyKey,
        protocolHistory: [protocol]
      };
      const session = transitionSession(baseSession, "claimed", {
        reason: "job_claimed",
        metadata: { protocol, idempotencyKey }
      });

      const persisted = await this.stateStore.upsertSession(session);
      this.publishSessionEvent("session.claimed", persisted);
      return persisted;
    } finally {
      await this.stateStore.releaseClaimLock?.(sessionLockId, lockOwner);
    }
  }

  async submitWork(sessionId, protocol, submissionInput = "submitted-via-service") {
    const session = await this.requireSession(sessionId);
    const job = this.getJobDefinition(session.jobId);
    const submission = normalizeSubmission(submissionInput);
    if (submission.kind === "structured") {
      validateStructuredSubmission(job.outputSchemaRef, submission.structured, { path: "submission" });
    }
    if (this.blockchainGateway?.isEnabled()) {
      await this.blockchainGateway.submitWork(session.chainJobId ?? session.jobId, hashSubmission(submission));
    }
    const protocolHistory = [...new Set([...session.protocolHistory, protocol])];
    const transitioned = transitionSession({
      ...session,
      protocolHistory,
      submission,
      outputSchemaBuiltin: Boolean(getBuiltinJobSchema(job.outputSchemaRef))
    }, "submitted", {
      reason: "work_submitted",
      metadata: {
        protocol,
        submissionKind: submission.kind,
        schemaRef: job.outputSchemaRef
      }
    });
    const persisted = await this.stateStore.upsertSession(transitioned);
    this.publishSessionEvent("session.submitted", persisted, {
      submissionKind: submission.kind,
      schemaRef: job.outputSchemaRef
    });
    return persisted;
  }

  async resumeSession(sessionId) {
    return this.requireSession(sessionId);
  }

  async listSessionHistory({ wallet = undefined, limit = 10, jobId = undefined } = {}) {
    let sessions = [];
    if (wallet) {
      sessions = await this.stateStore.listSessionsByWallet?.(wallet, limit) ?? [];
      if (jobId) {
        sessions = sessions.filter((session) => session.jobId === jobId);
      }
    } else if (jobId) {
      sessions = await this.stateStore.listSessionsByJob?.(jobId, limit) ?? [];
    }

    return Promise.all(
      sessions.map(async (session) => ({
        ...session,
        verification: await this.stateStore.getVerificationResult(session.sessionId) ?? undefined
      }))
    );
  }

  async listRecentSessions(limit = 10) {
    const sessions = await this.stateStore.listRecentSessions?.(limit) ?? [];
    return Promise.all(
      sessions.map(async (session) => ({
        ...session,
        verification: await this.stateStore.getVerificationResult(session.sessionId) ?? undefined
      }))
    );
  }

  /**
   * Walk every session belonging to `wallet`, paginating through the
   * state store so lifetime aggregates like the agent-profile totals
   * don't silently truncate at the first page. Each session comes back
   * enriched with its `verification` record, matching the shape of
   * `listSessionHistory`.
   *
   * `pageSize` sets the per-request batch size (defaults to 64). `maxSessions`
   * is a hard cap on total sessions collected so a wallet with runaway
   * history can't tie up the process indefinitely; exceeding it logs a
   * warning and returns what was collected so far.
   */
  async collectSessionHistory(wallet, { pageSize = 64, maxSessions = 10_000, logger = console } = {}) {
    if (!wallet || typeof this.stateStore.listSessionsByWallet !== "function") {
      return [];
    }
    const collected = [];
    let offset = 0;
    while (collected.length < maxSessions) {
      const page = await this.stateStore.listSessionsByWallet(wallet, pageSize, offset);
      if (!Array.isArray(page) || page.length === 0) {
        break;
      }
      collected.push(...page);
      if (page.length < pageSize) {
        break;
      }
      offset += pageSize;
    }
    if (collected.length >= maxSessions) {
      logger.warn?.(
        { wallet, collected: collected.length, maxSessions },
        "session-history.max_cap_reached"
      );
    }
    return Promise.all(
      collected.map(async (session) => ({
        ...session,
        verification: await this.stateStore.getVerificationResult(session.sessionId) ?? undefined
      }))
    );
  }

  async requireSession(sessionId) {
    const session = await this.stateStore.getSession(sessionId);
    if (!session) {
      throw new NotFoundError(`Unknown session: ${sessionId}`, "session_not_found");
    }
    return session;
  }

  getClaimLockTtlSeconds(job) {
    return Math.max(60, Math.min(Number(job?.claimTtlSeconds ?? 300), 900));
  }

  isTerminalSession(session) {
    return ["resolved", "rejected", "closed", "expired", "timed_out"].includes(session?.status);
  }

  publishSessionEvent(topic, session, data = {}) {
    if (!this.eventBus) {
      return;
    }

    this.eventBus.publish({
      id: `platform-${topic}-${session.sessionId}-${Date.now()}`,
      topic,
      wallet: session.wallet,
      wallets: [session.wallet],
      jobId: session.jobId,
      sessionId: session.sessionId,
      timestamp: new Date().toISOString(),
      correlationId: session.sessionId,
      data: {
        sessionId: session.sessionId,
        wallet: session.wallet,
        jobId: session.jobId,
        status: session.status,
        lifecycle: buildSessionLifecycle(session),
        phase: describeSessionStatus(session.status).phase,
        protocolHistory: session.protocolHistory,
        ...data
      }
    });
  }
}
