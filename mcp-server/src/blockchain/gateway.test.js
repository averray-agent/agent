import test from "node:test";
import assert from "node:assert/strict";
import { encodeBytes32String } from "ethers";

import { BlockchainGateway } from "./gateway.js";
import { InsufficientLiquidityError, ValidationError } from "../core/errors.js";

const DOT_ASSET = {
  symbol: "DOT",
  address: "0x2222222222222222222222222222222222222222",
  decimals: 18
};
const USDC_TRUST_ASSET = {
  symbol: "USDC",
  address: "0x0000053900000000000000000000000001200000",
  assetClass: "trust_backed",
  assetId: 1337,
  decimals: 6,
  minBalanceRaw: "70000"
};

function gatewayWithDot() {
  return new BlockchainGateway({ enabled: false, supportedAssets: [DOT_ASSET] });
}

function emptyPosition(overrides = {}) {
  return {
    liquid: 0n,
    reserved: 0n,
    strategyAllocated: 0n,
    collateralLocked: 0n,
    jobStakeLocked: 0n,
    debtOutstanding: 0n,
    ...overrides
  };
}

test("toDisputeReasonCode uses Solidity bytes32 string encoding", () => {
  const gateway = new BlockchainGateway({ enabled: false });

  assert.equal(
    gateway.toDisputeReasonCode("DISPUTE_LOST"),
    encodeBytes32String("DISPUTE_LOST")
  );
});

test("toContentHash accepts only canonical content hash values", () => {
  const gateway = new BlockchainGateway({ enabled: false });
  const hash = `0x${"A".repeat(64)}`;

  assert.equal(gateway.toContentHash(hash), hash.toLowerCase());
  assert.throws(
    () => gateway.toContentHash("not-a-hash"),
    /content hash/u
  );
});

test("discloseContent relays SIWE wallet through discloseFor", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  const hash = `0x${"1".repeat(64)}`;
  const byWallet = "0x1111111111111111111111111111111111111111";
  const calls = [];
  gateway.signer = {};
  gateway.escrowContract = {
    async discloseFor(...args) {
      calls.push(args);
      return {
        hash: "0xtx",
        async wait() {
          return { blockNumber: 123, status: 1 };
        }
      };
    }
  };

  const receipt = await gateway.discloseContent(hash, byWallet);

  assert.deepEqual(calls, [[hash, byWallet]]);
  assert.deepEqual(receipt, { txHash: "0xtx", blockNumber: 123, status: 1 });
});

test("autoDiscloseContent skips when the contract already recorded the hash", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  gateway.signer = {};
  gateway.escrowContract = {
    async autoDisclosed() {
      return true;
    },
    async autoDisclose() {
      throw new Error("should not send");
    }
  };

  assert.deepEqual(
    await gateway.autoDiscloseContent(`0x${"2".repeat(64)}`),
    { skipped: true, reason: "already_auto_disclosed" }
  );
});

test("handleClaimTimeout reopens the canonical chain job id", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  const calls = [];
  gateway.signer = {};
  gateway.escrowContract = {
    async handleClaimTimeout(...args) {
      calls.push(args);
      return {
        async wait() {}
      };
    }
  };

  await gateway.handleClaimTimeout("wiki-job");

  assert.deepEqual(calls, [[gateway.toJobId("wiki-job")]]);
});

test("getJob falls back to the legacy escrow struct when rc1 decoding fails", async () => {
  const gateway = gatewayWithDot();
  gateway.escrowContract = {
    async jobs() {
      const error = new Error("could not decode result data");
      error.code = "BAD_DATA";
      throw error;
    }
  };
  gateway.legacyEscrowContract = {
    async jobs(jobId) {
      assert.equal(jobId, gateway.toJobId("WIKI"));
      return {
        poster: "0x1111111111111111111111111111111111111111",
        worker: "0x0000000000000000000000000000000000000000",
        asset: "0x2222222222222222222222222222222222222222",
        verifierMode: encodeBytes32String("BENCH"),
        category: encodeBytes32String("WIKI"),
        reward: 4_000_000_000_000_000_000n,
        opsReserve: 0n,
        contingencyReserve: 0n,
        released: 0n,
        claimExpiry: 0n,
        claimStake: 0n,
        claimStakeBps: 0,
        payoutMode: 0,
        state: 1
      };
    }
  };

  const job = await gateway.getJob("WIKI");

  assert.equal(job.state, 1);
  assert.equal(job.reward, 4);
  assert.equal(job.specHash, `0x${"0".repeat(64)}`);
  assert.equal(job.claimFee, 0);
  assert.equal(job.claimEconomicsWaived, false);
  assert.equal("contractLayout" in job, false);
});

