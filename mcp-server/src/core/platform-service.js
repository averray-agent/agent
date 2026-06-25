import { createStateStore } from "./state-store.js";
import { AccountMutationService } from "./account-mutation-service.js";
import { JobCatalogService } from "./job-catalog-service.js";
import {
  JobExecutionService,
  normalizeSubmitPayloadShape,
  validateSubmissionContract
} from "./job-execution-service.js";
import { VerificationIngestionService } from "../services/verification-ingestion-service.js";
import { ConflictError, InsufficientLiquidityError, ValidationError } from "./errors.js";
import { normalizeSubmission } from "./submission.js";
import { buildPlatformCapabilities } from "./discovery-manifest.js";
import {
  EXTERNAL_SCHEMA_EIP712_VERSION,
  getBuiltinJobSchema,
  getRegisteredJobSchemaRegistration
} from "./job-schema-registry.js";
import {
  buildSessionLifecycle,
  getSessionStateMachineDefinition
} from "./session-state-machine.js";
import {
  buildChildJobTimelineEntry,
  buildChildSessionTimelineEntry,
  buildDerivativeJobTimelineEntry,
  buildEventBusTimelineEntry,
  buildJobStateTimelineEntry,
  buildSessionTimelineEntries,
  buildVerificationTimelineEntry,
  compareTimelineEntries
} from "./platform-timeline.js";
import {
  buildProviderOperations,
  PROVIDER_STATUS_FALLBACK,
  sanitizeProviderOperations
} from "./provider-operations-status.js";
import {
  buildSubmissionValidationContract,
  decimalToBaseUnits,
  formatBaseUnits,
  getTreasuryPolicyStatusSafely,
  getXcmObservationRelayStatusSafely,
  getXcmSettlementWatcherStatusSafely,
  minBalanceRawForAsset,
  sumSubJobRewards,
  validationPathFromError
} from "./platform-service-helpers.js";
import { computeClaimEconomics, countClaimedSessions } from "./claim-economics.js";
import { claimStatusFields, isTerminalSession, summarizeJobClaimState } from "./claim-state.js";
import { capabilityMatrix } from "../auth/capabilities.js";
import { normalizeAssetSymbol } from "./assets.js";
import { collectGithubOperatorStatus } from "./github-operator-helper.js";
import { collectHostDiagnostics } from "./host-diagnostics.js";
import { registerExternalSchema, validateSubmissionAgainstRegisteredSchema } from "../services/schema-registry.js";

