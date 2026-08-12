import test from "node:test";
import assert from "node:assert/strict";

import {
  DAILY_EXPOSURE_BUDGET_REACHED_REASON,
  DEFAULT_WORKER_DAILY_EXPOSURE_BUDGET_RAW,
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
  now = () => new Date("2026-08-12T12:00:00.000Z"),
  resolveBudget
} = {}) {
  const workerExposurePolicy = new WorkerExposurePolicy({
    stateStore,
    gasEstimateUsdc: 0.059,
    capUsdc: 100
  });
  return new WorkerDailyExposurePolicy({
    stateStore,
    workerExposurePolicy,
    resolveBudget: resolveBudget ?? (() => budgetRaw),
    now
  });
}

async function putClaim(stateStore, {
  id,
  claimedAt,
  rewardAmount = 0.25,
  status = "resolved"
}) {
  const reservedRewardUsdc = rewardAmount;
  const brokeredGasUsdc = 0.059;
  await stateStore.upsertSession({
    sessionId: id,
    wallet: WALLET,
    jobId: `${id}-job`,
    status,
    claimedAt,
    dailyExposure: {
      version: "worker-daily-exposure-v1",
      candidate: {
        reservedRewardUsdc,
        brokeredGasUsdc,
        totalUsdc: Number((reservedRewardUsdc + brokeredGasUsdc).toFixed(6))
      }
    }
  });
}

test("daily exposure config has a finite raw-unit default, accepts zero, and respects overrides", () => {
  assert.deepEqual(loadWorkerDailyExposureConfig({}), { budgetRaw: 1_500_000 });
  assert.deepEqual(loadWorkerDailyExposureConfig({ WORKER_DAILY_EXPOSURE_BUDGET_RAW: "0" }), { budgetRaw: 0 });
  assert.deepEqual(
    loadWorkerDailyExposureConfig({ WORKER_DAILY_EXPOSURE_BUDGET_RAW: "2250000" }),
    { budgetRaw: 2_250_000 }
  );
  assert.throws(
    () => loadWorkerDailyExposureConfig({ WORKER_DAILY_EXPOSURE_BUDGET_RAW: "1.5" }),
    /must be a non-negative integer/u
  );
});

test("resolveDailyExposureBudget is a wallet-aware flat-budget tier-3 hook", () => {
  assert.equal(resolveDailyExposureBudget(WALLET), 1_500_000n);
  assert.equal(resolveDailyExposureBudget(WALLET, { budgetRaw: 2_000_000 }), 2_000_000n);
});

test("42-claim morning replay is refused on the fifth typical claim with the oldest age-out", async () => {
  const stateStore = new MemoryStateStore();
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
  assert.equal(refusal.decision.dailyExposureRemaining, 0.264);
  assert.equal(refusal.decision.projectedDailyExposure, 1.545);
  assert.equal(refusal.decision.retryAfter, "2026-08-13T06:00:00.000Z");
  assert.equal(refusal.decision.retryAfterSeconds, 23 * 60 * 60 + 20 * 60);
});

test("fast settlement and rejection do not refund rolling daily exposure", async () => {
  const stateStore = new MemoryStateStore();
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

test("claim spend ages out at exactly 24 hours", async () => {
  const stateStore = new MemoryStateStore();
  const claimedAt = "2026-08-11T12:00:00.000Z";
  await putClaim(stateStore, { id: "aged-out", claimedAt, rewardAmount: 1.2 });

  const before = await makePolicy({
    stateStore,
    now: () => new Date("2026-08-12T11:59:59.999Z")
  }).evaluate({ wallet: WALLET, job: job(), claimEconomics: economics() });
  const atBoundary = await makePolicy({
    stateStore,
    now: () => new Date("2026-08-12T12:00:00.000Z")
  }).evaluate({ wallet: WALLET, job: job(), claimEconomics: economics() });

  assert.equal(before.eligible, false);
  assert.equal(before.retryAfter, "2026-08-12T12:00:00.000Z");
  assert.equal(atBoundary.eligible, true);
  assert.equal(atBoundary.dailyExposureUsed, 0);
});

test("configured zero is a kill-switch and exact-budget boundary remains eligible", async () => {
  const zero = await makePolicy({ budgetRaw: 0 }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });
  const exact = await makePolicy({ budgetRaw: 309_000 }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });
  const zeroExposure = await makePolicy({ budgetRaw: 0 }).evaluate({
    wallet: WALLET,
    job: job({ rewardAmount: 0 }),
    claimEconomics: economics({
      claimEconomicsWaived: false,
      claimFeeRetainedOnSuccess: true
    })
  });

  assert.equal(zero.eligible, false);
  assert.equal(zero.reason, DAILY_EXPOSURE_BUDGET_REACHED_REASON);
  assert.equal(zero.dailyExposureRemaining, 0);
  assert.equal(zeroExposure.eligible, false);
  assert.equal(exact.eligible, true);
  assert.equal(exact.projectedDailyExposureRemaining, 0);
});

test("mixed job sizes consume reserved reward plus brokered gas, not a claim count", async () => {
  const decision = await makePolicy().evaluate({
    wallet: WALLET,
    job: job({ rewardAmount: 0.5 }),
    claimEconomics: economics()
  });

  assert.deepEqual(decision.candidate, {
    reservedRewardUsdc: 0.5,
    brokeredGasUsdc: 0.059,
    totalUsdc: 0.559
  });
  assert.equal(decision.candidateExposureRaw, "559000");
});

test("pre-deploy worker exposure snapshots count in the current window after restart", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession({
    sessionId: "pre-deploy-session",
    wallet: WALLET,
    jobId: "pre-deploy-job",
    status: "resolved",
    claimedAt: "2026-08-12T08:00:00.000Z",
    workerExposure: {
      candidate: {
        reservedRewardUsdc: 1.2,
        brokeredGasUsdc: 0.059,
        totalUsdc: 1.259
      }
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

test("one hosted canary claim on an ephemeral wallet remains below the default budget", async () => {
  const decision = await makePolicy().evaluate({
    wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    job: job({ id: "worker-canary-1786453506586" }),
    claimEconomics: economics()
  });

  assert.equal(decision.eligible, true);
  assert.equal(decision.projectedDailyExposure, 0.309);
  assert.equal(decision.projectedDailyExposureRemaining, 1.191);
});

test("the budget resolver is called per wallet", async () => {
  const resolved = [];
  const decision = await makePolicy({
    resolveBudget: (wallet) => {
      resolved.push(wallet);
      return wallet === WALLET ? 1_000_000 : 0;
    }
  }).evaluate({ wallet: WALLET, job: job(), claimEconomics: economics() });

  assert.deepEqual(resolved, [WALLET]);
  assert.equal(decision.dailyExposureBudgetRaw, "1000000");
});
