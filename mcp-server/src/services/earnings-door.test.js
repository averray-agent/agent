import assert from "node:assert/strict";
import test from "node:test";

import { Interface } from "ethers";

import { AGENT_ACCOUNT_ABI, ERC20_MOCK_ABI } from "../blockchain/abis.js";
import { EARNINGS_WITHDRAWAL_STATEMENT } from "../core/earnings-door-copy.js";
import { CREDIT_INTEREST_STATEMENT } from "../core/worker-progression.js";
import {
  EarningsDoorService,
  WITHDRAWAL_STANDING_STATEMENT
} from "./earnings-door.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const DESTINATION = "0x2222222222222222222222222222222222222222";
const ACCOUNT = "0x3333333333333333333333333333333333333333";
const USDC = "0x0000053900000000000000000000000001200000";

function harness({
  liquidRaw = "1250000",
  nativeBalance = 30_000_000_000_000_000n,
  gasGrantService = undefined,
  workerClaimCount = 0,
  progression = {
    tier: "starter",
    badges: [],
    creditInterest: { eligible: false, registered: false }
  },
  reputation = { skill: 0, reliability: 0, economic: 0, tier: "starter" }
} = {}) {
  const capacityCalls = [];
  const gateway = {
    isEnabled: () => true,
    async getAccountPosition(wallet, asset) {
      assert.equal(wallet, WALLET);
      assert.equal(asset, "USDC");
      return {
        wallet,
        asset: { symbol: "USDC", address: USDC, decimals: 6, assetClass: "trust_backed", assetId: 1337 },
        source: { contract: "AgentAccountCore", address: ACCOUNT, method: "positions", field: "liquid" },
        position: {
          liquid: Number(liquidRaw) / 1_000_000,
          liquidRaw,
          jobStakeLocked: 0.2,
          jobStakeLockedRaw: "200000"
        }
      };
    },
    async getWorkerClaimCount(wallet) {
      assert.equal(wallet, WALLET);
      return workerClaimCount;
    }
  };
  const stateStore = {
    async listSessionsByWallet(wallet, _limit, offset) {
      assert.equal(wallet, WALLET);
      if (offset > 0) return [];
      return [{
        sessionId: "session-1",
        jobId: "job-1",
        resolvedAt: "2026-08-12T12:00:00.000Z",
        jobSnapshot: { definition: { rewardAsset: "USDC" } },
        payoutTx: {
          txHash: `0x${"a".repeat(64)}`,
          blockNumber: 19_000_001,
          status: 1,
          settlement: {
            asset: USDC,
            assetSymbol: "USDC",
            workerAmountRaw: "380000",
            protocolFeeAmountRaw: "20000"
          }
        }
      }];
    }
  };
  const eventBus = {
    async replayDurable(filter) {
      assert.equal(filter.wallet, WALLET);
      return {
        events: [{
          topic: "account.job_stake_locked",
          wallet: WALLET,
          data: { asset: USDC, amount: "200000" },
          sessionId: "session-open",
          jobId: "job-open",
          txHash: `0x${"b".repeat(64)}`,
          blockNumber: 19_000_002,
          timestamp: "2026-08-12T12:01:00.000Z"
        }, {
          topic: "account.job_stake_released",
          wallet: WALLET,
          data: { asset: USDC, amount: "100000" },
          sessionId: "session-prior",
          jobId: "job-prior",
          txHash: `0x${"c".repeat(64)}`,
          blockNumber: 19_000_004,
          timestamp: "2026-08-12T12:02:00.000Z"
        }]
      };
    }
  };
  const workerExposurePolicy = {
    async capacityForWallet(wallet, options = {}) {
      assert.equal(wallet, WALLET);
      capacityCalls.push(options);
      const additional = BigInt(options.additionalVestedRaw ?? 0);
      return {
        vestedAssetsRaw: (2_000_000n + additional).toString(),
        openExposureRaiseRaw: additional > 0n ? "1000000" : "500000",
        openExposureCapRaw: additional > 0n ? "3500000" : "3000000",
        externalRewardCeilingRaw: (3_000_000n + additional).toString(),
        vestingHours: 48,
        vestingAvailable: true,
        tranches: []
      };
    }
  };
  const chainReader = {
    async gasQuote(transaction, wallet) {
      assert.equal(transaction.from, WALLET);
      assert.equal(wallet, WALLET);
      return {
        gas: 50_000n,
        unitPrice: 500_000_000_000n,
        nativeBalance,
        blockNumber: 19_000_003
      };
    }
  };
  return {
    capacityCalls,
    door: new EarningsDoorService({
      agentAccountAddress: ACCOUNT,
      chainId: 420420419,
      rpcUrls: ["https://eth-rpc.polkadot.io"],
      gateway,
      stateStore,
      eventBus,
      workerExposurePolicy,
      workerProgressionService: {
        async getProgression(wallet) {
          assert.equal(wallet, WALLET);
          return progression;
        }
      },
      getReputation: async (wallet) => {
        assert.equal(wallet, WALLET);
        return reputation;
      },
      gasGrantService,
      chainReader
    })
  };
}

