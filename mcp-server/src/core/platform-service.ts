import {
  AccountSummary,
  AgentProfile,
  CreateJobInput,
  JobDefinition,
  JobSession,
  Recommendation,
  ReputationView,
  VerificationVerdict,
  ProtocolSurface
} from "../schemas/types.js";
import { createStateStore, StateStore } from "./state-store.js";

const STARTER_REPUTATION: ReputationView = {
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
} as const;

const VALID_TIERS = new Set(["starter", "pro", "elite"]);
const VALID_VERIFIER_MODES = new Set(["benchmark", "deterministic", "human_fallback"]);

function createValidationError(message: string) {
  const error = new Error(message);
  error.name = "ValidationError";
  return error;
}

export class PlatformService {
  constructor(
    private readonly jobs: JobDefinition[],
    private readonly profiles: Map<string, AgentProfile>,
    private readonly accounts: Map<string, AccountSummary>,
    private readonly reputations: Map<string, ReputationView>,
    private readonly blockchainGateway?: {
      isEnabled(): boolean;
      getAccountSummary(wallet: string): Promise<AccountSummary>;
      getReputation(wallet: string): Promise<{ skill: number; reliability: number; economic: number }>;
      reserveForJob(wallet: string, asset: string, amount: number): Promise<AccountSummary>;
      allocateIdleFunds(wallet: string, strategyId: string, amount: number): Promise<AccountSummary>;
      getBorrowCapacity(wallet: string, asset: string): Promise<number>;
      borrow(asset: string, amount: number): Promise<void>;
      repay(asset: string, amount: number): Promise<void>;
      getJob(jobId: string): Promise<{ state: number }>;
      claimJob(jobId: string): Promise<void>;
      ensureJob?(job: JobDefinition, instanceJobId?: string): Promise<unknown>;
      submitWork(jobId: string, evidence: string): Promise<void>;
      resolveSinglePayout?(jobId: string, approved: boolean, reasonCode: string, metadataURI: string): Promise<void>;
    },
    readonly stateStore: StateStore = createStateStore()
  ) {}

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

  listJobs(): JobDefinition[] {
    return [...this.jobs];
  }

  createJob(input: CreateJobInput): JobDefinition {
    const job = this.normalizeJobInput(input);
    if (this.jobs.some((candidate) => candidate.id === job.id)) {
      throw createValidationError(`Job already exists: ${job.id}`);
    }

    this.jobs.unshift(job);
    return job;
  }

