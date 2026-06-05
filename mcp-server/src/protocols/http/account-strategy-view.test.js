import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAccountStrategiesView,
  buildLiveStrategyAllocationByAsset,
  resolveStrategyAssetSymbol
} from "./account-strategy-view.js";

const GATEWAY = {
  isEnabled: () => true,
  config: {
    supportedAssets: [
      { address: "0x0000000000000000000000000000000000000abc", symbol: "USDC" },
      { address: "0x0000000000000000000000000000000000000def", symbol: "DOT" }
    ]
  }
};

test("buildLiveStrategyAllocationByAsset groups live value by resolved asset symbol", () => {
  const allocation = buildLiveStrategyAllocationByAsset({
    gateway: GATEWAY,
    strategies: [
      { strategyId: "a", asset: "0x0000000000000000000000000000000000000abc" },
      { strategyId: "b", asset: "0x0000000000000000000000000000000000000abc" },
      { strategyId: "c", asset: "0x0000000000000000000000000000000000000def" }
    ],
    strategyPositions: [
      { strategyId: "a", shares: 5 },
      { strategyId: "b", shares: 7 },
      { strategyId: "c", shares: 3 }
    ],
    strategyTelemetry: [
      { strategyId: "a", reported: true, sharePrice: 2 },
      { strategyId: "b", reported: false, sharePrice: 99 },
      { strategyId: "c", reported: true, sharePrice: 4 }
    ]
  });

  assert.deepEqual(allocation, {
    USDC: 17,
    DOT: 12
  });
});

test("resolveStrategyAssetSymbol prefers explicit strategy asset metadata", () => {
  assert.equal(resolveStrategyAssetSymbol(GATEWAY, {
    asset: "0x0000000000000000000000000000000000000abc",
    assetConfig: { symbol: "vUSDC" }
  }), "vUSDC");

  assert.equal(resolveStrategyAssetSymbol(GATEWAY, {
    asset: "0x0000000000000000000000000000000000000abc"
  }), "USDC");
});

test("buildAccountStrategiesView assembles strategy positions, summary, and normalized timeline", async () => {
  const calls = [];
  const gateway = {
    ...GATEWAY,
    getStrategyTelemetry: async () => {
      calls.push(["getStrategyTelemetry"]);
      return [{
        strategyId: "default-low-risk",
        reported: true,
        sharePrice: 2,
        performanceBps: 15,
        totalAssets: 20,
        totalAssetsRaw: "20000000",
        totalShares: 10,
        totalSharesRaw: "10000000",
        riskLabel: "low"
      }];
    },
    getStrategyPositions: async (wallet) => {
      calls.push(["getStrategyPositions", wallet]);
      return [{
        strategyId: "default-low-risk",
        shares: 3,
        sharesRaw: "3000000",
        pendingDepositAssets: 1,
        pendingDepositAssetsRaw: "1000000",
        pendingWithdrawalShares: 0
      }];
    }
  };
  const service = {
    recordStrategySnapshots: async (wallet, snapshots) => {
      calls.push(["recordStrategySnapshots", { wallet, snapshots }]);
      return [{
        id: "timeline-1",
        amountRaw: "120000",
        realizedYieldDeltaRaw: "3000",
        requestedSharesRaw: 100n,
        at: "2026-06-06T10:00:00.000Z"
      }];
    }
  };

  const view = await buildAccountStrategiesView({
    wallet: "0xabc",
    account: {
      liquid: { DOT: 10 },
      debtOutstanding: { DOT: 2 },
      strategyShares: {},
      strategyPending: {},
      strategyActivity: {
        "default-low-risk": { action: "allocated", at: "2026-06-01T00:00:00.000Z" }
      },
      strategyAccounting: {
        "default-low-risk": {
          principal: 5,
          principalRaw: "5000000",
          realizedYield: 1,
          realizedYieldRaw: "1000000"
        }
      }
    },
    borrowCapacity: 0,
    gateway,
    service,
    strategies: [{
      strategyId: "default-low-risk",
      asset: "0x0000000000000000000000000000000000000abc",
      riskLabel: "medium"
    }]
  });

  assert.equal(view.wallet, "0xabc");
  assert.deepEqual(view.summary, {
    treasuryBase: 16,
    liquid: 10,
    allocated: 6,
    principal: 5,
    unrealizedYield: 1,
    realizedYield: 1,
    totalYield: 2,
    debt: 2,
    borrowCapacity: 0,
    deployedLanes: 1,
    attentionCount: 1
  });
  assert.equal(view.positions[0].assetSymbol, "USDC");
  assert.equal(view.positions[0].routedAmount, 6);
  assert.equal(view.positions[0].routedAmountRaw, "6000000");
  assert.equal(view.positions[0].statusLabel, "Pending deposit");
  assert.equal(view.positions[0].yieldStatus, "live");
  assert.equal(view.positions[0].attention.code, "credit_constrained");
  assert.deepEqual(view.timeline[0], {
    id: "timeline-1",
    type: "treasury_event",
    strategyId: undefined,
    asset: "DOT",
    amount: 0,
    amountRaw: "120000",
    yieldDelta: 0,
    realizedYieldDeltaRaw: "3000",
    requestedSharesRaw: "100",
    at: "2026-06-06T10:00:00.000Z"
  });
  assert.deepEqual(calls, [
    ["getStrategyTelemetry"],
    ["getStrategyPositions", "0xabc"],
    ["recordStrategySnapshots", {
      wallet: "0xabc",
      snapshots: [{
        strategyId: "default-low-risk",
        asset: "0x0000000000000000000000000000000000000abc",
        assetSymbol: "USDC",
        shares: 3,
        currentValue: 6,
        currentValueRaw: "6000000",
        sharePrice: 2
      }]
    }]
  ]);
});