test("getAccountPosition is bank-statement shaped with account ownership, receipts, exit, and informational retention", async () => {
  const { door, capacityCalls } = harness();
  const result = await door.getAccount(WALLET, "usdc");

  assert.equal(result.available, true);
  assert.equal(result.account.owner, WALLET);
  assert.deepEqual(result.account.available, { raw: "1250000", decimals: 6, display: "1.25" });
  assert.deepEqual(result.account.stakedOnOpenWork, { raw: "200000", decimals: 6, display: "0.2" });
  assert.deepEqual(result.account.statement.map(({ type }) => type), ["stake_released", "stake_locked", "earnings_in"]);
  assert.equal(result.account.statement[2].txHash, `0x${"a".repeat(64)}`);
  assert.equal(result.ownershipProof.address, ACCOUNT);
  assert.equal(result.ownershipProof.method, "positions(address,address)");
  assert.equal(result.withdrawal.statement, EARNINGS_WITHDRAWAL_STATEMENT);
  assert.equal(result.withdrawal.http.path, "/account/withdraw/transactions");
  assert.equal(result.whatYourBalanceCanDo.retentionNotGates.conditionsWithdrawal, false);
  assert.equal(result.whatYourBalanceCanDo.retentionNotGates.templatesRemainComplete, true);
  assert.equal(Object.hasOwn(result.whatYourBalanceCanDo, "borrow"), false, "L1 borrowing must not be advertised");
  assert.deepEqual(capacityCalls, [{}, { additionalVestedRaw: "1250000" }]);
  assert.equal(JSON.stringify(result).includes('"position"'), false, "agent response must not frame the account as a position");
});

test("getAccountPosition plainly offers the first-withdrawal grant and returns named ineligibility reasons", async () => {
  const gasGrantService = {
    async inspect() {
      return {
        eligible: true,
        reason: "first_withdrawal_gas_grant_available",
        offer: "Your first withdrawal's network fee is on us."
      };
    }
  };
  const { door } = harness({ gasGrantService });
  const result = await door.getAccount(WALLET);

  assert.equal(result.withdrawal.gas.firstWithdrawalGrant.eligible, true);
  assert.equal(result.withdrawal.gas.firstWithdrawalGrant.reason, "first_withdrawal_gas_grant_available");
  assert.equal(result.withdrawal.gas.firstWithdrawalGrant.offer, "Your first withdrawal's network fee is on us.");
});

test("buildWithdrawTransactions returns verified AAC withdraw and optional onward transfer without retention gates", async () => {
  const { door } = harness();
  const result = await door.buildWithdrawTransactions(WALLET, {
    asset: "USDC",
    amount: "250000",
    destination: DESTINATION
  });

  assert.equal(result.available, true);
  assert.equal(result.templates.length, 2);
  assert.equal(result.templates[0].to, ACCOUNT);
  assert.equal(result.templates[0].gas.status, "measured");
  assert.equal(result.templates[0].gas.estimatedFee.display, "0.025");
  assert.equal(result.templates[0].gas.sufficient, true);
  assert.equal(result.templates[1].prerequisite, "withdraw_confirmed_on_chain");
  assert.equal(result.whatYourBalanceCanDo.retentionNotGates.delaysWithdrawal, false);
  assert.equal(result.standing.persists, true);
  assert.equal(result.standing.statement, WITHDRAWAL_STANDING_STATEMENT);

  const withdrawal = new Interface(AGENT_ACCOUNT_ABI).decodeFunctionData("withdraw", result.templates[0].data);
  assert.equal(withdrawal.asset, USDC);
  assert.equal(withdrawal.amount, 250000n);
  const transfer = new Interface(ERC20_MOCK_ABI).decodeFunctionData("transfer", result.templates[1].data);
  assert.equal(transfer.to, DESTINATION);
  assert.equal(transfer.amount, 250000n);
});

test("withdrawal standing matches a fresh wallet and omits the ineligible credit-interest line", async () => {
  const { door } = harness();
  const result = await door.buildWithdrawTransactions(WALLET, { amount: "1" });

  assert.deepEqual(result.standing, {
    claimTier: "starter",
    claimTierLabel: "claim tier",
    reputationTier: "apprentice",
    badges: 0,
    waiverSlotsRemaining: 3,
    creditInterest: { eligible: false, registered: false },
    persists: true,
    statement: WITHDRAWAL_STANDING_STATEMENT
  });
  assert.equal(Object.hasOwn(result.standing, "registerPath"), false);
  assert.equal(Object.hasOwn(result.standing, "creditInterestStatement"), false);
});