const TIMELINE_VERSION = "v2";

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
    this.standardsSpecIngestionScheduler = undefined;
    this.openApiSpecIngestionScheduler = undefined;
    this.jobStaleSweeper = undefined;
    this.xcmSettlementWatcher = undefined;
    this.xcmObservationRelay = undefined;
    this.upstreamStatusPoller = undefined;
    this.bootstrapSelfReportScheduler = undefined;
    this.submittedJobAutoVerifier = undefined;
    // Opt-in: pre-fund auto-ingested job rewards on-chain at ingestion time so a
    // job is genuinely funded before it is advertised claimable. Set in bootstrap
    // from INGESTION_PREFUND_ENABLED. Testnet-only is an operational invariant.
    this.prefundIngestedJobs = false;

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
    this.verificationIngestionService = new VerificationIngestionService(
      this.stateStore,
      this.eventBus,
      this.getJobDefinition.bind(this)
    );
  }

  getPlatformCapabilities() {
    return buildPlatformCapabilities();
  }

  getSessionStateMachine() {
    return {
      timelineVersion: TIMELINE_VERSION,
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
    const created = this.jobCatalogService.createJob(input);
    try {
      this.validateJobRewardMinBalance(created);
      return created;
    } catch (error) {
      this.jobCatalogService.removeJob(created.id);
      throw error;
    }
  }

  async createAdminJob(input, { posterWallet = undefined } = {}) {
    const jobInput = await this.withRegisteredExternalSchema(input);
    const created = this.createJob(jobInput);
    try {
      await this.reserveRecurringTemplateFunding(created, posterWallet);
      return created;
    } catch (error) {
      this.jobCatalogService.removeJob(created.id);
      throw error;
    }
  }

  /**
   * Create an auto-ingested job and, when prefunding is enabled, escrow its
   * reward on-chain immediately by reusing the idempotent gateway.ensureJob.
   * This makes the job genuinely funded before discovery can advertise it
   * claimable. A funding shortfall (e.g. the backend signer is short on a
   * settlement asset that cannot be auto-minted) is the expected steady state
   * until liquidity is topped up out-of-band — it must NEVER abort the ingest
   * run, so the job is kept and stamped funding.state="pending"; the discovery
   * gate (summarizeJobClaimState) then keeps it out of the claimable set.
   */
  async createIngestedJob(input, { now = new Date() } = {}) {
    const created = this.createJob(input);
    if (!this.shouldPrefundIngestedJobs()) {
      return created;
    }
    try {
      // claimStake 0: the worker funds their own claim stake at claim time;
      // here we only escrow the reward (totalRequired = rewardAmount).
      await this.blockchainGateway.ensureJob(created, created.id, 0);
      created.funding = {
        source: "ingestion_prefund",
        state: "funded",
        asset: created.rewardAsset,
        amount: created.rewardAmount,
        fundedAt: now.toISOString()
      };
      this.publishIngestionPrefundEvent(created, "funded");
    } catch (error) {
      created.funding = {
        source: "ingestion_prefund",
        state: "pending",
        asset: created.rewardAsset,
        amount: created.rewardAmount,
        reason: error?.code ?? "prefund_failed",
        attemptedAt: now.toISOString()
      };
      this.publishIngestionPrefundEvent(created, "pending", error);
    }
    return created;
  }

  shouldPrefundIngestedJobs() {
    return this.prefundIngestedJobs === true
      && Boolean(this.blockchainGateway?.isEnabled?.());
  }

  publishIngestionPrefundEvent(job, state, error = undefined) {
    this.eventBus?.publish?.({
      topic: state === "funded"
        ? "funding.ingestion_prefund_funded"
        : "funding.ingestion_prefund_pending",
      jobId: job.id,
      // "pending" is a normal, expected outcome (signer short of liquidity) —
      // emit it at info severity, not as an error.
      severity: "info",
      data: {
        jobId: job.id,
        state,
        asset: job.rewardAsset,
        amount: job.rewardAmount,
        source: job.source,
        ...(error ? { reason: error?.code ?? "prefund_failed" } : {})
      }
    });
  }

  async withRegisteredExternalSchema(input = {}) {
    if (!input?.externalSchema) {
      return input;
    }
    const outputSchemaRef = String(input.outputSchemaRef ?? `schema://jobs/${input.category}-output`).trim();
    const existingTrustPolicy = input.schemaTrustPolicy && typeof input.schemaTrustPolicy === "object"
      ? input.schemaTrustPolicy
      : {};
    const trustedIssuers = Array.isArray(existingTrustPolicy.trustedIssuers)
      ? existingTrustPolicy.trustedIssuers
      : [];
    const external = input.externalSchema;
    const signingDomain = this.blockchainGateway?.isEnabled?.() && this.blockchainGateway?.getExternalSchemaSigningDomain
      ? await this.blockchainGateway.getExternalSchemaSigningDomain()
      : undefined;
    const registration = await registerExternalSchema({
      schemaHash: external.schemaHash,
      schemaUrl: external.schemaUrl,
      schemaIssuer: external.schemaIssuer,
      signature: external.signature ?? external.schemaSignature,
      jobId: input.id,
      chainId: signingDomain?.chainId ?? external.chainId,
      verifyingContract: signingDomain?.verifyingContract ?? external.verifyingContract,
      schemaRef: outputSchemaRef,
      trustedIssuers,
      isTrustedIssuer: this.blockchainGateway?.isEnabled?.() && this.blockchainGateway?.isTrustedSchemaIssuer
        ? (issuer) => this.blockchainGateway.isTrustedSchemaIssuer(issuer)
        : undefined
    });

    return {
      ...input,
      outputSchemaRef,
      schemaTrustPolicy: {
        ...existingTrustPolicy,
        trustedIssuers: [...new Set([...trustedIssuers, registration.schemaIssuer])]
      },
      schemaRegistrations: [
        ...(Array.isArray(input.schemaRegistrations) ? input.schemaRegistrations : []),
        registration
      ]
    };
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

  async runBootstrapSelfReport({ now = new Date() } = {}) {
    if (!this.bootstrapSelfReportScheduler?.runOnce) {
      throw new ValidationError("Bootstrap self-report scheduler is not initialised.");
    }
    const result = await this.bootstrapSelfReportScheduler.runOnce(now);
    const bootstrapSelfReport = await this.bootstrapSelfReportScheduler.getStatus?.();
    return {
      ok: result?.status === "sent",
      result,
      bootstrapSelfReport
    };
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
      bootstrapSelfReport,
      jobStaleSweeper,
      submittedJobAutoVerifier,
      recentSessions,
      hostDiagnostics
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
        lastRun: undefined,
        lastAttemptedAt: undefined,
        lastFinishedAt: undefined,
        lastSuccessfulAt: undefined,
        lastFailureReason: undefined,
        evidencePersistenceNote: "poller not initialised",
        fundedJobs: {
          totalRecords: 0,
          openRecords: 0,
          finalRecords: 0,
          pollableRecords: 0,
          awaitingSubmissionRecords: 0,
          recordsWithUpstreamEvidence: 0,
          byFinalStatus: {},
          bySourceType: {},
          lastFundedAt: undefined,
          lastUpdatedAt: undefined,
          recordLimit: 0
        }
      },
      this.bootstrapSelfReportScheduler?.getStatus?.() ?? {
        enabled: false,
        running: false,
        intervalMs: 0,
        sendOnStart: false,
        from: undefined,
        to: [],
        recipientCount: 0,
        providerConfigured: false,
        nextRunAt: undefined,
        lastRun: undefined,
        lastAttemptedAt: undefined,
        lastSuccessfulAt: undefined,
        lastFailureReason: undefined,
        evidencePersistenceNote: "scheduler not initialised"
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
      this.submittedJobAutoVerifier?.getStatus?.() ?? {
        enabled: false,
        running: false,
        dryRun: false,
        mode: "live",
        intervalMs: 0,
        scanLimit: 0,
        maxPerRun: 0,
        autoModes: ["benchmark", "deterministic"],
        requireSettlementReady: true,
        lastRun: undefined
      },
      this.jobExecutionService.listRecentSessions(14),
      Promise.resolve().then(() => collectHostDiagnostics())
    ]);
    const [xcmSettlementWatcher, xcmObservationRelay] = await Promise.all([
      getXcmSettlementWatcherStatusSafely(this.xcmSettlementWatcher),
      getXcmObservationRelayStatusSafely(this.xcmObservationRelay)
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
    if (xcmSettlementWatcher?.error) {
      anomalies.push({
        severity: "medium",
        code: "xcm_settlement_watcher_status_unavailable",
        message: "XCM settlement watcher status is unavailable.",
        details: xcmSettlementWatcher.error
      });
    }
    if (xcmObservationRelay?.error) {
      anomalies.push({
        severity: "medium",
        code: "xcm_observation_relay_status_unavailable",
        message: "XCM observation relay status is unavailable.",
        details: xcmObservationRelay.error
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
      authPolicy: capabilityMatrix(),
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
      submittedJobAutoVerifier,
      scheduler,
      hostDiagnostics,
      providerOperations,
      githubIngestion: githubIngestion,
      wikipediaIngestion: wikipediaIngestion,
      osvIngestion: osvIngestion,
      openDataIngestion: openDataIngestion,
      standardsIngestion: standardsIngestion,
      openApiIngestion: openApiIngestion,
      upstreamStatus,
      bootstrapSelfReport,
      xcmSettlementWatcher,
      xcmObservationRelay
    };
  }

  async getGithubOperatorStatus(options = {}) {
    return collectGithubOperatorStatus(options);
  }

  getJobDefinition(jobId) {
    return this.jobCatalogService.getJobDefinition(jobId);
  }

  /**
   * Synchronous lookup of every child job posted from a given parent
   * session. Used by HTTP routes that need a slim sub-contracting
   * view (public agent profile, badge lineage block) without paying
   * for `getSubJobLineage`'s session-history fetches. Roadmap §8.
   */
  listChildJobsByParentSession(parentSessionId) {
    return this.jobCatalogService.listJobsByParentSession(parentSessionId);
  }

  async getPublicJobDefinition(jobId, options = {}) {
    const {
      wallet,
      currentWallet,
      now = new Date(),
      includeArchived = false,
      includePaused = false,
      includeStale = false
    } = options;
    return this.attachClaimState(
      this.jobCatalogService.getPublicJobDefinition(jobId, {
        includeArchived,
        includePaused,
        includeStale,
        now
      }),
      { wallet: currentWallet ?? wallet, now }
    );
  }

  async validateJobSubmission(jobId, submissionInput) {
    const job = this.getJobDefinition(jobId);
    const contract = buildSubmissionValidationContract(job);
    try {
      const normalized = normalizeSubmission(normalizeSubmitPayloadShape(job.outputSchemaRef, submissionInput, {
        registrations: job.schemaRegistrations
      }));
      const registration = getRegisteredJobSchemaRegistration(job.outputSchemaRef, job.schemaRegistrations);
      if (registration?.registrationVersion === EXTERNAL_SCHEMA_EIP712_VERSION) {
        await validateSubmissionAgainstRegisteredSchema(normalized, job.id, {
          schemaRef: job.outputSchemaRef,
          registrations: job.schemaRegistrations
        });
      } else {
        validateSubmissionContract(job.outputSchemaRef, normalized, { registrations: job.schemaRegistrations });
      }
      return {
        jobId,
        valid: true,
        submitSafe: true,
        ...contract,
        schemaRef: job.outputSchemaRef,
        submissionKind: normalized.kind,
        normalizedSubmission: normalized.kind === "structured" ? normalized.structured : normalized.rawText
      };
    } catch (error) {
      const path = validationPathFromError(error);
      return {
        jobId,
        valid: false,
        submitSafe: false,
        ...contract,
        schemaRef: job.outputSchemaRef,
        code: error?.code ?? "invalid_submission",
        message: error?.message ?? "Invalid submission.",
        ...(path ? { path, errorPaths: [path] } : {}),
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
    const subJobLineage = await this.getSubJobLineage(sessionId);
    const childJobs = subJobLineage.childJobs;
    const childRuns = await Promise.all(
      childJobs.map(async (job) => ({
        job,
        sessions: await this.jobExecutionService.listSessionHistory({ jobId: job.id, limit: 10 })
      }))
    );
    const lifecycle = buildSessionLifecycle(session, verification);

    const transitions = buildSessionTimelineEntries(session, { correlationId: sessionId });
    const verificationEvents = [buildVerificationTimelineEntry(session, verification, { correlationId: sessionId })]
      .filter(Boolean);
    const childEvents = childRuns.flatMap(({ job, sessions }) => ([
      buildChildJobTimelineEntry(job, { correlationId: sessionId }),
      ...sessions.map((childSession) => buildChildSessionTimelineEntry(childSession, { correlationId: sessionId }))
    ]));

    const timeline = [...transitions, ...verificationEvents, ...childEvents]
      .sort(compareTimelineEntries);

    return {
      timelineVersion: TIMELINE_VERSION,
      session,
      lifecycle,
      verification,
      childJobs,
      lineage: {
        parentSessionId: session.parentSessionId,
        childJobIds: childJobs.map((job) => job.id),
        childSessionIds: childRuns.flatMap(({ sessions }) => sessions.map((childSession) => childSession.sessionId)),
        subJobBudget: subJobLineage.budget,
        subJobPolicy: subJobLineage.policy
      },
      stateMachine: this.getSessionStateMachine(),
      timeline
    };
  }

  async getJobTimeline(jobId, {
    wallet = undefined,
    now = new Date(),
    limit = 100,
    topics = undefined,
    sources = undefined,
    phases = undefined,
    severities = undefined,
    correlationId = undefined,
    eventWallet = undefined
  } = {}) {
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
    const eventFilter = { jobId, wallet: eventWallet, topics, sources, phases, severities, correlationId };
    const eventBusReplay = this.eventBus?.replayDurable
      ? await this.eventBus.replayDurable(eventFilter, undefined, { limit })
      : (this.eventBus?.replay?.(eventFilter, undefined) ?? { events: [], gap: false });

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
      timelineVersion: TIMELINE_VERSION,
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
        eventFilters: {
          topics: topics ?? [],
          sources: sources ?? [],
          phases: phases ?? [],
          severities: severities ?? [],
          correlationId: correlationId ?? null,
          wallet: eventWallet ?? null
        },
        latestSessionStatus: sessions[0]?.status ?? null
      },
      timeline
    };
  }

  async collectSessionHistory(wallet, options = {}) {
    return this.jobExecutionService.collectSessionHistory(wallet, options);
  }

  async listSubJobs(parentSessionId) {
    const lineage = await this.getSubJobLineage(parentSessionId);
    const jobs = lineage.childJobs;
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
    const parentJob = this.jobCatalogService.getJobDefinition(parentSession.jobId);
    const parentDepth = await this.resolveDelegationDepth(parentJob);
    const policy = this.resolveDelegationPolicy(parentJob);
    const childDepth = parentDepth + 1;
    if (childDepth > policy.maxDepth) {
      throw new ConflictError("Sub-job delegation depth exceeded.", "subjob_depth_exceeded", {
        parentSessionId,
        parentJobId: parentJob.id,
        parentDepth,
        childDepth,
        maxDepth: policy.maxDepth
      });
    }

    const existingSubJobs = this.jobCatalogService.listJobsByParentSession(parentSessionId);
    if (existingSubJobs.length >= policy.maxSubJobs) {
      throw new ConflictError("Sub-job count limit exceeded.", "subjob_count_exceeded", {
        parentSessionId,
        maxSubJobs: policy.maxSubJobs,
        existingSubJobCount: existingSubJobs.length
      });
    }

    const rewardAmount = Number(input?.rewardAmount ?? 0);
    const rewardAsset = normalizeAssetSymbol(input?.rewardAsset ?? parentJob.rewardAsset);
    if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
      throw new ValidationError("Sub-job rewardAmount must be greater than zero.");
    }
    if (rewardAsset !== policy.budgetAsset) {
      throw new ValidationError("Sub-job rewardAsset must match the parent delegation budget asset.");
    }
    const usedBudgetAmount = sumSubJobRewards(existingSubJobs, policy.budgetAsset);
    const nextUsedBudgetAmount = usedBudgetAmount + rewardAmount;
    if (nextUsedBudgetAmount > policy.budgetAmount) {
      throw new ConflictError("Sub-job delegation budget exceeded.", "subjob_budget_exceeded", {
        parentSessionId,
        parentJobId: parentJob.id,
        budgetAsset: policy.budgetAsset,
        budgetAmount: policy.budgetAmount,
        usedBudgetAmount,
        requestedRewardAmount: rewardAmount,
        remainingBudgetAmount: Math.max(policy.budgetAmount - usedBudgetAmount, 0)
      });
    }

    const account = await this.getAccountSummary(wallet);
    const liquid = Number(account?.liquid?.[rewardAsset] ?? 0);
    if (liquid < rewardAmount) {
      throw new InsufficientLiquidityError(rewardAsset, {
        wallet,
        requiredAmount: rewardAmount,
        availableAmount: liquid,
        parentSessionId
      });
    }

    const createdAt = new Date().toISOString();
    const child = this.createJob({
      ...input,
      rewardAsset,
      parentSessionId,
      lineage: {
        ...(typeof input?.lineage === "object" && input.lineage && !Array.isArray(input.lineage) ? input.lineage : {}),
        kind: "sub_job",
        parentSessionId,
        parentJobId: parentJob.id,
        parentWallet: wallet,
        depth: childDepth,
        createdBy: wallet,
        createdAt,
        budget: {
          asset: policy.budgetAsset,
          parentBudgetAmount: policy.budgetAmount,
          usedBeforeAmount: usedBudgetAmount,
          usedAfterAmount: nextUsedBudgetAmount,
          remainingAfterAmount: Math.max(policy.budgetAmount - nextUsedBudgetAmount, 0)
        }
      }
    });
    await this.reserveForJob(wallet, rewardAsset, rewardAmount);
    child.lineage = {
      ...(child.lineage ?? {}),
      funding: {
        reservedAt: new Date().toISOString(),
        wallet,
        asset: rewardAsset,
        amount: rewardAmount,
        source: "parent_wallet"
      }
    };
    return child;
  }

  async getSubJobLineage(parentSessionId) {
    const parentSession = await this.jobExecutionService.resumeSession(parentSessionId);
    const parentJob = this.jobCatalogService.getJobDefinition(parentSession.jobId);
    const childJobs = this.jobCatalogService.listJobsByParentSession(parentSessionId);
    const policy = this.resolveDelegationPolicy(parentJob);
    const usedBudgetAmount = sumSubJobRewards(childJobs, policy.budgetAsset);
    const childRuns = await Promise.all(
      childJobs.map(async (job) => ({
        job,
        sessions: await this.jobExecutionService.listSessionHistory({ jobId: job.id, limit: 10 })
      }))
    );
    return {
      parentSession,
      parentJob,
      policy,
      budget: {
        asset: policy.budgetAsset,
        budgetAmount: policy.budgetAmount,
        usedAmount: usedBudgetAmount,
        remainingAmount: Math.max(policy.budgetAmount - usedBudgetAmount, 0)
      },
      childJobs,
      childSessionIds: childRuns.flatMap(({ sessions }) => sessions.map((session) => session.sessionId))
    };
  }

  resolveDelegationPolicy(parentJob) {
    const raw = parentJob?.delegationPolicy ?? {};
    return {
      maxDepth: Number.isInteger(raw.maxDepth) ? raw.maxDepth : 1,
      maxSubJobs: Number.isInteger(raw.maxSubJobs) ? raw.maxSubJobs : 5,
      budgetAmount: Number.isFinite(Number(raw.budgetAmount)) ? Number(raw.budgetAmount) : Number(parentJob?.rewardAmount ?? 0),
      budgetAsset: normalizeAssetSymbol(raw.budgetAsset ?? parentJob?.rewardAsset)
    };
  }

  async resolveDelegationDepth(job, seen = new Set()) {
    if (!job?.parentSessionId) {
      return 0;
    }
    if (seen.has(job.id)) {
      throw new ConflictError("Sub-job lineage cycle detected.", "subjob_lineage_cycle", { jobId: job.id });
    }
    seen.add(job.id);
    const parentSession = await this.stateStore.getSession?.(job.parentSessionId);
    if (!parentSession?.jobId) {
      return 1;
    }
    const parentJob = this.jobCatalogService.getJobDefinition(parentSession.jobId);
    return 1 + await this.resolveDelegationDepth(parentJob, seen);
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

  async getAccountPosition(wallet, asset) {
    if (!this.blockchainGateway?.isEnabled() || typeof this.blockchainGateway.getAccountPosition !== "function") {
      throw new ValidationError("Account position reads require the blockchain gateway.");
    }
    return this.blockchainGateway.getAccountPosition(wallet, asset);
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
    const priorClaimCount = this.blockchainGateway?.isEnabled()
      && typeof this.blockchainGateway.getWorkerClaimCount === "function"
      ? await this.blockchainGateway.getWorkerClaimCount(wallet)
      : countClaimedSessions(await this.jobExecutionService.collectSessionHistory(wallet));
    return computeClaimEconomics({
      rewardAmount: job.rewardAmount,
      rewardAsset: job.rewardAsset,
      priorClaimCount,
      onboardingWaiverEligible: Boolean(job.onboardingWaiverEligible),
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

  async reserveRecurringTemplateFunding(job, posterWallet) {
    const reserveAmount = Number(job?.recurringPolicy?.reserveAmount);
    if (!job?.recurring || !Number.isFinite(reserveAmount) || reserveAmount <= 0) {
      return undefined;
    }
    const wallet = String(posterWallet ?? "").trim();
    if (!wallet) {
      throw new ValidationError("Recurring templates with finite reserves require a poster wallet.");
    }
    const asset = normalizeAssetSymbol(job.recurringPolicy.reserveAsset ?? job.rewardAsset);
    const receipt = await this.accountMutationService.reserveRecurringTemplateFunding(
      wallet,
      asset,
      reserveAmount,
      job.id
    );
    const reservedAt = new Date().toISOString();
    job.recurringPolicy = {
      ...job.recurringPolicy,
      funding: {
        source: "recurring_template_reserve",
        wallet,
        asset,
        amount: reserveAmount,
        reservedAt,
        ...(receipt?.amountRaw ? { amountRaw: receipt.amountRaw } : {}),
        ...(receipt?.templateKey ? { templateKey: receipt.templateKey } : {})
      }
    };
    this.jobCatalogService.updateRecurringTemplateRuntime(job.id, {
      reserve: this.jobCatalogService.buildRecurringReserveStatus(job),
      funding: job.recurringPolicy.funding
    });
    return receipt;
  }

  validateJobRewardMinBalance(job) {
    const asset = this.resolveSupportedSettlementAsset(job?.rewardAsset);
    const minBalanceRaw = minBalanceRawForAsset(asset);
    if (minBalanceRaw === undefined) {
      return;
    }
    const decimals = Number(asset.decimals);
    const rewardRaw = decimalToBaseUnits(job.rewardAmount, decimals, "rewardAmount");
    if (rewardRaw >= minBalanceRaw) {
      return;
    }
    throw new ValidationError(
      `Job reward below asset minBalance: asset=${asset.symbol} minBalance=${minBalanceRaw} base units ` +
      `(${formatBaseUnits(minBalanceRaw, decimals)} ${asset.symbol}); reward=${job.rewardAmount} ${asset.symbol} ` +
      `= ${rewardRaw} base units.`,
      {
        asset: asset.symbol,
        assetClass: asset.assetClass,
        assetId: asset.assetId,
        rewardAmount: job.rewardAmount,
        rewardRaw: rewardRaw.toString(),
        minBalanceRaw: minBalanceRaw.toString()
      }
    );
  }

  resolveSupportedSettlementAsset(rewardAsset) {
    const symbol = normalizeAssetSymbol(rewardAsset);
    const assets = this.blockchainGateway?.config?.supportedAssets ?? [];
    return assets.find((asset) => normalizeAssetSymbol(asset.symbol) === symbol);
  }

  async sendToAgent(from, recipient, asset, amount, authorization = undefined) {
    return this.accountMutationService.agentTransfer(from, recipient, asset, amount, authorization);
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
