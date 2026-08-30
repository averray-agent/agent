import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, id } from "ethers";

import {
  INGEST_REFUSED_SPEC_HASH_MISMATCH,
  PlatformService
} from "./platform-service.js";
import { hashCanonicalContent } from "./canonical-content.js";
import { EventBus } from "./event-bus.js";
import { InsufficientLiquidityError } from "./errors.js";
import { MemoryStateStore } from "./state-store.js";
import { buildJobSnapshot } from "./job-snapshot.js";
import { WorkerDailyExposurePolicy } from "./worker-daily-exposure.js";
import { WorkerProgressionService } from "./worker-progression.js";
import { BOOTSTRAP_JOBS } from "../services/bootstrap-jobs.js";
import {
  buildExternalSchemaRegistrationTypedData,
  hashExternalSchemaContent
} from "./job-schema-registry.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DESIGNATED_WALLET = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const OTHER_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CANONICAL_USDC_ASSET = {
  symbol: "USDC",
  assetClass: "trust_backed",
  assetId: 1337,
  decimals: 6,
  address: "0x0000053900000000000000000000000001200000",
  minBalanceRaw: "70000"
};
const EXTERNAL_SCHEMA_SIGNER = new Wallet("0x8b3a350cf5c34c9194ca3a545d0ec67d61f328d6e5d11dd95b9af16e70ec4c63");
const EXTERNAL_SCHEMA_REF = "schema://jobs/off-platform-output";
const EXTERNAL_SCHEMA_URL = "https://schemas.example.com/jobs/off-platform-output.json";
const EXTERNAL_SCHEMA_CHAIN_ID = 420420421n;
const EXTERNAL_SCHEMA_VERIFYING_CONTRACT = "0x2222222222222222222222222222222222222222";
const EXTERNAL_SCHEMA = {
  $id: EXTERNAL_SCHEMA_REF,
  type: "object",
  additionalProperties: false,
  required: ["summary", "result"],
  properties: {
    summary: { type: "string", minLength: 1 },
    result: { type: "string", enum: ["pass", "fail"] }
  }
};
const EXTERNAL_LISTING_JOB_ID = `0x${"ab".repeat(32)}`;
const EXTERNAL_POSTER = "0x1111111111111111111111111111111111111111";
const BLIND_TESTER_WALLET = "0x97450bf69cb4aeb0b33db3ae51ac2d18224d4b5c";

function makeParentJob(overrides = {}) {
  return {
    id: "parent-job-001",
    category: "coding",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: 5,
    verifierMode: "benchmark",
    verifierConfig: {
      version: 1,
      handler: "benchmark",
      requiredKeywords: ["complete"],
      minimumMatches: 1
    },
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 3600,
    retryLimit: 1,
    requiresSponsoredGas: true,
    onboardingWaiverEligible: true,
    ...overrides
  };
}

function makePlatformService(
  blockchainGateway = undefined,
  eventBus = undefined,
  stateStore = undefined,
  onboardingSubsidyBudget = undefined,
  workerExposurePolicy = undefined,
  workerDailyExposurePolicy = undefined,
  catalogueDailyBudget = undefined,
  jobOverrides = {}
) {
  const jobs = [makeParentJob(jobOverrides)];
  const profiles = new Map([
    [WALLET, {
      wallet: WALLET,
      preferredCategories: ["coding"],
      verifierCompatibility: ["benchmark", "deterministic", "human_fallback"],
      preferredRiskLevel: "low",
      capabilities: ["claim_job", "submit_work"],
      supportedProtocols: ["http"],
      minLiquidReserve: 0,
      autoUnwindStrategies: false
    }]
  ]);
  const accounts = new Map([
    [WALLET, {
      wallet: WALLET,
      liquid: { DOT: 10 },
      reserved: {},
      strategyAllocated: {},
      collateralLocked: {},
      jobStakeLocked: {},
      debtOutstanding: {}
    }]
  ]);
  const reputations = new Map([
    [WALLET, { skill: 50, reliability: 50, economic: 50, tier: "starter" }]
  ]);
  const service = new PlatformService(
    jobs,
    profiles,
    accounts,
    reputations,
    blockchainGateway,
    stateStore,
    eventBus,
    undefined,
    onboardingSubsidyBudget,
    workerExposurePolicy,
    workerDailyExposurePolicy,
    catalogueDailyBudget
  );
  blockchainGateway?.setServedDefinition?.(service.getClaimableJobDefinition(jobs[0].id));
  return service;
}

function blockingWorkerExposurePolicy() {
  return {
    async evaluate({ wallet, job }) {
      assert.equal(wallet, WALLET);
      assert.equal(job.id, "parent-job-001");
      return {
        eligible: false,
        status: "exceeded",
        reason: "worker_open_exposure_cap_reached",
        capUsdc: 1,
        currentExposureUsdc: 0.8,
        candidateExposureUsdc: 0.559,
        projectedExposureUsdc: 1.359,
        headroomUsdc: 0.2
      };
    }
  };
}

function dailyExposurePolicy({ eligible = false } = {}) {
  return {
    async evaluate({ wallet, job }) {
      assert.equal(wallet, WALLET);
      assert.equal(job.id, "parent-job-001");
      return {
        eligible,
        applies: true,
        status: eligible ? "within_budget" : "exceeded",
        reason: eligible ? "daily_exposure_within_budget" : "daily_exposure_budget_reached",
        dailyExposureBudgetRaw: "1500000",
        dailyExposureUsedRaw: "1236000",
        dailyExposureRemainingRaw: "264000",
        dailyExposureRemaining: 0.264,
        candidateExposureRaw: "309000",
        projectedDailyExposureRaw: "1545000",
        retryAfter: eligible ? undefined : "2026-08-13T06:00:00.000Z",
        retryAfterSeconds: eligible ? undefined : 60,
        entry: {
          version: "worker-catalogue-exposure-v2",
          accessMode: "rolling_daily",
          candidate: { reservedRewardUsdc: 0.25, brokeredGasUsdc: 0.059, totalUsdc: 0.309 }
        },
        message: eligible ? "within budget" : "daily budget reached"
      };
    }
  };
}

function makeClaimEconomicsGateway({
  contractLayout = "current",
  initialState = 1,
  onboardingWaiverEligible = false,
  workerClaimCount = 0,
  onboardingWaiverClaimCount = 3,
  failWaiverPolicyRead = false,
  claimFeeRetainedOnSuccess = false,
  gasRetentionSupported = false
} = {}) {
  let state = initialState;
  let mappedEligibility = onboardingWaiverEligible;
  let committedSpecHash;
  const gateway = {
    previewCalls: 0,
    isEnabled: () => true,
    toJobId: (jobId) => `chain:${jobId}`,
    async getAccountSummary(wallet) {
      return {
        wallet,
        liquid: { DOT: 10 },
        reserved: {},
        strategyAllocated: {},
        collateralLocked: {},
        jobStakeLocked: {},
        debtOutstanding: {}
      };
    },
    async getReputation() {
      return { skill: 50, reliability: 50, economic: 50 };
    },
    async getDefaultClaimStakeBps() {
      return 1000;
    },
    async getClaimEconomicsConfig({ requireWaiverInputs = false } = {}) {
      if (requireWaiverInputs && failWaiverPolicyRead) {
        throw new Error("onboardingWaiverClaimCount read failed");
      }
      return {
        claimFeeBps: 200,
        claimFeeVerifierBps: 7000,
        onboardingWaiverClaimCount,
        minClaimFeeByAsset: { DOT: 0.05 }
      };
    },
    async getWorkerClaimCount(wallet) {
      assert.equal(wallet, WALLET);
      return workerClaimCount;
    },
    async getClaimEconomicsDecisionState() {
      return {
        state,
        exists: state !== 0,
        contractLayout,
        claimFeeRetainedOnSuccess,
        gasRetentionSupported,
        onboardingWaiverEligible: contractLayout === "legacy" ? false : mappedEligibility
      };
    },
    async previewGasRetentionForJob(jobId, asset, rewardAmount, { brokered, waived }) {
      assert.equal(jobId, "parent-job-001");
      const retained = gasRetentionSupported && brokered && !waived
        ? Math.min(0.05, Number(rewardAmount) * 0.2)
        : 0;
      return {
        supported: gasRetentionSupported,
        brokered,
        waived,
        retentionFlatRaw: gasRetentionSupported ? "50000" : undefined,
        retentionFlat: gasRetentionSupported ? 0.05 : undefined,
        retentionCapBps: gasRetentionSupported ? 2000 : undefined,
        rewardRaw: asset === "USDC" ? String(Math.round(Number(rewardAmount) * 1_000_000)) : undefined,
        retainedRaw: asset === "USDC" ? String(Math.round(retained * 1_000_000)) : "0",
        retained,
        netRewardRaw: asset === "USDC" ? String(Math.round((Number(rewardAmount) - retained) * 1_000_000)) : undefined,
        netReward: Number(rewardAmount) - retained,
        ...(gasRetentionSupported ? { source: "escrow_v3_claim_schedule" } : {})
      };
    },
    async getJob() {
      return { state, specHash: committedSpecHash };
    },
    setServedDefinition(job) {
      committedSpecHash = buildJobSnapshot(job).specHash;
    },
    async previewClaimEconomics() {
      gateway.previewCalls += 1;
      const claimNumber = workerClaimCount + 1;
      const waived = contractLayout !== "legacy"
        && mappedEligibility
        && claimNumber <= onboardingWaiverClaimCount;
      return waived
        ? {
            claimStake: 0,
            claimStakeBps: 0,
            claimFee: 0,
            claimFeeBps: 0,
            claimEconomicsWaived: true,
            claimNumber,
            totalClaimLock: 0
          }
        : {
            claimStake: 0.5,
            claimStakeBps: 1000,
            claimFee: 0.1,
            claimFeeBps: 200,
            claimEconomicsWaived: false,
            claimNumber,
            totalClaimLock: 0.6
          };
    },
    async ensureJob(job) {
      if (state === 0) {
        state = 1;
      }
      if (contractLayout !== "legacy" && job.onboardingWaiverEligible === true) {
        mappedEligibility = true;
      }
    },
    async ensureClaimStakeLiquidity() {},
    async claimJob() {
      state = 2;
    }
  };
  return gateway;
}