test("withdrawal standing matches a seasoned wallet's live tiers, badges, waiver use, and registration", async () => {
  const { door } = harness({
    workerClaimCount: 4,
    progression: {
      tier: "elite",
      badges: [{}, {}, {}, {}],
      creditInterest: { eligible: true, registered: true }
    },
    reputation: { skill: 250, reliability: 180, economic: 100, tier: "elite" }
  });
  const result = await door.buildWithdrawTransactions(WALLET, { amount: "1" });

  assert.equal(result.standing.claimTier, "elite");
  assert.equal(result.standing.reputationTier, "expert");
  assert.equal(result.standing.badges, 4);
  assert.equal(result.standing.waiverSlotsRemaining, 0);
  assert.deepEqual(result.standing.creditInterest, { eligible: true, registered: true });
  assert.equal(result.standing.registerPath, "/credit/interest");
});

test("withdrawal standing offers only the ratified line to an eligible unregistered wallet", async () => {
  const { door } = harness({
    workerClaimCount: 2,
    progression: {
      tier: "pro",
      badges: [{}, {}, {}],
      creditInterest: { eligible: true, registered: false }
    },
    reputation: { skill: 125, reliability: 110, economic: 40, tier: "pro" }
  });
  const result = await door.buildWithdrawTransactions(WALLET, { amount: "1" });

  assert.equal(result.standing.claimTier, "pro");
  assert.equal(result.standing.reputationTier, "journeyman");
  assert.equal(result.standing.badges, 3);
  assert.equal(result.standing.waiverSlotsRemaining, 1);
  assert.deepEqual(result.standing.creditInterest, { eligible: true, registered: false });
  assert.equal(result.standing.registerPath, "/credit/interest");
  assert.equal(result.standing.creditInterestStatement, CREDIT_INTEREST_STATEMENT);
});

test("a wallet short of DOT still receives the complete template with an honest insufficient-gas warning", async () => {
  const { door } = harness({ nativeBalance: 1n });
  const result = await door.buildWithdrawTransactions(WALLET, { amount: "1" });
  assert.equal(result.templates.length, 1);
  assert.equal(result.templates[0].gas.sufficient, false);
  assert.match(result.templates[0].gas.acquisition, /acquire DOT/iu);
});

test("buildWithdrawTransactions binds the one-time grant to the authenticated wallet's live withdrawal intent", async () => {
  const calls = [];
  const gasGrantService = {
    async grantForWithdrawalIntent(grantIntent) {
      calls.push(grantIntent);
      return {
        status: "granted",
        eligible: false,
        reason: "first_withdrawal_gas_grant_sent",
        txHash: `0x${"d".repeat(64)}`,
        amount: { raw: "30000000000000000", decimals: 18, display: "0.03", symbol: "DOT" }
      };
    }
  };
  const { door } = harness({ liquidRaw: "400000", nativeBalance: 1n, gasGrantService });

  const result = await door.buildWithdrawTransactions(WALLET, {
    amount: "250000",
    requestGasGrant: true
  });

  assert.equal(result.firstWithdrawalGasGrant.status, "granted");
  assert.equal(result.firstWithdrawalGasGrant.txHash, `0x${"d".repeat(64)}`);
  assert.deepEqual(calls, [{
    wallet: WALLET,
    assetSymbol: "USDC",
    assetAddress: USDC,
    amountRaw: "250000",
    destination: WALLET,
    liveLiquidRaw: "400000"
  }]);
  assert.equal(result.templates[0].unsigned, true);
  assert.equal(result.broadcast.signer, "your own wallet");
});

test("requestGasGrant fails closed when the intent-bound grant service is unavailable", async () => {
  const { door } = harness({ gasGrantService: undefined });
  await assert.rejects(
    door.buildWithdrawTransactions(WALLET, { amount: "250000", requestGasGrant: true }),
    (error) => error?.details?.reason === "first_withdrawal_gas_grant_unavailable"
  );
});

test("over-available withdrawal refuses before offering templates and echoes the account truth", async () => {
  const { door } = harness({ liquidRaw: "9" });
  await assert.rejects(
    door.buildWithdrawTransactions(WALLET, { amount: "10" }),
    (error) => {
      assert.equal(error.details.reason, "amount_exceeds_available");
      assert.equal(error.details.account.available.raw, "9");
      return true;
    }
  );
});
