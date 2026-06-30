import test from "node:test";
import assert from "node:assert/strict";

import { planRewardBankTopup, parseArgs } from "./auto-topup-reward-bank.mjs";

// All amounts are USDC base units (6 decimals). 1_000000n = 1 USDC.
const LOW = 20_000000n;
const TARGET = 100_000000n;
const MAX = 100_000000n;

test("no top-up when liquid is at or above the low-water mark", () => {
  const plan = planRewardBankTopup({ liquidNow: 50_000000n, lowWaterMark: LOW, targetLevel: TARGET, maxPerTopup: MAX, walletAvailable: 500_000000n });
  assert.equal(plan.shouldTopup, false);
  assert.equal(plan.amount, 0n);
  assert.equal(plan.treasuryLow, false);
});

test("refills toward target when below the low-water mark", () => {
  const plan = planRewardBankTopup({ liquidNow: 10_000000n, lowWaterMark: LOW, targetLevel: TARGET, maxPerTopup: MAX, walletAvailable: 500_000000n });
  assert.equal(plan.shouldTopup, true);
  assert.equal(plan.amount, 90_000000n); // 100 target - 10 current
  assert.equal(plan.treasuryLow, false);
});

test("bounded by max-per-topup", () => {
  const plan = planRewardBankTopup({ liquidNow: 10_000000n, lowWaterMark: LOW, targetLevel: TARGET, maxPerTopup: 50_000000n, walletAvailable: 500_000000n });
  assert.equal(plan.amount, 50_000000n); // capped at 50, not the 90 desired
});

test("bounded by the wallet float, and flags treasuryLow when the float can't cover", () => {
  const plan = planRewardBankTopup({ liquidNow: 10_000000n, lowWaterMark: LOW, targetLevel: TARGET, maxPerTopup: MAX, walletAvailable: 30_000000n });
  assert.equal(plan.shouldTopup, true);
  assert.equal(plan.amount, 30_000000n); // only what the float holds
  assert.equal(plan.treasuryLow, true); // 30 < 90 desired → page a human
});

test("empty float → no top-up but treasuryLow alert", () => {
  const plan = planRewardBankTopup({ liquidNow: 5_000000n, lowWaterMark: LOW, targetLevel: TARGET, maxPerTopup: MAX, walletAvailable: 0n });
  assert.equal(plan.shouldTopup, false);
  assert.equal(plan.amount, 0n);
  assert.equal(plan.treasuryLow, true);
});

test("rejects a target at/below the low-water mark (misconfig)", () => {
  assert.throws(() => planRewardBankTopup({ liquidNow: 0n, lowWaterMark: 100n, targetLevel: 100n, maxPerTopup: 100n, walletAvailable: 100n }));
});

test("parseArgs: dry-run is the default; --commit flips it", () => {
  assert.equal(parseArgs([]).dryRun, true);
  assert.equal(parseArgs(["--commit"]).dryRun, false);
  assert.equal(parseArgs(["--use-kms"]).useKms, true);
  assert.equal(parseArgs(["--target", "5"]).target, "5");
  assert.throws(() => parseArgs(["--bogus"]));
});
