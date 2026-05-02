import { createStateStore } from "./state-store.js";
import { AccountMutationService } from "./account-mutation-service.js";
import { JobCatalogService } from "./job-catalog-service.js";
import {
  JobExecutionService,
  normalizeSubmitPayloadShape,
  validateSubmissionContract
} from "./job-execution-service.js";
import { VerificationIngestionService } from "../services/verification-ingestion-service.js";
import { ValidationError } from "./errors.js";
import { normalizeSubmission } from "./submission.js";
import { buildPlatformCapabilities } from "./discovery-manifest.js";
import {
  buildSessionLifecycle,
  describeSessionStatus,
  getSessionStateMachineDefinition
} from "./session-state-machine.js";
import { computeClaimEconomics, countClaimedSessions } from "./claim-economics.js";
import { claimStatusFields, isTerminalSession, summarizeJobClaimState } from "./claim-state.js";

const STARTER_REPUTATION = {
  skill: 0,
  reliability: 0,
  economic: 0,
  tier: "starter"
};

const INGESTION_PROVIDER_DEFINITIONS = [
  ["github", "githubIngestion", "GitHub issues", "queryCount"],
  ["wikipedia", "wikipediaIngestion", "Wikipedia maintenance", "categoryCount"],
  ["osv", "osvIngestion", "OSV advisories", "targetCount"],
  ["openData", "openDataIngestion", "Open data", "targetCount"],
  ["standards", "standardsIngestion", "Standards freshness", "specCount"],
  ["openApi", "openApiIngestion", "OpenAPI quality", "specCount"]
];

const DEFAULT_TREASURY_POLICY_STATUS = {
  enabled: false,
  policyAddress: undefined,
  paused: undefined,
  owner: undefined,
  pauser: undefined,
  risk: {}
};

export class PlatformService {
  constructor(
    jobs,
    profiles,
    accounts,
    reputations,
    blockchainGateway = undefined,
    stateStore = createStateStore(),
    eventBus = undefined,
    recurringScheduler = undefined
  ) {
    this.jobs = jobs;
    this.profiles = profiles;
    this.accounts = accounts;
    this.reputations = reputations;
    this.blockchainGateway = blockchainGateway;
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    this.recurringScheduler = recurringScheduler;
    this.githubIssueIngestionScheduler = undefined;
    this.wikipediaMaintenanceIngestionScheduler = undefined;
    this.osvAdvisoryIngestionScheduler = undefined;
    this.openDataIngestionScheduler = undefined;
    this.standardsSpecIngestionScheduler = undefined;
    this.openApiSpecIngestionScheduler = undefined;
    this.jobStaleSweeper = undefined;
    this.xcmSettlementWatcher = undefined;
    this.xcmObservationRelay = undefined;
    this.upstreamStatusPoller = undefined;

    this.accountMutationService = new AccountMutationService(
      this.accounts,
      this.blockchainGateway,
      this.getAccountSummary.bind(this)
    );
    this.jobCatalogService = new JobCatalogService(
      this.jobs,
      this.profiles,
      this.getAccountSummary.bind(this),
      this.getReputation.bind(this),
      this.getDefaultClaimStakeBps.bind(this),
      this.getClaimEconomicsPreview.bind(this)
    );
    this.jobExecutionService = new JobExecutionService(
      this.stateStore,
      this.blockchainGateway,
      this.getJobDefinition.bind(this),
      this.eventBus,
      this.accountMutationService,
      this.getDefaultClaimStakeBps.bind(this),
      this.getClaimableJobDefinition.bind(this),
      this.getClaimEconomicsConfig.bind(this)
    );
    this.verificationIngestionService = new VerificationIngestionService(this.stateStore, this.eventBus);
  }

  getPlatformCapabilities() {
    return buildPlatformCapabilities();
  }

  getSessionStateMachine() {
    return {
      timelineVersion: "v2",
      statuses: getSessionStateMachineDefinition()
    };
  }

  listJobs(options = {}) {
    return this.jobCatalogService.listJobs(options);
  }

  /**
   * Same as `listJobs`, but joins active-session state onto each row.
   *
   * Today the catalog stores immutable job documents — claiming a job
   * only writes a Session into the state store, never mutates the job
   * itself. That left the public `/jobs` feed with `state`,
   * `claimedBy`, and `sessionId` permanently null even after a worker
   * had locked a job in. The operator queue + ready-to-claim cards
   * also rendered claimed jobs as still claimable.
   *
   * Joining sessions on read keeps the catalog clean and fixes the
   * surface in one place: any list endpoint that wants run-state
   * visibility calls this method instead of `listJobs`.
   */
  async listJobsWithSessions(options = {}) {
    const { wallet, currentWallet, now = new Date(), ...catalogOptions } = options;
    const jobs = this.jobCatalogService.listJobs({ ...catalogOptions, now });
    return Promise.all(
      jobs.map((job) => this.attachClaimState(job, { wallet: currentWallet ?? wallet, now }))
    );
  }

  createJob(input) {
    return this.jobCatalogService.createJob(input);
  }

  updateJobLifecycle(jobId, patch = {}) {
    return this.jobCatalogService.updateJobLifecycle(jobId, patch);
  }

  getJobLifecycleSummary() {
    return this.jobCatalogService.getJobLifecycleSummary();
  }

  getRecurringTemplateStatus() {
    return this.jobCatalogService.getRecurringTemplateStatus();
  }

  fireRecurringJob(templateId, options = {}) {
    return this.jobCatalogService.fireRecurringJob(templateId, options);
  }

  pauseRecurringTemplate(templateId) {
    return this.jobCatalogService.pauseRecurringTemplate(templateId);
  }