test("toBaseUnits converts display asset amounts before uint256 contract calls", () => {
  const gateway = gatewayWithDot();

  assert.equal(
    gateway.toBaseUnits(4, DOT_ASSET, "job reward"),
    4_000_000_000_000_000_000n
  );
  assert.equal(
    gateway.toBaseUnits(0.4, DOT_ASSET, "claim lock amount"),
    400_000_000_000_000_000n
  );
  assert.equal(
    gateway.toBaseUnits(0.05, DOT_ASSET, "minimum claim fee"),
    50_000_000_000_000_000n
  );
});

test("getAccountSummary returns display balances and preserves raw base units", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  gateway.accountContract = {
    async positions(wallet, asset) {
      assert.equal(wallet, "0x3333333333333333333333333333333333333333");
      assert.equal(asset, USDC_TRUST_ASSET.address);
      return emptyPosition({
        liquid: 1_234_500n,
        reserved: 70_000n,
        debtOutstanding: 250_000n
      });
    }
  };

  const summary = await gateway.getAccountSummary("0x3333333333333333333333333333333333333333");

  assert.equal(summary.liquid.USDC, 1.2345);
  assert.equal(summary.reserved.USDC, 0.07);
  assert.equal(summary.debtOutstanding.USDC, 0.25);
  assert.deepEqual(summary.raw.liquid, { USDC: "1234500" });
  assert.deepEqual(summary.raw.reserved, { USDC: "70000" });
  assert.deepEqual(summary.raw.debtOutstanding, { USDC: "250000" });
});

test("getClaimEconomicsConfig converts chain min fees back to display units", async () => {
  const gateway = gatewayWithDot();
  gateway.policyContract = {
    async claimFeeBps() {
      return 200n;
    },
    async claimFeeVerifierBps() {
      return 7000n;
    },
    async onboardingWaiverClaimCount() {
      return 3n;
    },
    async minClaimFeeByAsset(asset) {
      assert.equal(asset, DOT_ASSET.address);
      return 50_000_000_000_000_000n;
    }
  };

  assert.deepEqual(await gateway.getClaimEconomicsConfig(), {
    claimFeeBps: 200,
    claimFeeVerifierBps: 7000,
    onboardingWaiverClaimCount: 3,
    minClaimFeeByAsset: { DOT: 0.05 }
  });
});