test("v3 retention quote is identical in preflight, explain, and brokered claim; self-paid is zero", async () => {
  const gateway = makeClaimEconomicsGateway({
    onboardingWaiverEligible: false,
    workerClaimCount: 3,
    gasRetentionSupported: true
  });
  const service = makePlatformService(
    gateway,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { rewardAsset: "USDC", rewardAmount: 0.25, onboardingWaiverEligible: false }
  );

  const preflight = await service.preflightJob(WALLET, "parent-job-001");
  const explain = await service.explainEligibility(WALLET, "parent-job-001");
  const [listing] = await service.recommendJobs(WALLET);
  const claimed = await service.claimJob(WALLET, "parent-job-001", "http", "v3-retention-parity");

  assert.equal(preflight.gasRetentionSupported, true);
  assert.deepEqual(preflight.gasRetention, {
    supported: true,
    brokered: true,
    waived: false,
    retentionFlatRaw: "50000",
    retentionFlat: 0.05,
    retentionCapBps: 2000,
    rewardRaw: "250000",
    retainedRaw: "50000",
    retained: 0.05,
    netRewardRaw: "200000",
    netReward: 0.2,
    source: "escrow_v3_claim_schedule"
  });
  assert.deepEqual(explain.gasRetention, preflight.gasRetention);
  assert.equal(listing.netReward, 0.2);
  assert.deepEqual(listing.gasRetention, preflight.gasRetention);
  assert.deepEqual(claimed.gasRetention, preflight.gasRetention);

  const selfPaid = makePlatformService(
    makeClaimEconomicsGateway({
      onboardingWaiverEligible: false,
      workerClaimCount: 3,
      gasRetentionSupported: true
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      rewardAsset: "USDC",
      rewardAmount: 0.25,
      onboardingWaiverEligible: false,
      source: "external"
    }
  );
  const selfPaidPreflight = await selfPaid.preflightJob(WALLET, "parent-job-001");
  const selfPaidExplain = await selfPaid.explainEligibility(WALLET, "parent-job-001");
  assert.equal(selfPaidPreflight.gasRetention.retainedRaw, "0");
  assert.equal(selfPaidPreflight.gasRetention.brokered, false);
  assert.deepEqual(selfPaidExplain.gasRetention, selfPaidPreflight.gasRetention);
});

test("platform capabilities use the same explicitly selected chain as public health", () => {
  const service = makePlatformService();
  const capabilities = service.getPlatformCapabilities({ chainId: 420420419 });
  const advertisedChains = capabilities.onboarding.walletModes
    .filter((mode) => mode.chain)
    .map((mode) => mode.chain);

  assert.ok(advertisedChains.length > 0);
  assert.ok(advertisedChains.every((chain) => chain.chainId === 420420419));
  assert.ok(advertisedChains.every((chain) => chain.currencySymbol === "DOT"));
  assert.ok(advertisedChains.every((chain) => chain.faucetUrl === undefined));
});

test("preflight refuses a claim that would exceed the wallet USDC exposure cap", async () => {
  const service = makePlatformService(
    undefined,
    undefined,
    new MemoryStateStore(),
    undefined,
    blockingWorkerExposurePolicy()
  );

  const preflight = await service.preflightJob(WALLET, "parent-job-001");

  assert.equal(preflight.eligible, false);
  assert.equal(preflight.reason, "worker_open_exposure_cap_reached");
  assert.deepEqual(preflight.workerExposure, {
    eligible: false,
    status: "exceeded",
    reason: "worker_open_exposure_cap_reached",
    capUsdc: 1,
    currentExposureUsdc: 0.8,
    candidateExposureUsdc: 0.559,
    projectedExposureUsdc: 1.359,
    headroomUsdc: 0.2
  });
  const explanation = await service.explainEligibility(WALLET, "parent-job-001");
  assert.equal(explanation.reason, preflight.reason);
  assert.deepEqual(explanation.workerExposure, preflight.workerExposure);
});

test("claim rechecks the wallet USDC exposure cap before any local claim write", async () => {
  const stateStore = new MemoryStateStore();
  const service = makePlatformService(
    undefined,
    undefined,
    stateStore,
    undefined,
    blockingWorkerExposurePolicy()
  );

  await assert.rejects(
    () => service.claimJob(WALLET, "parent-job-001", "http", "exposure-blocked"),
    (error) => {
      assert.equal(error.code, "worker_open_exposure_cap_reached");
      assert.equal(error.details.projectedExposureUsdc, 1.359);
      return true;
    }
  );
  assert.equal(await stateStore.findSessionByJobId("parent-job-001"), undefined);
});

test("preflight and explainEligibility predict the rolling daily exposure refusal", async () => {
  const service = makePlatformService(
    undefined,
    undefined,
    new MemoryStateStore(),
    undefined,
    undefined,
    dailyExposurePolicy()
  );

  const preflight = await service.preflightJob(WALLET, "parent-job-001");
  const explanation = await service.explainEligibility(WALLET, "parent-job-001");

  assert.equal(preflight.eligible, false);
  assert.equal(preflight.reason, "daily_exposure_budget_reached");
  assert.equal(preflight.dailyExposureRemaining, 0.264);
  assert.equal(preflight.dailyExposure.retryAfter, "2026-08-13T06:00:00.000Z");
  assert.equal(explanation.eligible, false);
  assert.equal(explanation.reason, preflight.reason);
  assert.equal(explanation.dailyExposureRemaining, preflight.dailyExposureRemaining);
  assert.deepEqual(explanation.dailyExposure, preflight.dailyExposure);
});

test("claim refuses the same daily boundary before session creation or brokering", async () => {
  const stateStore = new MemoryStateStore();
  const service = makePlatformService(
    undefined,
    undefined,
    stateStore,
    undefined,
    undefined,
    dailyExposurePolicy()
  );

  await assert.rejects(
    () => service.claimJob(WALLET, "parent-job-001", "http", "daily-exposure-blocked"),
    (error) => {
      assert.equal(error.code, "daily_exposure_budget_reached");
      assert.equal(error.details.dailyExposureRemaining, 0.264);
      assert.equal(error.details.retryAfter, "2026-08-13T06:00:00.000Z");
      return true;
    }
  );
  assert.equal(await stateStore.findSessionByJobId("parent-job-001"), undefined);
});

test("successful claim persists its durable daily exposure entry", async () => {
  const stateStore = new MemoryStateStore();
  const service = makePlatformService(
    undefined,
    undefined,
    stateStore,
    undefined,
    undefined,
    dailyExposurePolicy({ eligible: true })
  );

  const claimed = await service.claimJob(WALLET, "parent-job-001", "http", "daily-exposure-recorded");

  assert.deepEqual(claimed.dailyExposure, {
    version: "worker-catalogue-exposure-v2",
    accessMode: "rolling_daily",
    candidate: { reservedRewardUsdc: 0.25, brokeredGasUsdc: 0.059, totalUsdc: 0.309 }
  });
  assert.deepEqual((await stateStore.getSession(claimed.sessionId)).dailyExposure, claimed.dailyExposure);
});

test("claim, preflight, and explainEligibility report one identical lifetime catalogue credit", async () => {
  const stateStore = new MemoryStateStore();
  const dailyPolicy = new WorkerDailyExposurePolicy({
    stateStore,
    workerExposurePolicy: {
      exposureForDefinition() {
        return { rewardUnits: 250_000n, gasUnits: 59_000n, totalUnits: 309_000n };
      },
      exposureForSession() {
        return { rewardUnits: 250_000n, gasUnits: 59_000n, totalUnits: 309_000n };
      }
    }
  });
  const service = makePlatformService(
    undefined,
    undefined,
    stateStore,
    undefined,
    undefined,
    dailyPolicy
  );

  const preflight = await service.preflightJob(WALLET, "parent-job-001");
  const explanation = await service.explainEligibility(WALLET, "parent-job-001");
  const claimed = await service.claimJob(WALLET, "parent-job-001", "http", "tier3-parity");

  assert.equal(preflight.dailyAllowance, undefined);
  assert.equal(preflight.catalogueAccess.mode, "lifetime_credit");
  assert.equal(preflight.catalogueAccess.lifetimeCredit, 10);
  assert.deepEqual(explanation.catalogueAccess, preflight.catalogueAccess);
  assert.deepEqual(claimed.catalogueAccess, preflight.catalogueAccess);
  assert.equal("fromDeposits" in claimed.catalogueAccess, false);
});

test("lifetime-credit refusal is identical in preflight, explainEligibility, and claim", async () => {
  const stateStore = new MemoryStateStore();
  const refusal = {
    eligible: false,
    applies: true,
    status: "exceeded",
    reason: "lifetime_catalogue_credit_exhausted",
    catalogueAccess: {
      mode: "lifetime_credit",
      settledApprovedCatalogueJobs: 2,
      graduationSettledJobs: 10,
      externalWorkAffected: false
    },
    message: "Lifetime catalogue credit exhausted; external work remains available."
  };
  const service = makePlatformService(
    undefined,
    undefined,
    stateStore,
    undefined,
    undefined,
    { async evaluate() { return refusal; } }
  );

  const preflight = await service.preflightJob(WALLET, "parent-job-001");
  const explanation = await service.explainEligibility(WALLET, "parent-job-001");
  await assert.rejects(
    () => service.claimJob(WALLET, "parent-job-001", "http", "lifetime-refusal-parity"),
    (error) => error.code === preflight.reason && error.details.reason === explanation.reason
  );
  assert.deepEqual(explanation.catalogueAccess, preflight.catalogueAccess);
});

test("global catalogue-budget refusal is identical in preflight, explainEligibility, and claim", async () => {
  const stateStore = new MemoryStateStore();
  const workerExposurePolicy = {
    async evaluate() {
      return {
        eligible: true,
        candidate: { reservedRewardUsdc: 0.25, brokeredGasUsdc: 0.059, totalUsdc: 0.309 }
      };
    }
  };
  const catalogueDailyBudget = {
    async evaluate() {
      return {
        eligible: false,
        applies: true,
        reason: "catalogue_daily_budget_exhausted",
        retryAfter: "2026-08-14T12:00:00.000Z",
        message: "Global catalogue budget exhausted."
      };
    }
  };
  const service = makePlatformService(
    undefined,
    undefined,
    stateStore,
    undefined,
    workerExposurePolicy,
    undefined,
    catalogueDailyBudget
  );

  const preflight = await service.preflightJob(WALLET, "parent-job-001");
  const explanation = await service.explainEligibility(WALLET, "parent-job-001");
  await assert.rejects(
    () => service.claimJob(WALLET, "parent-job-001", "http", "global-refusal-parity"),
    (error) => error.code === preflight.reason && error.details.retryAfter === explanation.catalogueDailyBudget.retryAfter
  );
  assert.deepEqual(explanation.catalogueDailyBudget, preflight.catalogueDailyBudget);
});

test("external capital-ceiling refusal is identical in preflight, explainEligibility, and claim", async () => {
  const stateStore = new MemoryStateStore();
  const workerExposurePolicy = {
    async evaluate() {
      return {
        eligible: false,
        applies: true,
        reason: "external_reward_exceeds_capital_ceiling",
        vestedAssetsRaw: "0",
        externalRewardCeilingRaw: "1000000",
        message: "External reward exceeds the capital-backed ceiling."
      };
    }
  };
  const service = makePlatformService(undefined, undefined, stateStore, undefined, workerExposurePolicy);
  service.jobs[0] = { ...service.jobs[0], source: "external", poster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
  await stateStore.materializeExternalJobDraft({
    draftId: "external-capital-ceiling-draft",
    jobId: service.jobs[0].id,
    wallet: service.jobs[0].poster,
    definition: service.jobs[0],
    status: "live"
  });

  const preflight = await service.preflightJob(WALLET, "parent-job-001");
  const explanation = await service.explainEligibility(WALLET, "parent-job-001");
  await assert.rejects(
    () => service.claimJob(WALLET, "parent-job-001", "http", "external-ceiling-parity"),
    (error) => error.code === preflight.reason && error.details.externalRewardCeilingRaw === explanation.workerExposure.externalRewardCeilingRaw
  );
  assert.deepEqual(explanation.workerExposure, preflight.workerExposure);
});

test("preflight, explain, and claim share the claim-scope definition mismatch refusal", async () => {
  const stateStore = new MemoryStateStore();
  const gateway = makeClaimEconomicsGateway({ initialState: 1 });
  let brokerCalls = 0;
  let exposureCalls = 0;
  gateway.getJob = async () => ({ state: 1, specHash: `0x${"f".repeat(64)}` });
  gateway.claimJob = async () => { brokerCalls += 1; };
  const mustNotEvaluateExposure = {
    async evaluate() {
      exposureCalls += 1;
      return { eligible: true };
    }
  };
  const service = makePlatformService(
    gateway,
    undefined,
    stateStore,
    undefined,
    mustNotEvaluateExposure,
    mustNotEvaluateExposure
  );

  const preflight = await service.preflightJob(WALLET, "parent-job-001");
  const explanation = await service.explainEligibility(WALLET, "parent-job-001");

  assert.equal(preflight.eligible, false);
  assert.equal(preflight.reason, "job_definition_chain_mismatch");
  assert.equal(preflight.jobDefinitionIntegrity.status, "mismatch");
  assert.equal(explanation.eligible, false);
  assert.equal(explanation.reason, preflight.reason);
  assert.deepEqual(explanation.jobDefinitionIntegrity, preflight.jobDefinitionIntegrity);
  await assert.rejects(
    () => service.claimJob(WALLET, "parent-job-001", "http", "preflight-definition-mismatch"),
    (error) => error?.code === preflight.reason
  );
  assert.equal(brokerCalls, 0);
  assert.equal(exposureCalls, 0);
  assert.equal(await stateStore.findSessionByJobId("parent-job-001"), undefined);
});

test("createSubJob links the child job to the active parent session", async () => {
  const service = makePlatformService();
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "parent-claim");

  const subJob = await service.createSubJob(session.sessionId, WALLET, {
    id: "child-job-001",
    category: "review",
    tier: "starter",
    rewardAmount: 2,
    verifierMode: "benchmark",
    verifierTerms: ["summary"],
    verifierMinimumMatches: 1,
    inputSchemaRef: "schema://jobs/review-input",
    outputSchemaRef: "schema://jobs/pr-review-findings-output",
    claimTtlSeconds: 1800,
    retryLimit: 1,
    requiresSponsoredGas: true
  });

  assert.equal(subJob.parentSessionId, session.sessionId);
  assert.equal(subJob.lineage.kind, "sub_job");
  assert.equal(subJob.lineage.parentJobId, "parent-job-001");
  assert.equal(subJob.lineage.depth, 1);
  assert.equal(subJob.lineage.budget.usedAfterAmount, 2);
  assert.equal(subJob.lineage.funding.asset, "DOT");
  const account = await service.getAccountSummary(WALLET);
  assert.equal(account.liquid.DOT, 8);
  assert.equal(account.reserved.DOT, 2);
  const subJobs = await service.listSubJobs(session.sessionId);
  assert.equal(subJobs.length, 1);
  assert.equal(subJobs[0].id, "child-job-001");
});

test("createAdminJob reserves finite recurring template funding from the poster wallet", async () => {
  const service = makePlatformService();

  const template = await service.createAdminJob({
    id: "weekly-recurring-001",
    category: "coding",
    tier: "starter",
    rewardAmount: 5,
    rewardAsset: "DOT",
    verifierMode: "benchmark",
    verifierTerms: ["complete"],
    verifierMinimumMatches: 1,
    recurring: true,
    schedule: { cron: "0 9 * * 1" },
    recurringPolicy: { reserveAmount: 10, reserveAsset: "DOT" }
  }, { posterWallet: WALLET });

  assert.equal(template.recurringPolicy.funding.source, "recurring_template_reserve");
  assert.equal(template.recurringPolicy.funding.wallet, WALLET);
  const account = await service.getAccountSummary(WALLET);
  assert.equal(account.liquid.DOT, 0);
  assert.equal(account.reserved.DOT, 10);

  const derivative = service.fireRecurringJob("weekly-recurring-001", {
    firedAt: new Date("2026-05-04T09:00:00.000Z")
  });
  assert.equal(derivative.funding.source, "recurring_template_reserve");
  assert.equal(derivative.funding.wallet, WALLET);
  assert.equal(derivative.funding.amount, 5);
});

test("recurring catalogue derivatives pass the posting lane before creation", async () => {
  const service = makePlatformService();
  await service.createAdminJob({
    id: "lane-recurring-001",
    category: "coding",
    tier: "starter",
    lane: "oss-anchored",
    rewardAmount: 1,
    rewardAsset: "DOT",
    verifierMode: "benchmark",
    verifierTerms: ["complete"],
    verifierMinimumMatches: 1,
    recurring: true,
    schedule: { cron: "0 9 * * 1" },
    recurringPolicy: { reserveAmount: 2, reserveAsset: "DOT" }
  }, { posterWallet: WALLET });
  const observed = [];
  service.setCatalogueLaneDiscipline({
    async post(candidate, action, { now }) {
      observed.push({ candidate, now });
      return action();
    }
  });
  const firedAt = new Date("2026-05-04T09:00:00.000Z");

  const derivative = await service.fireRecurringJob("lane-recurring-001", { firedAt });

  assert.equal(observed.length, 1);
  assert.equal(observed[0].candidate.id, derivative.id);
  assert.equal(observed[0].candidate.lane, "oss-anchored");
  assert.equal(observed[0].candidate.rewardAmount, 1);
  assert.equal(observed[0].now, firedAt);
});

test("createAdminJob reserves the snapshotted success fees for every unwaived recurring run", async () => {
  const reserveCalls = [];
  const gateway = {
    config: { supportedAssets: [] },
    isEnabled: () => true,
    async previewProtocolFeeForAsset(asset, rewardAmount) {
      assert.equal(asset, "DOT");
      assert.equal(rewardAmount, 5);
      return { protocolFeeAmount: 0.5, protocolFeeBps: 1_000 };
    },
    async reserveRecurringTemplateFunding(wallet, asset, amount, templateId) {
      reserveCalls.push({ wallet, asset, amount, templateId });
      return { amountRaw: "11000000000000000000", templateKey: "0xtemplate" };
    }
  };
  const service = makePlatformService(gateway);

  const template = await service.createAdminJob({
    id: "weekly-fee-bearing-001",
    category: "coding",
    tier: "pro",
    rewardAmount: 5,
    rewardAsset: "DOT",
    verifierMode: "benchmark",
    verifierTerms: ["complete"],
    verifierMinimumMatches: 1,
    recurring: true,
    schedule: { cron: "0 9 * * 1" },
    recurringPolicy: { reserveAmount: 10, reserveAsset: "DOT", maxRuns: 2 }
  }, { posterWallet: WALLET });

  assert.deepEqual(reserveCalls, [{
    wallet: WALLET,
    asset: "DOT",
    amount: 11,
    templateId: "weekly-fee-bearing-001"
  }]);
  assert.equal(template.recurringPolicy.funding.amount, 10);
  assert.equal(template.recurringPolicy.funding.protocolFeeReserveAmount, 1);
  assert.equal(template.recurringPolicy.funding.totalReservedAmount, 11);
  assert.equal(template.recurringPolicy.funding.protocolFeeBps, 1_000);
});

test("createAdminJob does not reserve protocol fees for onboarding-waived recurring runs", async () => {
  const reserveCalls = [];
  const gateway = {
    config: { supportedAssets: [] },
    isEnabled: () => true,
    async previewProtocolFeeForAsset() {
      throw new Error("fee quote must not run for a waived template");
    },
    async reserveRecurringTemplateFunding(_wallet, _asset, amount) {
      reserveCalls.push(amount);
      return {};
    }
  };
  const service = makePlatformService(gateway);

  await service.createAdminJob({
    id: "weekly-fee-waived-001",
    category: "coding",
    tier: "starter",
    rewardAmount: 5,
    rewardAsset: "DOT",
    verifierMode: "benchmark",
    verifierTerms: ["complete"],
    verifierMinimumMatches: 1,
    onboardingWaiverEligible: true,
    recurring: true,
    schedule: { cron: "0 9 * * 1" },
    recurringPolicy: { reserveAmount: 10, reserveAsset: "DOT", maxRuns: 2 }
  }, { posterWallet: WALLET });

  assert.deepEqual(reserveCalls, [10]);
});

test("external-schema admin job posts, claims, and validates against off-platform schema", async () => {
  const schemaHash = hashExternalSchemaContent(EXTERNAL_SCHEMA);
  const jobId = "off-platform-schema-job-001";
  const typedData = buildExternalSchemaRegistrationTypedData({
    schemaHash,
    schemaUrl: EXTERNAL_SCHEMA_URL,
    jobId: id(jobId),
    chainId: EXTERNAL_SCHEMA_CHAIN_ID,
    verifyingContract: EXTERNAL_SCHEMA_VERIFYING_CONTRACT
  });
  const signature = await EXTERNAL_SCHEMA_SIGNER.signTypedData(typedData.domain, typedData.types, typedData.value);
  const calls = [];
  let liveState = 0;
  const gateway = {
    isEnabled: () => true,
    toJobId: (value) => id(value),
    getDefaultClaimStakeBps: async () => 500,
    getClaimEconomicsConfig: async () => ({ onboardingWaiverClaimCount: 3 }),
    getWorkerClaimCount: async () => 0,
    getClaimEconomicsDecisionState: async () => ({
      state: liveState,
      exists: liveState !== 0,
      contractLayout: "current",
      onboardingWaiverEligible: false
    }),
    isTrustedSchemaIssuer: async (issuer) => issuer === EXTERNAL_SCHEMA_SIGNER.address,
    getExternalSchemaSigningDomain: async () => ({
      chainId: EXTERNAL_SCHEMA_CHAIN_ID,
      verifyingContract: EXTERNAL_SCHEMA_VERIFYING_CONTRACT
    }),
    getJob: async () => ({ state: liveState }),
    ensureJob: async (job, instanceJobId) => {
      calls.push(["ensureJob", { job, instanceJobId }]);
    },
    ensureClaimStakeLiquidity: async () => {},
    claimJob: async () => {
      liveState = 1;
      calls.push(["claimJob"]);
    },
    submitWork: async (_jobId, evidenceHash) => {
      calls.push(["submitWork", evidenceHash]);
    }
  };
  const service = makePlatformService(gateway, undefined, new MemoryStateStore());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return EXTERNAL_SCHEMA;
    }
  });
  try {
    const job = await service.createAdminJob({
      id: jobId,
      category: "off-platform",
      tier: "starter",
      rewardAmount: 1,
      rewardAsset: "DOT",
      verifierMode: "benchmark",
      verifierTerms: ["summary"],
      verifierMinimumMatches: 1,
      inputSchemaRef: "schema://jobs/coding-input",
      outputSchemaRef: EXTERNAL_SCHEMA_REF,
      claimTtlSeconds: 3600,
      retryLimit: 1,
      externalSchema: {
        schemaHash,
        schemaUrl: EXTERNAL_SCHEMA_URL,
        schemaIssuer: EXTERNAL_SCHEMA_SIGNER.address,
        signature
      }
    }, { posterWallet: WALLET });

    assert.equal(job.schemaRegistrations[0].schemaIssuer, EXTERNAL_SCHEMA_SIGNER.address);
    assert.equal(job.schemaRegistrations[0].schemaHash, schemaHash);
    const claimed = await service.claimJob(WALLET, jobId, "http", "external-schema-claim");
    const submitted = await service.submitWork(claimed.sessionId, "http", {
      summary: "External schema was honored.",
      result: "pass"
    });

    assert.equal(submitted.outputSchemaRegistered, true);
    assert.equal(submitted.submission.structured.result, "pass");
    assert.equal(calls.find(([name]) => name === "ensureJob")?.[1].job.schemaRegistrations[0].schemaHash, schemaHash);
    assert.ok(calls.some(([name]) => name === "submitWork"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createJob allows USDC rewards at or above asset minBalance", () => {
  const service = makePlatformService({
    config: { supportedAssets: [CANONICAL_USDC_ASSET] }
  });

  const exact = service.createJob({
    id: "usdc-minbalance-exact",
    category: "product_proof",
    tier: "starter",
    rewardAmount: 0.07,
    rewardAsset: "USDC",
    verifierMode: "benchmark",
    verifierTerms: ["complete"],
    verifierMinimumMatches: 1,
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 1800,
    retryLimit: 1
  });
  const double = service.createJob({
    id: "usdc-minbalance-double",
    category: "product_proof",
    tier: "starter",
    rewardAmount: 0.14,
    rewardAsset: "USDC",
    verifierMode: "benchmark",
    verifierTerms: ["complete"],
    verifierMinimumMatches: 1,
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 1800,
    retryLimit: 1
  });

  assert.equal(exact.rewardAmount, 0.07);
  assert.equal(double.rewardAmount, 0.14);
});

test("createJob rejects USDC rewards below asset minBalance and rolls back catalog insertion", () => {
  const service = makePlatformService({
    config: { supportedAssets: [CANONICAL_USDC_ASSET] }
  });

  assert.throws(
    () => service.createJob({
      id: "usdc-minbalance-low",
      category: "product_proof",
      tier: "starter",
      rewardAmount: 0.069999,
      rewardAsset: "USDC",
      verifierMode: "benchmark",
      verifierTerms: ["complete"],
      verifierMinimumMatches: 1,
      inputSchemaRef: "schema://jobs/coding-input",
      outputSchemaRef: "schema://jobs/coding-output",
      claimTtlSeconds: 1800,
      retryLimit: 1
    }),
    (error) => {
      assert.equal(error.code, "invalid_request");
      assert.match(error.message, /Job reward below asset minBalance/u);
      assert.equal(error.details.rewardRaw, "69999");
      assert.equal(error.details.minBalanceRaw, "70000");
      return true;
    }
  );
  assert.equal(service.listJobs().some((job) => job.id === "usdc-minbalance-low"), false);
});

test("createSubJob enforces parent delegation budget and count policy", async () => {
  const service = makePlatformService();
  service.jobs[0].delegationPolicy = { budgetAmount: 2, budgetAsset: "DOT", maxSubJobs: 1, maxDepth: 1 };
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "parent-budget-claim");

  await assert.rejects(
    () => service.createSubJob(session.sessionId, WALLET, {
      id: "child-too-expensive",
      category: "review",
      tier: "starter",
      rewardAmount: 3,
      verifierMode: "benchmark",
      verifierTerms: ["summary"],
      verifierMinimumMatches: 1,
      inputSchemaRef: "schema://jobs/review-input",
      outputSchemaRef: "schema://jobs/pr-review-findings-output",
      claimTtlSeconds: 1800,
      retryLimit: 1,
      requiresSponsoredGas: true
    }),
    (err) => err.code === "subjob_budget_exceeded"
  );

  await service.createSubJob(session.sessionId, WALLET, {
    id: "child-budget-ok",
    category: "review",
    tier: "starter",
    rewardAmount: 2,
    verifierMode: "benchmark",
    verifierTerms: ["summary"],
    verifierMinimumMatches: 1,
    inputSchemaRef: "schema://jobs/review-input",
    outputSchemaRef: "schema://jobs/pr-review-findings-output",
    claimTtlSeconds: 1800,
    retryLimit: 1,
    requiresSponsoredGas: true
  });

  await assert.rejects(
    () => service.createSubJob(session.sessionId, WALLET, {
      id: "child-too-many",
      category: "review",
      tier: "starter",
      rewardAmount: 1,
      verifierMode: "benchmark",
      verifierTerms: ["summary"],
      verifierMinimumMatches: 1,
      inputSchemaRef: "schema://jobs/review-input",
      outputSchemaRef: "schema://jobs/pr-review-findings-output",
      claimTtlSeconds: 1800,
      retryLimit: 1,
      requiresSponsoredGas: true
    }),
    (err) => err.code === "subjob_count_exceeded"
  );
});

