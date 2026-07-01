import test from "node:test";
import assert from "node:assert/strict";

import { computeClaimEconomics } from "./claim-economics.js";

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
