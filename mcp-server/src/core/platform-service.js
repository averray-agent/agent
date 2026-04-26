import { createStateStore } from "./state-store.js";
import { AccountMutationService } from "./account-mutation-service.js";
import { JobCatalogService } from "./job-catalog-service.js";
import { JobExecutionService } from "./job-execution-service.js";
import { VerificationIngestionService } from "../services/verification-ingestion-service.js";
import { ValidationError } from "./errors.js";
import { buildPlatformCapabilities } from "./discovery-manifest.js";
import {
  buildSessionLifecycle,
  describeSessionStatus,
  getSessionStateMachineDefinition
} from "./session-state-machine.js";

const STARTER_REPUTATION = {
  skill: 0,
  reliability: 0,
  economic: 0,
  tier: "starter"
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
    this.xcmSettlementWatcher = undefined;
    this.xcmObservationRelay = undefined;

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
      this.getDefaultClaimStakeBps.bind(this)
    );
    this.jobExecutionService = new JobExecutionService(
      this.stateStore,
      this.blockchainGateway,
      this.getJobDefinition.bind(this),
      this.eventBus,
      this.accountMutationService,
      this.getDefaultClaimStakeBps.bind(this)
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

  listJobs() {
    return this.jobCatalogService.listJobs();
  }

  createJob(input) {
    return this.jobCatalogService.createJob(input);
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
      recentSessions
    ] = await Promise.all([
      this.blockchainGateway?.getTreasuryPolicyStatus?.() ?? {
        enabled: false,
        policyAddress: undefined,
        paused: undefined,
        owner: undefined,
        pauser: undefined,
        risk: {}
      },
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
          updatedAt: session.updatedAt
        })),
        recentEvents: recentEvents.slice(-10).reverse(),
        activeSessions: activeSessions.length,
        activeWallets: wallets.size,
        totalCapitalAtWork: activeSessions.reduce(
          (sum, session) => sum + (Number(session.claimStake) || 0),
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
      scheduler,
      githubIngestion: githubIngestion,
      wikipediaIngestion: wikipediaIngestion,
      osvIngestion: osvIngestion,
      openDataIngestion: openDataIngestion,
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

  async recommendJobs(wallet) {
    return this.jobCatalogService.recommendJobs(wallet);
  }

  async tierLadder(wallet) {
    return this.jobCatalogService.tierLadder(wallet);
  }

  async preflightJob(wallet, jobId) {
    return this.jobCatalogService.preflightJob(wallet, jobId);
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
}