test("createSubJob rejects grandchild delegation by default depth policy", async () => {
  const service = makePlatformService();
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "parent-depth-claim");
  const subJob = await service.createSubJob(session.sessionId, WALLET, {
    id: "depth-child-job",
    category: "coding",
    tier: "starter",
    rewardAmount: 2,
    verifierMode: "benchmark",
    verifierTerms: ["summary"],
    verifierMinimumMatches: 1,
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 1800,
    retryLimit: 1,
    requiresSponsoredGas: true
  });
  const childSession = await service.claimJob(WALLET, subJob.id, "http", "child-depth-claim");

  await assert.rejects(
    () => service.createSubJob(childSession.sessionId, WALLET, {
      id: "grandchild-blocked",
      category: "coding",
      tier: "starter",
      rewardAmount: 1,
      verifierMode: "benchmark",
      verifierTerms: ["summary"],
      verifierMinimumMatches: 1,
      inputSchemaRef: "schema://jobs/coding-input",
      outputSchemaRef: "schema://jobs/coding-output",
      claimTtlSeconds: 1800,
      retryLimit: 1,
      requiresSponsoredGas: true
    }),
    (err) => err.code === "subjob_depth_exceeded"
  );
});

test("listJobsWithSessions joins active session state onto job rows", async () => {
  const service = makePlatformService();

  // Before any claim — listJobs and listJobsWithSessions agree.
  const before = await service.listJobsWithSessions();
  assert.equal(before.length, 1);
  assert.equal(before[0].id, "parent-job-001");
  assert.equal(before[0].claimedBy ?? null, null);
  assert.equal(before[0].sessionId ?? null, null);
  assert.equal(before[0].state, "open");
  assert.equal(before[0].claimState, "open");
  assert.equal(before[0].claimable, true);

  // After a claim — the row carries claim state read live from the
  // session store so the public /jobs feed and the operator queue
  // stop showing the row as "ready / unclaimed" the moment a worker
  // locks it in.
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "claim-state-test");
  const after = await service.listJobsWithSessions();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, "parent-job-001");
  assert.equal(after[0].claimedBy, WALLET);
  assert.equal(after[0].sessionId, session.sessionId);
  assert.equal(typeof after[0].state, "string");
  assert.equal(after[0].state, session.status);
  assert.equal(after[0].claimState, "claimed");
  assert.equal(after[0].claimable, false);
  assert.equal(after[0].currentWalletCanClaim, null);
  assert.equal(after[0].claimExpiresAt, new Date(Date.parse(session.claimedAt) + 3600 * 1000).toISOString());
});

test("listJobsWithSessions reuses one reward-bank reading for lazy-funded catalog jobs", async () => {
  let reads = 0;
  const service = makePlatformService({ isEnabled: () => true });
  service.setRewardBankHealthProvider(async () => {
    reads += 1;
    return {
      asset: "DOT",
      decimals: 18,
      liquidRaw: "4000000000000000000",
      readable: true,
      asOf: "2026-07-27T12:00:00.000Z"
    };
  });

  const rows = await service.listJobsWithSessions();

  assert.equal(reads, 1);
  assert.equal(rows[0].claimable, false);
  assert.equal(rows[0].reason, "reward_funding_pending");
  assert.equal(rows[0].fundingState, "pending");
});

test("listJobsWithSessions and definition return an unsubmitted expired claim to inventory", async () => {
  const service = makePlatformService();
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "expired-claim-test");
  await service.stateStore.upsertSession({
    ...session,
    claimedAt: "2026-05-01T11:18:03.973Z",
    statusHistory: [
      {
        from: null,
        to: "claimed",
        reason: "job_claimed",
        at: "2026-05-01T11:18:03.973Z"
      }
    ]
  });

  const now = new Date("2026-05-01T12:18:04.000Z");
  const rows = await service.listJobsWithSessions({ wallet: WALLET, now });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "expired");
  assert.equal(rows[0].claimState, "expired");
  assert.equal(rows[0].effectiveState, "claimable");
  assert.equal(rows[0].claimable, true);
  assert.equal(rows[0].currentWalletCanClaim, true);
  assert.equal(rows[0].reason, "claim_ttl_expired_reopen_available");
  assert.equal(rows[0].claimAttemptCount, 0);
  assert.equal(rows[0].remainingClaimAttempts, 1);
  assert.equal(rows[0].claimedBy, WALLET);
  assert.equal(rows[0].claimedAt, "2026-05-01T11:18:03.973Z");
  assert.equal(rows[0].claimExpiresAt, "2026-05-01T12:18:03.973Z");
  assert.equal(rows[0].retryLimit, 1);
  assert.equal(rows[0].sessionId, session.sessionId);

  const stored = await service.resumeSession(session.sessionId);
  assert.equal(stored.status, "expired");
  assert.equal(stored.expiredAt, "2026-05-01T12:18:03.973Z");

  const definition = await service.getPublicJobDefinition("parent-job-001", { wallet: WALLET, now });
  assert.equal(definition.lifecycle.state, "open");
  assert.equal(definition.claimabilitySource, "claimStatus");
  assert.match(definition.lifecycleStatusMeaning, /check claimStatus/u);
  assert.equal(definition.claimState, "expired");
  assert.equal(definition.effectiveState, "claimable");
  assert.equal(definition.claimStatus.claimExpiresAt, "2026-05-01T12:18:03.973Z");
  assert.equal(definition.claimStatus.reason, "claim_ttl_expired_reopen_available");
  assert.equal(definition.claimStatus.claimabilitySource, "claimStatus");
  assert.match(definition.claimStatus.lifecycleStatusMeaning, /check claimStatus/u);
});

test("preflight uses chain worker claim count for claim economics in blockchain mode", async () => {
  const blockchainGateway = {
    isEnabled() {
      return true;
    },
    async getAccountSummary(wallet) {
      assert.equal(wallet, WALLET);
      return {
        wallet,
        liquid: { DOT: 10 },
        reserved: {},
        strategyAllocated: {},
        collateralLocked: {},
        jobStakeLocked: {},
        debtOutstanding: {}
      };
    },
    async getReputation(wallet) {
      assert.equal(wallet, WALLET);
      return { skill: 50, reliability: 50, economic: 50 };
    },
    async getDefaultClaimStakeBps() {
      return 500;
    },
    async getClaimEconomicsConfig() {
      return {
        claimFeeBps: 200,
        claimFeeVerifierBps: 7000,
        onboardingWaiverClaimCount: 3,
        minClaimFeeByAsset: { DOT: 0.05 }
      };
    },
    async getClaimEconomicsDecisionState() {
      return {
        state: 0,
        exists: false,
        contractLayout: "current",
        onboardingWaiverEligible: false
      };
    },
    async getWorkerClaimCount(wallet) {
      assert.equal(wallet, WALLET);
      return 3;
    }
  };
  const service = makePlatformService(blockchainGateway);

  const preflight = await service.preflightJob(WALLET, "parent-job-001");

  assert.equal(preflight.claimNumber, 4);
  assert.equal(preflight.claimEconomicsWaived, false);
  assert.equal(preflight.claimStake, 0.25);
  assert.equal(preflight.claimFee, 0.1);
  assert.equal(preflight.totalClaimLock, 0.35);
});

