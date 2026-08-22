import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIORITY_WINDOW_ACTIVE_REASON,
  createDepositClaimPriorityPolicy
} from "./deposit-claim-priority.js";
import { PlatformService } from "./platform-service.js";
import { MemoryStateStore } from "./state-store.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LISTED_AT = "2026-08-22T12:00:00.000Z";

function job(overrides = {}) {
  return {
    id: "priority-integration-job",
    category: "coding",
    tier: "starter",
    jobType: "work",
    requiredRole: "worker",
    rewardAsset: "USDC",
    rewardAmount: 0.25,
    verifierMode: "benchmark",
    verifierConfig: {
      version: 1,
      handler: "benchmark",
      requiredKeywords: ["done"],
      minimumMatches: 1
    },
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 3_600,
    retryLimit: 1,
    requiresSponsoredGas: false,
    onboardingWaiverEligible: false,
    lifecycle: {
      status: "open",
      createdAt: LISTED_AT,
      updatedAt: LISTED_AT
    },
    ...overrides
  };
}

function harness({ vestedRaw = "0", outstandingCreditRaw = "0" } = {}) {
  let now = new Date("2026-08-22T12:02:00.000Z");
  const priorityPolicy = createDepositClaimPriorityPolicy({
    config: {
      enabled: true,
      windowSeconds: 300,
      thresholdRaw: 1_000_000n,
      thresholdUsdc: "1"
    },
    workerExposurePolicy: {
      capacityForWallet: async () => ({
        vestedAssetsRaw: vestedRaw,
        vestingAvailable: true,
        credit: { available: true, outstandingDebtRaw: outstandingCreditRaw }
      })
    },
    now: () => now
  });
  const profiles = new Map([[WALLET, {
    wallet: WALLET,
    preferredCategories: ["coding"],
    verifierCompatibility: ["benchmark"],
    preferredRiskLevel: "low",
    capabilities: ["claim_job", "submit_work"],
    supportedProtocols: ["http"],
    minLiquidReserve: 0,
    autoUnwindStrategies: false
  }]]);
  const accounts = new Map([[WALLET, {
    wallet: WALLET,
    liquid: { USDC: 10 },
    reserved: {},
    strategyAllocated: {},
    collateralLocked: {},
    jobStakeLocked: {},
    debtOutstanding: {}
  }]]);
  const reputations = new Map([[WALLET, {
    skill: 50,
    reliability: 50,
    economic: 50,
    tier: "starter"
  }]]);
  const service = new PlatformService(
    [job()],
    profiles,
    accounts,
    reputations,
    undefined,
    new MemoryStateStore(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    priorityPolicy
  );
  return {
    service,
    setNow(value) { now = new Date(value); }
  };
}

test("qualifying wallet claims curated work inside the priority window", async () => {
  const { service } = harness({ vestedRaw: "1000000" });
  const [listing] = await service.listJobsWithSessions({ wallet: WALLET });
  assert.equal(listing.listedAt, LISTED_AT);
  assert.deepEqual(listing.priorityWindow, {
    openAt: "2026-08-22T12:05:00.000Z",
    qualifiesWith: "≥ 1 USDC vested deposit and no outstanding credit draw"
  });
  const [recommendation] = await service.recommendJobs(WALLET);
  assert.equal(recommendation.listedAt, LISTED_AT);
  assert.deepEqual(recommendation.priorityWindow, listing.priorityWindow);
  const preflight = await service.preflightJob(WALLET, job().id);
  assert.equal(preflight.eligible, true);
  assert.equal(preflight.priorityQualification.qualifies, true);

  const claimed = await service.claimJob(WALLET, job().id, "http", "priority-qualified");
  assert.equal(claimed.status, "claimed");
});

test("preflight and claim gate share priority_window_active, then openAt admits the wallet", async () => {
  const { service, setNow } = harness({ vestedRaw: "999999" });
  const preflight = await service.preflightJob(WALLET, job().id);
  assert.equal(preflight.eligible, false);
  assert.equal(preflight.reason, PRIORITY_WINDOW_ACTIVE_REASON);
  assert.equal(preflight.openAt, "2026-08-22T12:05:00.000Z");

  await assert.rejects(
    () => service.claimJob(WALLET, job().id, "http", "priority-refused"),
    (error) => {
      assert.equal(error.code, preflight.reason);
      assert.equal(error.details.openAt, preflight.openAt);
      return true;
    }
  );

  setNow("2026-08-22T12:05:00.000Z");
  const after = await service.preflightJob(WALLET, job().id);
  assert.equal(after.eligible, true);
  const claimed = await service.claimJob(WALLET, job().id, "http", "priority-open");
  assert.equal(claimed.status, "claimed");
});

test("credit-draw wallet is refused by the same preflight and claim derivation", async () => {
  const { service } = harness({ vestedRaw: "5000000", outstandingCreditRaw: "1" });
  const preflight = await service.preflightJob(WALLET, job().id);
  assert.equal(preflight.reason, PRIORITY_WINDOW_ACTIVE_REASON);
  assert.equal(preflight.priorityQualification.depositQualified, true);
  assert.equal(preflight.priorityQualification.noOutstandingCreditDraw, false);
  await assert.rejects(
    () => service.claimJob(WALLET, job().id, "http", "priority-credit-draw"),
    (error) => error.code === PRIORITY_WINDOW_ACTIVE_REASON
  );
});