  resumeRecurringTemplate(templateId) {
    return this.jobCatalogService.resumeRecurringTemplate(templateId);
  }

  async getAdminStatus({ auth = undefined } = {}) {
    const [
      policy,
      recurring,
      scheduler,
      githubIngestion,
      wikipediaIngestion,
      osvIngestion,
      openDataIngestion,
      standardsIngestion,
      openApiIngestion,
      upstreamStatus,
      jobStaleSweeper,
      recentSessions
    ] = await Promise.all([
      getTreasuryPolicyStatusSafely(this.blockchainGateway),
      this.jobCatalogService.getRecurringTemplateStatus(),
      this.recurringScheduler?.getStatus?.() ?? { enabled: false, running: false, templates: [] },
      this.githubIssueIngestionScheduler?.getStatus?.() ?? {
        enabled: false,
        running: false,
        dryRun: true,
        intervalMs: 0,
        queryCount: 0,
        minScore: 0,
        maxJobsPerRun: 0,
        maxOpenJobs: 0,
        currentOpenJobs: 0,
        lastRun: undefined
      },
      this.wikipediaMaintenanceIngestionScheduler?.getStatus?.() ?? {
        enabled: false,
        running: false,
        dryRun: true,
        intervalMs: 0,
        language: "en",
        categoryCount: 0,
        minScore: 0,
        maxJobsPerRun: 0,
        maxOpenJobs: 0,
        currentOpenJobs: 0,
        lastRun: undefined
      },
      this.osvAdvisoryIngestionScheduler?.getStatus?.() ?? {
        enabled: false,
        running: false,
        dryRun: true,
        intervalMs: 0,
        packageCount: 0,
        minScore: 0,
        maxJobsPerRun: 0,
        maxOpenJobs: 0,
        currentOpenJobs: 0,
        lastRun: undefined
      },
      this.openDataIngestionScheduler?.getStatus?.() ?? {
        enabled: false,
        running: false,
        dryRun: true,
        intervalMs: 0,
        query: undefined,
        datasetCount: 0,
        minScore: 0,
        maxJobsPerRun: 0,
        maxOpenJobs: 0,
        currentOpenJobs: 0,
        lastRun: undefined
      },
      this.standardsSpecIngestionScheduler?.getStatus?.() ?? {
        enabled: false,
        running: false,
        dryRun: true,
        intervalMs: 0,
        specCount: 0,
        minScore: 0,
        maxJobsPerRun: 0,
        maxOpenJobs: 0,
        currentOpenJobs: 0,
        lastRun: undefined
      },
      this.openApiSpecIngestionScheduler?.getStatus?.() ?? {
        enabled: false,
        running: false,
        dryRun: true,
        intervalMs: 0,
        specCount: 0,
        minScore: 0,
        maxJobsPerRun: 0,
        maxOpenJobs: 0,
        currentOpenJobs: 0,
        lastRun: undefined
      },
      this.upstreamStatusPoller?.getStatus?.() ?? {
        enabled: false,
        running: false,
        intervalMs: 0,
        batchSize: 0,
        lastRun: undefined
      },
      this.jobStaleSweeper?.getStatus?.() ?? {
        enabled: false,
        running: false,
        dryRun: true,
        mode: "dry_run",
        intervalMs: 0,
        action: "archive",
        maxJobsPerRun: 0,
        lastRun: undefined
      },
      this.jobExecutionService.listRecentSessions(14)
    ]);
    const recentEvents = this.eventBus?.replay?.({}, undefined)?.events ?? [];
    const activeStatuses = new Set(["claimed", "submitted", "disputed", "rejected"]);
    const activeSessions = recentSessions.filter((session) => activeStatuses.has(session.status));
    const wallets = new Set(recentSessions.map((session) => session.wallet).filter(Boolean));
    const topJobs = [...recentSessions.reduce((accumulator, session) => {
      const current = accumulator.get(session.jobId) ?? {
        jobId: session.jobId,
        totalRuns: 0,
        activeRuns: 0,
        latestStatus: session.status,
        latestAt: session.updatedAt
      };
      current.totalRuns += 1;
      if (activeStatuses.has(session.status)) {
        current.activeRuns += 1;
      }
      if (String(session.updatedAt ?? "") > String(current.latestAt ?? "")) {
        current.latestAt = session.updatedAt;
        current.latestStatus = session.status;
      }
      accumulator.set(session.jobId, current);
      return accumulator;
    }, new Map()).values()]
      .sort((left, right) => {
        if (right.activeRuns !== left.activeRuns) return right.activeRuns - left.activeRuns;
        if (right.totalRuns !== left.totalRuns) return right.totalRuns - left.totalRuns;
        return String(right.latestAt ?? "").localeCompare(String(left.latestAt ?? ""));
      })
      .slice(0, 5);
    const anomalies = [];
    if (policy?.paused) {
      anomalies.push({
        severity: "high",
        code: "policy_paused",
        message: "Treasury policy is paused."
      });
    }
    if (policy?.error) {
      anomalies.push({
        severity: "medium",
        code: "policy_status_unavailable",
        message: "Treasury policy status is unavailable.",
        details: policy.error
      });
    }
    for (const template of scheduler.templates ?? []) {
      if (template.lastResult?.status === "failed" || template.lastResult?.status === "invalid_schedule") {
        anomalies.push({
          severity: "medium",
          code: "recurring_attention",
          templateId: template.templateId,
          message: `Recurring template ${template.templateId} needs attention (${template.lastResult.status}).`
        });
      }
    }
    const providerOperations = buildProviderOperations({
      githubIngestion,
      wikipediaIngestion,
      osvIngestion,
      openDataIngestion,
      standardsIngestion,
      openApiIngestion
    });

    return {
      auth: auth
        ? {
            wallet: auth.wallet,
            roles: auth.claims?.roles ?? [],
            capabilities: auth.capabilities ?? []
          }
        : undefined,
      anomalies,
      ops: {
        recentSessions: recentSessions.map((session) => ({
          sessionId: session.sessionId,
          wallet: session.wallet,
          jobId: session.jobId,
          status: session.status,
          outcome: session.verification?.outcome,
          claimStake: session.claimStake ?? 0,
          claimFee: session.claimFee ?? 0,
          totalClaimLock: session.totalClaimLock ?? session.claimStake ?? 0,
          updatedAt: session.updatedAt
        })),
        recentEvents: recentEvents.slice(-10).reverse(),
        activeSessions: activeSessions.length,
        activeWallets: wallets.size,
        totalCapitalAtWork: activeSessions.reduce(
          (sum, session) => sum + (Number(session.totalClaimLock ?? session.claimStake) || 0),
          0
        ),
        resolvedRecently: recentSessions.filter((session) => session.status === "resolved").length,
        topJobs
      },
      maintenance: {
        policy,
        release: {
          checklistDoc: "https://github.com/depre-dev/agent/blob/main/docs/PRODUCTION_CHECKLIST.md",
          incidentDoc: "https://github.com/depre-dev/agent/blob/main/docs/INCIDENT_RESPONSE.md",
          multisigDoc: "https://github.com/depre-dev/agent/blob/main/docs/MULTISIG_SETUP.md"
        }
      },
      recurring: recurring,
      jobLifecycle: this.jobCatalogService.getJobLifecycleSummary(),
      jobStaleSweeper,
      scheduler,
      providerOperations,
      githubIngestion: githubIngestion,
      wikipediaIngestion: wikipediaIngestion,
      osvIngestion: osvIngestion,
      openDataIngestion: openDataIngestion,
      standardsIngestion: standardsIngestion,
      openApiIngestion: openApiIngestion,
      upstreamStatus,
      xcmSettlementWatcher: await this.xcmSettlementWatcher?.getStatus?.() ?? {
        enabled: false,
        running: false,
        pendingCount: 0,
        pending: []
      },
      xcmObservationRelay: await this.xcmObservationRelay?.getStatus?.() ?? {
        enabled: false,
        running: false,
        syncing: false,
        feedUrl: undefined,
        batchSize: 0,
        pollIntervalMs: 0,
        cursor: undefined,
        lastObservedCount: 0,
        lastSyncedAt: undefined,
        lastError: undefined,
        updatedAt: undefined
      }
    };
  }

