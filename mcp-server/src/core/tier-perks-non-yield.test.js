import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStateStore } from "./state-store.js";
import {
  NON_YIELD_TIER_PERKS_ENABLED_ENV,
  createNonYieldTierPerksPolicy,
  loadNonYieldTierPerksConfig
} from "./tier-perks-non-yield.js";
import { WorkerExposurePolicy } from "./worker-exposure.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FLOOR_RAW = "2500000";
const TIERS = ["flex", "t7", "t30", "t90"];

function harness({ tier = "flex", bankRaw = "50000000", readable = true, enabled = true } = {}) {
  let currentTier = tier;
  let currentBankRaw = bankRaw;
  let bankReadable = readable;
  let tierReads = 0;
  const policy = createNonYieldTierPerksPolicy({
    config: { enabled },
    getTierState: async () => {
      tierReads += 1;
      return {
        tier: currentTier,
        perksActive: currentTier !== "flex"
      };
    },
    getRewardBankHealth: async () => ({
      readable: bankReadable,
      liquidRaw: currentBankRaw,
      stale: false
    }),
    logger: {}
  });
  return {
    policy,
    setTier(value) { currentTier = value; },
    setBank(value) { currentBankRaw = value; },
    setReadable(value) { bankReadable = value; },
    tierReads: () => tierReads
  };
}

async function resultFor(tier, bankRaw = "50000000") {
  return harness({ tier, bankRaw }).policy.forWallet(WALLET, {
    defaultOpenExposureCapRaw: FLOOR_RAW
  });
}

test("tier-perk cap floor holds at a zero reward bank and the enforced cap never shrinks", async () => {
  for (const tier of TIERS) {
    const h = harness({ tier, bankRaw: "50000000" });
    const exposure = workerExposure(h.policy);
    const funded = await exposure.capacityForWallet(WALLET);
    h.setBank("0"); // Mutation: only the live reward-bank balance changes.
    const empty = await exposure.capacityForWallet(WALLET);
    assert.equal(empty.baseOpenExposureCapRaw, FLOOR_RAW, tier);
    assert.equal(empty.openExposureCapRaw, FLOOR_RAW, tier);
    assert.ok(BigInt(funded.openExposureCapRaw) >= BigInt(empty.openExposureCapRaw), tier);
  }
  const h = harness({ tier: "t90", bankRaw: "0" });
  const vestedWorker = new WorkerExposurePolicy({
    stateStore: new MemoryStateStore(),
    gasEstimateUsdc: 0.059,
    capUsdc: 2.5,
    resolveVesting: async () => ({ vestedRaw: 10_000_000n, tranches: [], available: true }),
    tierPerksPolicy: h.policy,
    logger: {}
  });
  assert.equal((await vestedWorker.capacityForWallet(WALLET)).openExposureCapRaw, "4000000");
});

test("tier-perk unreadable reward bank fails closed to the fixed default", async () => {
  const h = harness({ tier: "t90", bankRaw: "999999999", readable: false });
  const result = await h.policy.forWallet(WALLET, { defaultOpenExposureCapRaw: FLOOR_RAW });
  assert.equal(result.exposure.bankReadable, false);
  assert.equal(result.exposure.rewardBankLiquidRaw, null);
  assert.equal(result.exposure.resolvedOpenExposureCapRaw, FLOOR_RAW);
  assert.equal(result.exposure.basis, "fixed_default_floor");
});

test("tier-perk credit qualification begins at 30 days and 90 days carries the better-terms class", async () => {
  const states = Object.fromEntries(await Promise.all(TIERS.map(async (tier) => [tier, await resultFor(tier)])));
  assert.equal(states.flex.creditQualification.qualified, false);
  assert.equal(states.t7.creditQualification.qualified, false);
  assert.deepEqual(states.t30.creditQualification, {
    qualified: true,
    termsClass: "standard",
    basis: "active_locked_balance_commitment_plus_settlement_history",
    fundsAtRisk: "operator_underwritten",
    seizurePath: "none"
  });
  assert.equal(states.t90.creditQualification.qualified, true);
  assert.equal(states.t90.creditQualification.termsClass, "better_terms");
});

