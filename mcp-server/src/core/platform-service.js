import { createStateStore } from "./state-store.js";
import { randomUUID } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  ValidationError
} from "./errors.js";
import { AccountMutationService } from "./account-mutation-service.js";
import { VerificationIngestionService } from "../services/verification-ingestion-service.js";

const STARTER_REPUTATION = {
  skill: 0,
  reliability: 0,
  economic: 0,
  tier: "starter"
};

const DEFAULT_AGENT_PROFILE = {
  capabilities: ["claim_job", "submit_work", "allocate_idle_funds"],
  supportedProtocols: ["mcp", "a2a", "http"],
  preferredCategories: ["coding"],
  preferredRiskLevel: "low",
  verifierCompatibility: ["benchmark", "deterministic", "human_fallback"],
  minLiquidReserve: 0,
  autoUnwindStrategies: false
};

const VALID_TIERS = new Set(["starter", "pro", "elite"]);
const VALID_VERIFIER_MODES = new Set(["benchmark", "deterministic", "human_fallback"]);

export class PlatformService {
  constructor(jobs, profiles, accounts, reputations, blockchainGateway = undefined, stateStore = createStateStore()) {
    this.jobs = jobs;
    this.profiles = profiles;
    this.accounts = accounts;
    this.reputations = reputations;
    this.blockchainGateway = blockchainGateway;
    this.stateStore = stateStore;
    this.accountMutationService = new AccountMutationService(
      this.accounts,
      this.blockchainGateway,
      this.getAccountSummary.bind(this)
    );
    this.verificationIngestionService = new VerificationIngestionService(this.stateStore);
  }

  getPlatformCapabilities() {
    return {
      protocols: ["mcp", "a2a", "http"],
      onboarding: {
        starterFlow: [
          "connect-wallet",
          "fetch-account-summary",
          "run-preflight-job",
          "claim-sponsored-starter-job",
          "submit-structured-work",
          "poll-verification-status"
        ]
      },
      tools: [
        "getPlatformCapabilities",
        "getAccountSummary",
        "listJobs",
        "recommendJobs",
        "getJobDefinition",
        "createJob",
        "preflightJob",
        "explainEligibility",
        "estimateNetReward",
        "reserveForJob",
        "claimJob",
        "submitWork",
        "resumeSession",
        "allocateIdleFunds",
        "getBorrowCapacity",
        "borrow",
        "repay",
        "getReputation",
        "verifySubmission",
        "getVerificationResult"
      ]
    };
  }

  listJobs() {
    return [...this.jobs];
  }

  createJob(input) {
    const job = this.normalizeJobInput(input);
    if (this.jobs.some((candidate) => candidate.id === job.id)) {
      throw new ConflictError(`Job already exists: ${job.id}`, "job_exists");
    }

    this.jobs.unshift(job);
    return job;
  }