  getJobDefinition(jobId) {
    return this.jobCatalogService.getJobDefinition(jobId);
  }

  async getPublicJobDefinition(jobId, options = {}) {
    const { wallet, currentWallet, now = new Date() } = options;
    return this.attachClaimState(
      this.jobCatalogService.getPublicJobDefinition(jobId),
      { wallet: currentWallet ?? wallet, now }
    );
  }

  validateJobSubmission(jobId, submissionInput) {
    const job = this.getJobDefinition(jobId);
    try {
      const normalized = normalizeSubmission(normalizeSubmitPayloadShape(job.outputSchemaRef, submissionInput));
      validateSubmissionContract(job.outputSchemaRef, normalized);
      return {
        jobId,
        valid: true,
        schemaRef: job.outputSchemaRef,
        schemaValidates: "payload.submission",
        submissionKind: normalized.kind,
        normalizedSubmission: normalized.kind === "structured" ? normalized.structured : normalized.rawText
      };
    } catch (error) {
      return {
        jobId,
        valid: false,
        schemaRef: job.outputSchemaRef,
        schemaValidates: "payload.submission",
        code: error?.code ?? "invalid_submission",
        message: error?.message ?? "Invalid submission.",
        details: error?.details
      };
    }
  }

  getClaimableJobDefinition(jobId) {
    return this.jobCatalogService.getClaimableJobDefinition(jobId);
  }

  async recommendJobs(wallet) {
    return this.jobCatalogService.recommendJobs(wallet);
  }

  async tierLadder(wallet) {
    return this.jobCatalogService.tierLadder(wallet);
  }

  async preflightJob(wallet, jobId) {
    const [preflight, job] = await Promise.all([
      this.jobCatalogService.preflightJob(wallet, jobId),
      this.getPublicJobDefinition(jobId, { wallet })
    ]);
    return {
      ...preflight,
      catalogEligible: preflight.eligible,
      eligible: preflight.eligible && job.claimable === true && job.currentWalletCanClaim !== false,
      claimStatus: job.claimStatus,
      claimState: job.claimState,
      claimable: job.claimable,
      currentWalletCanClaim: job.currentWalletCanClaim,
      reason: job.reason,
      claimedBy: job.claimedBy,
      claimedAt: job.claimedAt,
      claimExpiresAt: job.claimExpiresAt,
      retryLimit: job.retryLimit,
      sessionId: job.sessionId
    };
  }

  async explainEligibility(wallet, jobId) {
    return this.jobCatalogService.explainEligibility(wallet, jobId);
  }

  async estimateNetReward(wallet, jobId) {
    return this.jobCatalogService.estimateNetReward(wallet, jobId);
  }

  async claimJob(wallet, jobId, protocol, idempotencyKey) {
    return this.jobExecutionService.claimJob(wallet, jobId, protocol, idempotencyKey);
  }

  async submitWork(sessionId, protocol, evidence = "submitted-via-service") {
    return this.jobExecutionService.submitWork(sessionId, protocol, evidence);
  }

