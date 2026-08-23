import test from "node:test";
import assert from "node:assert/strict";

import {
  DAILY_EXPOSURE_BUDGET_REACHED_REASON,
  DEFAULT_WORKER_DAILY_EXPOSURE_BUDGET_RAW,
  LIFETIME_CATALOGUE_CREDIT_EXHAUSTED_REASON,
  WorkerDailyExposurePolicy,
  loadWorkerDailyExposureConfig,
  resolveDailyExposureBudget
} from "./worker-daily-exposure.js";
import { WorkerExposurePolicy } from "./worker-exposure.js";
import { MemoryStateStore } from "./state-store.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MORNING_STARTED_AT = new Date("2026-08-12T06:00:00.000Z");
const FORTY_TWO_CLAIM_MORNING = Array.from({ length: 42 }, (_, index) => ({
  id: `morning-claim-${index + 1}`,
  claimedAt: new Date(MORNING_STARTED_AT.getTime() + (index * 10 * 60 * 1_000)).toISOString(),
  rewardAmount: 0.25
}));

function job(overrides = {}) {
  return {
    id: "candidate-job",
    source: "curated",
    rewardAsset: "USDC",
    rewardAmount: 0.25,
    ...overrides
  };
}

function economics(overrides = {}) {
  return {
    claimEconomicsWaived: true,
    claimFeeRetainedOnSuccess: false,
    ...overrides
  };
}

function makePolicy({
  stateStore = new MemoryStateStore(),
  budgetRaw = DEFAULT_WORKER_DAILY_EXPOSURE_BUDGET_RAW,
  lifetimeCreditRaw = 10_000_000,
  graduationSettledJobs = 10,
  now = () => new Date("2026-08-12T12:00:00.000Z")
} = {}) {
  const workerExposurePolicy = new WorkerExposurePolicy({
    stateStore,
    gasEstimateUsdc: 0.059,
    capUsdc: 100,
    resolveVesting: async () => ({ vestedRaw: 0n, tranches: [] })
  });
  return new WorkerDailyExposurePolicy({
    stateStore,
    workerExposurePolicy,
    budgetRaw,
    lifetimeCreditRaw,
    graduationSettledJobs,
    now
  });
}

async function putClaim(stateStore, {
  id,
  claimedAt,
  rewardAmount = 0.25,
  status = "claimed",
  wallet = WALLET,
  d0 = true
}) {
  const reservedRewardUsdc = rewardAmount;
  const brokeredGasUsdc = 0.059;
  const candidate = {
    reservedRewardUsdc,
    brokeredGasUsdc,
    totalUsdc: Number((reservedRewardUsdc + brokeredGasUsdc).toFixed(6))
  };
  await stateStore.upsertSession({
    sessionId: id,
    wallet,
    jobId: `${id}-job`,
    status,
    claimedAt,
    ...(status === "resolved" ? { verificationSummary: { outcome: "approved" } } : {}),
    jobSnapshot: { definition: job({ id: `${id}-job` }) },
    workerExposure: { candidate },
    dailyExposure: {
      version: d0 ? "worker-catalogue-exposure-v2" : "worker-daily-exposure-v1",
      accessMode: "lifetime_credit",
      candidate
    }
  });
}

async function seedGraduation(stateStore, count = 10, wallet = WALLET) {
  for (let index = 0; index < count; index += 1) {
    await putClaim(stateStore, {
      id: `graduation-${index + 1}`,
      claimedAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      rewardAmount: 0,
      status: "resolved",
      wallet,
      d0: false
    });
  }
}

test("daily and lifetime config defaults are finite and the retired deposit multiplier fails loudly", () => {
  assert.deepEqual(loadWorkerDailyExposureConfig({}), {
    budgetRaw: 1_500_000,
    lifetimeCreditRaw: 10_000_000,
    graduationSettledJobs: 10
  });
  assert.deepEqual(loadWorkerDailyExposureConfig({
    WORKER_DAILY_EXPOSURE_BUDGET_RAW: "2250000",
    WORKER_LIFETIME_CATALOGUE_CREDIT_RAW: "9000000",
    WORKER_GRADUATION_SETTLED_JOBS: "12"
  }), {
    budgetRaw: 2_250_000,
    lifetimeCreditRaw: 9_000_000,
    graduationSettledJobs: 12
  });
  for (const retiredValue of ["1000", "0", ""]) {
    assert.throws(
      () => loadWorkerDailyExposureConfig({ WORKER_TIER3_ALLOWANCE_PER_DEPOSITED_MILLI: retiredValue }),
      /WORKER_TIER3_ALLOWANCE_PER_DEPOSITED_MILLI.*retired by Packet D0/u
    );
  }
});