  async getAccountSummary(wallet) {
    if (this.blockchainGateway?.isEnabled()) {
      return this.blockchainGateway.getAccountSummary(wallet);
    }
    return this.accounts.get(wallet) ?? {
      wallet,
      liquid: {},
      reserved: {},
      strategyAllocated: {},
      collateralLocked: {},
      debtOutstanding: {}
    };
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

  async recommendJobs(wallet) {
    const profile = this.requireProfile(wallet);
    const account = await this.getAccountSummary(wallet);
    const reputation = await this.getReputation(wallet);

    return Promise.all(this.jobs.map(async (job) => {
      const netReward = await this.estimateNetReward(wallet, job.id);
      const eligible = this.isEligible(job, profile, reputation);
      const liquid = account.liquid[job.rewardAsset] ?? 0;
      const fitScore = this.computeFitScore(job, profile, reputation, liquid);

      return {
        jobId: job.id,
        fitScore,
        netReward,
        eligible,
        explanation: eligible
          ? `Eligible via ${job.category} preferences and ${job.verifierMode} verifier support.`
          : "Missing eligibility, liquidity, or reputation requirements for this tier."
      };
    })).then((recommendations) => recommendations.sort((left, right) => right.fitScore - left.fitScore));
  }

  getJobDefinition(jobId) {
    return this.requireJob(jobId);
  }

  async preflightJob(wallet, jobId) {
    const job = this.requireJob(jobId);
    const profile = this.requireProfile(wallet);
    const reputation = await this.getReputation(wallet);
    const account = await this.getAccountSummary(wallet);
    const liquid = account.liquid[job.rewardAsset] ?? 0;
    const eligible = this.isEligible(job, profile, reputation);

    return {
      wallet,
      jobId,
      eligible,
      netReward: await this.estimateNetReward(wallet, jobId),
      availableLiquidity: liquid,
      strategyUnwindNeeded: liquid < job.rewardAmount,
      requiredOutputSchema: job.outputSchemaRef,
      verifierMode: job.verifierMode,
      verifierConfig: job.verifierConfig,
      failureStates: [
        "verifier_timeout",
        "submission_rejected",
        "dispute_opened",
        "insufficient_liquidity",
        "paused_system"
      ]
    };
  }

  async explainEligibility(wallet, jobId) {
    const job = this.requireJob(jobId);
    const profile = this.requireProfile(wallet);
    const reputation = await this.getReputation(wallet);

    return {
      jobId,
      wallet,
      tier: job.tier,
      preferredCategory: profile.preferredCategories.includes(job.category),
      supportsVerifier: profile.verifierCompatibility.includes(job.verifierMode),
      reputationTier: reputation.tier,
      verifierHandler: job.verifierConfig.handler,
      eligible: this.isEligible(job, profile, reputation)
    };
  }

  async estimateNetReward(wallet, jobId) {
    const job = this.requireJob(jobId);
    const profile = this.requireProfile(wallet);
    const gasPenalty = job.requiresSponsoredGas ? 0 : 0.5;
    const riskPenalty = profile.preferredRiskLevel === "low" && job.tier === "elite" ? 5 : 0;
    return Math.max(job.rewardAmount - gasPenalty - riskPenalty, 0);
  }

  async claimJob(wallet, jobId, protocol, idempotencyKey) {
    const existing = await this.stateStore.findSessionByIdempotencyKey(idempotencyKey);
    if (existing) {
      return existing;
    }

    const job = this.requireJob(jobId);
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
      if (replay) {
        return replay;
      }

      const existingSession = await this.stateStore.getSession(sessionId);
      if (existingSession) {
        return existingSession;
      }

      let chainJobId = jobId;
      if (this.blockchainGateway?.isEnabled()) {
        const live = await this.blockchainGateway.getJob(jobId);
        if (live.state !== 0 && live.state !== 1) {
          chainJobId = `${jobId}:${idempotencyKey}`;
        }
        if (this.blockchainGateway.ensureJob) {
          await this.blockchainGateway.ensureJob(job, chainJobId);
        }
        await this.blockchainGateway.claimJob(chainJobId);
      }

      const session = {
        sessionId,
        wallet,
        jobId,
        chainJobId,
        idempotencyKey,
        status: "claimed",
        protocolHistory: [protocol]
      };

      return this.stateStore.upsertSession(session);
    } finally {
      await this.stateStore.releaseClaimLock?.(sessionLockId, lockOwner);
    }
  }

  async submitWork(sessionId, protocol, evidence = "submitted-via-service") {
    const session = await this.requireSession(sessionId);
    if (this.blockchainGateway?.isEnabled()) {
      await this.blockchainGateway.submitWork(session.chainJobId ?? session.jobId, evidence);
    }
    const protocolHistory = [...new Set([...session.protocolHistory, protocol])];
    return this.stateStore.upsertSession({
      ...session,
      status: "submitted",
      protocolHistory
    });
  }

  async resumeSession(sessionId) {
    return this.requireSession(sessionId);
  }

  async allocateIdleFunds(wallet, asset, amount, strategyId = "default-low-risk") {
    return this.accountMutationService.allocateIdleFunds(wallet, asset, amount, strategyId);
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

  async ingestVerification(verdict) {
    return this.verificationIngestionService.ingest(verdict);
  }

  computeFitScore(job, profile, reputation, liquid) {
    let score = 0;
    if (profile.preferredCategories.includes(job.category)) score += 30;
    if (profile.verifierCompatibility.includes(job.verifierMode)) score += 30;
    if ((job.tier === "starter" && reputation.tier === "starter") || reputation.tier === "elite") score += 20;
    if (liquid >= job.rewardAmount || job.requiresSponsoredGas) score += 20;
    return score;
  }

  isEligible(job, profile, reputation) {
    if (!profile.verifierCompatibility.includes(job.verifierMode)) return false;
    if (job.tier === "pro" && reputation.skill < 100) return false;
    if (job.tier === "elite" && reputation.skill < 200) return false;
    return true;
  }

  requireProfile(wallet) {
    const existing = this.profiles.get(wallet);
    if (existing) {
      return existing;
    }
    const profile = {
      wallet,
      ...DEFAULT_AGENT_PROFILE
    };
    this.profiles.set(wallet, profile);
    return profile;
  }

  requireJob(jobId) {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new NotFoundError(`Unknown job: ${jobId}`, "job_not_found");
    }
    return job;
  }