  async resumeSession(sessionId) {
    return this.jobExecutionService.resumeSession(sessionId);
  }

  async attachClaimState(job, { wallet = undefined, now = new Date() } = {}) {
    const session = await this.stateStore.findSessionByJobId?.(job.id);
    const refreshedSession = session
      ? await this.jobExecutionService.materializeExpiredClaim(session, job, now)
      : undefined;
    const sessions = await this.stateStore.listSessionsByJob?.(job.id, 100) ?? (
      refreshedSession ? [refreshedSession] : []
    );
    const claimStatus = summarizeJobClaimState({
      job,
      session: refreshedSession,
      sessions,
      wallet,
      now
    });
    return {
      ...job,
      ...claimStatusFields(claimStatus)
    };
  }

  async listSessionHistory({ wallet = undefined, limit = 10, jobId = undefined } = {}) {
    return this.jobExecutionService.listSessionHistory({ wallet, limit, jobId });
  }

  async listRecentSessions(limit = 10) {
    return this.jobExecutionService.listRecentSessions(limit);
  }

  async getSessionTimeline(sessionId) {
    const session = await this.jobExecutionService.resumeSession(sessionId);
    const verification = await this.stateStore.getVerificationResult(sessionId)
      ?? (session.verificationSummary
        ? {
            ...session.verificationSummary,
            session: {
              sessionId: session.sessionId,
              jobId: session.jobId,
              wallet: session.wallet,
              status: session.status,
              updatedAt: session.updatedAt,
              resolvedAt: session.resolvedAt
            }
          }
        : undefined);
    const childJobs = this.jobCatalogService.listJobsByParentSession(sessionId);
    const childRuns = await Promise.all(
      childJobs.map(async (job) => ({
        job,
        sessions: await this.jobExecutionService.listSessionHistory({ jobId: job.id, limit: 10 })
      }))
    );
    const lifecycle = buildSessionLifecycle(session, verification);

    const transitions = (session.statusHistory ?? []).map((entry, index) => ({
      id: `${sessionId}:transition:${index}`,
      type: "session_transition",
      at: entry.at,
      correlationId: sessionId,
      phase: describeSessionStatus(entry.to).phase,
      data: entry
    }));
    const verificationEvents = verification
      ? [{
          id: `${sessionId}:verification`,
          type: "verification",
          at: verification.session?.updatedAt ?? verification.session?.resolvedAt ?? new Date().toISOString(),
          correlationId: sessionId,
          phase: "verification",
          data: {
            outcome: verification.outcome,
            reasonCode: verification.reasonCode,
            handler: verification.handler,
            handlerVersion: verification.handlerVersion,
            verifierConfigVersion: verification.verifierConfigVersion
          }
        }]
      : [];
    const childEvents = childRuns.flatMap(({ job, sessions }) => ([
      {
        id: `${job.id}:child-job`,
        type: "child_job",
        at: job.firedAt ?? sessions[0]?.updatedAt ?? session.updatedAt,
        correlationId: sessionId,
        phase: "child_job",
        data: {
          jobId: job.id,
          templateId: job.templateId,
          parentSessionId: job.parentSessionId
        }
      },
      ...sessions.map((childSession) => ({
        id: `${childSession.sessionId}:child-session`,
        type: "child_session",
        at: childSession.updatedAt,
        correlationId: sessionId,
        phase: describeSessionStatus(childSession.status).phase,
        data: {
          sessionId: childSession.sessionId,
          jobId: childSession.jobId,
          wallet: childSession.wallet,
          status: childSession.status
        }
      }))
    ]));

    const timeline = [...transitions, ...verificationEvents, ...childEvents]
      .sort((left, right) => String(left.at ?? "").localeCompare(String(right.at ?? "")));

    return {
      timelineVersion: "v2",
      session,
      lifecycle,
      verification,
      childJobs,
      lineage: {
        parentSessionId: session.parentSessionId,
        childJobIds: childJobs.map((job) => job.id),
        childSessionIds: childRuns.flatMap(({ sessions }) => sessions.map((childSession) => childSession.sessionId))
      },
      stateMachine: this.getSessionStateMachine(),
      timeline
    };
  }

