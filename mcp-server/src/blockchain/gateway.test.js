import test from "node:test";
import assert from "node:assert/strict";
import { encodeBytes32String } from "ethers";

import { BlockchainGateway } from "./gateway.js";

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
  const gateway = new BlockchainGateway({ enabled: false });
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
        reward: 4n,
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

test("createSinglePayoutJobForLayout uses the legacy signature for legacy escrow deployments", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
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
    4,
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
    4,
    0,
    0,
    3600,
    encodeBytes32String("BENCH"),
    encodeBytes32String("WIKI")
  ]);
});