test("tier-perk surfaces never advertise bond relief, a reduced bond, or a waived bond", async () => {
  const rendered = JSON.stringify(await Promise.all(TIERS.map((tier) => resultFor(tier))));
  assert.doesNotMatch(rendered, /bond relief|reduced bond|waived bond/iu);
});

test("tier-perk surfaces describe locked balance only as a qualification signal", async () => {
  const rendered = JSON.stringify(await Promise.all(TIERS.map((tier) => resultFor(tier))));
  assert.doesNotMatch(rendered, /\b(?:collateral|security|backing)\b/iu);
  assert.match(rendered, /qualification signal/iu);
  assert.match(rendered, /no seizure path/iu);
});

test("tier-perk policy re-reads the live tier at every use and never caches an exited commitment", async () => {
  const h = harness({ tier: "t90", bankRaw: "50000000" });
  const before = await h.policy.forWallet(WALLET, { defaultOpenExposureCapRaw: FLOOR_RAW });
  h.setTier("flex"); // Mutation: the live tier changes without rebuilding the policy.
  const after = await h.policy.forWallet(WALLET, { defaultOpenExposureCapRaw: FLOOR_RAW });
  assert.equal(before.tier, "t90");
  assert.equal(before.exposure.resolvedOpenExposureCapRaw, "10000000");
  assert.equal(after.tier, "flex");
  assert.equal(after.exposure.resolvedOpenExposureCapRaw, FLOOR_RAW);
  assert.equal(h.tierReads(), 2);
});

test("tier-perk flag defaults off and leaves worker exposure byte-identical", async () => {
  assert.deepEqual(loadNonYieldTierPerksConfig({}), { enabled: false });
  assert.equal(NON_YIELD_TIER_PERKS_ENABLED_ENV, "NON_YIELD_TIER_PERKS_ENABLED");
  const disabled = harness({ tier: "t90", bankRaw: "50000000", enabled: false }).policy;
  const baseline = await workerExposure().capacityForWallet(WALLET);
  const dark = await workerExposure(disabled).capacityForWallet(WALLET);
  assert.deepEqual(dark, baseline);
  assert.equal(Object.hasOwn(dark, "tierPerks"), false);
});

test("tier-perk cap table resolves exactly at 12 and 50 USDC", async () => {
  const expectedAt12 = ["2500000", "2500000", "2500000", "2500000"];
  const expectedAt50 = ["2500000", "5000000", "7500000", "10000000"];
  for (const [index, tier] of TIERS.entries()) {
    assert.equal((await resultFor(tier, "12000000")).exposure.resolvedOpenExposureCapRaw, expectedAt12[index]);
    assert.equal((await resultFor(tier, "50000000")).exposure.resolvedOpenExposureCapRaw, expectedAt50[index]);
  }

  const t90 = harness({ tier: "t90", bankRaw: "50000000" });
  const existingVestedRaise = new WorkerExposurePolicy({
    stateStore: new MemoryStateStore(),
    gasEstimateUsdc: 0.059,
    capUsdc: 2.5,
    resolveVesting: async () => ({ vestedRaw: 10_000_000n, tranches: [], available: true }),
    tierPerksPolicy: t90.policy,
    logger: {}
  });
  const capacity = await existingVestedRaise.capacityForWallet(WALLET);
  assert.equal(capacity.openExposureCapRaw, "10000000");
  assert.equal(capacity.openExposureRaiseRaw, "0");
});

function workerExposure(tierPerksPolicy = undefined) {
  return new WorkerExposurePolicy({
    stateStore: new MemoryStateStore(),
    gasEstimateUsdc: 0.059,
    capUsdc: 2.5,
    resolveVesting: async () => ({ vestedRaw: 0n, tranches: [], available: true }),
    tierPerksPolicy,
    logger: {}
  });
}