test("designated-claimant parity mutation drill binds both preflight and claim to the same wallet", async () => {
  const service = makePlatformService(
    undefined,
    undefined,
    new MemoryStateStore(),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      designatedClaimants: [DESIGNATED_WALLET],
      requiresSponsoredGas: false,
      onboardingWaiverEligible: false
    }
  );

  const refusedPreflight = await service.preflightJob(OTHER_WALLET, "parent-job-001");
  assert.equal(refusedPreflight.eligible, false);
  assert.equal(refusedPreflight.currentWalletCanClaim, false);
  assert.equal(refusedPreflight.reason, "designated_claimants_only");
  await assert.rejects(
    service.claimJob(OTHER_WALLET, "parent-job-001", "http", "wrong-designated-wallet"),
    (error) => error.code === "designated_claimants_only"
  );

  const admittedPreflight = await service.preflightJob(WALLET, "parent-job-001");
  assert.equal(admittedPreflight.eligible, true);
  assert.equal(admittedPreflight.claimable, false, "restricted is not public supply");
  assert.equal(admittedPreflight.currentWalletCanClaim, true);
  assert.equal(admittedPreflight.progressionValvesBypassed, true);
  assert.deepEqual(admittedPreflight.designatedClaimants, [DESIGNATED_WALLET]);
  const claimed = await service.claimJob(
    WALLET,
    "parent-job-001",
    "http",
    "correct-designated-wallet"
  );
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.wallet, WALLET);
});

test("designated agreements are restricted and excluded from every open inventory count", async () => {
  const service = makePlatformService(
    undefined,
    undefined,
    new MemoryStateStore(),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      source: { type: "external" },
      funding: { source: "external_escrow", state: "funded" },
      designatedClaimants: [DESIGNATED_WALLET],
      requiresSponsoredGas: false
    }
  );

  const [publicRow] = await service.listJobsWithSessions({ wallet: WALLET });
  assert.equal(publicRow.state, "restricted");
  assert.equal(publicRow.effectiveState, "restricted");
  assert.equal(publicRow.claimable, false);
  assert.equal(publicRow.currentWalletCanClaim, null);
  assert.equal(publicRow.designatedClaimants, undefined);
  const publicDefinition = await service.getPublicJobDefinition("parent-job-001", { wallet: WALLET });
  assert.equal(publicDefinition.state, "restricted");
  assert.equal(publicDefinition.currentWalletCanClaim, null);
  assert.equal(publicDefinition.designatedClaimants, undefined);
  const [operatorRow] = await service.listJobsWithSessions({
    wallet: WALLET,
    includeDesignatedClaimants: true
  });
  assert.deepEqual(operatorRow.designatedClaimants, [DESIGNATED_WALLET]);
  assert.deepEqual(service.getJobLifecycleSummary(), {
    total: 1,
    open: 0,
    claimable: 0,
    stale: 0,
    paused: 0,
    archived: 0
  });
  assert.deepEqual(await service.recommendJobs(WALLET), []);
});

test("legacy external posting is visibly unclaimable and excluded from claimable inventory", async () => {
  const currentEscrow = "0xC2Eb191FB75246667226a5D5Db9d821f95a5f793";
  const legacyEscrow = "0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC";
  const gateway = {
    config: {
      escrowCoreAddress: currentEscrow,
      legacyEscrowCoreAddress: legacyEscrow
    },
    isEnabled: () => true,
    async getJobs(jobIds) {
      assert.deepEqual(jobIds, ["parent-job-001"]);
      return [{
        status: "fulfilled",
        value: { state: 1, escrowAddress: legacyEscrow }
      }];
    }
  };
  const service = makePlatformService(
    gateway,
    undefined,
    new MemoryStateStore(),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      source: { type: "external" },
      funding: { source: "external_escrow", state: "funded" },
      requiresSponsoredGas: false
    }
  );

  const [listing] = await service.listJobsWithSessions({ wallet: WALLET });

  assert.equal(listing.escrowGeneration, "legacy");
  assert.equal(listing.legacyPostingUnclaimable, true);
  assert.equal(listing.claimable, false);
  assert.equal(listing.currentWalletCanClaim, false);
  assert.equal(listing.effectiveState, "unclaimable");
  assert.equal(listing.reason, "legacy_posting_unclaimable");
  assert.deepEqual(service.getExternalPostingClaimabilitySweep(), {
    candidateCount: 1,
    legacyUnclaimableCount: 1
  });
  assert.equal(service.getJobLifecycleSummary().claimable, 0);
});

test("progression valves run for routed external jobs, skip designated jobs, and both claims post stake", async () => {
  const makePolicies = () => {
    const calls = { worker: 0, daily: 0, catalogue: 0 };
    return {
      calls,
      worker: {
        async evaluate() {
          calls.worker += 1;
          return { eligible: true, status: "within_cap", entry: { candidate: "ordinary" } };
        }
      },
      daily: {
        async evaluate() {
          calls.daily += 1;
          return { eligible: true, status: "within_budget", entry: { candidate: "ordinary" } };
        }
      },
      catalogue: {
        async evaluate() {
          calls.catalogue += 1;
          return { eligible: true, status: "within_budget", entry: { candidate: "ordinary" } };
        }
      }
    };
  };
  const ordinaryPolicies = makePolicies();
  const ordinaryState = new MemoryStateStore();
  const ordinary = makePlatformService(
    undefined,
    undefined,
    ordinaryState,
    undefined,
    ordinaryPolicies.worker,
    ordinaryPolicies.daily,
    ordinaryPolicies.catalogue,
    {
      source: { type: "external" },
      funding: { source: "external_escrow", state: "funded" },
      requiresSponsoredGas: false,
      onboardingWaiverEligible: false
    }
  );
  await ordinaryState.materializeExternalJobDraft({
    draftId: "ordinary-external-valves",
    jobId: ordinary.jobs[0].id,
    status: "live",
    definition: ordinary.jobs[0]
  });
  const ordinaryClaim = await ordinary.claimJob(
    WALLET,
    "parent-job-001",
    "http",
    "ordinary-external-valves"
  );
  assert.deepEqual(ordinaryPolicies.calls, { worker: 1, daily: 1, catalogue: 1 });
  assert.equal(ordinaryClaim.totalClaimLock, 0.35);
  assert.equal(ordinary.accounts.get(WALLET).jobStakeLocked.DOT, 0.35);

  const designatedPolicies = makePolicies();
  const designatedState = new MemoryStateStore();
  const designated = makePlatformService(
    undefined,
    undefined,
    designatedState,
    undefined,
    designatedPolicies.worker,
    designatedPolicies.daily,
    designatedPolicies.catalogue,
    {
      source: { type: "external" },
      funding: { source: "external_escrow", state: "funded" },
      designatedClaimants: [DESIGNATED_WALLET],
      requiresSponsoredGas: false,
      onboardingWaiverEligible: false
    }
  );
  await designatedState.materializeExternalJobDraft({
    draftId: "designated-external-no-valves",
    jobId: designated.jobs[0].id,
    status: "live",
    definition: designated.jobs[0]
  });
  const designatedClaim = await designated.claimJob(
    WALLET,
    "parent-job-001",
    "http",
    "designated-external-no-valves"
  );
  assert.deepEqual(designatedPolicies.calls, { worker: 0, daily: 0, catalogue: 0 });
  assert.equal(designatedClaim.totalClaimLock, 0.35);
  assert.equal(designated.accounts.get(WALLET).jobStakeLocked.DOT, 0.35);
  assert.equal(designatedClaim.gasRetentionSupported, false);
});

test("preflight rejects a zero-balance wallet when a non-waived claim lock is required", async () => {
  const service = makePlatformService();
  service.jobs[0].onboardingWaiverEligible = false;
  service.accounts.get(WALLET).liquid.DOT = 0;

  const preflight = await service.preflightJob(WALLET, "parent-job-001");

  assert.equal(preflight.catalogEligible, true);
  assert.equal(preflight.claimable, true);
  assert.equal(preflight.claimEconomicsWaived, false);
  assert.equal(preflight.availableLiquidity, 0);
  assert.equal(preflight.totalClaimLock, 0.35);
  assert.equal(preflight.claimFundingAsset, "DOT");
  assert.equal(preflight.claimFundingShortfall, 0.35);
  assert.equal(preflight.eligible, false);
  assert.equal(preflight.reason, "insufficient_liquidity");
});

test("preflight refuses a delisted external job with an explicit claim reason", async () => {
  const stateStore = new MemoryStateStore();
  const service = makePlatformService(undefined, undefined, stateStore);
  const externalJobId = `0x${"d".repeat(64)}`;
  service.jobs[0].id = externalJobId;
  service.jobs[0].source = { type: "external" };
  await stateStore.upsertExternalJobDelisting({
    jobId: externalJobId,
    adminWallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    reason: "operator rescue requested",
    delistedAt: "2026-08-01T12:00:00.000Z"
  });

  const preflight = await service.preflightJob(WALLET, externalJobId);

  assert.equal(preflight.catalogEligible, false);
  assert.equal(preflight.eligible, false);
  assert.equal(preflight.claimable, false);
  assert.equal(preflight.currentWalletCanClaim, false);
  assert.equal(preflight.reason, "external_job_delisted");
  assert.equal(preflight.delisted, true);
  assert.equal(preflight.delistedAt, "2026-08-01T12:00:00.000Z");
  assert.equal(preflight.delistReason, "operator rescue requested");
  assert.ok(preflight.failureStates.includes("external_job_delisted"));
});

test("preflight remains eligible when wallet liquidity exactly covers the non-waived claim lock", async () => {
  const service = makePlatformService();
  service.jobs[0].onboardingWaiverEligible = false;
  service.accounts.get(WALLET).liquid.DOT = 0.35;

  const preflight = await service.preflightJob(WALLET, "parent-job-001");

  assert.equal(preflight.totalClaimLock, 0.35);
  assert.equal(preflight.claimFundingSufficient, true);
  assert.equal(preflight.claimFundingShortfall, 0);
  assert.equal(preflight.eligible, true);
  assert.equal(preflight.reason, "claimable");
});

for (const scenario of [
  { name: "waived zero-liquidity", waiverEligible: true, liquidity: 0, expectedEligible: true },
  { name: "waived funded", waiverEligible: true, liquidity: 10, expectedEligible: true },
  { name: "non-waived insufficient-liquidity", waiverEligible: false, liquidity: 0, expectedEligible: false },
  { name: "non-waived sufficient-liquidity", waiverEligible: false, liquidity: 10, expectedEligible: true }
]) {
  test(`preflight and explain-eligibility agree for ${scenario.name}`, async () => {
    const service = makePlatformService();
    service.jobs[0].onboardingWaiverEligible = scenario.waiverEligible;
    service.accounts.get(WALLET).liquid.DOT = scenario.liquidity;

    const preflight = await service.preflightJob(WALLET, "parent-job-001");
    const explanation = await service.explainEligibility(WALLET, "parent-job-001");

    assert.equal(preflight.eligible, scenario.expectedEligible);
    assert.equal(explanation.eligible, preflight.eligible);
    assert.equal(explanation.reason, preflight.reason);
    assert.equal(explanation.claimFundingSufficient, preflight.claimFundingSufficient);
    assert.equal(explanation.claimFundingShortfall, preflight.claimFundingShortfall);
    assert.equal(explanation.claimEconomicsWaived, preflight.claimEconomicsWaived);
  });
}

test("preflight and claim both waive a fresh wallet after the guaranteed eligibility sync", async () => {
  const service = makePlatformService(makeClaimEconomicsGateway({
    onboardingWaiverEligible: false,
    workerClaimCount: 0,
    onboardingWaiverClaimCount: 3
  }));

  const preflight = await service.preflightJob(WALLET, "parent-job-001");
  const claimed = await service.claimJob(WALLET, "parent-job-001", "http", "waiver-parity-fresh");

  assert.equal(preflight.claimNumber, 1);
  assert.equal(preflight.claimEconomicsWaived, true);
  assert.equal(preflight.claimEconomicsWaiverScope, "next_claim_projection");
  assert.equal(preflight.claimStake, 0);
  assert.equal(preflight.claimFee, 0);
  assert.equal(preflight.totalClaimLock, 0);
  assert.equal(preflight.claimFundingSufficient, true);
  assert.equal(preflight.claimFundingShortfall, 0);
  assert.equal(preflight.eligible, true);
  assert.equal(preflight.strategyUnwindNeeded, false);
  assert.equal(claimed.claimEconomicsWaived, preflight.claimEconomicsWaived);
  assert.equal(claimed.claimStake, preflight.claimStake);
  assert.equal(claimed.totalClaimLock, preflight.totalClaimLock);
});

test("preflight exposes global subsidy headroom and the actionable exhausted reason", async () => {
  const subsidy = {
    applies: true,
    available: false,
    dailyBudgetUsdc: 2,
    allocatedUsdc: 2,
    headroomUsdc: 0,
    estimatedClaimSubsidyUsdc: 0.109,
    resetAt: "2026-08-12T00:00:00.000Z",
    clock: "UTC"
  };
  const onboardingSubsidyBudget = {
    async inspect() {
      return subsidy;
    },
    async getStatus() {
      return subsidy;
    }
  };
  const service = makePlatformService(
    makeClaimEconomicsGateway({
      onboardingWaiverEligible: true,
      workerClaimCount: 0,
      onboardingWaiverClaimCount: 3
    }),
    undefined,
    undefined,
    onboardingSubsidyBudget
  );

  const preflight = await service.preflightJob(WALLET, "parent-job-001");

  assert.equal(preflight.eligible, false);
  assert.equal(preflight.reason, "onboarding_subsidy_exhausted");
  assert.match(preflight.reasonMessage, /self-funded claim path/u);
  assert.deepEqual(preflight.onboardingSubsidy, subsidy);
  assert.ok(preflight.failureStates.includes("onboarding_subsidy_exhausted"));
  assert.deepEqual(await service.getOnboardingSubsidyStatus(), subsidy);
});

test("post-tier retained claim fee removes curated brokered gas from operator subsidy exposure", async () => {
  const subsidyStatus = {
    dailyBudgetUsdc: 8,
    allocatedUsdc: 1,
    headroomUsdc: 7,
    resetAt: "2026-08-12T00:00:00.000Z",
    clock: "UTC"
  };
  const onboardingSubsidyBudget = {
    async inspect() {
      throw new Error("retained-fee claims must not inspect operator subsidy exposure");
    },
    async getStatus() {
      return subsidyStatus;
    }
  };
  const service = makePlatformService(
    makeClaimEconomicsGateway({
      onboardingWaiverEligible: false,
      workerClaimCount: 3,
      claimFeeRetainedOnSuccess: true
    }),
    undefined,
    undefined,
    onboardingSubsidyBudget
  );

  const preflight = await service.preflightJob(WALLET, "parent-job-001");

  assert.equal(preflight.claimEconomicsWaived, false);
  assert.equal(preflight.claimFeeRetainedOnSuccess, true);
  assert.deepEqual(preflight.onboardingSubsidy, {
    ...subsidyStatus,
    applies: false,
    available: true
  });
});

test("preflight trusts an existing on-chain waiver when the catalog flag is false", async () => {
  const gateway = makeClaimEconomicsGateway({
    onboardingWaiverEligible: true,
    workerClaimCount: 0,
    onboardingWaiverClaimCount: 3
  });
  const service = makePlatformService(gateway);
  service.jobs[0].onboardingWaiverEligible = false;
  gateway.setServedDefinition(service.getClaimableJobDefinition("parent-job-001"));

  const preflight = await service.preflightJob(WALLET, "parent-job-001");
  const claimed = await service.claimJob(WALLET, "parent-job-001", "http", "waiver-parity-split-brain");

  assert.equal(preflight.claimEconomicsWaived, true);
  assert.equal(preflight.claimStake, 0);
  assert.equal(preflight.totalClaimLock, 0);
  assert.equal(claimed.claimEconomicsWaived, preflight.claimEconomicsWaived);
  assert.equal(claimed.totalClaimLock, preflight.totalClaimLock);
});