test("getTreasuryPolicyStatus surfaces settlement readiness roles", async () => {
  const gateway = new BlockchainGateway({
    enabled: true,
    rpcUrl: "http://127.0.0.1:8545",
    signerPrivateKey: `0x${"11".repeat(32)}`,
    treasuryPolicyAddress: "0x1111111111111111111111111111111111111111",
    agentAccountAddress: "0x3333333333333333333333333333333333333333",
    escrowCoreAddress: "0x2222222222222222222222222222222222222222",
    reputationSbtAddress: "0x4444444444444444444444444444444444444444",
    supportedAssets: [DOT_ASSET]
  });
  const signerAddress = await gateway.signer.getAddress();
  gateway.policyContract = {
    async owner() {
      return "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    },
    async pauser() {
      return "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    },
    async paused() {
      return false;
    },
    async verifiers(address) {
      assert.equal(address, signerAddress);
      return true;
    },
    async serviceOperators(address) {
      assert.ok([
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333"
      ].includes(address));
      return true;
    },
    async approvedAssets(address) {
      assert.equal(address, DOT_ASSET.address);
      return true;
    },
    async dailyOutflowCap() {
      return 100n;
    },
    async perAccountBorrowCap() {
      return 200n;
    },
    async minimumCollateralRatioBps() {
      return 300n;
    },
    async defaultClaimStakeBps() {
      return 400n;
    },
    async claimFeeBps() {
      return 5n;
    },
    async claimFeeVerifierBps() {
      return 6000n;
    },
    async onboardingWaiverClaimCount() {
      return 7n;
    },
    async rejectionSkillPenalty() {
      return 8n;
    },
    async rejectionReliabilityPenalty() {
      return 9n;
    },
    async disputeLossSkillPenalty() {
      return 10n;
    },
    async disputeLossReliabilityPenalty() {
      return 11n;
    }
  };

  const status = await gateway.getTreasuryPolicyStatus();

  assert.equal(status.settlementReady, true);
  assert.equal(status.roles.signerAddress, signerAddress);
  assert.equal(status.roles.signerIsVerifier, true);
  assert.equal(status.roles.escrowIsServiceOperator, true);
  assert.equal(status.roles.agentAccountIsServiceOperator, true);
  assert.deepEqual(status.readErrors, []);
  assert.deepEqual(status.contracts.supportedAssets, [{
    symbol: "DOT",
    address: DOT_ASSET.address,
    assetClass: "custom",
    assetId: undefined,
    foreignAssetIndex: undefined,
    decimals: 18,
    approved: true
  }]);
});

test("getTreasuryPolicyStatus records individual read errors without hiding roles", async () => {
  const gateway = new BlockchainGateway({
    enabled: true,
    rpcUrl: "http://127.0.0.1:8545",
    signerPrivateKey: `0x${"11".repeat(32)}`,
    treasuryPolicyAddress: "0x1111111111111111111111111111111111111111",
    agentAccountAddress: "0x3333333333333333333333333333333333333333",
    escrowCoreAddress: "0x2222222222222222222222222222222222222222",
    reputationSbtAddress: "0x4444444444444444444444444444444444444444",
    supportedAssets: [DOT_ASSET]
  });
  gateway.policyContract = {
    async owner() {
      return "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    },
    async pauser() {
      return "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    },
    async paused() {
      return false;
    },
    async verifiers() {
      return true;
    },
    async serviceOperators() {
      const error = new Error("require(false)");
      error.shortMessage = "execution reverted";
      throw error;
    },
    async approvedAssets() {
      return false;
    },
    async dailyOutflowCap() {
      return 100n;
    },
    async perAccountBorrowCap() {
      return 200n;
    },
    async minimumCollateralRatioBps() {
      return 300n;
    },
    async defaultClaimStakeBps() {
      return 400n;
    },
    async claimFeeBps() {
      return 5n;
    },
    async claimFeeVerifierBps() {
      return 6000n;
    },
    async onboardingWaiverClaimCount() {
      return 7n;
    },
    async rejectionSkillPenalty() {
      return 8n;
    },
    async rejectionReliabilityPenalty() {
      return 9n;
    },
    async disputeLossSkillPenalty() {
      return 10n;
    },
    async disputeLossReliabilityPenalty() {
      return 11n;
    }
  };

  const status = await gateway.getTreasuryPolicyStatus();

  assert.equal(status.roles.signerIsVerifier, true);
  assert.equal(status.roles.escrowIsServiceOperator, false);
  assert.equal(status.roles.agentAccountIsServiceOperator, false);
  assert.equal(status.settlementReady, false);
  assert.deepEqual(status.readErrors, [
    {
      field: "serviceOperators(escrowCore)",
      message: "execution reverted"
    },
    {
      field: "serviceOperators(agentAccount)",
      message: "execution reverted"
    }
  ]);
});

test("previewClaimEconomics returns display values while preserving raw chain amounts", async () => {
  const gateway = gatewayWithDot();
  gateway.escrowContract = {
    async jobs() {
      return {
        poster: "0x1111111111111111111111111111111111111111",
        worker: "0x0000000000000000000000000000000000000000",
        asset: DOT_ASSET.address,
        verifierMode: encodeBytes32String("BENCH"),
        category: encodeBytes32String("WIKI"),
        specHash: `0x${"0".repeat(64)}`,
        reward: 4_000_000_000_000_000_000n,
        opsReserve: 0n,
        contingencyReserve: 0n,
        released: 0n,
        claimExpiry: 0n,
        claimStake: 0n,
        claimStakeBps: 0,
        claimFee: 0n,
        claimFeeBps: 0,
        claimEconomicsWaived: false,
        rejectingVerifier: "0x0000000000000000000000000000000000000000",
        rejectedAt: 0n,
        disputedAt: 0n,
        payoutMode: 0,
        state: 1
      };
    },
    async previewClaimEconomics() {
      return {
        claimStake: 400_000_000_000_000_000n,
        claimStakeBps: 1000,
        claimFee: 80_000_000_000_000_000n,
        claimFeeBps: 200,
        waived: false,
        claimNumber: 4n
      };
    }
  };

  assert.deepEqual(
    await gateway.previewClaimEconomics("0x3333333333333333333333333333333333333333", "WIKI"),
    {
      claimStake: 0.4,
      claimStakeRaw: "400000000000000000",
      claimStakeBps: 1000,
      claimFee: 0.08,
      claimFeeRaw: "80000000000000000",
      claimFeeBps: 200,
      claimEconomicsWaived: false,
      claimNumber: 4,
      totalClaimLock: 0.48
    }
  );
});

test("ensureClaimStakeLiquidity checks fractional display locks against base-unit balances", async () => {
  const gateway = gatewayWithDot();
  gateway.signer = {
    async getAddress() {
      return "0x3333333333333333333333333333333333333333";
    }
  };
  gateway.accountContract = {
    async positions(account, asset) {
      assert.equal(account, "0x3333333333333333333333333333333333333333");
      assert.equal(asset, DOT_ASSET.address);
      return { liquid: 480_000_000_000_000_000n };
    }
  };

  assert.equal(await gateway.ensureClaimStakeLiquidity("DOT", 0.48), true);
});

test("fundAccount rejects non-mock settlement assets before minting", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  gateway.signer = {
    async getAddress() {
      return "0x3333333333333333333333333333333333333333";
    }
  };

  await assert.rejects(
    () => gateway.fundAccount("0x3333333333333333333333333333333333333333", "USDC", 1),
    (error) => {
      assert.ok(error instanceof InsufficientLiquidityError);
      assert.equal(error.details.assetClass, "trust_backed");
      assert.match(error.details.reason, /cannot be auto-minted/u);
      return true;
    }
  );
});

test("ensureJob rejects real settlement asset shortfalls before mock minting", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  gateway.signer = {
    async getAddress() {
      return "0x3333333333333333333333333333333333333333";
    }
  };
  gateway.readEscrowJob = async () => ({ state: 0, contractLayout: "rc1" });
  gateway.accountContract = {
    async positions(account, asset) {
      assert.equal(account, "0x3333333333333333333333333333333333333333");
      assert.equal(asset, USDC_TRUST_ASSET.address);
      return { liquid: 0n };
    }
  };
  gateway.createSinglePayoutJobForJob = async () => {
    throw new Error("job creation should not be attempted without funded liquidity");
  };

  await assert.rejects(
    () => gateway.ensureJob({
      id: "product-proof-worker-loop",
      rewardAsset: "USDC",
      rewardAmount: 0.000001,
      claimTtlSeconds: 3600,
      verifierMode: "benchmark",
      category: "product_proof"
    }),
    (error) => {
      assert.ok(error instanceof InsufficientLiquidityError);
      assert.equal(error.details.operation, "ensureJob");
      assert.equal(error.details.assetClass, "trust_backed");
      assert.equal(error.details.shortfall, 0.000001);
      assert.match(error.details.reason, /recurring template reserve/u);
      return true;
    }
  );
});

test("reserveRecurringTemplateFunding converts display amounts and records the template key", async () => {
  const gateway = gatewayWithDot();
  const calls = [];
  gateway.signer = {};
  gateway.accountContract = {
    async reserveForRecurringTemplate(...args) {
      calls.push(args);
      return { async wait() {} };
    }
  };

  const receipt = await gateway.reserveRecurringTemplateFunding(
    "0x3333333333333333333333333333333333333333",
    "DOT",
    10,
    "weekly-digest"
  );

  assert.deepEqual(calls, [[
    "0x3333333333333333333333333333333333333333",
    DOT_ASSET.address,
    gateway.toJobId("weekly-digest"),
    10_000_000_000_000_000_000n
  ]]);
  assert.equal(receipt.source, "agent_account_recurring_template_reserve");
  assert.equal(receipt.amountRaw, "10000000000000000000");
});

test("account mutations convert display amounts before contract calls", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const wallet = "0x3333333333333333333333333333333333333333";
  const recipient = "0x4444444444444444444444444444444444444444";
  const calls = [];
  gateway.signer = {
    async getAddress() {
      return wallet;
    }
  };
  gateway.accountContract = {
    async positions() {
      return emptyPosition();
    },
    async reserveForJob(...args) {
      calls.push(["reserveForJob", ...args]);
      return { async wait() {} };
    },
    async allocateIdleFunds(...args) {
      calls.push(["allocateIdleFunds", ...args]);
      return { async wait() {} };
    },
    async deallocateIdleFunds(...args) {
      calls.push(["deallocateIdleFunds", ...args]);
      return { async wait() {} };
    },
    async borrow(...args) {
      calls.push(["borrow", ...args]);
      return { async wait() {} };
    },
    async repay(...args) {
      calls.push(["repay", ...args]);
      return { async wait() {} };
    },
    async sendToAgentFor(...args) {
      calls.push(["sendToAgentFor", ...args]);
      return { async wait() {} };
    }
  };

  await gateway.reserveForJob(wallet, "USDC", 1.25);
  await gateway.allocateIdleFunds(wallet, "usdc-yield", "2.5", "USDC");
  await gateway.deallocateIdleFunds(wallet, "usdc-yield", 0.75, "USDC");
  await gateway.borrow(wallet, "USDC", 3);
  await gateway.repay(wallet, "USDC", 1.5);
  await gateway.sendToAgent(wallet, recipient, "USDC", 0.125);

  assert.deepEqual(calls, [
    ["reserveForJob", wallet, USDC_TRUST_ASSET.address, 1_250_000n],
    ["allocateIdleFunds", wallet, gateway.normalizeStrategyId("usdc-yield"), 2_500_000n],
    ["deallocateIdleFunds", wallet, gateway.normalizeStrategyId("usdc-yield"), 750_000n],
    ["borrow", USDC_TRUST_ASSET.address, 3_000_000n],
    ["repay", USDC_TRUST_ASSET.address, 1_500_000n],
    ["sendToAgentFor", wallet, recipient, USDC_TRUST_ASSET.address, 125_000n]
  ]);
});

test("borrow refuses to relay for a wallet that is not the configured signer", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  gateway.signer = {
    async getAddress() {
      return "0x3333333333333333333333333333333333333333";
    }
  };
  gateway.accountContract = {
    async borrow() {
      throw new Error("borrow should not be sent");
    }
  };

  await assert.rejects(
    () => gateway.borrow("0x4444444444444444444444444444444444444444", "USDC", 1),
    /configured blockchain signer/u
  );
});

