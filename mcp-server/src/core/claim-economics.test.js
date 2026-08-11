import test from "node:test";
import assert from "node:assert/strict";

import {
  OnboardingSubsidyBudget,
  computeClaimEconomics,
  loadOnboardingSubsidyBudgetConfig
} from "./claim-economics.js";
import { MemoryStateStore } from "./state-store.js";

test("nice values reproduce the historical Number math exactly", () => {
  const e = computeClaimEconomics({
    rewardAmount: 5.5,
    rewardAsset: "USDC",
    claimStakeBps: 500,
    claimFeeBps: 200
  });
  assert.equal(e.claimStake, 0.275); // 5.5 * 500 / 10000
  assert.equal(e.claimFee, 0.11); //    5.5 * 200 / 10000  (> 0.05 min)
  assert.equal(e.totalClaimLock, 0.385);
  assert.equal(e.totalClaimLock, e.claimStake + e.claimFee);
});

test("E-17: bps math is exact in base units, not IEEE-754", () => {
  // Pre-fix, `0.1 * 500 / 10000` evaluates to 0.005000000000000001 — a
  // different double than 0.005 — and that drift leaked into the projection
  // ledger and API payloads. Doing the bps math in integer base units at the
  // asset's precision (DOT = 18 decimals, the drift-prone case) yields exactly
  // 0.005 / 0.055.
  const e = computeClaimEconomics({
    rewardAmount: 0.1,
    rewardAsset: "DOT",
    claimStakeBps: 500,
    claimFeeBps: 200
  });
  assert.equal(e.claimStake, 0.005);
  assert.equal(e.claimFee, 0.05); // 0.1 * 200 / 10000 = 0.002 → floored to the 0.05 min
  assert.equal(e.totalClaimLock, 0.055);
});

test("claim fee floors at the per-asset minimum", () => {
  const e = computeClaimEconomics({
    rewardAmount: 1,
    rewardAsset: "USDC",
    claimStakeBps: 500,
    claimFeeBps: 200
  });
  assert.equal(e.claimStake, 0.05); // 1 * 500 / 10000
  assert.equal(e.claimFee, 0.05); //   1 * 200 / 10000 = 0.02 < 0.05 min → floored
  assert.equal(e.totalClaimLock, 0.1);
});

test("waived claims lock nothing", () => {
  const e = computeClaimEconomics({
    rewardAmount: 5,
    rewardAsset: "USDC",
    onboardingWaiverEligible: true,
    priorClaimCount: 0
  });
  assert.equal(e.claimEconomicsWaived, true);
  assert.equal(e.claimStake, 0);
  assert.equal(e.claimFee, 0);
  assert.equal(e.totalClaimLock, 0);
});

test("an over-precise reward falls back to the legacy path instead of throwing", () => {
  // 7 fractional digits on a 6-decimal asset can't be represented exactly. The
  // projection must still produce a finite number and never throw (preserving
  // the pre-fix behaviour for malformed inputs).
  let e;
  assert.doesNotThrow(() => {
    e = computeClaimEconomics({
      rewardAmount: 5.1234567,
      rewardAsset: "USDC",
      claimStakeBps: 500,
      claimFeeBps: 200
    });
  });
  assert.ok(Number.isFinite(e.claimStake));
  assert.ok(Number.isFinite(e.claimFee));
  assert.equal(e.totalClaimLock, e.claimStake + e.claimFee);
});

test("onboarding subsidy allocation includes the waived claim stake and brokered gas estimate", async () => {
  const budget = new OnboardingSubsidyBudget({
    stateStore: new MemoryStateStore(),
    dailyBudgetUsdc: 2,
    gasEstimateUsdc: 0.059,
    now: () => new Date("2026-08-11T12:00:00.000Z")
  });

  const before = await budget.inspect({ rewardAsset: "USDC", waivedClaimStake: 0.1 });
  const reserved = await budget.reserve({
    reservationId: "session-1",
    estimatedClaimSubsidyUsdc: before.estimatedClaimSubsidyUsdc
  });

  assert.equal(before.waivedClaimStakeUsdc, 0.1);
  assert.equal(before.brokeredGasEstimateUsdc, 0.059);
  assert.equal(before.estimatedClaimSubsidyUsdc, 0.159);
  assert.equal(reserved.accepted, true);
  assert.equal(reserved.allocatedUsdc, 0.159);
  assert.equal(reserved.headroomUsdc, 1.841);
  assert.equal(reserved.clock, "UTC");
  assert.equal(reserved.resetAt, "2026-08-12T00:00:00.000Z");
});

test("onboarding subsidy status resets at UTC midnight without a wallet-scoped allowance", async () => {
  let current = new Date("2026-08-11T23:59:59.000Z");
  const budget = new OnboardingSubsidyBudget({
    stateStore: new MemoryStateStore(),
    dailyBudgetUsdc: 0.159,
    gasEstimateUsdc: 0.059,
    now: () => current
  });
  const estimate = await budget.inspect({ rewardAsset: "USDC", waivedClaimStake: 0.1 });
  await budget.reserve({
    reservationId: "wallet-a:job-1",
    estimatedClaimSubsidyUsdc: estimate.estimatedClaimSubsidyUsdc
  });
  assert.equal((await budget.getStatus()).headroomUsdc, 0);

  current = new Date("2026-08-12T00:00:00.000Z");
  const reset = await budget.getStatus();
  assert.equal(reset.day, "2026-08-12");
  assert.equal(reset.allocatedUsdc, 0);
  assert.equal(reset.headroomUsdc, 0.159);
  assert.equal(reset.resetAt, "2026-08-13T00:00:00.000Z");
});

test("onboarding subsidy config has a finite default and rejects malformed overrides", () => {
  assert.deepEqual(loadOnboardingSubsidyBudgetConfig({}), {
    dailyBudgetUsdc: 8,
    gasEstimateUsdc: 0.059
  });
  assert.throws(
    () => loadOnboardingSubsidyBudgetConfig({ ONBOARDING_SUBSIDY_DAILY_BUDGET_USDC: "unbounded" }),
    /ONBOARDING_SUBSIDY_DAILY_BUDGET_USDC must be a non-negative number/u
  );
});