test("the catalogue daily base is deposit-blind", () => {
  assert.equal(resolveDailyExposureBudget(WALLET), 1_500_000n);
  assert.equal(resolveDailyExposureBudget(WALLET, {
    budgetRaw: 2_000_000,
    depositedAssetsRaw: 100_000_000,
    allowancePerDepositedMilli: 50_000
  }), 2_000_000n);
});

test("an un-established wallet spends finite lifetime credit and settlement does not refund it", async () => {
  const stateStore = new MemoryStateStore();
  await putClaim(stateStore, {
    id: "lifetime-settled",
    claimedAt: "2026-08-01T08:00:00.000Z",
    rewardAmount: 9.5,
    status: "resolved"
  });

  const decision = await makePolicy({ stateStore }).evaluate({
    wallet: WALLET,
    job: job({ rewardAmount: 0.5 }),
    claimEconomics: economics()
  });

  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, LIFETIME_CATALOGUE_CREDIT_EXHAUSTED_REASON);
  assert.equal(decision.catalogueAccess.mode, "lifetime_credit");
  assert.equal(decision.catalogueAccess.settledApprovedCatalogueJobs, 1);
  assert.equal(decision.catalogueAccess.graduationSettledJobs, 10);
  assert.equal(decision.catalogueAccess.externalWorkAffected, false);
  assert.match(decision.message, /external poster-funded work is not gated by this lifetime credit/iu);
});

test("graduation boundary switches exactly at N settled and approved catalogue jobs", async () => {
  const stateStore = new MemoryStateStore();
  await seedGraduation(stateStore, 9);
  await putClaim(stateStore, {
    id: "spent-lifetime",
    claimedAt: "2026-08-01T08:00:00.000Z",
    rewardAmount: 9.7,
    status: "rejected"
  });
  const policy = makePolicy({ stateStore });

  const before = await policy.evaluate({ wallet: WALLET, job: job(), claimEconomics: economics() });
  await putClaim(stateStore, {
    id: "graduation-10",
    claimedAt: "2026-07-10T00:00:00.000Z",
    rewardAmount: 0,
    status: "resolved",
    d0: false
  });
  const after = await policy.evaluate({ wallet: WALLET, job: job(), claimEconomics: economics() });

  assert.equal(before.reason, LIFETIME_CATALOGUE_CREDIT_EXHAUSTED_REASON);
  assert.equal(before.catalogueAccess.settledApprovedCatalogueJobs, 9);
  assert.equal(after.eligible, true);
  assert.equal(after.catalogueAccess.mode, "rolling_daily");
  assert.equal(after.catalogueAccess.settledApprovedCatalogueJobs, 10);
  assert.deepEqual(after.dailyAllowance, { base: 1.5, total: 1.5 });
  assert.equal("fromDeposits" in after.dailyAllowance, false);
  assert.equal("depositedAssets" in after.dailyAllowance, false);
});

test("mixed-era verification and lane shapes produce one stable catalogue settlement count", async () => {
  const stateStore = new MemoryStateStore();
  const sessions = [
    {
      sessionId: "catalogue-current",
      wallet: WALLET,
      jobId: "catalogue-current-job",
      status: "resolved",
      verificationSummary: { outcome: "approved" },
      jobSnapshot: { definition: { source: { type: "wikipedia_article" } } }
    },
    {
      sessionId: "catalogue-stored-verification",
      wallet: WALLET,
      jobId: "catalogue-stored-verification-job",
      status: "resolved",
      jobSnapshot: { source: "wikipedia", sourceType: "wikipedia_article" }
    },
    {
      sessionId: "catalogue-legacy-status",
      wallet: WALLET,
      jobId: "catalogue-legacy-status-job",
      status: "resolved",
      verification: { status: "approved" },
      jobSnapshot: { specDefinition: { sourceType: "wikipedia_article" } }
    },
    {
      sessionId: "external-public-projection",
      wallet: WALLET,
      jobId: "external-public-projection-job",
      status: "resolved",
      verificationSummary: { outcome: "approved" },
      jobSnapshot: { specDefinition: { sourceType: "external" } }
    }
  ];
  for (const session of sessions) await stateStore.upsertSession(session);
  await stateStore.upsertVerificationResult("catalogue-stored-verification", { outcome: "approved" });

  const decision = await makePolicy({
    stateStore,
    graduationSettledJobs: 3
  }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });

  assert.equal(decision.catalogueAccess.mode, "rolling_daily");
  assert.equal(decision.catalogueAccess.settledApprovedCatalogueJobs, 3);
});