test("async XCM request readers return display amounts and raw base-unit fields", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const requestId = `0x${"1".repeat(64)}`;
  const account = "0x3333333333333333333333333333333333333333";
  const recipient = "0x4444444444444444444444444444444444444444";
  gateway.xcmWrapperContract = {
    async getRequest(id) {
      assert.equal(id, requestId);
      return {
        context: {
          strategyId: encodeBytes32String("USDC"),
          kind: 0,
          account,
          asset: USDC_TRUST_ASSET.address,
          recipient,
          assets: 1_250_000n,
          shares: 500_000n,
          nonce: 7n
        },
        status: 1,
        settledAssets: 250_000n,
        settledShares: 100_000n,
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: `0x${"0".repeat(64)}`,
        createdAt: 10n,
        updatedAt: 12n
      };
    }
  };
  gateway.accountContract = {
    async strategyRequests(id) {
      assert.equal(id, requestId);
      return {
        strategyId: encodeBytes32String("USDC"),
        adapter: "0x5555555555555555555555555555555555555555",
        account,
        asset: USDC_TRUST_ASSET.address,
        recipient,
        kind: 0,
        status: 1,
        requestedAssets: 1_250_000n,
        requestedShares: 500_000n,
        settledAssets: 250_000n,
        settledShares: 100_000n,
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: `0x${"0".repeat(64)}`,
        settled: false
      };
    }
  };

  const xcmRequest = await gateway.getXcmRequest(requestId);
  const strategyRequest = await gateway.getStrategyRequest(requestId);

  assert.equal(xcmRequest.requestedAssets, 1.25);
  assert.equal(xcmRequest.requestedAssetsRaw, "1250000");
  assert.equal(xcmRequest.requestedShares, 0.5);
  assert.equal(xcmRequest.settledAssets, 0.25);
  assert.equal(strategyRequest.requestedAssets, 1.25);
  assert.equal(strategyRequest.requestedAssetsRaw, "1250000");
  assert.equal(strategyRequest.settledShares, 0.1);
  assert.equal(strategyRequest.settledSharesRaw, "100000");
});

