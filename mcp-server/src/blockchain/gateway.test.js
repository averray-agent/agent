import test from "node:test";
import assert from "node:assert/strict";
import { encodeBytes32String } from "ethers";

import { BlockchainGateway } from "./gateway.js";

const DOT_ASSET = {
  symbol: "DOT",
  address: "0x2222222222222222222222222222222222222222",
  decimals: 18
};

function gatewayWithDot() {
  return new BlockchainGateway({ enabled: false, supportedAssets: [DOT_ASSET] });
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