  async getJobTimeline(jobId, { wallet = undefined, now = new Date(), limit = 100 } = {}) {
    const baseJob = this.jobCatalogService.getJobDefinition(jobId);
    const [job, sessions] = await Promise.all([
      this.attachClaimState(baseJob, { wallet, now }),
      this.jobExecutionService.listSessionHistory({ jobId, limit })
    ]);

    const childRunsBySession = await Promise.all(
      sessions.map(async (session) => {
        const childJobs = this.jobCatalogService.listJobsByParentSession(session.sessionId);
        const childRuns = await Promise.all(
          childJobs.map(async (childJob) => ({
            job: childJob,
            sessions: await this.jobExecutionService.listSessionHistory({ jobId: childJob.id, limit: 10 })
          }))
        );
        return { session, childRuns };
      })
    );
    const childRuns = childRunsBySession.flatMap(({ childRuns: runs }) => runs);
    const childJobs = childRuns.map(({ job }) => job);
    const childSessions = childRuns.flatMap(({ sessions: childSessionRows }) => childSessionRows);
    const derivativeJobs = job.recurring
      ? this.jobCatalogService
          .listJobs({ includePaused: true, includeArchived: true, includeStale: true, now })
          .filter((candidate) => candidate.templateId === job.id)
      : [];
    const parentSession = job.parentSessionId
      ? await this.stateStore.getSession?.(job.parentSessionId)
      : undefined;
    const eventBusReplay = this.eventBus?.replay?.({ jobId }, undefined) ?? { events: [], gap: false };

    const sessionEvents = sessions.flatMap((session) => buildSessionTimelineEntries(session));
    const verificationEvents = sessions
      .map((session) => buildVerificationTimelineEntry(session))
      .filter(Boolean);
    const childEvents = childRuns.flatMap(({ job: childJob, sessions: childSessionRows }) => ([
      buildChildJobTimelineEntry(childJob),
      ...childSessionRows.map((childSession) => buildChildSessionTimelineEntry(childSession))
    ]));
    const derivativeEvents = derivativeJobs.map((derivative) => buildDerivativeJobTimelineEntry(derivative));
    const eventBusEvents = eventBusReplay.events.map((event, index) => buildEventBusTimelineEntry(event, index));

    const timeline = [
      buildJobStateTimelineEntry(job, sessions),
      ...sessionEvents,
      ...verificationEvents,
      ...childEvents,
      ...derivativeEvents,
      ...eventBusEvents
    ]
      .filter(Boolean)
      .sort(compareTimelineEntries);

    return {
      timelineVersion: "v2",
      job,
      lineage: {
        templateId: job.templateId ?? null,
        recurringTemplate: Boolean(job.recurring),
        derivativeJobIds: derivativeJobs.map((derivative) => derivative.id),
        parentSessionId: job.parentSessionId ?? null,
        parentSession: parentSession
          ? {
              sessionId: parentSession.sessionId,
              jobId: parentSession.jobId,
              wallet: parentSession.wallet,
              status: parentSession.status,
              updatedAt: parentSession.updatedAt
            }
          : null,
        sessionIds: sessions.map((session) => session.sessionId),
        childJobIds: childJobs.map((childJob) => childJob.id),
        childSessionIds: childSessions.map((childSession) => childSession.sessionId)
      },
      summary: {
        sessionCount: sessions.length,
        activeSessionIds: sessions
          .filter((session) => !isTerminalSession(session))
          .map((session) => session.sessionId),
        terminalSessionIds: sessions
          .filter((session) => isTerminalSession(session))
          .map((session) => session.sessionId),
        childJobCount: childJobs.length,
        derivativeJobCount: derivativeJobs.length,
        eventCount: timeline.length,
        eventBusGap: Boolean(eventBusReplay.gap),
        latestSessionStatus: sessions[0]?.status ?? null
      },
      timeline
    };
  }

  async collectSessionHistory(wallet, options = {}) {
    return this.jobExecutionService.collectSessionHistory(wallet, options);
  }

  async listSubJobs(parentSessionId) {
    const jobs = this.jobCatalogService.listJobsByParentSession(parentSessionId);
    return Promise.all(
      jobs.map(async (job) => ({
        ...job,
        sessions: await this.jobExecutionService.listSessionHistory({ jobId: job.id, limit: 10 })
      }))
    );
  }

  async createSubJob(parentSessionId, wallet, input) {
    const parentSession = await this.jobExecutionService.resumeSession(parentSessionId);
    if (parentSession.wallet.toLowerCase() !== wallet.toLowerCase()) {
      throw new ValidationError("parentSessionId must belong to the authenticated wallet.");
    }
    if (parentSession.status !== "claimed" && parentSession.status !== "submitted") {
      throw new ValidationError("parent session must be active before creating sub-jobs.");
    }
    return this.jobCatalogService.createJob({
      ...input,
      parentSessionId
    });
  }

  async getAccountSummary(wallet) {
    if (this.blockchainGateway?.isEnabled()) {
      return this.accountMutationService.attachStoredTreasuryMetadata(
        wallet,
        await this.blockchainGateway.getAccountSummary(wallet)
      );
    }
    return this.accounts.get(wallet) ?? {
      wallet,
      liquid: {},
      reserved: {},
      strategyAllocated: {},
      strategyShares: {},
      strategyActivity: {},
      strategyAccounting: {},
      treasuryTimeline: [],
      collateralLocked: {},
      jobStakeLocked: {},
      debtOutstanding: {}
    };
  }

  async fundAccount(wallet, asset, amount) {
    if (this.blockchainGateway?.isEnabled()) {
      this.accountMutationService.attachStoredTreasuryMetadata(
        wallet,
        await this.blockchainGateway.fundAccount(wallet, asset, amount)
      );
      await this.accountMutationService.recordTreasuryMutation(wallet, {
        type: "fund",
        asset,
        amount: Number(amount)
      });
      return this.getAccountSummary(wallet);
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      throw new ValidationError("Funding amount must be greater than zero.");
    }

    const account = await this.getAccountSummary(wallet);
    account.liquid[asset] = (account.liquid[asset] ?? 0) + numericAmount;
    this.accounts.set(wallet, account);
    await this.accountMutationService.recordTreasuryMutation(wallet, {
      type: "fund",
      asset,
      amount: numericAmount
    });
    return account;
  }

  async getDefaultClaimStakeBps() {
    if (this.blockchainGateway?.isEnabled()) {
      return this.blockchainGateway.getDefaultClaimStakeBps();
    }
    return 500;
  }

  async getClaimEconomicsConfig() {
    if (this.blockchainGateway?.isEnabled() && typeof this.blockchainGateway.getClaimEconomicsConfig === "function") {
      return this.blockchainGateway.getClaimEconomicsConfig();
    }
    return {};
  }

  async getClaimEconomicsPreview(wallet, job) {
    const priorClaimCount = countClaimedSessions(await this.jobExecutionService.collectSessionHistory(wallet));
    return computeClaimEconomics({
      rewardAmount: job.rewardAmount,
      rewardAsset: job.rewardAsset,
      priorClaimCount,
      claimStakeBps: await this.getDefaultClaimStakeBps(),
      ...(await this.getClaimEconomicsConfig())
    });
  }