test("resolveXcmMaxWeight uses caller weight when refTime is non-zero", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  gateway.xcmWrapperContract = {
    async weighMessage() {
      throw new Error("weighMessage should not be called");
    }
  };

  assert.deepEqual(
    await gateway.resolveXcmMaxWeight({ refTime: 7, proofSize: 0 }, "0x1234", "requestStrategyDeposit"),
    { refTime: 7, proofSize: 0 }
  );
});

test("resolveXcmMaxWeight quotes the wrapper when builder weight is zero", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  gateway.xcmWrapperContract = {
    async weighMessage(message) {
      assert.equal(message, "0x1234");
      return { refTime: 70n, proofSize: 4n };
    }
  };

  assert.deepEqual(
    await gateway.resolveXcmMaxWeight({ refTime: 0, proofSize: 0 }, "0x1234", "requestStrategyDeposit"),
    { refTime: 70, proofSize: 4 }
  );
});

test("resolveXcmMaxWeight rejects zero weight without a wrapper quote", async () => {
  const gateway = new BlockchainGateway({ enabled: false });

  await assert.rejects(
    () => gateway.resolveXcmMaxWeight({ refTime: 0, proofSize: 0 }, "0x1234", "requestStrategyDeposit"),
    ValidationError
  );
});

test("resolveXcmMaxWeight rejects zero wrapper quotes", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  gateway.xcmWrapperContract = {
    async weighMessage() {
      return { refTime: 0n, proofSize: 0n };
    }
  };

  await assert.rejects(
    () => gateway.resolveXcmMaxWeight({ refTime: 0, proofSize: 0 }, "0x1234", "requestStrategyDeposit"),
    ValidationError
  );
});