test("preflight fails closed when the onboarding-waiver policy read fails", async () => {
  const service = makePlatformService(makeClaimEconomicsGateway({
    initialState: 0,
    onboardingWaiverEligible: false,
    workerClaimCount: 0,
    failWaiverPolicyRead: true
  }));

  await assert.rejects(
    () => service.preflightJob(WALLET, "parent-job-001"),
    /onboardingWaiverClaimCount read failed/u
  );
  assert.equal(service.blockchainGateway.previewCalls, 0);
});

test("legacy layout never advertises an onboarding waiver without a worker claim selector", async () => {
  const gateway = makeClaimEconomicsGateway({
    contractLayout: "legacy",
    onboardingWaiverEligible: false
  });
  delete gateway.getWorkerClaimCount;
  delete gateway.previewClaimEconomics;
  const service = makePlatformService(gateway);

  const preflight = await service.preflightJob(WALLET, "parent-job-001");

  assert.equal(preflight.claimEconomicsWaived, false);
  assert.equal(preflight.claimStake, 0.5);
  assert.equal(preflight.totalClaimLock, 0.6);
});

test("getAccountPosition delegates to blockchain gateway for chain-authoritative liquidity", async () => {
  const blockchainGateway = {
    isEnabled() {
      return true;
    },
    async getAccountPosition(wallet, asset) {
      assert.equal(wallet, WALLET);
      assert.equal(asset, "USDC");
      return {
        wallet,
        asset: CANONICAL_USDC_ASSET,
        source: { contract: "AgentAccountCore", method: "positions", field: "liquid" },
        position: { liquidRaw: "250000", liquid: 0.25 }
      };
    }
  };
  const service = makePlatformService(blockchainGateway);

  const position = await service.getAccountPosition(WALLET, "USDC");

  assert.equal(position.position.liquidRaw, "250000");
  assert.equal(position.source.contract, "AgentAccountCore");
});

test("validateJobSubmission gives a non-mutating schema-native verdict", async () => {
  const service = makePlatformService();

  const valid = await service.validateJobSubmission("parent-job-001", {
    summary: "Parser fixed.",
    output: "Added regression coverage.",
    status: "complete"
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.submitSafe, true);
  assert.equal(valid.schemaRef, "schema://jobs/coding-output");
  assert.equal(valid.schemaValidates, "payload.submission");
  assert.equal(valid.validationEndpoint, "POST /jobs/validate-submission");
  assert.deepEqual(valid.requiredTopLevelKeys, ["summary", "output", "status"]);
  assert.equal(valid.submissionKind, "structured");

  const invalid = await service.validateJobSubmission("parent-job-001", "complete");
  assert.equal(invalid.valid, false);
  assert.equal(invalid.submitSafe, false);
  assert.equal(invalid.schemaRef, "schema://jobs/coding-output");
  assert.match(invalid.message, /Schema-native jobs require/u);
  assert.equal(invalid.path, "payload.submission.summary");
  assert.deepEqual(invalid.errorPaths, ["payload.submission.summary"]);
  assert.equal(invalid.details.schemaValidates, "payload.submission");
});

test("getSessionTimeline includes transitions and verification state", async () => {
  const service = makePlatformService();
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "timeline-claim");
  const submitted = await service.submitWork(session.sessionId, "http", {
    summary: "Timeline run complete.",
    output: "complete verified output",
    status: "complete"
  });
  await service.ingestVerification(submitted.sessionId, {
    jobId: submitted.jobId,
    handler: "benchmark",
    handlerVersion: 1,
    outcome: "approved",
    reasonCode: "BENCHMARK_THRESHOLD_MET"
  });
  const result = await service.stateStore.getVerificationResult(submitted.sessionId);
  await assert.rejects(
    () => service.ingestVerification(submitted.sessionId, {
      jobId: submitted.jobId,
      handler: "benchmark",
      handlerVersion: 1,
      outcome: "rejected",
      reasonCode: "LATE_REJECT"
    }),
    (error) => {
      assert.equal(error.code, "invalid_session_transition");
      assert.equal(error.details.currentStatus, "resolved");
      assert.equal(error.details.terminal, true);
      return true;
    }
  );
  const stillResolved = await service.stateStore.getSession(submitted.sessionId);
  assert.equal(stillResolved.verificationSummary.reasonCode, "BENCHMARK_THRESHOLD_MET");

  const timeline = await service.getSessionTimeline(submitted.sessionId);
  assert.equal(timeline.timelineVersion, "v2");
  assert.equal(timeline.session.status, "resolved");
  assert.equal(result.verifierPolicyVersion, 1);
  assert.equal(result.verifierConfigVersion, 1);
  assert.equal(result.verificationContract.version, "verification-contract-v1");
  assert.equal(result.verificationContract.handler, "benchmark");
  assert.equal(result.verificationContract.verifierPolicyVersion, 1);
  assert.equal(result.verificationInput.kind, "structured");
  assert.equal(typeof result.verifierConfigHash, "string");
  assert.equal(typeof result.verificationInputHash, "string");
  assert.equal(timeline.lifecycle.currentPhase, "terminal");
  assert.equal(timeline.stateMachine.timelineVersion, "v2");
  assert.ok(Array.isArray(timeline.stateMachine.statuses));
  assert.ok(Array.isArray(timeline.lineage.childJobIds));
  assert.equal(timeline.lineage.subJobBudget.asset, "DOT");
  assert.equal(timeline.lineage.subJobPolicy.maxDepth, 1);
  assert.ok(timeline.timeline.some((entry) => entry.type === "session_transition"));
  assert.ok(timeline.timeline.some((entry) => entry.type === "verification"));
  assert.ok(timeline.timeline.every((entry) => entry.correlationId === submitted.sessionId));
  assert.ok(timeline.timeline.every((entry) => entry.timestamp === entry.at));
  assert.ok(timeline.timeline.every((entry) => entry.source && entry.topic && entry.severity));
  assert.ok(timeline.timeline.every((entry) => entry.sessionId === submitted.sessionId || entry.type === "child_job"));
  const submittedTransition = timeline.timeline.find((entry) => entry.type === "session_transition" && entry.data.to === "submitted");
  assert.equal(submittedTransition.topic, "session.transition");
  assert.equal(submittedTransition.source, "state");
  assert.equal(submittedTransition.jobId, submitted.jobId);
  assert.equal(submittedTransition.sessionId, submitted.sessionId);
  const verificationEvent = timeline.timeline.find((entry) => entry.type === "verification");
  assert.equal(verificationEvent.topic, "session.verification");
  assert.equal(verificationEvent.source, "verification");
  assert.equal(verificationEvent.data.handlerVersion, 1);
  assert.equal(verificationEvent.data.verifierPolicyVersion, 1);
  assert.equal(verificationEvent.data.verifierConfigVersion, 1);
});

test("getJobTimeline stitches sessions, verification, events, and child lineage", async () => {
  const eventBus = new EventBus();
  const service = makePlatformService(undefined, eventBus);
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "job-timeline-claim");
  const subJob = await service.createSubJob(session.sessionId, WALLET, {
    id: "timeline-child-job-001",
    category: "review",
    tier: "starter",
    rewardAmount: 2,
    verifierMode: "benchmark",
    verifierTerms: ["summary"],
    verifierMinimumMatches: 1,
    inputSchemaRef: "schema://jobs/review-input",
    outputSchemaRef: "schema://jobs/pr-review-findings-output",
    claimTtlSeconds: 1800,
    retryLimit: 1,
    requiresSponsoredGas: true
  });
  const submitted = await service.submitWork(session.sessionId, "http", {
    summary: "Timeline run complete.",
    output: "complete verified output",
    status: "complete"
  });
  await service.ingestVerification(submitted.sessionId, {
    jobId: submitted.jobId,
    handler: "benchmark",
    handlerVersion: 1,
    outcome: "approved",
    reasonCode: "BENCHMARK_THRESHOLD_MET"
  });
  eventBus.publish({
    id: "chain-funded-parent-job-001",
    topic: "escrow.job_funded",
    jobId: "parent-job-001",
    blockNumber: 123,
    txHash: "0xabc",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      amount: "2",
      asset: "DOT"
    }
  });

  const timeline = await service.getJobTimeline("parent-job-001", { wallet: WALLET });
  assert.equal(timeline.timelineVersion, "v2");
  assert.equal(timeline.job.id, "parent-job-001");
  assert.equal(timeline.job.claimState, "exhausted");
  assert.equal(timeline.summary.sessionCount, 1);
  assert.equal(timeline.summary.childJobCount, 1);
  assert.deepEqual(timeline.lineage.sessionIds, [submitted.sessionId]);
  assert.deepEqual(timeline.lineage.childJobIds, [subJob.id]);
  assert.ok(timeline.timeline.some((entry) => entry.type === "job_state"));
  assert.ok(timeline.timeline.some((entry) => entry.type === "session_transition" && entry.data.to === "submitted"));
  assert.ok(timeline.timeline.some((entry) => entry.type === "verification"));
  assert.ok(timeline.timeline.some((entry) => entry.type === "child_job"));
  assert.ok(timeline.timeline.some((entry) => entry.type === "event_bus" && entry.data.topic === "session.claimed"));
  assert.ok(timeline.timeline.every((entry) => entry.timestamp === entry.at));
  assert.ok(timeline.timeline.every((entry) => entry.source && entry.topic && entry.severity));
  const jobState = timeline.timeline.find((entry) => entry.type === "job_state");
  assert.equal(jobState.topic, "job.state");
  assert.equal(jobState.source, "state");
  assert.equal(jobState.jobId, "parent-job-001");
  const childJob = timeline.timeline.find((entry) => entry.type === "child_job");
  assert.equal(childJob.topic, "job.child_created");
  assert.equal(childJob.source, "lineage");
  assert.equal(childJob.jobId, subJob.id);
  const claimedEvent = timeline.timeline.find((entry) => entry.type === "event_bus" && entry.topic === "session.claimed");
  assert.equal(claimedEvent.source, "state");
  assert.equal(claimedEvent.jobId, "parent-job-001");
  assert.equal(claimedEvent.sessionId, submitted.sessionId);
  const claimFundingEvent = timeline.timeline.find((entry) => entry.topic === "funding.claim_lock_recorded");
  assert.equal(claimFundingEvent.type, "event_bus");
  assert.equal(claimFundingEvent.source, "settlement");
  assert.equal(claimFundingEvent.phase, "funding");
  assert.equal(claimFundingEvent.correlationId, submitted.sessionId);
  assert.equal(claimFundingEvent.data.source, "local_claim_lock");
  assert.equal(claimFundingEvent.data.asset, "DOT");
  assert.equal(claimFundingEvent.data.totalClaimLock, 0);
  assert.equal(claimFundingEvent.data.claimEconomicsWaived, true);
  const settlementEvent = timeline.timeline.find((entry) => entry.topic === "settlement.session_resolved");
  assert.equal(settlementEvent.type, "event_bus");
  assert.equal(settlementEvent.source, "settlement");
  assert.equal(settlementEvent.phase, "settlement");
  assert.equal(settlementEvent.correlationId, submitted.sessionId);
  assert.equal(settlementEvent.data.status, "resolved");
  assert.equal(settlementEvent.data.reasonCode, "BENCHMARK_THRESHOLD_MET");
  const fundedEvent = timeline.timeline.find((entry) => entry.topic === "escrow.job_funded");
  assert.equal(fundedEvent.type, "event_bus");
  assert.equal(fundedEvent.source, "chain");
  assert.equal(fundedEvent.phase, "funding");
  assert.equal(fundedEvent.severity, "info");
  assert.equal(fundedEvent.correlationId, "parent-job-001");
  assert.equal(fundedEvent.data.txHash, "0xabc");
});

test("getJobTimeline folds disputed verification into the canonical dispute trace", async () => {
  const eventBus = new EventBus();
  const service = makePlatformService(undefined, eventBus);
  const session = await service.claimJob(WALLET, "parent-job-001", "http", "job-timeline-dispute-claim");
  const submitted = await service.submitWork(session.sessionId, "http", {
    summary: "Timeline run needs review.",
    output: "Human fallback requested.",
    status: "complete"
  });
  await service.ingestVerification(submitted.sessionId, {
    jobId: submitted.jobId,
    handler: "benchmark",
    handlerVersion: 1,
    outcome: "disputed",
    reasonCode: "HUMAN_REVIEW_REQUIRED"
  });

  const timeline = await service.getJobTimeline("parent-job-001", {
    wallet: WALLET,
    phases: ["dispute"],
    limit: 25
  });
  const disputeEvent = timeline.timeline.find((entry) => entry.topic === "dispute.opened");
  assert.equal(disputeEvent.type, "event_bus");
  assert.equal(disputeEvent.source, "settlement");
  assert.equal(disputeEvent.phase, "dispute");
  assert.equal(disputeEvent.severity, "warn");
  assert.equal(disputeEvent.jobId, submitted.jobId);
  assert.equal(disputeEvent.sessionId, submitted.sessionId);
  assert.equal(disputeEvent.correlationId, submitted.sessionId);
  assert.match(disputeEvent.data.disputeId, /^dispute-[a-f0-9]{12}$/u);
  assert.equal(disputeEvent.data.reasonCode, "HUMAN_REVIEW_REQUIRED");
  assert.deepEqual(timeline.summary.eventFilters.phases, ["dispute"]);
});

test("getJobTimeline reads durable event log and applies event filters", async () => {
  const stateStore = new MemoryStateStore();
  const writerBus = new EventBus({ bufferSize: 1, eventStore: stateStore });
  writerBus.publish({
    id: "durable-chain-funded",
    topic: "escrow.job_funded",
    jobId: "parent-job-001",
    wallet: WALLET,
    timestamp: "2026-01-01T00:00:00.000Z"
  });
  writerBus.publish({
    id: "durable-settlement",
    topic: "xcm.settlement_succeeded",
    jobId: "parent-job-001",
    wallet: WALLET,
    correlationId: "settlement-correlation-1",
    timestamp: "2026-01-01T00:00:01.000Z"
  });
  writerBus.publish({
    id: "durable-other-wallet",
    topic: "escrow.job_funded",
    jobId: "parent-job-001",
    wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    timestamp: "2026-01-01T00:00:02.000Z"
  });
  await writerBus.flush();

  const readerBus = new EventBus({ bufferSize: 1, eventStore: stateStore });
  const service = makePlatformService(undefined, readerBus, stateStore);

  const chainTimeline = await service.getJobTimeline("parent-job-001", {
    wallet: WALLET,
    sources: ["chain"],
    limit: 10
  });
  assert.ok(chainTimeline.timeline.some((entry) => entry.id === "durable-chain-funded"));
  assert.ok(!chainTimeline.timeline.some((entry) => entry.id === "durable-settlement"));
  assert.deepEqual(chainTimeline.summary.eventFilters.sources, ["chain"]);

  const correlationTimeline = await service.getJobTimeline("parent-job-001", {
    wallet: WALLET,
    correlationId: "settlement-correlation-1",
    limit: 10
  });
  assert.ok(correlationTimeline.timeline.some((entry) => entry.id === "durable-settlement"));
  assert.ok(!correlationTimeline.timeline.some((entry) => entry.id === "durable-chain-funded"));
  assert.equal(correlationTimeline.summary.eventFilters.correlationId, "settlement-correlation-1");

  const walletTimeline = await service.getJobTimeline("parent-job-001", {
    wallet: WALLET,
    eventWallet: WALLET,
    limit: 10
  });
  assert.ok(walletTimeline.timeline.some((entry) => entry.id === "durable-chain-funded"));
  assert.ok(!walletTimeline.timeline.some((entry) => entry.id === "durable-other-wallet"));
  assert.equal(walletTimeline.summary.eventFilters.wallet, WALLET);
});