  async getReputation(wallet) {
    if (this.blockchainGateway?.isEnabled()) {
      const live = await this.blockchainGateway.getReputation(wallet);
      const skill = live.skill;
      return {
        ...live,
        tier: skill >= 200 ? "elite" : skill >= 100 ? "pro" : "starter"
      };
    }
    return this.reputations.get(wallet) ?? STARTER_REPUTATION;
  }

  async reserveForJob(wallet, asset, amount) {
    return this.accountMutationService.reserveForJob(wallet, asset, amount);
  }

  async sendToAgent(from, recipient, asset, amount) {
    return this.accountMutationService.agentTransfer(from, recipient, asset, amount);
  }

  async allocateIdleFunds(wallet, asset, amount, strategyId = "default-low-risk", strategy = undefined, options = {}) {
    if (strategy?.executionMode === "async_xcm") {
      return this.accountMutationService.requestStrategyDeposit(wallet, asset, amount, strategyId, strategy, options);
    }
    return this.accountMutationService.allocateIdleFunds(wallet, asset, amount, strategyId);
  }

  async deallocateIdleFunds(wallet, asset, amount, strategyId = "default-low-risk", strategy = undefined, options = {}) {
    if (strategy?.executionMode === "async_xcm") {
      return this.accountMutationService.requestStrategyWithdraw(wallet, asset, amount, strategyId, strategy, options);
    }
    return this.accountMutationService.deallocateIdleFunds(wallet, asset, amount, strategyId);
  }

  async recordStrategySnapshots(wallet, snapshots = []) {
    return this.accountMutationService.recordStrategySnapshots(wallet, snapshots);
  }

  async getBorrowCapacity(wallet, asset) {
    return this.accountMutationService.getBorrowCapacity(wallet, asset);
  }

  async borrow(wallet, asset, amount) {
    return this.accountMutationService.borrow(wallet, asset, amount);
  }

  async repay(wallet, asset, amount) {
    return this.accountMutationService.repay(wallet, asset, amount);
  }

  async getXcmRequest(requestId) {
    if (!this.blockchainGateway?.isEnabled()) {
      throw new ValidationError("XCM request lookup requires the blockchain gateway.");
    }
    return this.blockchainGateway.getXcmRequest(requestId);
  }

  async finalizeXcmRequest(requestId, outcome) {
    if (!this.blockchainGateway?.isEnabled()) {
      throw new ValidationError("XCM request finalization requires the blockchain gateway.");
    }
    const finalized = await this.blockchainGateway.finalizeXcmRequest(requestId, outcome);
    if (finalized?.strategyRequest?.account) {
      await this.accountMutationService.recordAsyncStrategySettlement(finalized);
    }
    return finalized;
  }

  async observeXcmOutcome(requestId, outcome) {
    if (!this.xcmSettlementWatcher) {
      throw new ValidationError("XCM outcome observation requires the settlement watcher.");
    }
    return this.xcmSettlementWatcher.observeOutcome(requestId, outcome);
  }

  async ingestVerification(sessionId, verdict) {
    return this.verificationIngestionService.ingest(sessionId, verdict);
  }

  /**
   * Public, sanitized counterpart to the providerOperations slice of
   * `getAdminStatus`. The full admin status carries `lastRun.errors[]` and
   * `lastRun.skipped[]`, which can include candidate URLs, query strings,
   * stack traces, or other internals. The public version strips both
   * arrays but preserves their counts and the human-readable `summary`,
   * so external trust dashboards can still answer "is each ingestion
   * provider healthy / running / at capacity?" without leaking internal
   * detail.
   */
  async getPublicProviderOperations() {
    const [
      githubIngestion,
      wikipediaIngestion,
      osvIngestion,
      openDataIngestion,
      standardsIngestion,
      openApiIngestion
    ] = await Promise.all([
      this.githubIssueIngestionScheduler?.getStatus?.() ?? PROVIDER_STATUS_FALLBACK,
      this.wikipediaMaintenanceIngestionScheduler?.getStatus?.() ?? PROVIDER_STATUS_FALLBACK,
      this.osvAdvisoryIngestionScheduler?.getStatus?.() ?? PROVIDER_STATUS_FALLBACK,
      this.openDataIngestionScheduler?.getStatus?.() ?? PROVIDER_STATUS_FALLBACK,
      this.standardsSpecIngestionScheduler?.getStatus?.() ?? PROVIDER_STATUS_FALLBACK,
      this.openApiSpecIngestionScheduler?.getStatus?.() ?? PROVIDER_STATUS_FALLBACK
    ]);
    const providerOperations = buildProviderOperations({
      githubIngestion,
      wikipediaIngestion,
      osvIngestion,
      openDataIngestion,
      standardsIngestion,
      openApiIngestion
    });
    return {
      providerOperations: sanitizeProviderOperations(providerOperations)
    };
  }
}

function buildJobStateTimelineEntry(job, sessions) {
  return {
    id: `${job.id}:job-state`,
    type: "job_state",
    at: firstDefined(job.lifecycle?.updatedAt, job.createdAt, job.firedAt, sessions[0]?.updatedAt),
    correlationId: job.id,
    phase: "job",
    data: compactTimelineData({
      jobId: job.id,
      category: job.category,
      tier: job.tier,
      verifierMode: job.verifierMode,
      lifecycle: job.lifecycle,
      claimState: job.claimState,
      effectiveState: job.effectiveState,
      claimable: job.claimable,
      reason: job.reason,
      sessionId: job.sessionId,
      claimedBy: job.claimedBy,
      claimExpiresAt: job.claimExpiresAt
    })
  };
}

