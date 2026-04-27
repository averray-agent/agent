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