test("createSinglePayoutJobForJob consumes recurring template reserve when funding metadata is present", async () => {
  const gateway = gatewayWithDot();
  const calls = [];
  gateway.escrowContract = {
    async createSinglePayoutJobFromRecurringReserve(...args) {
      calls.push(args);
      return { async wait() {} };
    },
    async createSinglePayoutJob() {
      throw new Error("fresh reservation path should not be used");
    }
  };

  await gateway.createSinglePayoutJobForJob(
    {
      funding: {
        source: "recurring_template_reserve",
        wallet: "0x3333333333333333333333333333333333333333",
        templateId: "weekly-digest"
      }
    },
    "rc1",
    gateway.toJobId("weekly-digest-run-1"),
    DOT_ASSET.address,
    5_000_000_000_000_000_000n,
    0,
    0,
    3600,
    encodeBytes32String("BENCH"),
    encodeBytes32String("WIKI"),
    `0x${"1".repeat(64)}`
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [{
    jobId: gateway.toJobId("weekly-digest-run-1"),
    templateId: gateway.toJobId("weekly-digest"),
    poster: "0x3333333333333333333333333333333333333333",
    asset: DOT_ASSET.address,
    reward: 5_000_000_000_000_000_000n,
    opsReserve: 0,
    contingencyReserve: 0,
    claimTtl: 3600,
    verifierMode: encodeBytes32String("BENCH"),
    category: encodeBytes32String("WIKI"),
    specHash: `0x${"1".repeat(64)}`
  }]);
});

test("createSinglePayoutJobForLayout uses the legacy signature for legacy escrow deployments", async () => {
  const gateway = gatewayWithDot();
  const calls = [];
  gateway.legacyEscrowContract = {
    async createSinglePayoutJob(...args) {
      calls.push(args);
      return { async wait() {} };
    }
  };
  gateway.escrowContract = {
    async createSinglePayoutJob() {
      throw new Error("rc1 signature should not be used");
    }
  };

  await gateway.createSinglePayoutJobForLayout(
    "legacy",
    gateway.toJobId("WIKI"),
    "0x2222222222222222222222222222222222222222",
    4_000_000_000_000_000_000n,
    0,
    0,
    3600,
    encodeBytes32String("BENCH"),
    encodeBytes32String("WIKI"),
    `0x${"1".repeat(64)}`
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 8);
  assert.deepEqual(calls[0].slice(2), [
    4_000_000_000_000_000_000n,
    0,
    0,
    3600,
    encodeBytes32String("BENCH"),
    encodeBytes32String("WIKI")
  ]);
});