function buildSessionTimelineEntries(session) {
  const history = Array.isArray(session.statusHistory) ? session.statusHistory : [];
  if (!history.length) {
    return [{
      id: `${session.sessionId}:session-snapshot`,
      type: "session_snapshot",
      at: firstDefined(session.updatedAt, session.claimedAt),
      correlationId: session.sessionId,
      phase: describeSessionStatus(session.status).phase,
      data: compactTimelineData({
        sessionId: session.sessionId,
        jobId: session.jobId,
        wallet: session.wallet,
        status: session.status
      })
    }];
  }
  return history.map((entry, index) => ({
    id: `${session.sessionId}:transition:${index}`,
    type: "session_transition",
    at: entry.at,
    correlationId: session.sessionId,
    phase: describeSessionStatus(entry.to).phase,
    data: {
      sessionId: session.sessionId,
      jobId: session.jobId,
      wallet: session.wallet,
      ...entry
    }
  }));
}

function buildVerificationTimelineEntry(session) {
  const verification = session.verification ?? session.verificationSummary;
  if (!verification) {
    return undefined;
  }
  return {
    id: `${session.sessionId}:verification`,
    type: "verification",
    at: firstDefined(
      verification.session?.updatedAt,
      verification.session?.resolvedAt,
      session.resolvedAt,
      session.updatedAt
    ),
    correlationId: session.sessionId,
    phase: "verification",
    data: compactTimelineData({
      sessionId: session.sessionId,
      jobId: session.jobId,
      outcome: verification.outcome,
      reasonCode: verification.reasonCode,
      handler: verification.handler,
      handlerVersion: verification.handlerVersion,
      verifierConfigVersion: verification.verifierConfigVersion
    })
  };
}

function buildChildJobTimelineEntry(job) {
  return {
    id: `${job.id}:child-job`,
    type: "child_job",
    at: firstDefined(job.createdAt, job.firedAt, job.lifecycle?.updatedAt),
    correlationId: job.parentSessionId ?? job.id,
    phase: "child_job",
    data: compactTimelineData({
      jobId: job.id,
      parentSessionId: job.parentSessionId,
      category: job.category,
      tier: job.tier,
      verifierMode: job.verifierMode,
      lifecycle: job.lifecycle
    })
  };
}

function buildChildSessionTimelineEntry(session) {
  return {
    id: `${session.sessionId}:child-session`,
    type: "child_session",
    at: firstDefined(session.updatedAt, session.claimedAt),
    correlationId: session.sessionId,
    phase: describeSessionStatus(session.status).phase,
    data: compactTimelineData({
      sessionId: session.sessionId,
      jobId: session.jobId,
      wallet: session.wallet,
      status: session.status
    })
  };
}

function buildDerivativeJobTimelineEntry(job) {
  return {
    id: `${job.id}:derivative-job`,
    type: "derivative_job",
    at: firstDefined(job.firedAt, job.createdAt, job.lifecycle?.updatedAt),
    correlationId: job.templateId ?? job.id,
    phase: "recurring",
    data: compactTimelineData({
      jobId: job.id,
      templateId: job.templateId,
      firedAt: job.firedAt,
      category: job.category,
      tier: job.tier,
      lifecycle: job.lifecycle
    })
  };
}

function buildEventBusTimelineEntry(event, index) {
  return {
    id: event.id ?? `event-bus:${index}`,
    type: "event_bus",
    at: event.timestamp,
    correlationId: event.sessionId ?? event.jobId,
    phase: event.topic,
    data: compactTimelineData({
      topic: event.topic,
      jobId: event.jobId,
      sessionId: event.sessionId,
      wallet: event.wallet,
      blockNumber: event.blockNumber,
      txHash: event.txHash,
      ...event.data
    })
  };
}

function compareTimelineEntries(left, right) {
  const leftTime = timelineTime(left.at);
  const rightTime = timelineTime(right.at);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left.id ?? "").localeCompare(String(right.id ?? ""));
}