test("getAdminStatus surfaces recurring scheduler anomalies", async () => {
  const service = makePlatformService();
  service.updateJobLifecycle("parent-job-001", {
    action: "pause",
    reason: "operator hold"
  });
  service.recurringScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        templates: [
          {
            templateId: "weekly-digest",
            lastResult: {
              status: "failed"
            }
          }
        ]
      };
    }
  };

  const status = await service.getAdminStatus({
    auth: {
      wallet: WALLET,
      claims: { roles: ["admin"] },
      capabilities: ["admin:status"]
    }
  });

  assert.equal(status.auth.wallet, WALLET);
  assert.equal(status.authPolicy.version, "auth-policy-v1");
  assert.ok(status.authPolicy.roles.admin.includes("admin:status"));
  assert.deepEqual(status.authPolicy.routes["/admin/status"], ["admin:status", "ops:view"]);
  assert.deepEqual(status.authPolicy.uiControls["admin.status.view"], ["admin:status", "ops:view"]);
  assert.ok(status.anomalies.some((entry) => entry.code === "recurring_attention"));
  assert.equal(status.hostDiagnostics.mutates, false);
  assert.ok(["ok", "ok_with_notes", "attention", "critical"].includes(status.hostDiagnostics.health));
  assert.equal(status.hostDiagnostics.process.pid, process.pid);
  assert.equal(status.jobLifecycle.total, 1);
  assert.equal(status.jobLifecycle.paused, 1);
  assert.equal(status.jobLifecycle.claimable, 0);
  assert.equal(status.jobStaleSweeper.enabled, false);
});

test("getAdminStatus exposes durable per-wallet SIWE conversion telemetry", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.recordSiweAuthEvent({
    wallet: WALLET,
    event: "nonce_issued",
    at: "2026-07-28T10:00:00.000Z"
  });
  await stateStore.recordSiweAuthEvent({
    wallet: WALLET,
    event: "verify_succeeded",
    at: "2026-07-28T10:01:00.000Z"
  });
  const service = makePlatformService(undefined, undefined, stateStore);

  const status = await service.getAdminStatus();

  assert.deepEqual(status.authTelemetry.siwe.totals, {
    noncesIssued: 1,
    verifiesSucceeded: 1,
    verificationGap: 0
  });
  assert.equal(status.authTelemetry.siwe.walletCount, 1);
  assert.equal(status.authTelemetry.siwe.readable, true);
  assert.deepEqual(
    status.authTelemetry.siwe.wallets[0],
    {
      wallet: WALLET,
      noncesIssued: 1,
      verifiesSucceeded: 1,
      verificationGap: 0,
      firstSeenAt: "2026-07-28T10:00:00.000Z",
      lastNonceIssuedAt: "2026-07-28T10:00:00.000Z",
      lastVerifySucceededAt: "2026-07-28T10:01:00.000Z",
      lastSeenAt: "2026-07-28T10:01:00.000Z"
    }
  );
});

test("getAdminStatus exposes first-withdrawal grants as operator gas outflow rather than payout or revenue", async () => {
  const service = makePlatformService();
  service.setFirstWithdrawalGasGrantStatusProvider({
    async getGasGrantOpsStatus() {
      return {
        schemaVersion: 1,
        category: "operator_gas_outflow",
        countedAsPayout: false,
        countedAsRevenue: false,
        daily: {
          day: "2026-08-21",
          limit: 25,
          granted: 1,
          total: { raw: "30000000000000000", decimals: 18, display: "0.03", symbol: "DOT" }
        },
        recent: [{ wallet: WALLET, balanceAtGrant: { raw: "400000", decimals: 6, display: "0.4", symbol: "USDC" } }]
      };
    }
  });

  const status = await service.getAdminStatus();

  assert.equal(status.ops.firstWithdrawalGasGrants.category, "operator_gas_outflow");
  assert.equal(status.ops.firstWithdrawalGasGrants.daily.total.display, "0.03");
  assert.equal(status.ops.firstWithdrawalGasGrants.countedAsPayout, false);
  assert.equal(status.ops.firstWithdrawalGasGrants.countedAsRevenue, false);
});

test("getAdminStatus reports treasury policy failures without failing the status response", async () => {
  const service = makePlatformService({
    config: {
      treasuryPolicyAddress: "0x1111111111111111111111111111111111111111"
    },
    isEnabled() {
      return true;
    },
    async getTreasuryPolicyStatus() {
      const error = new Error("getTreasuryPolicyStatus failed: require(false)");
      error.code = "blockchain_revert";
      error.details = {
        operation: "getTreasuryPolicyStatus",
        rawCode: "CALL_EXCEPTION",
        rawReason: "require(false)"
      };
      throw error;
    }
  });

  const status = await service.getAdminStatus();

  assert.equal(status.maintenance.policy.enabled, true);
  assert.equal(status.maintenance.policy.policyAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(status.maintenance.policy.roles.agentAccountIsOutflowRecorder, false);
  assert.equal(status.maintenance.policy.error.code, "blockchain_revert");
  assert.equal(status.maintenance.policy.error.details.rawReason, "require(false)");
  assert.ok(status.anomalies.some((entry) => entry.code === "policy_status_unavailable"));
  assert.equal(status.jobStaleSweeper.enabled, false);
});

test("getAdminStatus surfaces public source ingestion scheduler status", async () => {
  const service = makePlatformService();
  service.githubIssueIngestionScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: true,
        intervalMs: 900000,
        queryCount: 2,
        maxJobsPerRun: 2,
        maxJobsPerQuery: 2,
        maxOpenJobs: 12,
        currentOpenJobs: 3,
        lastRun: {
          startedAt: "2026-04-27T08:00:00.000Z",
          finishedAt: "2026-04-27T08:00:02.000Z",
          candidateCount: 4,
          createdCount: 1,
          errors: [],
          queries: [
            {
              query: "repo:averray-agent/agent label:good-first-issue",
              skipped: [{ id: "github-1", reason: "source_already_ingested" }]
            }
          ]
        }
      };
    }
  };
  service.wikipediaMaintenanceIngestionScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: true,
        intervalMs: 1800000,
        language: "en",
        categoryCount: 1,
        maxJobsPerRun: 2,
        maxOpenJobs: 10,
        currentOpenJobs: 0,
        minClaimableJobs: 2,
        currentClaimableJobs: 0,
        lastRun: { candidateCount: 0, createdCount: 0, skipped: [{ reason: "no_candidates" }], errors: [] }
      };
    }
  };
  service.osvAdvisoryIngestionScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: true,
        intervalMs: 3600000,
        packageCount: 0,
        manifestCount: 1,
        targetCount: 1,
        maxJobsPerRun: 2,
        maxOpenJobs: 20,
        currentOpenJobs: 2,
        lastRun: { candidateCount: 2, createdCount: 0, skipped: [], errors: [] }
      };
    }
  };
  service.openDataIngestionScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: false,
        intervalMs: 3600000,
        query: "res_format:CSV",
        queryCount: 7,
        nextQuery: "transport",
        datasetCount: 0,
        targetCount: 3,
        maxJobsPerRun: 2,
        maxOpenJobs: 20,
        currentOpenJobs: 4,
        lastRun: {
          candidateCount: 2,
          createdCount: 1,
          skipped: [
            { datasetId: "abc", resourceId: "abc-1", reason: "dataset_already_ingested" }
          ],
          errors: []
        }
      };
    }
  };
  service.standardsSpecIngestionScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: true,
        intervalMs: 3600000,
        specCount: 2,
        maxJobsPerRun: 2,
        maxOpenJobs: 20,
        currentOpenJobs: 1,
        lastRun: { candidateCount: 1, createdCount: 1, skipped: [], errors: [] }
      };
    }
  };
  service.openApiSpecIngestionScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: true,
        intervalMs: 3600000,
        specCount: 1,
        maxJobsPerRun: 2,
        maxOpenJobs: 20,
        currentOpenJobs: 1,
        lastRun: { candidateCount: 1, createdCount: 1, skipped: [], errors: [{ message: "temporary upstream failure" }] }
      };
    }
  };
  service.jobStaleSweeper = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        dryRun: false,
        mode: "live",
        intervalMs: 3600000,
        action: "archive",
        maxJobsPerRun: 25,
        lastRun: {
          candidateCount: 3,
          updatedCount: 2,
          skipped: [{ id: "active", reason: "active_session" }],
          errors: []
        }
      };
    }
  };
  service.bootstrapSelfReportScheduler = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        intervalMs: 604800000,
        from: "Averray <ops@example.com>",
        to: ["pascal@example.com"],
        recipientCount: 1,
        providerConfigured: true,
        nextRunAt: "2026-05-08T00:00:00.000Z",
        lastAttemptedAt: "2026-05-08T00:00:00.000Z",
        lastSuccessfulAt: "2026-05-08T00:00:00.000Z",
        lastFailureReason: undefined,
        lastRun: { status: "sent", email: { providerId: "email_123" } }
      };
    }
  };

  const status = await service.getAdminStatus();
  assert.equal(status.osvIngestion.packageCount, 0);
  assert.equal(status.osvIngestion.manifestCount, 1);
  assert.equal(status.osvIngestion.targetCount, 1);
  assert.equal(status.openDataIngestion.query, "res_format:CSV");
  assert.equal(status.openDataIngestion.lastRun.createdCount, 1);
  assert.equal(status.standardsIngestion.specCount, 2);
  assert.equal(status.openApiIngestion.specCount, 1);
  assert.equal(status.providerOperations.github.label, "GitHub issues");
  assert.equal(status.providerOperations.github.mode, "dry_run");
  assert.equal(status.providerOperations.github.currentOpenJobs, 3);
  assert.equal(status.providerOperations.github.maxJobsPerQuery, 2);
  assert.equal(status.providerOperations.github.lastRun.createdCount, 1);
  assert.equal(status.providerOperations.github.lastRun.skippedCount, 1);
  assert.equal(status.providerOperations.github.lastRun.skipped[0].reason, "source_already_ingested");
  assert.equal(status.providerOperations.wikipedia.minClaimableJobs, 2);
  assert.equal(status.providerOperations.wikipedia.currentClaimableJobs, 0);
  assert.equal(status.providerOperations.osv.targetCount, 1);
  assert.equal(status.providerOperations.openData.mode, "live");
  assert.equal(status.providerOperations.openData.health, "healthy");
  assert.equal(status.providerOperations.openData.targetCount, 3);
  // Open data rotates a query pool that's distinct from the dataset
  // target list — both signals reach the operator UI.
  assert.equal(status.providerOperations.openData.queryCount, 7);
  assert.equal(status.providerOperations.openData.nextQuery, "transport");
  assert.equal(status.providerOperations.openData.lastRun.summary, "2 candidate(s), 1 created, 1 skipped, 0 error(s)");
  assert.equal(status.providerOperations.openData.lastRun.skipped[0].reason, "dataset_already_ingested");
  // github's queryCount IS its targetCount — don't duplicate the
  // field at the top level.
  assert.equal(status.providerOperations.github.queryCount, undefined);
  assert.equal(status.providerOperations.github.nextQuery, undefined);
  assert.equal(status.providerOperations.openApi.health, "error");
  assert.equal(status.providerOperations.openApi.lastRun.errorCount, 1);
  assert.equal(status.jobStaleSweeper.mode, "live");
  assert.equal(status.jobStaleSweeper.lastRun.updatedCount, 2);
  assert.equal(status.bootstrapSelfReport.providerConfigured, true);
  assert.equal(status.bootstrapSelfReport.from, "Averray <ops@example.com>");
  assert.deepEqual(status.bootstrapSelfReport.to, ["pascal@example.com"]);
  assert.equal(status.bootstrapSelfReport.lastAttemptedAt, "2026-05-08T00:00:00.000Z");
  assert.equal(status.bootstrapSelfReport.lastSuccessfulAt, "2026-05-08T00:00:00.000Z");
  assert.equal(status.bootstrapSelfReport.lastRun.email.providerId, "email_123");

  // Public sanitized counterpart preserves health / mode / counts but
  // strips lastRun.skipped[] and lastRun.errors[] (which can carry
  // candidate URLs, query strings, stack traces, internal IDs).
  const publicStatus = await service.getPublicProviderOperations();
  assert.deepEqual(Object.keys(publicStatus), ["providerOperations"]);
  // Same six providers as the admin payload.
  assert.deepEqual(
    Object.keys(publicStatus.providerOperations).sort(),
    ["github", "openApi", "openData", "osv", "standards", "wikipedia"]
  );
  // Health, mode, counts, and human-readable summary survive…
  assert.equal(publicStatus.providerOperations.github.mode, "dry_run");
  assert.equal(publicStatus.providerOperations.github.currentOpenJobs, 3);
  assert.equal(publicStatus.providerOperations.wikipedia.minClaimableJobs, 2);
  assert.equal(publicStatus.providerOperations.wikipedia.currentClaimableJobs, 0);
  assert.equal(publicStatus.providerOperations.github.lastRun.skippedCount, 1);
  assert.equal(publicStatus.providerOperations.openApi.health, "error");
  assert.equal(publicStatus.providerOperations.openApi.lastRun.errorCount, 1);
  // …but the arrays themselves are emptied.
  assert.deepEqual(publicStatus.providerOperations.github.lastRun.skipped, []);
  assert.deepEqual(publicStatus.providerOperations.github.lastRun.errors, []);
  assert.deepEqual(publicStatus.providerOperations.openApi.lastRun.skipped, []);
  assert.deepEqual(publicStatus.providerOperations.openApi.lastRun.errors, []);
  // No leakage of any admin-only top-level fields (auth, recurring,
  // anomalies, recentSessions, etc.) — only providerOperations.
  assert.equal(publicStatus.auth, undefined);
  assert.equal(publicStatus.anomalies, undefined);
  assert.equal(publicStatus.recurring, undefined);
});

test("runBootstrapSelfReport delegates to the configured scheduler", async () => {
  const service = makePlatformService();
  const attemptedAt = "2026-05-15T06:00:00.000Z";
  let calledWith;
  service.bootstrapSelfReportScheduler = {
    async runOnce(now) {
      calledWith = now;
      return {
        status: "sent",
        email: { providerId: "email_live_123" }
      };
    },
    async getStatus() {
      return {
        enabled: true,
        running: true,
        lastAttemptedAt: attemptedAt,
        lastSuccessfulAt: attemptedAt,
        lastRun: { status: "sent", email: { providerId: "email_live_123" } }
      };
    }
  };

  const result = await service.runBootstrapSelfReport({ now: new Date(attemptedAt) });

  assert.equal(calledWith.toISOString(), attemptedAt);
  assert.equal(result.ok, true);
  assert.equal(result.result.status, "sent");
  assert.equal(result.bootstrapSelfReport.lastSuccessfulAt, attemptedAt);
});

