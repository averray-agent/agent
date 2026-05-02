import { randomUUID } from "node:crypto";
import {
  ConflictError,
  InvalidSubmissionShapeError,
  NotFoundError,
  ValidationError
} from "./errors.js";
import { buildSessionLifecycle, describeSessionStatus, transitionSession } from "./session-state-machine.js";
import { hashSubmission, isStructuredSubmission, normalizeSubmission } from "./submission.js";
import { getBuiltinJobSchema, validateAgainstSchema, validateStructuredSubmission } from "./job-schema-registry.js";
import {
  buildFundedJobFromClaim,
  parseGithubPullRequestUrl,
  updateFundedJobFromSession
} from "./funded-jobs.js";
import { computeClaimEconomics, countClaimedSessions } from "./claim-economics.js";
import {
  DEFAULT_OPEN_PR_CAP_PER_REPO,
  countOpenGithubPullRequestsForRepo
} from "./maintainer-surface-policy.js";
import { claimExpiresAt, countClaimAttempts, isExpiredClaim, isTerminalSession } from "./claim-state.js";

export class JobExecutionService {
  constructor(
    stateStore,
    blockchainGateway = undefined,
    getJobDefinition,
    eventBus = undefined,
    accountMutationService = undefined,
    getDefaultClaimStakeBps = async () => 500,
    getClaimableJobDefinition = getJobDefinition,
    getClaimEconomicsConfig = async () => ({}),
    maintainerSurfaceConfig = {}
  ) {
    this.stateStore = stateStore;
    this.blockchainGateway = blockchainGateway;
    this.getJobDefinition = getJobDefinition;
    this.getClaimableJobDefinition = getClaimableJobDefinition;
    this.eventBus = eventBus;
    this.accountMutationService = accountMutationService;
    this.getDefaultClaimStakeBps = getDefaultClaimStakeBps;
    this.getClaimEconomicsConfig = getClaimEconomicsConfig;
    this.openPrCap = Number.isInteger(maintainerSurfaceConfig.openPrCap) && maintainerSurfaceConfig.openPrCap > 0
      ? maintainerSurfaceConfig.openPrCap
      : DEFAULT_OPEN_PR_CAP_PER_REPO;
  }