function timelineTime(value) {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function compactTimelineData(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

/**
 * Default empty status used when an ingestion scheduler is not wired in
 * the current process. Matches the shape produced by every concrete
 * scheduler's `getStatus()` so `buildProviderOperations` can treat all
 * providers uniformly.
 */
const PROVIDER_STATUS_FALLBACK = Object.freeze({
  enabled: false,
  running: false,
  dryRun: true,
  intervalMs: 0,
  maxJobsPerRun: 0,
  maxOpenJobs: 0,
  currentOpenJobs: 0,
  lastRun: undefined
});

/**
 * Strip `lastRun.errors[]` and `lastRun.skipped[]` from every provider in
 * a providerOperations object, preserving every other field including
 * `errorCount` and `skippedCount`. Used to derive the public sanitized
 * payload from the admin one.
 */
function sanitizeProviderOperations(providerOperations) {
  const entries = Object.entries(providerOperations).map(([key, value]) => [
    key,
    sanitizeProviderOperationStatus(value)
  ]);
  return Object.fromEntries(entries);
}

function sanitizeProviderOperationStatus(status) {
  if (!status?.lastRun) return status;
  return {
    ...status,
    lastRun: {
      ...status.lastRun,
      skipped: [],
      errors: []
    }
  };
}

async function getTreasuryPolicyStatusSafely(blockchainGateway) {
  if (!blockchainGateway?.getTreasuryPolicyStatus) {
    return { ...DEFAULT_TREASURY_POLICY_STATUS };
  }

  try {
    return await blockchainGateway.getTreasuryPolicyStatus();
  } catch (error) {
    return {
      ...DEFAULT_TREASURY_POLICY_STATUS,
      enabled: Boolean(blockchainGateway.isEnabled?.()),
      policyAddress: blockchainGateway.config?.treasuryPolicyAddress || undefined,
      error: {
        code: error?.code ?? "policy_status_error",
        message: error?.message ?? "Treasury policy status failed.",
        details: error?.details
      }
    };
  }
}

function buildProviderOperations(statuses) {
  const entries = INGESTION_PROVIDER_DEFINITIONS.map(([key, statusKey, label, targetCountField]) => {
    const status = statuses[statusKey] ?? {};
    return [key, buildProviderOperationStatus({
      label,
      status,
      targetCountField
    })];
  });
  return Object.fromEntries(entries);
}

function buildProviderOperationStatus({ label, status, targetCountField }) {
  const lastRun = summarizeProviderLastRun(status.lastRun);
  const currentOpenJobs = status.currentOpenJobs !== undefined
    ? toNonNegativeInteger(status.currentOpenJobs)
    : inferCurrentOpenJobs(status.lastRun);
  // queryCount/nextQuery describe the rotation pool — only meaningful
  // when the provider rotates a query list distinct from its
  // targetCount. github's queryCount IS its targetCount, so don't
  // duplicate it; openData rotates queries against a dataset list, so
  // queryCount and targetCount are genuinely different signals.
  const queryCount = status.queryCount !== undefined && targetCountField !== "queryCount"
    ? toNonNegativeInteger(status.queryCount)
    : undefined;
  const nextQuery = stringOrUndefined(status.nextQuery);
  return {
    label,
    enabled: Boolean(status.enabled),
    running: Boolean(status.running),
    dryRun: status.dryRun !== false,
    mode: !status.enabled ? "disabled" : (status.dryRun === false ? "live" : "dry_run"),
    intervalMs: toNonNegativeInteger(status.intervalMs),
    maxJobsPerRun: toNonNegativeInteger(status.maxJobsPerRun),
    ...(status.maxJobsPerQuery !== undefined ? { maxJobsPerQuery: toNonNegativeInteger(status.maxJobsPerQuery) } : {}),
    maxOpenJobs: toNonNegativeInteger(status.maxOpenJobs),
    currentOpenJobs,
    ...(status.minClaimableJobs !== undefined ? { minClaimableJobs: toNonNegativeInteger(status.minClaimableJobs) } : {}),
    ...(status.currentClaimableJobs !== undefined
      ? { currentClaimableJobs: toNonNegativeInteger(status.currentClaimableJobs) }
      : {}),
    targetCount: toNonNegativeInteger(status[targetCountField]),
    ...(queryCount !== undefined ? { queryCount } : {}),
    ...(nextQuery ? { nextQuery } : {}),
    lastRunAt: lastRun?.finishedAt ?? lastRun?.startedAt,
    lastRun,
    health: summarizeProviderHealth({
      enabled: Boolean(status.enabled),
      dryRun: status.dryRun !== false,
      currentOpenJobs,
      maxOpenJobs: toNonNegativeInteger(status.maxOpenJobs),
      lastRun
    })
  };
}

function summarizeProviderLastRun(lastRun) {
  if (!lastRun || typeof lastRun !== "object") {
    return undefined;
  }
  const skippedCount = countSkipped(lastRun);
  const errorCount = Array.isArray(lastRun.errors) ? lastRun.errors.length : 0;
  const createdCount = toNonNegativeInteger(lastRun.createdCount);
  const candidateCount = toNonNegativeInteger(lastRun.candidateCount);
  const skipped = collectSkipped(lastRun);
  return {
    startedAt: stringOrUndefined(lastRun.startedAt),
    finishedAt: stringOrUndefined(lastRun.finishedAt),
    dryRun: lastRun.dryRun !== false,
    candidateCount,
    createdCount,
    skippedCount,
    errorCount,
    summary: summarizeLastRunText({ candidateCount, createdCount, skippedCount, errorCount }),
    skipped: skipped.slice(0, 5),
    errors: Array.isArray(lastRun.errors) ? lastRun.errors.slice(0, 5) : []
  };
}

function summarizeLastRunText({ candidateCount, createdCount, skippedCount, errorCount }) {
  return `${candidateCount} candidate(s), ${createdCount} created, ${skippedCount} skipped, ${errorCount} error(s)`;
}

function summarizeProviderHealth({ enabled, dryRun, currentOpenJobs, maxOpenJobs, lastRun }) {
  if (!enabled) {
    return "disabled";
  }
  if (lastRun?.errorCount > 0) {
    return "error";
  }
  if (maxOpenJobs > 0 && currentOpenJobs >= maxOpenJobs) {
    return "at_capacity";
  }
  if (dryRun) {
    return "dry_run";
  }
  return "healthy";
}

function countSkipped(lastRun) {
  return collectSkipped(lastRun).length;
}

function collectSkipped(lastRun) {
  const topLevel = Array.isArray(lastRun.skipped) ? lastRun.skipped : [];
  const queryLevel = Array.isArray(lastRun.queries)
    ? lastRun.queries.flatMap((query) => Array.isArray(query.skipped) ? query.skipped : [])
    : [];
  return [...topLevel, ...queryLevel];
}

function inferCurrentOpenJobs(lastRun) {
  if (!lastRun || typeof lastRun !== "object") {
    return 0;
  }
  for (const key of ["openGithubJobs", "openWikipediaJobs", "openOsvJobs", "openDataJobs", "openStandardsJobs", "openApiJobs"]) {
    if (lastRun[key] !== undefined) {
      return toNonNegativeInteger(lastRun[key]);
    }
  }
  return 0;
}

function toNonNegativeInteger(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) {
    return 0;
  }
  return Math.trunc(number);
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
