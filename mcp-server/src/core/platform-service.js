import { createStateStore } from "./state-store.js";

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

export class PlatformService {
  constructor(jobs, profiles, accounts, reputations, blockchainGateway = undefined, stateStore = createStateStore()) {
    this.jobs = jobs;
    this.profiles = profiles;
    this.accounts = accounts;
    this.reputations = reputations;
    this.blockchainGateway = blockchainGateway;
    this.stateStore = stateStore;
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
        "recommendJobs",
        "getJobDefinition",
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
    if (this.blockchainGateway?.isEnabled()) {
      return this.blockchainGateway.reserveForJob(wallet, asset, amount);
    }
    const account = await this.getAccountSummary(wallet);
    const liquid = account.liquid[asset] ?? 0;
    if (liquid < amount) {
      throw new Error(`Insufficient liquid balance for ${asset}`);
    }
    account.liquid[asset] = liquid - amount;
    account.reserved[asset] = (account.reserved[asset] ?? 0) + amount;
    this.accounts.set(wallet, account);
    return account;
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
      sessionId: `${jobId}:${wallet}`,
      wallet,
      jobId,
      chainJobId,
      idempotencyKey,
      status: "claimed",
      protocolHistory: [protocol]
    };

    return this.stateStore.upsertSession(session);
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
    if (this.blockchainGateway?.isEnabled()) {
      return this.blockchainGateway.allocateIdleFunds(wallet, strategyId, amount);
    }
    const account = await this.getAccountSummary(wallet);
    const liquid = account.liquid[asset] ?? 0;
    if (liquid < amount) {
      throw new Error(`Insufficient liquid balance for ${asset}`);
    }
    account.liquid[asset] = liquid - amount;
    account.strategyAllocated[asset] = (account.strategyAllocated[asset] ?? 0) + amount;
    this.accounts.set(wallet, account);
    return account;
  }

  async getBorrowCapacity(wallet, asset) {
    if (this.blockchainGateway?.isEnabled()) {
      return this.blockchainGateway.getBorrowCapacity(wallet, asset);
    }
    const account = await this.getAccountSummary(wallet);
    const collateral = account.collateralLocked[asset] ?? 0;
    const debt = account.debtOutstanding[asset] ?? 0;
    return Math.max((collateral / 1.5) - debt, 0);
  }

  async borrow(wallet, asset, amount) {
    const capacity = await this.getBorrowCapacity(wallet, asset);
    if (capacity < amount) {
      throw new Error(`Borrow capacity exceeded for ${asset}`);
    }
    if (this.blockchainGateway?.isEnabled()) {
      await this.blockchainGateway.borrow(asset, amount);
      return this.getAccountSummary(wallet);
    }

    const account = await this.getAccountSummary(wallet);
    account.liquid[asset] = (account.liquid[asset] ?? 0) + amount;
    account.debtOutstanding[asset] = (account.debtOutstanding[asset] ?? 0) + amount;
    this.accounts.set(wallet, account);
    return account;
  }

  async repay(wallet, asset, amount) {
    if (this.blockchainGateway?.isEnabled()) {
      await this.blockchainGateway.repay(asset, amount);
      return this.getAccountSummary(wallet);
    }
    const account = await this.getAccountSummary(wallet);
    const outstanding = account.debtOutstanding[asset] ?? 0;
    if (outstanding < amount) {
      throw new Error(`Repay amount exceeds debt for ${asset}`);
    }

    account.debtOutstanding[asset] = outstanding - amount;
    account.liquid[asset] = Math.max((account.liquid[asset] ?? 0) - amount, 0);
    this.accounts.set(wallet, account);
    return account;
  }

  async ingestVerification(verdict) {
    const session = await this.stateStore.findSessionByJobId(verdict.jobId);
    if (!session) {
      return undefined;
    }

    const status = verdict.outcome === "approved"
      ? "resolved"
      : verdict.outcome === "disputed"
        ? "disputed"
        : "verifying";

    return this.stateStore.upsertSession({
      ...session,
      status
    });
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
      throw new Error(`Unknown job: ${jobId}`);
    }
    return job;
  }

  async requireSession(sessionId) {
    const session = await this.stateStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }
}