  async getAccountSummary(wallet: string): Promise<AccountSummary> {
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

  async getReputation(wallet: string): Promise<ReputationView> {
    if (this.blockchainGateway?.isEnabled()) {
      const live = await this.blockchainGateway.getReputation(wallet);
      return {
        ...live,
        tier: live.skill >= 200 ? "elite" : live.skill >= 100 ? "pro" : "starter"
      };
    }
    return this.reputations.get(wallet) ?? STARTER_REPUTATION;
  }

  async reserveForJob(wallet: string, asset: string, amount: number) {
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

  async recommendJobs(wallet: string): Promise<Recommendation[]> {
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

  getJobDefinition(jobId: string): JobDefinition {
    return this.requireJob(jobId);
  }

  async preflightJob(wallet: string, jobId: string) {
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

  async explainEligibility(wallet: string, jobId: string) {
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

  async estimateNetReward(wallet: string, jobId: string): Promise<number> {
    const job = this.requireJob(jobId);
    const profile = this.requireProfile(wallet);
    const gasPenalty = job.requiresSponsoredGas ? 0 : 0.5;
    const riskPenalty = profile.preferredRiskLevel === "low" && job.tier === "elite" ? 5 : 0;
    return Math.max(job.rewardAmount - gasPenalty - riskPenalty, 0);
  }

  async claimJob(wallet: string, jobId: string, protocol: ProtocolSurface, idempotencyKey: string): Promise<JobSession> {
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

    const session: JobSession = {
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

  async submitWork(sessionId: string, protocol: ProtocolSurface, evidence = "submitted-via-service"): Promise<JobSession> {
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

  async resumeSession(sessionId: string): Promise<JobSession> {
    return this.requireSession(sessionId);
  }

  async allocateIdleFunds(wallet: string, asset: string, amount: number, strategyId = "default-low-risk") {
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

  async getBorrowCapacity(wallet: string, asset: string): Promise<number> {
    if (this.blockchainGateway?.isEnabled()) {
      return this.blockchainGateway.getBorrowCapacity(wallet, asset);
    }
    const account = await this.getAccountSummary(wallet);
    const collateral = account.collateralLocked[asset] ?? 0;
    const debt = account.debtOutstanding[asset] ?? 0;
    return Math.max((collateral / 1.5) - debt, 0);
  }

  async borrow(wallet: string, asset: string, amount: number) {
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

  async repay(wallet: string, asset: string, amount: number) {
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

  async ingestVerification(verdict: VerificationVerdict): Promise<JobSession | undefined> {
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

  private computeFitScore(job: JobDefinition, profile: AgentProfile, reputation: ReputationView, liquid: number): number {
    let score = 0;
    if (profile.preferredCategories.includes(job.category)) score += 30;
    if (profile.verifierCompatibility.includes(job.verifierMode)) score += 30;
    if ((job.tier === "starter" && reputation.tier === "starter") || reputation.tier === "elite") score += 20;
    if (liquid >= job.rewardAmount || job.requiresSponsoredGas) score += 20;
    return score;
  }

  private isEligible(job: JobDefinition, profile: AgentProfile, reputation: ReputationView): boolean {
    if (!profile.verifierCompatibility.includes(job.verifierMode)) return false;
    if (job.tier === "pro" && reputation.skill < 100) return false;
    if (job.tier === "elite" && reputation.skill < 200) return false;
    return true;
  }

  private requireProfile(wallet: string): AgentProfile {
    const existing = this.profiles.get(wallet);
    if (existing) {
      return existing;
    }

    const profile: AgentProfile = {
      wallet,
      ...DEFAULT_AGENT_PROFILE
    };
    this.profiles.set(wallet, profile);
    return profile;
  }

  private requireJob(jobId: string): JobDefinition {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    return job;
  }

  private async requireSession(sessionId: string): Promise<JobSession> {
    const session = await this.stateStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  private normalizeJobInput(input: CreateJobInput): JobDefinition {
    const id = this.normalizeId(input?.id);
    const category = String(input?.category ?? "").trim().toLowerCase();
    const tier = String(input?.tier ?? "").trim().toLowerCase() as JobDefinition["tier"];
    const verifierMode = String(input?.verifierMode ?? "").trim().toLowerCase() as JobDefinition["verifierMode"];
    const rewardAmount = Number(input?.rewardAmount ?? 0);
    const claimTtlSeconds = Number(input?.claimTtlSeconds ?? 3600);
    const retryLimit = Number(input?.retryLimit ?? 1);
    const rewardAsset = String(input?.rewardAsset ?? "DOT").trim().toUpperCase();

    if (!id) {
      throw createValidationError("Job id is required.");
    }
    if (!category) {
      throw createValidationError("Category is required.");
    }
    if (!VALID_TIERS.has(tier)) {
      throw createValidationError(`Invalid tier: ${tier}`);
    }
    if (!VALID_VERIFIER_MODES.has(verifierMode)) {
      throw createValidationError(`Invalid verifier mode: ${verifierMode}`);
    }
    if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
      throw createValidationError("Reward amount must be greater than zero.");
    }
    if (!Number.isInteger(claimTtlSeconds) || claimTtlSeconds < 60) {
      throw createValidationError("Claim TTL must be at least 60 seconds.");
    }
    if (!Number.isInteger(retryLimit) || retryLimit < 0) {
      throw createValidationError("Retry limit must be zero or higher.");
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

  private buildVerifierConfig(verifierMode: JobDefinition["verifierMode"], input: CreateJobInput): JobDefinition["verifierConfig"] {
    const verifierTerms = Array.isArray(input?.verifierTerms)
      ? input.verifierTerms.map((value) => String(value).trim()).filter(Boolean)
      : [];

    if (verifierMode === "benchmark") {
      const minimumMatches = Number(input?.verifierMinimumMatches ?? Math.min(verifierTerms.length || 1, 2));
      if (!verifierTerms.length) {
        throw createValidationError("Benchmark jobs need at least one verifier keyword.");
      }
      if (!Number.isInteger(minimumMatches) || minimumMatches < 1) {
        throw createValidationError("Benchmark minimum matches must be at least 1.");
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
        throw createValidationError("Deterministic jobs need at least one expected output.");
      }
      if (matchMode !== "exact" && matchMode !== "contains_all") {
        throw createValidationError(`Invalid deterministic match mode: ${matchMode}`);
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

  private normalizeId(value: string | undefined): string {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
}