test("runBootstrapSelfReport fails closed without a scheduler", async () => {
  const service = makePlatformService();

  await assert.rejects(
    () => service.runBootstrapSelfReport(),
    /Bootstrap self-report scheduler is not initialised/u
  );
});

test("finalizeXcmRequest records async treasury settlement when the request is strategy-backed", async () => {
  const gateway = {
    isEnabled: () => true,
    getAccountSummary: async (wallet) => ({
      wallet,
      liquid: { DOT: 10 },
      reserved: {},
      strategyAllocated: {},
      collateralLocked: {},
      jobStakeLocked: {},
      debtOutstanding: {}
    }),
    finalizeXcmRequest: async () => ({
      requestId: "0xrequest",
      strategyRequest: {
        account: WALLET,
        strategyId: "0xstrategy",
        assetSymbol: "DOT",
        kindLabel: "deposit",
        statusLabel: "succeeded",
        requestedAssets: 5,
        settledAssets: 5
      }
    })
  };
  const service = makePlatformService(gateway);

  const finalized = await service.finalizeXcmRequest("0xrequest", {
    status: "succeeded",
    settledAssets: 5,
    settledShares: 5
  });
  const account = await service.getAccountSummary(WALLET);

  assert.equal(finalized.requestId, "0xrequest");
  assert.equal(account.strategyAccounting["0xstrategy"].principal, 5);
  assert.equal(account.treasuryTimeline[0].type, "allocate");
});

test("finalizeXcmRequest reconciles local treasury state for already-settled replays", async () => {
  const gateway = {
    isEnabled: () => true,
    getAccountSummary: async (wallet) => ({
      wallet,
      liquid: { DOT: 10 },
      reserved: {},
      strategyAllocated: {},
      collateralLocked: {},
      jobStakeLocked: {},
      debtOutstanding: {}
    }),
    finalizeXcmRequest: async () => ({
      requestId: "0xrequest",
      alreadySettled: true,
      strategyRequest: {
        account: WALLET,
        strategyId: "0xstrategy",
        assetSymbol: "DOT",
        kindLabel: "deposit",
        statusLabel: "succeeded",
        requestedAssets: 5,
        settledAssets: 5
      }
    })
  };
  const service = makePlatformService(gateway);
  const pending = await service.getAccountSummary(WALLET);
  pending.strategyPending["0xstrategy"] = {
    asset: "DOT",
    pendingDepositAssets: 5,
    pendingDepositRequestIds: ["0xrequest"],
    pendingWithdrawalShares: 0
  };
  service.accounts.set(WALLET, pending);

  const finalized = await service.finalizeXcmRequest("0xrequest", {
    status: "succeeded",
    settledAssets: 5,
    settledShares: 5
  });
  const account = await service.getAccountSummary(WALLET);

  assert.equal(finalized.alreadySettled, true);
  assert.equal(account.strategyAccounting["0xstrategy"].principal, 5);
  assert.equal(account.strategyPending["0xstrategy"].pendingDepositAssets, 0);
  assert.deepEqual(account.strategyPending["0xstrategy"].settledRequestIds, ["0xrequest"]);
  assert.equal(account.treasuryTimeline.filter((event) => event.type === "allocate").length, 1);

  await service.finalizeXcmRequest("0xrequest", {
    status: "succeeded",
    settledAssets: 5,
    settledShares: 5
  });
  const replayed = await service.getAccountSummary(WALLET);

  assert.equal(replayed.strategyAccounting["0xstrategy"].principal, 5);
  assert.equal(replayed.treasuryTimeline.filter((event) => event.type === "allocate").length, 1);
});

test("getAdminStatus surfaces XCM observation relay status", async () => {
  const service = makePlatformService();
  service.xcmObservationRelay = {
    getStatus() {
      return {
        enabled: true,
        running: true,
        syncing: false,
        feedUrl: "https://observer.example/outcomes",
        batchSize: 25,
        pollIntervalMs: 30_000,
        cursor: "cursor-1",
        lastObservedCount: 2,
        lastSyncedAt: "2026-04-22T10:00:00.000Z"
      };
    }
  };

  const status = await service.getAdminStatus();
  assert.equal(status.xcmObservationRelay.enabled, true);
  assert.equal(status.xcmObservationRelay.cursor, "cursor-1");
});

test("getAdminStatus exposes D3 catalogue lane board payload", async () => {
  const service = makePlatformService();
  const catalogueLanes = {
    version: "catalogue-lanes-v1",
    lanes: [{ id: "liveness", hypothesis: "test", stopCondition: "stop" }]
  };
  service.setCatalogueLaneDiscipline({
    async getBoardSnapshot() { return catalogueLanes; }
  });

  const status = await service.getAdminStatus();
  assert.deepEqual(status.catalogueLanes, catalogueLanes);
});

test("getAdminStatus alarms when a venue balance read is unknown/stale", async () => {
  const service = makePlatformService();
  service.xcmBalanceObserver = {
    async getStatus() {
      return {
        enabled: true,
        running: true,
        polling: false,
        pendingCount: 1,
        readErrorCount: 1,
        overdueCount: 0,
        oldestPendingAgeMs: 1_000,
        pending: [{
          requestId: `0x${"11".repeat(32)}`,
          observationState: "unknown_stale",
          lastError: "Cannot find package @polkadot/api"
        }]
      };
    }
  };

  const status = await service.getAdminStatus();
  assert.equal(status.xcmBalanceObserver.readErrorCount, 1);
  assert.ok(status.anomalies.some((entry) => entry.code === "xcm_balance_observation_read_failed"));
});

test("getAdminStatus alarms when a chain event cannot arm its Bank watch", async () => {
  const service = makePlatformService();
  service.xcmBalanceObserver = {
    async getStatus() {
      return {
        enabled: true,
        running: true,
        pendingCount: 0,
        readErrorCount: 0,
        overdueCount: 0,
        chainEventIngestionError: "RequestQueued event came from an unexpected wrapper generation."
      };
    }
  };

  const status = await service.getAdminStatus();
  assert.ok(status.anomalies.some((entry) => entry.code === "xcm_balance_watch_ingestion_failed"));
});

test("getAdminStatus exposes the Bank runtime pre-staging gate", async () => {
  const service = makePlatformService();
  service.bankXcmRuntime = {
    async getStatus() {
      return {
        enabled: true,
        wrapper: "0xecee778e11b238d2fc096e56460e7b98dc7b26b8",
        observerRunning: false,
        chainEventWatchEnabled: true,
        readyForStaging: false
      };
    }
  };

  const status = await service.getAdminStatus();
  assert.equal(status.bankXcmRuntime.enabled, true);
  assert.equal(status.bankXcmRuntime.readyForStaging, false);
  assert.ok(status.anomalies.some((entry) => entry.code === "bank_xcm_runtime_not_ready_for_staging"));
});

test("getAdminStatus reports XCM status read failures without failing the response", async () => {
  const service = makePlatformService();
  service.xcmSettlementWatcher = {
    enabled: true,
    running: true,
    async getStatus() {
      const error = new Error("redis unavailable");
      error.code = "state_store_unavailable";
      throw error;
    }
  };
  service.xcmObservationRelay = {
    enabled: true,
    running: true,
    syncing: true,
    feedUrl: "https://observer.example/outcomes",
    batchSize: 25,
    pollIntervalMs: 30_000,
    async getStatus() {
      throw new Error("observer cursor read failed");
    }
  };

  const status = await service.getAdminStatus();

  assert.equal(status.xcmSettlementWatcher.enabled, true);
  assert.equal(status.xcmSettlementWatcher.running, true);
  assert.equal(status.xcmSettlementWatcher.pendingCount, 0);
  assert.equal(status.xcmSettlementWatcher.error.code, "state_store_unavailable");
  assert.equal(status.xcmObservationRelay.enabled, true);
  assert.equal(status.xcmObservationRelay.running, true);
  assert.equal(status.xcmObservationRelay.syncing, true);
  assert.equal(status.xcmObservationRelay.feedUrl, "https://observer.example/outcomes");
  assert.equal(status.xcmObservationRelay.error.code, "xcm_observation_relay_status_error");
  assert.ok(status.anomalies.some((entry) => entry.code === "xcm_settlement_watcher_status_unavailable"));
  assert.ok(status.anomalies.some((entry) => entry.code === "xcm_observation_relay_status_unavailable"));
});

test("getGithubOperatorStatus exposes the read-only GitHub helper", async () => {
  const service = makePlatformService();
  const status = await service.getGithubOperatorStatus({
    repos: "",
    view: "prs",
    fetchImpl: async () => {
      throw new Error("fetch should not be called when no repos are configured");
    }
  });

  assert.equal(status.mutates, false);
  assert.equal(status.configured, false);
  assert.equal(status.selectedView.name, "prs");
  assert.equal(status.digest.pullRequestsNeedingAttention.length, 0);
});

const INGEST_JOB_INPUT = {
  id: "open-data-job-001",
  category: "coding",
  tier: "starter",
  rewardAmount: 2,
  rewardAsset: "DOT",
  verifierMode: "benchmark",
  verifierTerms: ["complete"],
  verifierMinimumMatches: 1,
  source: { type: "operator_upload" }
};

const VERIFIABLE_REAL_INGEST_JOB_INPUT = {
  ...INGEST_JOB_INPUT,
  id: "pr-example-project-42",
  verifierMode: "github_pr",
  verifierMinimumScore: 80,
  requireIssueReference: true,
  requireTestEvidence: true,
  requireClaimantBinding: true,
  outputSchemaRef: "schema://jobs/github-pr-evidence-output",
  source: {
    type: "github_issue",
    repo: "example/project",
    issueNumber: 42,
    issueUrl: "https://github.com/example/project/issues/42"
  }
};

function makePrefundGateway(ensureJob) {
  const calls = [];
  return {
    calls,
    isEnabled: () => true,
    getJob: async () => ({ state: 0 }),
    ensureJob: async (job, instanceJobId, claimStake) => {
      calls.push({ jobId: instanceJobId, claimStake });
      return ensureJob(job, instanceJobId, claimStake);
    }
  };
}

test("createIngestedJob does not prefund when the flag is off (no funding stamp)", async () => {
  const gateway = makePrefundGateway(async () => ({ state: 1 }));
  const service = makePlatformService(gateway);
  // prefundIngestedJobs defaults to false
  const created = await service.createIngestedJob(INGEST_JOB_INPUT);
  assert.equal(created.funding, undefined);
  assert.equal(created.onboardingWaiverEligible, undefined);
  assert.equal(gateway.calls.length, 0);
});

test("fresh wallets retain a real waiver-eligible claimable path after demo retirement", async () => {
  const service = new PlatformService(
    BOOTSTRAP_JOBS.map((job) => structuredClone(job)),
    new Map(),
    new Map(),
    new Map(),
    { isEnabled: () => false },
    new MemoryStateStore()
  );
  await service.createIngestedJob({
    ...VERIFIABLE_REAL_INGEST_JOB_INPUT,
    rewardAmount: 0.25
  });

  const jobs = await service.listJobsWithSessions({
    wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  });
  const eligible = jobs.filter((job) => (
    job.source?.type === "github_issue"
    && job.onboardingWaiverEligible === true
    && job.claimable === true
  ));

  assert.ok(eligible.length >= 1);
  assert.equal(jobs.some((job) => job.id === "starter-coding-002"), false);
});

test("ingestion waiver policy is source-scoped and starter-only", async () => {
  const service = makePlatformService();
  const unknown = await service.createIngestedJob({
    ...INGEST_JOB_INPUT,
    id: "unknown-source-starter",
    source: { type: "operator_upload" }
  });
  const pro = await service.createIngestedJob({
    ...VERIFIABLE_REAL_INGEST_JOB_INPUT,
    id: "pr-example-project-43",
    tier: "pro"
  });

  assert.equal(unknown.onboardingWaiverEligible, undefined);
  assert.equal(pro.onboardingWaiverEligible, undefined);
});

test("production ingestion refuses new keyword-only provider jobs", async () => {
  const service = makePlatformService();
  await assert.rejects(
    () => service.createIngestedJob({
      ...INGEST_JOB_INPUT,
      id: "unsafe-open-data-job",
      source: { type: "open_data_dataset" }
    }),
    (error) => error?.code === "catalog_verifier_cannot_reject_bad_work"
  );
  assert.equal(service.listJobs().some((job) => job.id === "unsafe-open-data-job"), false);
});

test("createIngestedJob does not prefund when the gateway is disabled", async () => {
  const gateway = { isEnabled: () => false, calls: [], ensureJob: async () => { gateway.calls.push(1); } };
  const service = makePlatformService(gateway);
  service.prefundIngestedJobs = true;
  const created = await service.createIngestedJob(INGEST_JOB_INPUT);
  assert.equal(created.funding, undefined);
  assert.equal(gateway.calls.length, 0);
});

test("createIngestedJob escrows the reward and stamps funded on success", async () => {
  const bus = new EventBus();
  const gateway = makePrefundGateway(async () => ({ state: 1 }));
  const service = makePlatformService(gateway, bus);
  service.prefundIngestedJobs = true;

  const created = await service.createIngestedJob(INGEST_JOB_INPUT);

  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].claimStake, 0); // worker funds their own stake
  assert.equal(created.funding.source, "ingestion_prefund");
  assert.equal(created.funding.state, "funded");
  assert.equal(created.funding.asset, "DOT");
  assert.equal(created.funding.amount, 2);
  assert.ok(created.funding.fundedAt);
  // Must NOT carry recurring-reserve keys, or gateway.usesRecurringTemplateReserve misfires.
  assert.equal("wallet" in created.funding, false);
  assert.equal("templateId" in created.funding, false);
  // The stamp is persisted on the catalog job and surfaces through discovery.
  const claimable = await service.attachClaimState(created, {});
  assert.equal(claimable.claimable, true);
  assert.equal(claimable.fundingState, "funded");
  const events = bus.replay({}, undefined).events;
  assert.ok(events.some((event) => event.topic === "funding.ingestion_prefund_funded"));
});

test("createIngestedJob keeps the job and stamps pending on insufficient liquidity", async () => {
  const bus = new EventBus();
  const gateway = makePrefundGateway(async () => {
    throw new InsufficientLiquidityError("DOT", { operation: "ensureJob" });
  });
  const service = makePlatformService(gateway, bus);
  service.prefundIngestedJobs = true;

  // Resolves (never rejects) so the ingest run is not aborted.
  const created = await service.createIngestedJob(INGEST_JOB_INPUT);

  assert.equal(created.funding.state, "pending");
  assert.equal(created.funding.reason, "insufficient_liquidity");
  assert.ok(created.funding.attemptedAt);
  // Job is still in the catalog, discoverable but NOT claimable.
  const fetched = service.getJobDefinition("open-data-job-001");
  assert.equal(fetched.id, "open-data-job-001");
  const claimable = await service.attachClaimState(fetched, { wallet: WALLET });
  assert.equal(claimable.claimable, false);
  assert.equal(claimable.currentWalletCanClaim, false);
  assert.equal(claimable.reason, "reward_funding_pending");
  assert.equal(claimable.fundingState, "pending");
  const events = bus.replay({}, undefined).events;
  assert.ok(events.some((event) => event.topic === "funding.ingestion_prefund_pending"));
});

