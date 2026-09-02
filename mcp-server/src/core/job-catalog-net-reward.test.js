import test from "node:test";
import assert from "node:assert/strict";

import { JobCatalogService } from "./job-catalog-service.js";

const WALLET = "0xworker";

function makeService(jobs) {
  const profiles = new Map();
  // A low-risk worker on an elite job is what arms the risk haircut.
  profiles.set(WALLET, { wallet: WALLET, preferredRiskLevel: "low" });
  const svc = new JobCatalogService(
    jobs,
    profiles,
    async () => ({}),
    async () => ({}),
    async () => 0
  );
  return svc;
}

test("a USDC reward is NOT docked the native-gas haircut (invariant-9)", async () => {
  const svc = makeService([
    { id: "usdc", rewardAmount: 0.2, rewardAsset: "USDC", tier: "elite", requiresSponsoredGas: false }
  ]);
  // Pre-fix this returned max(0.2 - 0.5 - 5, 0) = 0 — the reward vanished.
  assert.equal(await svc.estimateNetReward(WALLET, "usdc"), 0.2);
});

test("a DOT reward still takes the gas + risk haircut", async () => {
  const svc = makeService([
    { id: "dot", rewardAmount: 50, rewardAsset: "DOT", tier: "elite", requiresSponsoredGas: false }
  ]);
  assert.equal(await svc.estimateNetReward(WALLET, "dot"), 50 - 0.5 - 5);
});

test("a sponsored-gas DOT reward takes only the risk haircut", async () => {
  const svc = makeService([
    { id: "dot2", rewardAmount: 50, rewardAsset: "DOT", tier: "elite", requiresSponsoredGas: true }
  ]);
  assert.equal(await svc.estimateNetReward(WALLET, "dot2"), 50 - 5);
});

test("a non-native reward defaults (undefined asset → USDC) take no haircut", async () => {
  const svc = makeService([
    { id: "def", rewardAmount: 3, tier: "elite", requiresSponsoredGas: false }
  ]);
  assert.equal(await svc.estimateNetReward(WALLET, "def"), 3);
});

test("E-17: the native-gas haircut nets exactly in base units (no float drift)", async () => {
  const svc = makeService([
    // pro tier ⇒ no risk haircut, so only the 0.5 gas haircut applies.
    { id: "drift", rewardAmount: 0.6, rewardAsset: "DOT", tier: "pro", requiresSponsoredGas: false }
  ]);
  // Pre-fix, `0.6 - 0.5` evaluates to 0.09999999999999998 — a different double
  // than 0.1. Netting in integer base units returns exactly 0.1.
  assert.equal(await svc.estimateNetReward(WALLET, "drift"), 0.1);
});
