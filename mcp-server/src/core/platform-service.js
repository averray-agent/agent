import { createStateStore } from "./state-store.js";
import { AccountMutationService } from "./account-mutation-service.js";
import { JobCatalogService } from "./job-catalog-service.js";
import { JobExecutionService } from "./job-execution-service.js";
import { VerificationIngestionService } from "../services/verification-ingestion-service.js";
import { ValidationError } from "./errors.js";

const STARTER_REPUTATION = {
  skill: 0,
  reliability: 0,
  economic: 0,
  tier: "starter"
};

export class PlatformService {
  constructor(jobs, profiles, accounts, reputations, blockchainGateway = undefined, stateStore = createStateStore(), eventBus = undefined) {
    this.jobs = jobs;
    this.profiles = profiles;
    this.accounts = accounts;
    this.reputations = reputations;
    this.blockchainGateway = blockchainGateway;
    this.stateStore = stateStore;
    this.eventBus = eventBus;

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
        "fundAccount",
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
    return this.jobCatalogService.listJobs();
  }

  createJob(input) {
    return this.jobCatalogService.createJob(input);
  }

  getJobDefinition(jobId) {
    return this.jobCatalogService.getJobDefinition(jobId);
  }

  async recommendJobs(wallet) {
    return this.jobCatalogService.recommendJobs(wallet);
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
      jobStakeLocked: {},
      debtOutstanding: {}
    };
  }

  async fundAccount(wallet, asset, amount) {
    if (this.blockchainGateway?.isEnabled()) {
      return this.blockchainGateway.fundAccount(wallet, asset, amount);
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      throw new ValidationError("Funding amount must be greater than zero.");
    }

    const account = await this.getAccountSummary(wallet);
    account.liquid[asset] = (account.liquid[asset] ?? 0) + numericAmount;
    this.accounts.set(wallet, account);
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
}