  async claimJob(wallet, jobId, protocol, idempotencyKey) {
    const existing = await this.stateStore.findSessionByIdempotencyKey(idempotencyKey);
    if (existing) {
      const existingJob = this.getJobDefinition(existing.jobId);
      const refreshed = await this.materializeExpiredClaim(existing, existingJob);
      if (!this.isTerminalSession(refreshed)) {
        return refreshed;
      }
      throw new ConflictError(
        "Idempotency key already belongs to a terminal claim session.",
        "idempotency_key_already_used",
        { sessionId: refreshed.sessionId, jobId: refreshed.jobId, status: refreshed.status }
      );
    }

    const job = this.getClaimableJobDefinition(jobId);
    const activeJobSession = await this.stateStore.findSessionByJobId(jobId);
    const refreshedActiveJobSession = activeJobSession
      ? await this.materializeExpiredClaim(activeJobSession, job)
      : undefined;
    const jobSessions = await this.listJobSessions(jobId);
    const claimAttemptCount = countClaimAttempts(jobSessions);
    if (this.isRetryExhausted(job, claimAttemptCount)) {
      throw new ConflictError(
        `Job ${jobId} exhausted its claim retry budget.`,
        "retry_limit_exhausted",
        { jobId, retryLimit: job.retryLimit, claimAttemptCount }
      );
    }
    const sessionId = this.nextSessionId(jobId, wallet, jobSessions);
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
      if (replay) {
        const replayJob = this.getJobDefinition(replay.jobId);
        const refreshed = await this.materializeExpiredClaim(replay, replayJob);
        if (!this.isTerminalSession(refreshed)) {
          return refreshed;
        }
        throw new ConflictError(
          "Idempotency key already belongs to a terminal claim session.",
          "idempotency_key_already_used",
          { sessionId: refreshed.sessionId, jobId: refreshed.jobId, status: refreshed.status }
        );
      }

      const existingSession = await this.stateStore.getSession(sessionId);
      if (existingSession) {
        const refreshed = await this.materializeExpiredClaim(existingSession, job);
        if (this.isTerminalSession(refreshed)) {
          const refreshedSessions = await this.listJobSessions(jobId);
          if (refreshed.status === "expired" && !this.isRetryExhausted(job, countClaimAttempts(refreshedSessions))) {
            await this.reopenExpiredClaim(jobId);
          } else {
            throw new ConflictError(
              `Job ${jobId} already has a completed session for this wallet. Create or select a different job to run again.`,
              refreshed.status === "expired" ? "retry_limit_exhausted" : "job_session_completed",
              this.buildClaimExpiryDetails(refreshed, job)
            );
          }
        }
        if (!this.isTerminalSession(refreshed)) {
          return refreshed;
        }
      }

      const liveJobSession = refreshedActiveJobSession ?? await this.stateStore.findSessionByJobId(jobId);
      if (liveJobSession && liveJobSession.sessionId !== sessionId) {
        const refreshed = await this.materializeExpiredClaim(liveJobSession, job);
        if (!this.isTerminalSession(refreshed)) {
          throw new ConflictError(
            `Job ${jobId} is already claimed by another wallet.`,
            "job_already_claimed",
            this.buildClaimExpiryDetails(refreshed, job)
          );
        }
        if (refreshed.status === "expired") {
          const refreshedSessions = await this.listJobSessions(jobId);
          if (!this.isRetryExhausted(job, countClaimAttempts(refreshedSessions))) {
            await this.reopenExpiredClaim(jobId);
          } else {
            throw new ConflictError(
              `Job ${jobId} exhausted its claim retry budget.`,
              "retry_limit_exhausted",
              this.buildClaimExpiryDetails(refreshed, job)
            );
          }
        }
      }

      const chainJobId = this.blockchainGateway?.isEnabled()
        ? this.blockchainGateway.toJobId(jobId)
        : jobId;
      const priorClaimCount = countClaimedSessions(await this.collectSessionHistory(wallet));
      const claimEconomicsConfig = await this.getClaimEconomicsConfig();
      let claimEconomics = computeClaimEconomics({
        rewardAmount: job.rewardAmount,
        rewardAsset: job.rewardAsset,
        priorClaimCount,
        claimStakeBps: await this.getDefaultClaimStakeBps(),
        ...claimEconomicsConfig
      });
      if (this.blockchainGateway?.isEnabled()) {
        const live = await this.blockchainGateway.getJob(jobId);
        if (live.state !== 0 && live.state !== 1) {
          throw new ConflictError(`Job ${jobId} is not claimable in its current on-chain state.`, "job_not_claimable");
        }
        if (this.blockchainGateway.ensureJob) {
          await this.blockchainGateway.ensureJob(job, jobId, claimEconomics.totalClaimLock);
        }
        if (typeof this.blockchainGateway.previewClaimEconomics === "function") {
          claimEconomics = await this.blockchainGateway.previewClaimEconomics(wallet, jobId).catch(() => claimEconomics);
        }
        await this.blockchainGateway.ensureClaimStakeLiquidity?.(job.rewardAsset, claimEconomics.totalClaimLock);
        await this.blockchainGateway.claimJob(jobId);
      } else if (claimEconomics.totalClaimLock > 0) {
        await this.accountMutationService?.lockJobStake?.(wallet, job.rewardAsset, claimEconomics.totalClaimLock, undefined);
      }

      const baseSession = {
        sessionId,
        wallet,
        jobId,
        chainJobId,
        claimStake: claimEconomics.claimStake,
        claimStakeBps: claimEconomics.claimStakeBps,
        claimFee: claimEconomics.claimFee,
        claimFeeBps: claimEconomics.claimFeeBps,
        claimEconomicsWaived: claimEconomics.claimEconomicsWaived,
        claimNumber: claimEconomics.claimNumber,
        totalClaimLock: claimEconomics.totalClaimLock,
        idempotencyKey,
        protocolHistory: [protocol]
      };
      const session = transitionSession(baseSession, "claimed", {
        reason: "job_claimed",
        metadata: { protocol, idempotencyKey }
      });

      const persisted = await this.stateStore.upsertSession(session);
      await this.stateStore.upsertFundedJob?.(buildFundedJobFromClaim({ job, session: persisted }));
      this.publishSessionEvent("session.claimed", persisted);
      return persisted;
    } finally {
      await this.stateStore.releaseClaimLock?.(sessionLockId, lockOwner);
    }
  }

  async submitWork(sessionId, protocol, submissionInput = "submitted-via-service") {
    const session = await this.requireSession(sessionId);
    const job = this.getJobDefinition(session.jobId);
    const refreshed = await this.materializeExpiredClaim(session, job);
    if (refreshed.status === "expired") {
      throw new ConflictError(
        `Claim ${sessionId} expired before submission.`,
        "claim_expired",
        this.buildClaimExpiryDetails(refreshed, job)
      );
    }
    if (this.isTerminalSession(refreshed)) {
      throw new ConflictError(
        `Session ${sessionId} is already complete and cannot be submitted.`,
        "job_session_completed",
        this.buildClaimExpiryDetails(refreshed, job)
      );
    }
    const submission = normalizeSubmission(normalizeSubmitPayloadShape(job.outputSchemaRef, submissionInput));
    validateSubmissionContract(job.outputSchemaRef, submission);
    await this.enforceMaintainerOpenPrCap(job, submission);
    if (this.blockchainGateway?.isEnabled()) {
      await this.blockchainGateway.submitWork(session.chainJobId ?? session.jobId, hashSubmission(submission));
    }
    const protocolHistory = [...new Set([...refreshed.protocolHistory, protocol])];
    const transitioned = transitionSession({
      ...refreshed,
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
    const fundedJob = await this.stateStore.getFundedJob?.(persisted.jobId);
    await this.stateStore.upsertFundedJob?.(updateFundedJobFromSession(fundedJob, { job, session: persisted }));
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

  async materializeExpiredClaim(session, job, now = new Date()) {
    if (!isExpiredClaim(session, job, now)) {
      return session;
    }
    const expiredAt = claimExpiresAt(session, job) ?? now.toISOString();
    const transitioned = transitionSession(session, "expired", {
      reason: "claim_ttl_expired",
      timestamp: expiredAt,
      metadata: {
        claimExpiresAt: expiredAt,
        claimTtlSeconds: job?.claimTtlSeconds
      }
    });
    const persisted = await this.stateStore.upsertSession(transitioned);
    const fundedJob = await this.stateStore.getFundedJob?.(persisted.jobId);
    await this.stateStore.upsertFundedJob?.(updateFundedJobFromSession(fundedJob, { job, session: persisted }));
    this.publishSessionEvent("session.expired", persisted, {
      claimExpiresAt: expiredAt,
      reason: "claim_ttl_expired"
    });
    return persisted;
  }

  async reopenExpiredClaim(jobId) {
    if (this.blockchainGateway?.isEnabled() && typeof this.blockchainGateway.handleClaimTimeout === "function") {
      await this.blockchainGateway.handleClaimTimeout(jobId);
    }
  }

  async listJobSessions(jobId, limit = 100) {
    return await this.stateStore.listSessionsByJob?.(jobId, limit) ?? [];
  }

  isRetryExhausted(job, claimAttemptCount) {
    const retryLimit = Number.isInteger(job?.retryLimit) ? job.retryLimit : 1;
    return retryLimit > 0 && claimAttemptCount >= retryLimit;
  }

  nextSessionId(jobId, wallet, sessions = []) {
    const baseSessionId = `${jobId}:${wallet}`;
    const existingIds = new Set(sessions.map((session) => session?.sessionId).filter(Boolean));
    if (!existingIds.has(baseSessionId)) {
      return baseSessionId;
    }
    let attempt = existingIds.size + 1;
    let candidate = `${baseSessionId}:${attempt}`;
    while (existingIds.has(candidate)) {
      attempt += 1;
      candidate = `${baseSessionId}:${attempt}`;
    }
    return candidate;
  }

  buildClaimExpiryDetails(session, job) {
    return {
      sessionId: session?.sessionId,
      jobId: session?.jobId,
      claimedBy: session?.wallet,
      claimedAt: session?.claimedAt,
      claimExpiresAt: claimExpiresAt(session, job) ?? session?.expiredAt,
      claimTtlSeconds: job?.claimTtlSeconds
    };
  }

  getClaimLockTtlSeconds(job) {
    return Math.max(60, Math.min(Number(job?.claimTtlSeconds ?? 300), 900));
  }

  async enforceMaintainerOpenPrCap(job, submission) {
    if (job?.source?.type !== "github_issue" || submission.kind !== "structured") return;
    const parsed = parseGithubPullRequestUrl(submission.structured?.prUrl ?? submission.structured?.pullRequestUrl);
    if (!parsed) return;
    const repo = job.source.repo ?? parsed.repo;
    const openCount = await countOpenGithubPullRequestsForRepo(this.stateStore, repo);
    if (openCount >= this.openPrCap) {
      throw new ConflictError(
        `Repository ${repo} already has ${openCount} open Averray pull request submissions.`,
        "maintainer_open_pr_cap_reached",
        { repo, openCount, openPrCap: this.openPrCap }
      );
    }
  }

  isTerminalSession(session) {
    return isTerminalSession(session);
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

export function normalizeSubmitPayloadShape(schemaRef, submissionInput) {
  if (!isPlainObject(submissionInput) || !isStructuredSubmission(submissionInput.output)) {
    return submissionInput;
  }

  const schema = getBuiltinJobSchema(schemaRef);
  if (!schema) {
    return submissionInput;
  }

  const directValidation = tryValidateAgainstSchema(submissionInput, schema, "submission");
  if (directValidation.ok) {
    return submissionInput;
  }

  const outputValidation = tryValidateAgainstSchema(submissionInput.output, schema, "submission.output");
  if (outputValidation.ok) {
    return submissionInput.output;
  }

  throw new InvalidSubmissionShapeError(
    "Send the structured proposal object directly as submission, not under submission.output.",
    {
      expected: firstRequiredSubmissionPath(schema),
      schemaValidates: "payload.submission",
      received: "payload.submission.output",
      hint: "Move the object currently under submission.output up to submission. Do not wrap the job output under an output key.",
      directError: directValidation.message,
      outputError: outputValidation.message
    }
  );
}

export function validateSubmissionContract(schemaRef, submission, { path = "submission" } = {}) {
  const schema = getBuiltinJobSchema(schemaRef);
  if (!schema) {
    if (submission.kind === "structured") {
      validateStructuredSubmission(schemaRef, submission.structured, { path });
    }
    return submission;
  }

  if (submission.kind !== "structured") {
    throw new ValidationError(
      `Schema-native jobs require payload.submission to be an object matching ${schemaRef}; plain evidence strings are not valid for this job.`,
      {
        schemaRef,
        schemaValidates: "payload.submission",
        received: "payload.evidence",
        expected: firstRequiredSubmissionPath(schema),
        hint: "Submit the direct JSON object shown in /jobs/definition.submissionContract.submitPayloadExample.submission."
      }
    );
  }

  validateStructuredSubmission(schemaRef, submission.structured, { path });
  return submission;
}

function tryValidateAgainstSchema(value, schema, path) {
  try {
    validateAgainstSchema(value, schema, path);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error?.message ?? "invalid submission" };
  }
}

function firstRequiredSubmissionPath(schema) {
  const [firstRequired] = schema?.required ?? [];
  return firstRequired ? `payload.submission.${firstRequired}` : "payload.submission";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