test("createIngestedJob stamps pending on an unexpected gateway error and never aborts", async () => {
  const gateway = makePrefundGateway(async () => {
    throw new Error("RPC timeout");
  });
  const service = makePlatformService(gateway);
  service.prefundIngestedJobs = true;

  const created = await service.createIngestedJob(INGEST_JOB_INPUT);
  assert.equal(created.funding.state, "pending");
  assert.equal(created.funding.reason, "prefund_failed");
});

test("createIngestedJob propagates validation errors and does not attempt prefund", async () => {
  const gateway = makePrefundGateway(async () => ({ state: 1 }));
  const service = makePlatformService(gateway);
  service.prefundIngestedJobs = true;

  await assert.rejects(() => service.createIngestedJob({
    ...INGEST_JOB_INPUT,
    id: ""
  }), /Job id is required/u);
  assert.equal(gateway.calls.length, 0);
});

test("upsertIngestedJob writes an idempotent refresh that reproduces the commitment", async () => {
  let live = { state: 0 };
  const gateway = {
    isEnabled: () => true,
    getJob: async () => live
  };
  const service = makePlatformService(gateway);
  const now = new Date("2026-08-12T12:00:00.000Z");
  const original = await service.upsertIngestedJob(INGEST_JOB_INPUT, { now });
  live = {
    state: 1,
    specHash: hashCanonicalContent(service.getJobDefinition(original.id))
  };

  const refreshed = await service.upsertIngestedJob({
    ...INGEST_JOB_INPUT,
    category: " CODING "
  }, { now });

  assert.notEqual(refreshed, original);
  assert.equal(hashCanonicalContent(service.getJobDefinition(refreshed.id)), live.specHash);
  assert.deepEqual(service.jobCatalogService.getSpecHashIntegrityStatus(), {
    driftedCount: 0,
    drifted: []
  });
});

test("upsertIngestedJob hydrates an exact pre-D3 definition without manufacturing spec drift", async () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const preD3 = {
    ...INGEST_JOB_INPUT,
    rewardAmount: 0.25,
    lifecycle: {
      status: "open",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      // This test controls `now` and is about exact legacy hydration, not
      // wall-clock staleness. Keep the fixture open across future CI runs.
      staleAt: "9999-12-31T23:59:59.999Z"
    }
  };
  let live = { state: 0 };
  const gateway = {
    isEnabled: () => true,
    getJob: async () => live
  };
  const originalService = makePlatformService(gateway);
  const original = await originalService.upsertIngestedJob(preD3, { now });
  const committedSpecHash = hashCanonicalContent(originalService.getJobDefinition(original.id));
  live = { state: 1, specHash: committedSpecHash };
  const service = makePlatformService(gateway);

  const hydrated = await service.upsertIngestedJob({
    ...INGEST_JOB_INPUT,
    lane: "liveness",
    rewardAmount: 0.1
  }, {
    now,
    compatibleDefinitions: [preD3]
  });

  assert.equal(hydrated.rewardAmount, 0.25);
  assert.equal(hydrated.lane, undefined);
  assert.equal(service.jobCatalogService.getSpecHashIntegrityStatus().driftedCount, 0);
  assert.equal(hashCanonicalContent(service.getJobDefinition(hydrated.id)), committedSpecHash);
});

test("upsertIngestedJob refuses a mismatching refresh and retains the committed definition", async () => {
  let live = { state: 0 };
  const gateway = {
    isEnabled: () => true,
    getJob: async () => live
  };
  const service = makePlatformService(gateway);
  const now = new Date("2026-08-12T12:00:00.000Z");
  await service.upsertIngestedJob(INGEST_JOB_INPUT, { now });
  const servedBefore = service.getJobDefinition(INGEST_JOB_INPUT.id);
  live = { state: 1, specHash: hashCanonicalContent(servedBefore) };

  await assert.rejects(
    () => service.upsertIngestedJob({
      ...INGEST_JOB_INPUT,
      description: "Changed after the chain commitment."
    }, { now }),
    (error) => {
      assert.equal(error.code, INGEST_REFUSED_SPEC_HASH_MISMATCH);
      assert.equal(error.details.servedDefinitionRetained, true);
      assert.equal(error.details.legacyDrift, false);
      return true;
    }
  );

  assert.deepEqual(service.getJobDefinition(INGEST_JOB_INPUT.id), servedBefore);
  assert.equal(service.jobCatalogService.getSpecHashIntegrityStatus().driftedCount, 0);
});

test("upsertIngestedJob hides legacy drift and exposes it to operators", async () => {
  const gateway = {
    isEnabled: () => true,
    getJob: async () => ({ state: 1, specHash: `0x${"ab".repeat(32)}` })
  };
  const service = makePlatformService(gateway);
  const now = new Date("2026-08-12T12:00:00.000Z");

  await assert.rejects(
    () => service.upsertIngestedJob(INGEST_JOB_INPUT, { now }),
    (error) => error.code === INGEST_REFUSED_SPEC_HASH_MISMATCH
      && error.details.legacyDrift === true
  );

  assert.equal(service.listJobs().some((job) => job.id === INGEST_JOB_INPUT.id), false);
  assert.throws(
    () => service.jobCatalogService.getClaimableJobDefinition(INGEST_JOB_INPUT.id),
    (error) => error.code === "job_definition_chain_mismatch"
  );
  const status = await service.getAdminStatus();
  assert.equal(status.jobSpecHashIntegrity.driftedCount, 1);
  assert.equal(status.jobSpecHashIntegrity.drifted[0].jobId, INGEST_JOB_INPUT.id);
  assert.equal(status.jobSpecHashIntegrity.drifted[0].recovery, "operator_tombstone_rescue_after_review_window");
});

test("external projections strip sponsored-gas and waiver flags even from legacy material", () => {
  const service = makePlatformService();
  const created = service.createExternalJobProjection({
    jobId: "external-open-door-projection",
    wallet: WALLET,
    definition: {
      category: "coding",
      tier: "starter",
      rewardAsset: "DOT",
      rewardAmount: 5,
      verifierMode: "benchmark",
      verifierTerms: ["complete"],
      verifierMinimumMatches: 1,
      inputSchemaRef: "schema://jobs/coding-input",
      outputSchemaRef: "schema://jobs/coding-output",
      claimTtlSeconds: 3600,
      retryLimit: 1,
      requiresSponsoredGas: true,
      onboardingWaiverEligible: true
    }
  }, {
    fundedAt: "2026-08-08T10:00:00.000Z",
    txHash: `0x${"ab".repeat(32)}`,
    blockNumber: "19150000"
  });

  assert.equal(created.source.type, "external");
  assert.equal(created.requiresSponsoredGas, false);
  assert.notEqual(created.onboardingWaiverEligible, true);
});

test("serving metadata exposes curated provenance without changing the canonical definition", async () => {
  const committedSpecHash = `0x${"cd".repeat(32)}`;
  const service = makePlatformService({
    isEnabled: () => true,
    async getJob() {
      return { poster: EXTERNAL_POSTER, specHash: committedSpecHash, state: 1 };
    }
  });
  const definition = service.getJobDefinition("parent-job-001");
  const canonicalBefore = hashCanonicalContent(definition);

  const served = await service.addListingSecurityMetadata(definition);

  assert.equal(served.listingStatus, "listed");
  assert.equal(served.contentTrust, "operator-curated");
  assert.equal(
    served.verificationDepth,
    "Starter-tier benchmark check: output schema conformance and required reference terms. This is not a content audit."
  );
  assert.deepEqual(served.provenance, {
    posterAddress: EXTERNAL_POSTER,
    posterTier: "operator-curated",
    postingRoute: "curated",
    firstSeenAt: null,
    specHash: committedSpecHash
  });
  assert.equal(hashCanonicalContent(service.getJobDefinition("parent-job-001")), canonicalBefore);
  assert.equal(service.getJobDefinition("parent-job-001").provenance, undefined);
  assert.equal(service.getJobDefinition("parent-job-001").verificationDepth, undefined);
});

test("external serving metadata uses the hash-pinned draft provenance", async () => {
  const store = new MemoryStateStore();
  const service = makePlatformService(undefined, undefined, store, undefined, undefined, undefined, undefined, {
    id: EXTERNAL_LISTING_JOB_ID,
    source: { type: "external", fundingRail: "x402", poster: { wallet: EXTERNAL_POSTER } }
  });
  const specHash = `0x${"ef".repeat(32)}`;
  await store.materializeExternalJobDraft({
    draftId: "draft-listing-security",
    jobId: EXTERNAL_LISTING_JOB_ID,
    wallet: EXTERNAL_POSTER,
    fundingRail: "x402",
    specHash,
    createdAt: "2026-08-13T08:00:00.000Z",
    status: "live"
  });

  const served = await service.addListingSecurityMetadata(
    service.getJobDefinition(EXTERNAL_LISTING_JOB_ID)
  );

  assert.equal(served.contentTrust, "external-unreviewed");
  assert.deepEqual(served.provenance, {
    posterAddress: EXTERNAL_POSTER,
    posterTier: "external-self-serve",
    postingRoute: "external-x402",
    firstSeenAt: "2026-08-13T08:00:00.000Z",
    specHash
  });
});

test("explainEligibility narrates the same effective cap and next raise as the gate", async () => {
  const service = makePlatformService();
  service.preflightJob = async () => ({
    jobId: "parent-job-001",
    wallet: WALLET,
    eligible: true,
    workerExposure: { consumesOperatorExposure: false, vestedAssetsRaw: "1000000" }
  });
  service.setWorkerProgressionService({
    getProgression: async () => ({
      tier: "pro",
      effectiveCaps: {
        perJobMax: { asset: "USDC", raw: "2000000", amount: 2, source: "capital_backed_external_reward_ceiling", components: { deposit: { raw: "1000000" } } },
        rolling24h: { asset: "USDC", raw: "1500000", amount: 1.5 },
        concurrent: { asset: "USDC", raw: "3000000", amount: 3, components: { deposit: { raw: "500000" } } }
      },
      raises: [
        { action: "keep_completing", effect: "Complete one more job to unlock the next reputation tier." },
        { action: "deposit", effect: "Deposit 3 USDC to raise the live cap." }
      ]
    })
  });

  const explained = await service.explainEligibility(WALLET, "parent-job-001");
  assert.equal(explained.currentCap.raw, "2000000");
  assert.equal(explained.capSource.gate, "capital_backed_external_reward_ceiling");
  assert.equal(explained.capSource.tier, "pro");
  assert.equal(explained.capSource.tierLabel, "claim tier");
  assert.equal(explained.tierLabel, "claim tier");
  assert.equal(explained.capSource.deposit.vestedRaw, "1000000");
  assert.deepEqual(explained.nextRaise, {
    action: "deposit",
    effect: "Deposit 3 USDC to raise the live cap."
  });
});

test("verification settlement persists progression and settled-session reads reuse it", async () => {
  const store = new MemoryStateStore();
  const service = makePlatformService(undefined, undefined, store);
  const approvedSession = (index) => ({
    sessionId: `blind-tester-approved-${index}`,
    jobId: `blind-tester-job-${index}`,
    wallet: BLIND_TESTER_WALLET,
    status: "resolved",
    claimedAt: `2026-08-${18 + index}T08:00:00.000Z`,
    submittedAt: `2026-08-${18 + index}T08:05:00.000Z`,
    resolvedAt: `2026-08-${18 + index}T08:10:00.000Z`,
    updatedAt: `2026-08-${18 + index}T08:10:00.000Z`,
    verificationSummary: { outcome: "approved", handler: "benchmark" },
    badgeSnapshot: { category: "coding", tier: "starter", level: 1 }
  });
  const visibleSessions = [approvedSession(1), approvedSession(2)];
  for (const session of visibleSessions) await store.upsertSession(session);
  const submitted = {
    sessionId: "blind-tester-third-settlement",
    jobId: "parent-job-001",
    wallet: BLIND_TESTER_WALLET,
    status: "submitted",
    claimedAt: "2026-08-22T08:00:00.000Z",
    submittedAt: "2026-08-22T08:05:00.000Z",
    updatedAt: "2026-08-22T08:05:00.000Z",
    submission: {
      summary: "Blind walkthrough third job.",
      output: "complete verified output",
      status: "complete"
    },
    jobSnapshot: buildJobSnapshot(makeParentJob(), {
      capturedAt: "2026-08-22T08:00:00.000Z"
    })
  };
  await store.upsertSession(submitted);
  const persistedListSessionsByWallet = store.listSessionsByWallet.bind(store);
  store.listSessionsByWallet = async (wallet, limit, offset) => {
    const sessions = await persistedListSessionsByWallet(wallet, limit, offset);
    return sessions.filter((session) => session.sessionId !== submitted.sessionId);
  };
  store.putRunReceiptDocument = undefined;
  service.reputations.set(BLIND_TESTER_WALLET, {
    skill: 100,
    reliability: 100,
    economic: 0,
    tier: "pro"
  });
  service.setWorkerProgressionService(new WorkerProgressionService({
    stateStore: store,
    getReputation: service.getReputation.bind(service),
    workerExposurePolicy: {
      async capacityForWallet() {
        return {
          vestedAssetsRaw: "0",
          vestedAssetsUsdc: 0,
          externalRewardCeilingBaseRaw: "1000000",
          externalRewardCeilingBaseUsdc: 1,
          externalRewardCeilingRaiseRaw: "0",
          externalRewardCeilingRaiseUsdc: 0,
          externalRewardCeilingRaw: "1000000",
          externalRewardCeilingUsdc: 1,
          baseOpenExposureCapRaw: "2500000",
          baseOpenExposureCapUsdc: 2.5,
          openExposureRaiseRaw: "0",
          openExposureRaiseUsdc: 0,
          openExposureCapRaw: "2500000",
          openExposureCapUsdc: 2.5,
          nextConcurrentRaiseVestedRaw: "1000000",
          nextConcurrentRaiseAmountRaw: "1000000",
          nextConcurrentOpenExposureCapRaw: "3000000",
          nextConcurrentOpenExposureCapUsdc: 3,
          nextConcurrentExternalRewardCeilingRaw: "2000000",
          nextConcurrentExternalRewardCeilingUsdc: 2,
          vestingHours: 48,
          vestingAvailable: true
        };
      }
    },
    workerDailyExposurePolicy: {
      progressionConfig: () => ({
        rolling24hRaw: "1500000",
        rolling24hUsdc: 1.5,
        lifetimeCreditRaw: "10000000",
        lifetimeCreditUsdc: 10,
        graduationSettledJobs: 10
      })
    },
    creditInterestSettledJobs: 3
  }));

  const before = await service.getWorkerProgression(BLIND_TESTER_WALLET);
  const settled = await service.ingestVerification(submitted.sessionId, {
    jobId: submitted.jobId,
    handler: "benchmark",
    handlerVersion: 1,
    outcome: "approved",
    reasonCode: "BENCHMARK_THRESHOLD_MET"
  });
  const { progression: _persistedProgression, ...resolvedWithoutProgression } = await store.getSession(
    submitted.sessionId
  );
  await store.upsertSession(resolvedWithoutProgression);
  const resumed = await service.resumeSession(submitted.sessionId);

  assert.equal(before.creditInterest.eligible, false);
  assert.equal(settled.progression.creditInterest.eligible, true);
  assert.deepEqual(settled.progression.justChanged, {
    field: "creditInterest.eligible",
    from: false,
    to: true
  });
  assert.deepEqual(resumed.progression, settled.progression);
});