  async requireSession(sessionId) {
    const session = await this.stateStore.getSession(sessionId);
    if (!session) {
      throw new NotFoundError(`Unknown session: ${sessionId}`, "session_not_found");
    }
    return session;
  }

  normalizeJobInput(input) {
    const id = this.normalizeId(input?.id);
    const category = String(input?.category ?? "").trim().toLowerCase();
    const tier = String(input?.tier ?? "").trim().toLowerCase();
    const verifierMode = String(input?.verifierMode ?? "").trim().toLowerCase();
    const rewardAmount = Number(input?.rewardAmount ?? 0);
    const claimTtlSeconds = Number(input?.claimTtlSeconds ?? 3600);
    const retryLimit = Number(input?.retryLimit ?? 1);
    const rewardAsset = String(input?.rewardAsset ?? "DOT").trim().toUpperCase();

    if (!id) {
      throw new ValidationError("Job id is required.");
    }
    if (!category) {
      throw new ValidationError("Category is required.");
    }
    if (!VALID_TIERS.has(tier)) {
      throw new ValidationError(`Invalid tier: ${tier}`);
    }
    if (!VALID_VERIFIER_MODES.has(verifierMode)) {
      throw new ValidationError(`Invalid verifier mode: ${verifierMode}`);
    }
    if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
      throw new ValidationError("Reward amount must be greater than zero.");
    }
    if (!Number.isInteger(claimTtlSeconds) || claimTtlSeconds < 60) {
      throw new ValidationError("Claim TTL must be at least 60 seconds.");
    }
    if (!Number.isInteger(retryLimit) || retryLimit < 0) {
      throw new ValidationError("Retry limit must be zero or higher.");
    }

    return {
      id,
      category,
      tier,
      rewardAsset,
      rewardAmount,
      verifierMode,
      verifierConfig: this.buildVerifierConfig(verifierMode, input),
      inputSchemaRef: String(input?.inputSchemaRef ?? `schema://jobs/${category}-input`).trim(),
      outputSchemaRef: String(input?.outputSchemaRef ?? `schema://jobs/${category}-output`).trim(),
      claimTtlSeconds,
      retryLimit,
      requiresSponsoredGas: Boolean(input?.requiresSponsoredGas)
    };
  }

  buildVerifierConfig(verifierMode, input) {
    const verifierTerms = Array.isArray(input?.verifierTerms)
      ? input.verifierTerms.map((value) => String(value).trim()).filter(Boolean)
      : [];

    if (verifierMode === "benchmark") {
      const minimumMatches = Number(input?.verifierMinimumMatches ?? Math.min(verifierTerms.length || 1, 2));
      if (!verifierTerms.length) {
        throw new ValidationError("Benchmark jobs need at least one verifier keyword.");
      }
      if (!Number.isInteger(minimumMatches) || minimumMatches < 1) {
        throw new ValidationError("Benchmark minimum matches must be at least 1.");
      }
      return {
        handler: "benchmark",
        requiredKeywords: verifierTerms,
        minimumMatches: Math.min(minimumMatches, verifierTerms.length)
      };
    }

    if (verifierMode === "deterministic") {
      const matchMode = String(input?.verifierMatchMode ?? "contains_all").trim();
      if (!verifierTerms.length) {
        throw new ValidationError("Deterministic jobs need at least one expected output.");
      }
      if (!["exact", "contains_all"].includes(matchMode)) {
        throw new ValidationError(`Invalid deterministic match mode: ${matchMode}`);
      }
      return {
        handler: "deterministic",
        expectedOutputs: verifierTerms,
        matchMode
      };
    }

    return {
      handler: "human_fallback",
      escalationMessage: String(input?.escalationMessage ?? "Escalate to human reviewer.").trim(),
      autoApprove: Boolean(input?.autoApprove)
    };
  }

  normalizeId(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  getClaimLockTtlSeconds(job) {
    return Math.max(15, Math.min(Number(job?.claimTtlSeconds ?? 60), 120));
  }
}