test("external poster-funded work is outside catalogue lifetime and daily accounting", async () => {
  const decision = await makePolicy({ lifetimeCreditRaw: 0 }).evaluate({
    wallet: WALLET,
    job: job({ source: "external", poster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    claimEconomics: economics()
  });

  assert.equal(decision.eligible, true);
  assert.equal(decision.applies, false);
});

test("42-claim replay for an established wallet is refused on the fifth typical claim", async () => {
  const stateStore = new MemoryStateStore();
  await seedGraduation(stateStore);
  let now = MORNING_STARTED_AT;
  const dailyPolicy = makePolicy({ stateStore, now: () => now });
  let refusal;

  for (const claim of FORTY_TWO_CLAIM_MORNING) {
    now = new Date(claim.claimedAt);
    const decision = await dailyPolicy.evaluate({
      wallet: WALLET,
      job: job({ id: claim.id, rewardAmount: claim.rewardAmount }),
      claimEconomics: economics()
    });
    if (!decision.eligible) {
      refusal = { claim, decision };
      break;
    }
    await putClaim(stateStore, claim);
  }

  assert.equal(refusal.claim.id, "morning-claim-5");
  assert.equal(refusal.decision.reason, DAILY_EXPOSURE_BUDGET_REACHED_REASON);
  assert.equal(refusal.decision.dailyExposureUsed, 1.236);
  assert.equal(refusal.decision.projectedDailyExposure, 1.545);
  assert.equal(refusal.decision.retryAfter, "2026-08-13T06:00:00.000Z");
});

test("established settlement and rejection do not refund the rolling window", async () => {
  const stateStore = new MemoryStateStore();
  await seedGraduation(stateStore);
  const claimedAt = "2026-08-12T08:00:00.000Z";
  await putClaim(stateStore, { id: "settled-fast", claimedAt, status: "resolved", rewardAmount: 0.5 });
  await putClaim(stateStore, { id: "rejected-fast", claimedAt, status: "rejected", rewardAmount: 0.5 });

  const decision = await makePolicy({ stateStore }).evaluate({
    wallet: WALLET,
    job: job({ rewardAmount: 0.5 }),
    claimEconomics: economics()
  });

  assert.equal(decision.eligible, false);
  assert.equal(decision.currentWindowClaimCount, 2);
  assert.equal(decision.dailyExposureUsed, 1.118);
});

test("established claim spend ages out at exactly 24 hours", async () => {
  const stateStore = new MemoryStateStore();
  await seedGraduation(stateStore);
  await putClaim(stateStore, {
    id: "aged-out",
    claimedAt: "2026-08-11T12:00:00.000Z",
    rewardAmount: 1.2
  });

  const before = await makePolicy({
    stateStore,
    now: () => new Date("2026-08-12T11:59:59.999Z")
  }).evaluate({ wallet: WALLET, job: job(), claimEconomics: economics() });
  const boundary = await makePolicy({
    stateStore,
    now: () => new Date("2026-08-12T12:00:00.000Z")
  }).evaluate({ wallet: WALLET, job: job(), claimEconomics: economics() });

  assert.equal(before.eligible, false);
  assert.equal(before.retryAfter, "2026-08-12T12:00:00.000Z");
  assert.equal(boundary.eligible, true);
  assert.equal(boundary.dailyExposureUsed, 0);
});

test("established zero base is a kill-switch and exact-budget boundary remains eligible", async () => {
  const stateStore = new MemoryStateStore();
  await seedGraduation(stateStore);
  const zero = await makePolicy({ stateStore, budgetRaw: 0 }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });
  const exact = await makePolicy({ stateStore, budgetRaw: 309_000 }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });

  assert.equal(zero.eligible, false);
  assert.equal(zero.reason, DAILY_EXPOSURE_BUDGET_REACHED_REASON);
  assert.equal(exact.eligible, true);
  assert.equal(exact.projectedDailyExposureRemaining, 0);
});

test("pre-D0 snapshots count in an established rolling window but not lifetime credit", async () => {
  const stateStore = new MemoryStateStore();
  await seedGraduation(stateStore);
  await stateStore.upsertSession({
    sessionId: "pre-d0-session",
    wallet: WALLET,
    jobId: "pre-d0-job",
    status: "resolved",
    claimedAt: "2026-08-12T08:00:00.000Z",
    jobSnapshot: { definition: job({ id: "pre-d0-job" }) },
    workerExposure: {
      candidate: { reservedRewardUsdc: 1.2, brokeredGasUsdc: 0.059, totalUsdc: 1.259 }
    }
  });

  const decision = await makePolicy({ stateStore }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });

  assert.equal(decision.eligible, false);
  assert.equal(decision.dailyExposureUsedRaw, "1259000");
});
