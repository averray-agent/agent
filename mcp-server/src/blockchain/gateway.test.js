import test from "node:test";
import assert from "node:assert/strict";
import { encodeBytes32String, Interface } from "ethers";

import { BlockchainGateway } from "./gateway.js";
import { ConfigError, InsufficientLiquidityError, ValidationError } from "../core/errors.js";
import { EXTERNAL_SCHEMA_EIP712_VERSION } from "../core/job-schema-registry.js";

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
const CREATE_SINGLE_PAYOUT_WITH_SCHEMA =
  "createSinglePayoutJob(bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32,(bytes32,string,address,bytes))";
const CREATE_SINGLE_PAYOUT_FEE_WAIVED_WITH_SCHEMA =
  "createSinglePayoutJobFeeWaived(bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32,(bytes32,string,address,bytes))";

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

test("openDispute uses the primary service signer participant path", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  const calls = [];
  gateway.signer = {};
  gateway.escrowContract = {
    async openDispute(...args) {
      calls.push(args);
      return {
        hash: "0xopen",
        async wait() {
          return { blockNumber: 7, status: 1 };
        }
      };
    }
  };

  const receipt = await gateway.openDispute("wiki-job");

  assert.deepEqual(calls, [[gateway.toJobId("wiki-job")]]);
  assert.deepEqual(receipt, { txHash: "0xopen", blockNumber: 7, status: 1 });
});

test("resolveDispute uses the arbitrator signer contract when configured", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  const calls = [];
  gateway.signer = {
    marker: "service"
  };
  gateway.escrowContract = {
    async resolveDispute() {
      throw new Error("service signer must not resolve disputes when an arbitrator signer exists");
    }
  };
  gateway.arbitratorSigner = {
    marker: "arbitrator"
  };
  gateway.arbitratorEscrowContract = {
    async resolveDispute(...args) {
      calls.push(args);
      return {
        hash: "0xresolve",
        async wait() {
          return { blockNumber: 8, status: 1 };
        }
      };
    }
  };
  gateway.getJob = async (jobId) => {
    assert.equal(jobId, "wiki-job");
    return { asset: DOT_ASSET.address };
  };
  gateway.getTreasuryPolicyStatus = async () => ({
    roles: {
      arbitratorSignerAddress: "0x4444444444444444444444444444444444444444",
      arbitratorSignerIsArbitrator: true
    }
  });

  const receipt = await gateway.resolveDispute("wiki-job", 0, "DISPUTE_LOST", "https://api.example.test/content/0xabc");

  assert.deepEqual(calls, [[
    gateway.toJobId("wiki-job"),
    0n,
    gateway.toDisputeReasonCode("DISPUTE_LOST"),
    "https://api.example.test/content/0xabc"
  ]]);
  assert.deepEqual(receipt, { txHash: "0xresolve", blockNumber: 8, status: 1 });
});

test("resolveDispute fails closed when no arbitrator signer exists", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  let resolveCalls = 0;
  gateway.arbitratorSigner = undefined;
  gateway.arbitratorEscrowContract = {
    async resolveDispute() {
      resolveCalls += 1;
    }
  };

  await assert.rejects(
    gateway.resolveDispute("wiki-job", 0, "DISPUTE_LOST"),
    (error) => error instanceof ConfigError
      && error.details?.reason === "arbitrator_signer_missing"
      && /no blockchain signer is configured/u.test(error.message)
  );
  assert.equal(resolveCalls, 0);
});

test("resolveDispute fails closed when the configured signer is not the on-chain arbitrator", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  let getJobCalls = 0;
  let resolveCalls = 0;
  gateway.arbitratorSigner = {
    async getAddress() {
      return "0x5555555555555555555555555555555555555555";
    }
  };
  gateway.arbitratorEscrowContract = {
    async resolveDispute() {
      resolveCalls += 1;
    }
  };
  gateway.getJob = async () => {
    getJobCalls += 1;
    return { asset: DOT_ASSET.address };
  };
  gateway.getTreasuryPolicyStatus = async () => ({
    roles: {
      arbitratorSignerAddress: "0x5555555555555555555555555555555555555555",
      arbitratorSignerIsArbitrator: false
    }
  });

  await assert.rejects(
    gateway.resolveDispute("wiki-job", 0, "DISPUTE_LOST"),
    (error) => error instanceof ConfigError
      && error.details?.reason === "arbitrator_signer_not_on_chain_arbitrator"
      && /out-of-band.*hardware arbitrator/u.test(error.message)
  );
  assert.equal(getJobCalls, 0);
  assert.equal(resolveCalls, 0);
});

test("resolveDispute converts display worker payout to asset base units", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const iface = new Interface([
    "function resolveDispute(bytes32 jobId,uint256 workerPayout,bytes32 reasonCode,string metadataURI)"
  ]);
  const encodedCalls = [];
  gateway.signer = {
    marker: "service"
  };
  gateway.escrowContract = {
    async resolveDispute() {
      throw new Error("service signer must not resolve disputes when an arbitrator signer exists");
    }
  };
  gateway.arbitratorSigner = {
    marker: "arbitrator"
  };
  gateway.arbitratorEscrowContract = {
    async resolveDispute(...args) {
      encodedCalls.push(iface.encodeFunctionData("resolveDispute", args));
      return {
        hash: "0xresolve",
        async wait() {
          return { blockNumber: 9, status: 1 };
        }
      };
    }
  };
  gateway.getJob = async (jobId) => {
    assert.equal(jobId, "wiki-job");
    return { asset: USDC_TRUST_ASSET.address };
  };
  gateway.getTreasuryPolicyStatus = async () => ({
    roles: {
      arbitratorSignerAddress: "0x4444444444444444444444444444444444444444",
      arbitratorSignerIsArbitrator: true
    }
  });

  const receipt = await gateway.resolveDispute("wiki-job", 2, "WORKER_WINS", "averray://disputes/dispute-1");

  assert.deepEqual(receipt, { txHash: "0xresolve", blockNumber: 9, status: 1 });
  assert.equal(encodedCalls.length, 1);
  const [, workerPayout] = iface.decodeFunctionData("resolveDispute", encodedCalls[0]);
  assert.equal(workerPayout, 2_000_000n);
});

test("resolveSinglePayout returns the settle/payout tx receipt", async () => {
  const events = [];
  const gateway = new BlockchainGateway(
    { enabled: false },
    { logger: { info(fields, event) { events.push({ fields, event }); } } }
  );
  const calls = [];
  gateway.signer = {};
  gateway.writeBroadcaster = {
    takeProviderUsed(txHash) {
      assert.equal(txHash, "0xpayout");
      return "https://write-rpc.example.test";
    }
  };
  gateway.escrowContract = {
    async resolveSinglePayout(...args) {
      calls.push(args);
      return {
        hash: "0xpayout",
        provider: {
          _getConnection() {
            return { url: "https://rpc.example.test/v1/private-key?token=secret" };
          }
        },
        async wait() {
          return { blockNumber: 99, status: 1 };
        }
      };
    }
  };

  const receipt = await gateway.resolveSinglePayout("wiki-job", true, "OK", "ipfs://badge");

  assert.equal(calls.length, 1);
  assert.deepEqual(receipt, { txHash: "0xpayout", blockNumber: 99, status: 1 });
  assert.deepEqual(events.map(({ event }) => event), [
    "blockchain.resolve_single_payout.submitted",
    "blockchain.resolve_single_payout.confirmed"
  ]);
  assert.deepEqual(events[1].fields, {
    jobId: "wiki-job",
    txHash: "0xpayout",
    blockNumber: 99,
    durationMs: events[1].fields.durationMs,
    providerUsed: "https://write-rpc.example.test"
  });
  assert.equal(typeof events[1].fields.durationMs, "number");
  assert.ok(events[1].fields.durationMs >= 0);
  assert.equal(JSON.stringify(events).includes("private-key"), false);
  assert.equal(JSON.stringify(events).includes("secret"), false);
});

test("extractSettlementSplit preserves the exact worker reward and protocol fee", () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const worker = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const treasuryAccount = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const settlement = gateway.extractSettlementSplit(
    { logs: [{}] },
    {
      interface: {
        parseLog() {
          return {
            name: "SettlementSplit",
            args: {
              worker,
              treasuryAccount,
              asset: USDC_TRUST_ASSET.address,
              workerAmount: 1_000_000n,
              protocolFeeAmount: 25_000n,
              protocolFeeBps: 250
            }
          };
        }
      }
    }
  );

  assert.deepEqual(settlement, {
    worker,
    treasuryAccount,
    asset: USDC_TRUST_ASSET.address,
    assetSymbol: "USDC",
    workerAmount: 1,
    workerAmountRaw: "1000000",
    protocolFeeAmount: 0.025,
    protocolFeeAmountRaw: "25000",
    protocolFeeBps: 250
  });
});

test("getProtocolFeeConfig reads the owner-controlled v2 fee state", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  gateway.escrowContract = {
    async protocolFeeBps() { return 250; },
    async MAX_PROTOCOL_FEE_BPS() { return 1_000; },
    async treasuryAccount() { return "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; }
  };

  assert.deepEqual(await gateway.getProtocolFeeConfig(), {
    supported: true,
    protocolFeeBps: 250,
    maxProtocolFeeBps: 1_000,
    treasuryAccount: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  });
});

test("previewProtocolFeeForAsset quotes the exact reserve increment in asset units", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  gateway.escrowContract = {
    async previewProtocolFee(rewardAmount) {
      assert.equal(rewardAmount, 1_000_000n);
      return 25_000n;
    },
    async protocolFeeBps() {
      return 250;
    }
  };

  assert.deepEqual(await gateway.previewProtocolFeeForAsset("USDC", 1), {
    asset: "USDC",
    rewardAmount: 1,
    rewardAmountRaw: "1000000",
    protocolFeeAmount: 0.025,
    protocolFeeAmountRaw: "25000",
    protocolFeeBps: 250
  });
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

test("claimJob relays the authenticated wallet when the signer is an operator", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  const worker = "0x3333333333333333333333333333333333333333";
  const calls = [];
  gateway.signer = {
    async getAddress() {
      return "0x9999999999999999999999999999999999999999";
    }
  };
  gateway.escrowContract = {
    async claimJob() {
      throw new Error("operator signer must not become the worker");
    },
    async claimJobFor(...args) {
      calls.push(args);
      return {
        async wait() {}
      };
    }
  };

  await gateway.claimJob("wiki-job", worker);

  assert.deepEqual(calls, [[gateway.toJobId("wiki-job"), worker]]);
});

test("claimJob uses direct claim when the signer is the authenticated wallet", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  const worker = "0x3333333333333333333333333333333333333333";
  const calls = [];
  gateway.signer = {
    async getAddress() {
      return worker.toUpperCase();
    }
  };
  gateway.escrowContract = {
    async claimJob(...args) {
      calls.push(args);
      return {
        async wait() {}
      };
    },
    async claimJobFor() {
      throw new Error("direct wallet claims should not use claimJobFor");
    }
  };

  await gateway.claimJob("wiki-job", worker);

  assert.deepEqual(calls, [[gateway.toJobId("wiki-job")]]);
});

test("submitWork relays the worker via submitWorkFor when the signer is an operator", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  const worker = "0x3333333333333333333333333333333333333333";
  const evidence = `0x${"a".repeat(64)}`;
  const calls = [];
  gateway.signer = {
    async getAddress() {
      return "0x9999999999999999999999999999999999999999";
    }
  };
  gateway.escrowContract = {
    async submitWork() {
      throw new Error("operator signer must not submit as the worker");
    },
    async submitWorkFor(...args) {
      calls.push(args);
      return {
        async wait() {}
      };
    }
  };

  await gateway.submitWork("wiki-job", evidence, worker);

  assert.deepEqual(calls, [[gateway.toJobId("wiki-job"), worker, evidence]]);
});

test("submitWork uses direct submitWork when no relayed worker is supplied", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  const evidence = `0x${"b".repeat(64)}`;
  const calls = [];
  gateway.signer = {
    async getAddress() {
      throw new Error("direct submits must not need the signer address");
    }
  };
  gateway.escrowContract = {
    async submitWork(...args) {
      calls.push(args);
      return {
        async wait() {}
      };
    },
    async submitWorkFor() {
      throw new Error("direct submits should not use submitWorkFor");
    }
  };

  await gateway.submitWork("wiki-job", evidence);

  assert.deepEqual(calls, [[gateway.toJobId("wiki-job"), evidence]]);
});

test("openDispute relays the participant via openDisputeFor when the signer is not the participant", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  const participant = "0x3333333333333333333333333333333333333333";
  const calls = [];
  gateway.signer = {
    async getAddress() {
      return "0x9999999999999999999999999999999999999999";
    }
  };
  gateway.escrowContract = {
    async openDispute() {
      throw new Error("operator signer must not open the dispute as itself when brokering");
    },
    async openDisputeFor(...args) {
      calls.push(args);
      return {
        hash: "0xopenfor",
        async wait() {
          return { blockNumber: 9, status: 1 };
        }
      };
    }
  };

  const receipt = await gateway.openDispute("wiki-job", participant);

  assert.deepEqual(calls, [[gateway.toJobId("wiki-job"), participant]]);
  assert.deepEqual(receipt, { txHash: "0xopenfor", blockNumber: 9, status: 1 });
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

test("getAccountPosition returns direct AgentAccountCore position with provenance", async () => {
  const gateway = new BlockchainGateway({ enabled: false, agentAccountAddress: "0x2222222222222222222222222222222222222222", supportedAssets: [USDC_TRUST_ASSET] });
  gateway.accountContract = {
    async positions(wallet, asset) {
      assert.equal(wallet, "0x3333333333333333333333333333333333333333");
      assert.equal(asset, USDC_TRUST_ASSET.address);
      return emptyPosition({
        liquid: 250_000n,
        jobStakeLocked: 125_000n
      });
    }
  };

  const position = await gateway.getAccountPosition("0x3333333333333333333333333333333333333333", "USDC");

  assert.equal(position.wallet, "0x3333333333333333333333333333333333333333");
  assert.equal(position.asset.symbol, "USDC");
  assert.deepEqual(position.source, {
    contract: "AgentAccountCore",
    address: "0x2222222222222222222222222222222222222222",
    method: "positions",
    field: "liquid"
  });
  assert.equal(position.position.liquidRaw, "250000");
  assert.equal(position.position.jobStakeLockedRaw, "125000");
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
    minClaimFeeByAsset: { DOT: 0.05 },
    minClaimFeeRawByAsset: { DOT: "50000000000000000" }
  });
});

test("getClaimEconomicsConfig fails closed when an exact bond input is unreadable", async () => {
  const gateway = gatewayWithDot();
  gateway.policyContract = {
    async claimFeeBps() {
      throw new Error("policy RPC unavailable");
    },
    async claimFeeVerifierBps() {
      return 7000n;
    },
    async onboardingWaiverClaimCount() {
      return 3n;
    },
    async minClaimFeeByAsset() {
      return 50_000_000_000_000_000n;
    }
  };

  await assert.rejects(
    () => gateway.getClaimEconomicsConfig({ requireBondInputs: true }),
    /policy RPC unavailable/u
  );
});

test("getDisputeWindowSeconds reads the live EscrowCore constant", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  gateway.escrowContract = {
    async DISPUTE_WINDOW() {
      return 123_456n;
    }
  };

  assert.equal(await gateway.getDisputeWindowSeconds(), 123_456);
});

test("getClaimEconomicsConfig surfaces a required onboarding-waiver policy read failure", async () => {
  const gateway = gatewayWithDot();
  gateway.policyContract = {
    async claimFeeBps() {
      return 200n;
    },
    async claimFeeVerifierBps() {
      return 7000n;
    },
    async onboardingWaiverClaimCount() {
      throw new Error("policy RPC unavailable");
    },
    async minClaimFeeByAsset() {
      return 50_000_000_000_000_000n;
    }
  };

  await assert.rejects(
    () => gateway.getClaimEconomicsConfig({ requireWaiverInputs: true }),
    (error) => {
      assert.equal(error.code, "blockchain_unavailable");
      assert.match(error.message, /policy RPC unavailable/u);
      return true;
    }
  );
});

test("getWorkerClaimCount reads the escrow contract counter", async () => {
  const gateway = gatewayWithDot();
  gateway.escrowContract = {
    async workerClaimCount(wallet) {
      assert.equal(wallet, "0x3333333333333333333333333333333333333333");
      return 4n;
    }
  };

  assert.equal(
    await gateway.getWorkerClaimCount("0x3333333333333333333333333333333333333333"),
    4
  );
});

test("getWorkerClaimCount refuses a missing contract selector instead of fabricating zero", async () => {
  const gateway = gatewayWithDot();
  gateway.escrowContract = {};

  await assert.rejects(
    () => gateway.getWorkerClaimCount("0x3333333333333333333333333333333333333333"),
    (error) => {
      assert.equal(error.code, "blockchain_unavailable");
      assert.match(error.message, /workerClaimCount selector is unavailable/u);
      return true;
    }
  );
});

test("getClaimEconomicsDecisionState exposes current-layout mapping truth for an existing escrow", async () => {
  const gateway = gatewayWithDot();
  gateway.readEscrowJob = async () => ({
    state: 1,
    contractLayout: "rc1"
  });
  gateway.escrowContract = {
    async onboardingWaiverEligibleJobs(jobId) {
      assert.equal(jobId, gateway.toJobId("eligible-job"));
      return true;
    }
  };

  assert.deepEqual(await gateway.getClaimEconomicsDecisionState("eligible-job"), {
    state: 1,
    exists: true,
    contractLayout: "current",
    onboardingWaiverEligible: true
  });
});

test("getClaimEconomicsDecisionState treats the live v1 layout as waiver-capable", async () => {
  const gateway = gatewayWithDot();
  gateway.readEscrowJob = async () => ({
    state: 1,
    contractLayout: "v1"
  });
  gateway.v1EscrowContract = {
    async onboardingWaiverEligibleJobs(jobId) {
      assert.equal(jobId, gateway.toJobId("eligible-v1-job"));
      return true;
    }
  };

  assert.deepEqual(await gateway.getClaimEconomicsDecisionState("eligible-v1-job"), {
    state: 1,
    exists: true,
    contractLayout: "current",
    onboardingWaiverEligible: true
  });
});

test("readEscrowJob detects v1 before the pre-waiver legacy layout", async () => {
  const gateway = gatewayWithDot();
  const decodeError = Object.assign(new Error("could not decode result data"), { code: "BAD_DATA" });
  let v2Reads = 0;
  let v1Reads = 0;
  let legacyReads = 0;
  gateway.escrowContract = {
    async jobs() {
      v2Reads += 1;
      throw decodeError;
    }
  };
  gateway.v1EscrowContract = {
    async jobs() {
      v1Reads += 1;
      return {
        poster: "0x0000000000000000000000000000000000000000",
        worker: "0x0000000000000000000000000000000000000000",
        asset: DOT_ASSET.address,
        verifierMode: encodeBytes32String("BENCH"),
        category: encodeBytes32String("CODING"),
        specHash: `0x${"0".repeat(64)}`,
        reward: 0n,
        opsReserve: 0n,
        contingencyReserve: 0n,
        released: 0n,
        claimExpiry: 0n,
        claimStake: 0n,
        claimStakeBps: 0n,
        claimFee: 0n,
        claimFeeBps: 0n,
        claimEconomicsWaived: false,
        rejectingVerifier: "0x0000000000000000000000000000000000000000",
        rejectedAt: 0n,
        disputedAt: 0n,
        payoutMode: 0n,
        state: 0n
      };
    }
  };
  gateway.legacyEscrowContract = {
    async jobs() {
      legacyReads += 1;
      throw new Error("v1 must not be downgraded to pre-waiver legacy");
    }
  };

  const live = await gateway.readEscrowJob("worker-canary-v1");
  await gateway.readEscrowJob("worker-canary-v1-second-read");

  assert.equal(live.contractLayout, "v1");
  assert.equal(live.state, 0);
  assert.equal(v2Reads, 1, "the detected v1 layout should be cached after the first read");
  assert.equal(v1Reads, 2);
  assert.equal(legacyReads, 0);
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
    async settlementBroker(address) {
      assert.equal(address, signerAddress);
      return true;
    },
    async outflowRecorder(address) {
      assert.equal(address, "0x3333333333333333333333333333333333333333");
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
  gateway.accountContract = {
    async escrowOperators(address) {
      assert.equal(address, "0x2222222222222222222222222222222222222222");
      return true;
    },
    async positions(account, asset) {
      assert.equal(account, signerAddress);
      assert.equal(asset, DOT_ASSET.address);
      return emptyPosition({
        liquid: 1_000_000_000_000_000_000n,
        reserved: 250_000_000_000_000_000n
      });
    }
  };
  gateway.escrowContract = {
    async accounts() {
      return "0x3333333333333333333333333333333333333333";
    }
  };

  const status = await gateway.getTreasuryPolicyStatus();

  assert.equal(status.settlementReady, true);
  assert.equal(status.roles.signerAddress, signerAddress);
  assert.equal(status.roles.signerIsVerifier, true);
  assert.equal(status.roles.signerIsSettlementBroker, true);
  assert.equal(status.roles.escrowIsAgentAccountEscrowOperator, true);
  assert.equal(status.roles.escrowAgentAccountMatchesConfig, true);
  assert.equal(status.roles.agentAccountIsOutflowRecorder, true);
  assert.deepEqual(status.readErrors, []);
  assert.equal(status.contracts.escrowCoreAgentAccountAddress, "0x3333333333333333333333333333333333333333");
  assert.deepEqual(status.contracts.supportedAssets, [{
    symbol: "DOT",
    address: DOT_ASSET.address,
    assetClass: "custom",
    assetId: undefined,
    foreignAssetIndex: undefined,
    decimals: 18,
    approved: true
  }]);
  assert.deepEqual(status.signerFunding, {
    account: signerAddress,
    agentAccountAddress: "0x3333333333333333333333333333333333333333",
    assets: [{
      symbol: "DOT",
      address: DOT_ASSET.address,
      assetClass: "custom",
      assetId: undefined,
      foreignAssetIndex: undefined,
      decimals: 18,
      readable: true,
      liquid: 1,
      liquidRaw: "1000000000000000000",
      reserved: 0.25,
      reservedRaw: "250000000000000000",
      strategyAllocated: 0,
      strategyAllocatedRaw: "0",
      collateralLocked: 0,
      collateralLockedRaw: "0",
      jobStakeLocked: 0,
      jobStakeLockedRaw: "0",
      debtOutstanding: 0,
      debtOutstandingRaw: "0"
    }]
  });
});

test("getTreasuryPolicyStatus marks settlement not ready when EscrowCore points at a different AgentAccountCore", async () => {
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
    async settlementBroker() {
      return true;
    },
    async outflowRecorder() {
      return true;
    },
    async approvedAssets() {
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
  gateway.accountContract = {
    async escrowOperators() {
      return true;
    },
    async positions() {
      return emptyPosition();
    }
  };
  gateway.escrowContract = {
    async accounts() {
      return "0x9999999999999999999999999999999999999999";
    }
  };

  const status = await gateway.getTreasuryPolicyStatus();

  assert.equal(status.roles.escrowAgentAccountMatchesConfig, false);
  assert.equal(status.contracts.escrowCoreAgentAccountAddress, "0x9999999999999999999999999999999999999999");
  assert.equal(status.settlementReady, false);
});

test("getTreasuryPolicyStatus reports missing escrow authorization when escrowOperators getter is absent (no legacy serviceOperator fallback)", async () => {
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
    async settlementBroker(address) {
      assert.equal(address, signerAddress);
      return true;
    },
    async outflowRecorder(address) {
      assert.equal(address, "0x3333333333333333333333333333333333333333");
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
  gateway.accountContract = {
    async escrowOperators() {
      const error = new Error("selector missing on deployed legacy AgentAccountCore");
      error.shortMessage = "execution reverted";
      throw error;
    },
    async positions(account, asset) {
      assert.equal(account, signerAddress);
      assert.equal(asset, DOT_ASSET.address);
      return emptyPosition();
    }
  };
  gateway.escrowContract = {
    async accounts() {
      return "0x3333333333333333333333333333333333333333";
    }
  };

  const status = await gateway.getTreasuryPolicyStatus();

  // No escrowOperators getter → escrow is NOT authorized to drive AAC, and there is
  // no longer a legacy serviceOperator fallback (#724), so settlement is not ready.
  assert.equal(status.settlementReady, false);
  assert.equal(status.roles.signerIsSettlementBroker, true);
  assert.equal(status.roles.agentAccountIsOutflowRecorder, true);
  assert.equal(status.roles.escrowIsAgentAccountEscrowOperator, false);
  assert.equal(status.roles.agentAccountEscrowAuthorizationMode, "missing");
  assert.equal(status.roles.agentAccountEscrowOperatorsGetterReady, false);
  assert.equal(status.roles.escrowAgentAccountMatchesConfig, true);
  assert.deepEqual(status.readErrors, [{
    field: "AgentAccountCore.escrowOperators(escrowCore)",
    message: "execution reverted"
  }]);
});

test("getTreasuryPolicyStatus preserves raw policy risk values when numbers are unsafe", async () => {
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
  const unsafeDailyCap = (1n << 256n) - 1n;
  const unsafeBorrowCap = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
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
    async settlementBroker() {
      return true;
    },
    async outflowRecorder() {
      return true;
    },
    async approvedAssets() {
      return true;
    },
    async dailyOutflowCap() {
      return unsafeDailyCap;
    },
    async perAccountBorrowCap() {
      return unsafeBorrowCap;
    },
    async minimumCollateralRatioBps() {
      return 15000n;
    },
    async defaultClaimStakeBps() {
      return 500n;
    },
    async claimFeeBps() {
      return 200n;
    },
    async claimFeeVerifierBps() {
      return 7000n;
    },
    async onboardingWaiverClaimCount() {
      return 3n;
    },
    async rejectionSkillPenalty() {
      return 10n;
    },
    async rejectionReliabilityPenalty() {
      return 20n;
    },
    async disputeLossSkillPenalty() {
      return 30n;
    },
    async disputeLossReliabilityPenalty() {
      return 50n;
    }
  };
  gateway.accountContract = {
    async escrowOperators() {
      return true;
    },
    async positions() {
      return emptyPosition();
    }
  };
  gateway.escrowContract = {
    async accounts() {
      return "0x3333333333333333333333333333333333333333";
    }
  };

  const status = await gateway.getTreasuryPolicyStatus();

  assert.equal(status.risk.dailyOutflowCap, null);
  assert.equal(status.risk.dailyOutflowCapRaw, unsafeDailyCap.toString());
  assert.equal(status.risk.dailyOutflowCapExact, false);
  assert.equal(status.risk.perAccountBorrowCap, null);
  assert.equal(status.risk.perAccountBorrowCapRaw, unsafeBorrowCap.toString());
  assert.equal(status.risk.perAccountBorrowCapExact, false);
  assert.equal(status.risk.minimumCollateralRatioBps, 15000);
  assert.equal(status.risk.minimumCollateralRatioBpsRaw, "15000");
  assert.equal(status.risk.minimumCollateralRatioBpsExact, true);
  assert.equal(status.risk.claimFeeVerifierBps, 7000);
  assert.equal(status.risk.claimFeeVerifierBpsRaw, "7000");
  assert.equal(status.risk.claimFeeVerifierBpsExact, true);
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
    async settlementBroker() {
      const error = new Error("require(false)");
      error.shortMessage = "execution reverted";
      throw error;
    },
    async outflowRecorder() {
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
  gateway.accountContract = {
    async escrowOperators() {
      const error = new Error("require(false)");
      error.shortMessage = "execution reverted";
      throw error;
    },
    async positions() {
      return emptyPosition();
    }
  };
  gateway.escrowContract = {
    async accounts() {
      return "0x3333333333333333333333333333333333333333";
    }
  };

  const status = await gateway.getTreasuryPolicyStatus();

  assert.equal(status.roles.signerIsVerifier, true);
  assert.equal(status.roles.signerIsSettlementBroker, false);
  assert.equal(status.roles.escrowIsAgentAccountEscrowOperator, false);
  assert.equal(status.roles.agentAccountIsOutflowRecorder, false);
  assert.equal(status.settlementReady, false);
  assert.deepEqual(status.readErrors, [
    {
      field: "settlementBroker(signer)",
      message: "execution reverted"
    },
    {
      field: "AgentAccountCore.escrowOperators(escrowCore)",
      message: "execution reverted"
    },
    {
      field: "outflowRecorder(agentAccount)",
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
      return "0x9999999999999999999999999999999999999999";
    }
  };
  gateway.accountContract = {
    async positions(account, asset) {
      assert.equal(account, "0x3333333333333333333333333333333333333333");
      assert.equal(asset, DOT_ASSET.address);
      return { liquid: 480_000_000_000_000_000n };
    }
  };

  assert.equal(
    await gateway.ensureClaimStakeLiquidity("0x3333333333333333333333333333333333333333", "DOT", 0.48),
    true
  );
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

test("ensureJob marks explicitly eligible onboarding-waiver jobs on-chain", async () => {
  const gateway = gatewayWithDot();
  const signer = "0x3333333333333333333333333333333333333333";
  const waiverCalls = [];
  gateway.signer = {
    async getAddress() {
      return signer;
    }
  };
  gateway.readEscrowJob = async () => ({ state: 0, contractLayout: "rc1" });
  gateway.accountContract = {
    async positions(account, asset) {
      assert.equal(account, signer);
      assert.equal(asset, DOT_ASSET.address);
      return { liquid: 10_000_000_000_000_000_000n };
    }
  };
  gateway.createSinglePayoutJobForJob = async () => ({
    async wait() {
      return { blockNumber: 9, status: 1 };
    }
  });
  gateway.escrowContract = {
    async onboardingWaiverEligibleJobs(jobId) {
      waiverCalls.push(["read", jobId]);
      return false;
    },
    async setOnboardingWaiverEligible(jobId, eligible) {
      waiverCalls.push(["set", jobId, eligible]);
      return {
        async wait() {
          return { blockNumber: 10, status: 1 };
        }
      };
    }
  };
  gateway.getJob = async () => ({ id: "eligible-job", state: 1 });

  await gateway.ensureJob({
    id: "eligible-job",
    rewardAsset: "DOT",
    rewardAmount: 1,
    claimTtlSeconds: 3600,
    verifierMode: "benchmark",
    category: "coding",
    onboardingWaiverEligible: true
  });

  assert.deepEqual(waiverCalls, [
    ["read", gateway.toJobId("eligible-job")],
    ["set", gateway.toJobId("eligible-job"), true]
  ]);
});

test("ensureJob skips optional onboarding-waiver write when pinned EscrowCore lacks the selector", async () => {
  const gateway = gatewayWithDot();
  const signer = "0x3333333333333333333333333333333333333333";
  let setCalled = false;
  gateway.signer = {
    async getAddress() {
      return signer;
    }
  };
  gateway.readEscrowJob = async () => ({ state: 0, contractLayout: "rc1" });
  gateway.accountContract = {
    async positions(account, asset) {
      assert.equal(account, signer);
      assert.equal(asset, DOT_ASSET.address);
      return { liquid: 10_000_000_000_000_000_000n };
    }
  };
  gateway.createSinglePayoutJobForJob = async () => ({
    async wait() {
      return { blockNumber: 9, status: 1 };
    }
  });
  gateway.escrowContract = {
    async onboardingWaiverEligibleJobs() {
      const error = new Error("execution reverted (no data present; likely require(false) occurred");
      error.code = "CALL_EXCEPTION";
      error.reason = "require(false)";
      error.shortMessage = "execution reverted (no data present; likely require(false) occurred";
      error.data = "0x";
      throw error;
    },
    async setOnboardingWaiverEligible() {
      setCalled = true;
      throw new Error("setOnboardingWaiverEligible should not be called for legacy bytecode");
    }
  };
  gateway.getJob = async () => ({ id: "legacy-waiver-job", state: 1 });

  await gateway.ensureJob({
    id: "legacy-waiver-job",
    rewardAsset: "DOT",
    rewardAmount: 1,
    claimTtlSeconds: 3600,
    verifierMode: "benchmark",
    category: "coding",
    onboardingWaiverEligible: true
  });

  assert.equal(setCalled, false);
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

test("cancelRecurringTemplateReserve converts display amounts and records the template key", async () => {
  const gateway = gatewayWithDot();
  const calls = [];
  gateway.signer = {};
  gateway.accountContract = {
    async cancelRecurringTemplateReserve(...args) {
      calls.push(args);
      return { async wait() {} };
    }
  };

  const receipt = await gateway.cancelRecurringTemplateReserve(
    "0x3333333333333333333333333333333333333333",
    "DOT",
    2.5,
    "weekly-digest"
  );

  assert.deepEqual(calls, [[
    "0x3333333333333333333333333333333333333333",
    DOT_ASSET.address,
    gateway.toJobId("weekly-digest"),
    2_500_000_000_000_000_000n
  ]]);
  assert.equal(receipt.source, "agent_account_recurring_template_cancel");
  assert.equal(receipt.amountRaw, "2500000000000000000");
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
  const transferAuthorization = {
    nonce: "42",
    deadline: "2000000000",
    signature: `0x${"1".repeat(130)}`
  };
  await gateway.sendToAgent(wallet, recipient, "USDC", 0.125, transferAuthorization);

  assert.deepEqual(calls, [
    ["reserveForJob", wallet, USDC_TRUST_ASSET.address, 1_250_000n],
    ["allocateIdleFunds", wallet, gateway.normalizeStrategyId("usdc-yield"), 2_500_000n],
    ["deallocateIdleFunds", wallet, gateway.normalizeStrategyId("usdc-yield"), 750_000n],
    ["borrow", USDC_TRUST_ASSET.address, 3_000_000n],
    ["repay", USDC_TRUST_ASSET.address, 1_500_000n],
    ["sendToAgentFor", wallet, recipient, USDC_TRUST_ASSET.address, 125_000n, 42n, 2_000_000_000n, transferAuthorization.signature]
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
        queuedBy: "0x2222222222222222222222222222222222222222",
        status: 1,
        settledAssets: 250_000n,
        settledShares: 100_000n,
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: `0x${"0".repeat(64)}`,
        createdAt: 10n,
        updatedAt: 12n
      };
    },
    async getRequestParameters(id) {
      assert.equal(id, requestId);
      return {
        sellAmount: 100_000n,
        minimumOutput: 95_000n,
        maxFeePerLeg: 40_000n,
        dispatchDeadline: 1_785_919_032n
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
  const parameters = await gateway.getXcmRequestParameters(requestId);
  const strategyRequest = await gateway.getStrategyRequest(requestId);

  assert.equal(xcmRequest.requestedAssets, 1.25);
  assert.equal(xcmRequest.requestedAssetsRaw, "1250000");
  assert.equal(xcmRequest.requestedShares, 0.5);
  assert.equal(xcmRequest.nonce, 7);
  assert.equal(xcmRequest.queuedBy, "0x2222222222222222222222222222222222222222");
  assert.equal(xcmRequest.nonceRaw, "7");
  assert.equal(xcmRequest.createdAt, 10);
  assert.equal(xcmRequest.createdAtRaw, "10");
  assert.equal(xcmRequest.updatedAt, 12);
  assert.equal(xcmRequest.updatedAtRaw, "12");
  assert.equal(xcmRequest.settledAssets, 0.25);
  assert.deepEqual(parameters, {
    requestId,
    sellAmountRaw: "100000",
    minimumOutputRaw: "95000",
    maxFeePerLegRaw: "40000",
    dispatchDeadlineRaw: "1785919032"
  });
  assert.equal(strategyRequest.requestedAssets, 1.25);
  assert.equal(strategyRequest.requestedAssetsRaw, "1250000");
  assert.equal(strategyRequest.settledShares, 0.1);
  assert.equal(strategyRequest.settledSharesRaw, "100000");
});

test("async XCM request reader preserves unsafe uint64 metadata as raw strings", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const requestId = `0x${"2".repeat(64)}`;
  const unsafeNonce = BigInt(Number.MAX_SAFE_INTEGER) + 42n;
  const unsafeCreatedAt = BigInt(Number.MAX_SAFE_INTEGER) + 100n;
  const unsafeUpdatedAt = BigInt(Number.MAX_SAFE_INTEGER) + 101n;
  gateway.xcmWrapperContract = {
    async getRequest(id) {
      assert.equal(id, requestId);
      return {
        context: {
          strategyId: encodeBytes32String("USDC"),
          kind: 0,
          account: "0x3333333333333333333333333333333333333333",
          asset: USDC_TRUST_ASSET.address,
          recipient: "0x4444444444444444444444444444444444444444",
          assets: 1n,
          shares: 1n,
          nonce: unsafeNonce
        },
        status: 1,
        settledAssets: 0n,
        settledShares: 0n,
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: `0x${"0".repeat(64)}`,
        createdAt: unsafeCreatedAt,
        updatedAt: unsafeUpdatedAt
      };
    }
  };

  const xcmRequest = await gateway.getXcmRequest(requestId);

  assert.equal(xcmRequest.nonce, unsafeNonce.toString());
  assert.equal(xcmRequest.nonceRaw, unsafeNonce.toString());
  assert.equal(xcmRequest.createdAt, unsafeCreatedAt.toString());
  assert.equal(xcmRequest.createdAtRaw, unsafeCreatedAt.toString());
  assert.equal(xcmRequest.updatedAt, unsafeUpdatedAt.toString());
  assert.equal(xcmRequest.updatedAtRaw, unsafeUpdatedAt.toString());
});

test("finalizeXcmRequest rejects successful strategy withdrawals with zero settled assets before tx", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const requestId = `0x${"2".repeat(64)}`;
  const account = "0x3333333333333333333333333333333333333333";
  const recipient = "0x4444444444444444444444444444444444444444";
  let settlementRelayed = false;

  gateway.signer = {};
  gateway.accountContract = {
    async strategyRequests(id) {
      assert.equal(id, requestId);
      return {
        strategyId: encodeBytes32String("USDC"),
        adapter: "0x5555555555555555555555555555555555555555",
        account,
        asset: USDC_TRUST_ASSET.address,
        recipient,
        kind: 1,
        status: 1,
        requestedAssets: 0n,
        requestedShares: 500_000n,
        settledAssets: 0n,
        settledShares: 0n,
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: `0x${"0".repeat(64)}`,
        settled: false
      };
    },
    async settleStrategyRequest() {
      settlementRelayed = true;
      return { async wait() {} };
    }
  };

  await assert.rejects(
    () => gateway.finalizeXcmRequest(requestId, { status: "succeeded", settledAssets: 0, settledShares: 0 }),
    ValidationError
  );
  assert.equal(settlementRelayed, false);
});

test("finalizeXcmRequest preserves exact uint256 settlement amounts", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const requestId = `0x${"3".repeat(64)}`;
  const account = "0x3333333333333333333333333333333333333333";
  const recipient = "0x4444444444444444444444444444444444444444";
  const settledAssets = "9007199254740993";
  const settledShares = "18446744073709551616";
  const calls = [];

  gateway.signer = {};
  gateway.getStrategyAdapterTotals = async () => ({
    totalAssets: BigInt(settledAssets),
    totalShares: BigInt(settledShares)
  });
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
        requestedAssets: 1n,
        requestedShares: 0n,
        settledAssets: 0n,
        settledShares: 0n,
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: `0x${"0".repeat(64)}`,
        settled: false
      };
    },
    async settleStrategyRequest(...args) {
      calls.push(args);
      return { async wait() {} };
    }
  };
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
          assets: 1n,
          shares: 0n,
          nonce: 7n
        },
        status: 2,
        settledAssets: BigInt(settledAssets),
        settledShares: BigInt(settledShares),
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: `0x${"0".repeat(64)}`,
        createdAt: 10n,
        updatedAt: 12n
      };
    }
  };

  await gateway.finalizeXcmRequest(requestId, {
    status: "succeeded",
    settledAssets,
    settledShares
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], 9007199254740993n);
  assert.equal(calls[0][3], 18446744073709551616n);
});

test("finalizeXcmRequest routes treasury-staged requests through the configured adapter", async () => {
  const adapter = "0x631A09913B2403B18b2B659a1397916621b29b4c";
  const treasury = "0x01E6eed856e989201F4FF6346E18EAb7e46C874C";
  const gateway = new BlockchainGateway({
    enabled: false,
    supportedAssets: [USDC_TRUST_ASSET],
    hydrationUsdcAdapterAddress: adapter
  });
  const requestId = `0x${"9d".repeat(32)}`;
  const zero = `0x${"0".repeat(64)}`;
  const adapterCalls = [];
  let settled = false;
  let wrapperDirectCalled = false;

  gateway.signer = {};
  gateway.getStrategyAdapterTotals = async () => ({ totalAssets: 0n, totalShares: 0n });
  gateway.accountContract = {
    async strategyRequests() {
      return { account: "0x0000000000000000000000000000000000000000" };
    }
  };
  gateway.xcmWrapperContract = {
    async getRequest(id) {
      assert.equal(id, requestId);
      return {
        context: {
          strategyId: encodeBytes32String("HYDRATION_USDC_V1"),
          kind: 0,
          account: treasury,
          asset: USDC_TRUST_ASSET.address,
          recipient: treasury,
          assets: 150_000n,
          shares: 0n,
          nonce: 2n
        },
        queuedBy: adapter,
        status: settled ? 2 : 1,
        settledAssets: settled ? 100_000n : 0n,
        settledShares: settled ? 100_000n : 0n,
        remoteRef: zero,
        failureCode: zero,
        createdAt: 10n,
        updatedAt: 12n
      };
    },
    async finalizeRequest() {
      wrapperDirectCalled = true;
      throw new Error("operator must not finalize the wrapper directly");
    }
  };
  gateway.hydrationUsdcAdapterContract = {
    async getAdapterRequest(id) {
      assert.equal(id, requestId);
      return {
        kind: 0,
        status: settled ? 2 : 1,
        account: treasury,
        requester: treasury,
        recipient: treasury,
        requestedAssets: 150_000n,
        requestedShares: 0n,
        settledAssets: settled ? 100_000n : 0n,
        settledShares: settled ? 100_000n : 0n,
        remoteRef: zero,
        failureCode: zero,
        settled
      };
    },
    async settleRequest(...args) {
      adapterCalls.push(args);
      return {
        async wait() {
          settled = true;
        }
      };
    }
  };

  const preflight = await gateway.preflightXcmSettlementOutcome(requestId, {
    status: "succeeded",
    settledAssets: "100000",
    settledShares: "100000"
  });
  assert.equal(preflight.strategyBacked, false);
  assert.equal(preflight.adapterBacked, true);

  const result = await gateway.finalizeXcmRequest(requestId, {
    status: "succeeded",
    settledAssets: "100000",
    settledShares: "100000"
  });

  assert.equal(wrapperDirectCalled, false);
  assert.deepEqual(adapterCalls, [[requestId, 2, 100_000n, 100_000n, 0n, zero, zero]]);
  assert.equal(result.settledVia, "strategy_adapter");
  assert.equal(result.adapterRequest.settled, true);
  assert.equal(result.statusLabel, "succeeded");
});

test("preflightXcmSettlementOutcome rejects strategy deposit ratios that the adapter would revert", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const requestId = `0x${"7".repeat(64)}`;
  let settlementRelayed = false;

  gateway.signer = {};
  gateway.getStrategyAdapterTotals = async () => ({
    totalAssets: 10_000_000n,
    totalShares: 5_000_000n
  });
  gateway.accountContract = {
    async strategyRequests() {
      return {
        strategyId: encodeBytes32String("USDC"),
        adapter: "0x5555555555555555555555555555555555555555",
        account: "0x3333333333333333333333333333333333333333",
        asset: USDC_TRUST_ASSET.address,
        recipient: "0x4444444444444444444444444444444444444444",
        kind: 0,
        status: 1,
        requestedAssets: 4_000_000n,
        requestedShares: 0n,
        settledAssets: 0n,
        settledShares: 0n,
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: `0x${"0".repeat(64)}`,
        settled: false
      };
    },
    async settleStrategyRequest() {
      settlementRelayed = true;
      return { async wait() {} };
    }
  };

  await assert.rejects(
    () => gateway.finalizeXcmRequest(requestId, {
      status: "succeeded",
      settledAssets: "4000000",
      settledShares: "3000000"
    }),
    /settledShares=2000000/u
  );
  assert.equal(settlementRelayed, false);
});

test("preflightXcmSettlementOutcome rejects strategy withdrawals above adapter ratio cap", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const requestId = `0x${"8".repeat(64)}`;
  let settlementRelayed = false;

  gateway.signer = {};
  gateway.getStrategyAdapterTotals = async () => ({
    totalAssets: 10_000_000n,
    totalShares: 5_000_000n
  });
  gateway.accountContract = {
    async strategyRequests() {
      return {
        strategyId: encodeBytes32String("USDC"),
        adapter: "0x5555555555555555555555555555555555555555",
        account: "0x3333333333333333333333333333333333333333",
        asset: USDC_TRUST_ASSET.address,
        recipient: "0x4444444444444444444444444444444444444444",
        kind: 1,
        status: 1,
        requestedAssets: 0n,
        requestedShares: 2_000_000n,
        settledAssets: 0n,
        settledShares: 0n,
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: `0x${"0".repeat(64)}`,
        settled: false
      };
    },
    async settleStrategyRequest() {
      settlementRelayed = true;
      return { async wait() {} };
    }
  };

  await assert.rejects(
    () => gateway.finalizeXcmRequest(requestId, {
      status: "succeeded",
      settledAssets: "4000001",
      settledShares: "0"
    }),
    /maxAssets=4000000/u
  );
  assert.equal(settlementRelayed, false);
});

test("preflightXcmSettlementOutcome returns contract-ratio metadata for matching outcomes", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const requestId = `0x${"9".repeat(64)}`;

  gateway.getStrategyAdapterTotals = async () => ({
    totalAssets: 10_000_000n,
    totalShares: 5_000_000n
  });
  gateway.accountContract = {
    async strategyRequests() {
      return {
        strategyId: encodeBytes32String("USDC"),
        adapter: "0x5555555555555555555555555555555555555555",
        account: "0x3333333333333333333333333333333333333333",
        asset: USDC_TRUST_ASSET.address,
        recipient: "0x4444444444444444444444444444444444444444",
        kind: 0,
        status: 1,
        requestedAssets: 4_000_000n,
        requestedShares: 0n,
        settledAssets: 0n,
        settledShares: 0n,
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: `0x${"0".repeat(64)}`,
        settled: false
      };
    }
  };

  const preflight = await gateway.preflightXcmSettlementOutcome(requestId, {
    status: "succeeded",
    settledAssets: "4000000",
    settledShares: "2000000"
  });

  assert.equal(preflight.ok, true);
  assert.equal(preflight.strategyBacked, true);
  assert.equal(preflight.settlementPreflight.expectedSharesRaw, "2000000");
});

test("quoteStrategySharesForAssets uses the adapter floor formula", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  gateway.getStrategyAdapterTotals = async () => ({
    totalAssets: 3n,
    totalShares: 2n
  });

  const shares = await gateway.quoteStrategySharesForAssets({ adapter: "0x5555555555555555555555555555555555555555" }, 10n);

  assert.equal(shares, 6n);
});

test("strategy settlement preflight matches adapter floor math across representative ratios", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const adapter = "0x5555555555555555555555555555555555555555";
  const cases = [
    { settledAssets: 1n, totalAssets: 3n, totalShares: 2n },
    { settledAssets: 1_000_000n, totalAssets: 10_000_000n, totalShares: 25_000_000n },
    { settledAssets: 9_007_199_254_740_993n, totalAssets: 12_345_678_901_234_567n, totalShares: 8_765_432_109_876_543n },
    { settledAssets: 42n, totalAssets: 0n, totalShares: 0n }
  ];

  for (const vector of cases) {
    gateway.getStrategyAdapterTotals = async () => ({
      totalAssets: vector.totalAssets,
      totalShares: vector.totalShares
    });
    const expectedShares = vector.totalAssets <= 0n || vector.totalShares <= 0n
      ? vector.settledAssets
      : (vector.settledAssets * vector.totalShares) / vector.totalAssets;

    const depositPreflight = await gateway.preflightStrategySettlementRatio(
      { kind: 0, adapter },
      2,
      vector.settledAssets,
      expectedShares
    );
    assert.equal(depositPreflight.expectedSharesRaw, expectedShares.toString());

    const requestedShares = expectedShares + 1n;
    const maxAssets = vector.totalShares <= 0n
      ? 0n
      : (requestedShares * vector.totalAssets) / vector.totalShares;
    const withdrawPreflight = await gateway.preflightStrategySettlementRatio(
      { kind: 1, adapter, requestedSharesRaw: requestedShares.toString() },
      2,
      maxAssets,
      0n
    );
    assert.equal(withdrawPreflight.maxAssetsRaw, maxAssets.toString());
  }
});

test("finalizeXcmRequest skips matching already-settled strategy requests", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const requestId = `0x${"5".repeat(64)}`;
  const account = "0x3333333333333333333333333333333333333333";
  const recipient = "0x4444444444444444444444444444444444444444";
  let settlementRelayed = false;

  gateway.signer = {};
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
        status: 2,
        requestedAssets: 1n,
        requestedShares: 0n,
        settledAssets: 5_000_000n,
        settledShares: 7_000_000n,
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: `0x${"0".repeat(64)}`,
        settled: true
      };
    },
    async settleStrategyRequest() {
      settlementRelayed = true;
      return { async wait() {} };
    }
  };
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
          assets: 1n,
          shares: 0n,
          nonce: 7n
        },
        status: 2,
        settledAssets: 5_000_000n,
        settledShares: 7_000_000n,
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: `0x${"0".repeat(64)}`,
        createdAt: 10n,
        updatedAt: 12n
      };
    }
  };

  const finalized = await gateway.finalizeXcmRequest(requestId, {
    status: "succeeded",
    settledAssets: "5000000",
    settledShares: "7000000"
  });

  assert.equal(settlementRelayed, false);
  assert.equal(finalized.alreadySettled, true);
  assert.equal(finalized.settledVia, "agent_account");
  assert.equal(finalized.strategyRequest.settled, true);
});

test("finalizeXcmRequest rejects conflicting already-settled strategy replays before tx", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const requestId = `0x${"6".repeat(64)}`;
  let settlementRelayed = false;

  gateway.signer = {};
  gateway.accountContract = {
    async strategyRequests() {
      return {
        strategyId: encodeBytes32String("USDC"),
        adapter: "0x5555555555555555555555555555555555555555",
        account: "0x3333333333333333333333333333333333333333",
        asset: USDC_TRUST_ASSET.address,
        recipient: "0x4444444444444444444444444444444444444444",
        kind: 0,
        status: 3,
        requestedAssets: 1n,
        requestedShares: 0n,
        settledAssets: 0n,
        settledShares: 0n,
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: encodeBytes32String("FAILED"),
        settled: true
      };
    },
    async settleStrategyRequest() {
      settlementRelayed = true;
      return { async wait() {} };
    }
  };

  await assert.rejects(
    () => gateway.finalizeXcmRequest(requestId, {
      status: "succeeded",
      settledAssets: "5000000",
      settledShares: "7000000"
    }),
    ValidationError
  );
  assert.equal(settlementRelayed, false);
});

test("finalizeXcmRequest rejects unsafe numeric settlement amounts before tx", async () => {
  const gateway = new BlockchainGateway({ enabled: false, supportedAssets: [USDC_TRUST_ASSET] });
  const requestId = `0x${"4".repeat(64)}`;
  let settlementRelayed = false;

  gateway.signer = {};
  gateway.accountContract = {
    async strategyRequests() {
      return {
        strategyId: encodeBytes32String("USDC"),
        adapter: "0x5555555555555555555555555555555555555555",
        account: "0x3333333333333333333333333333333333333333",
        asset: USDC_TRUST_ASSET.address,
        recipient: "0x4444444444444444444444444444444444444444",
        kind: 0,
        status: 1,
        requestedAssets: 1n,
        requestedShares: 0n,
        settledAssets: 0n,
        settledShares: 0n,
        remoteRef: `0x${"0".repeat(64)}`,
        failureCode: `0x${"0".repeat(64)}`,
        settled: false
      };
    },
    async settleStrategyRequest() {
      settlementRelayed = true;
      return { async wait() {} };
    }
  };

  await assert.rejects(
    () => gateway.finalizeXcmRequest(requestId, {
      status: "succeeded",
      settledAssets: Number.MAX_SAFE_INTEGER + 2,
      settledShares: 1
    }),
    ValidationError
  );
  assert.equal(settlementRelayed, false);
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
    { refTime: 7n, proofSize: 0n }
  );
});

test("resolveXcmMaxWeight preserves exact uint64 string weights", async () => {
  const gateway = new BlockchainGateway({ enabled: false });
  const refTime = "9007199254740993";

  assert.deepEqual(
    await gateway.resolveXcmMaxWeight(
      { refTime, proofSize: "18446744073709551615" },
      "0x1234",
      "requestStrategyDeposit"
    ),
    { refTime: 9007199254740993n, proofSize: 18446744073709551615n }
  );
});

test("resolveXcmMaxWeight rejects unsafe numeric weights before rounding", async () => {
  const gateway = new BlockchainGateway({ enabled: false });

  await assert.rejects(
    () => gateway.resolveXcmMaxWeight(
      { refTime: Number.MAX_SAFE_INTEGER + 2, proofSize: 0 },
      "0x1234",
      "requestStrategyDeposit"
    ),
    ValidationError
  );
});

test("resolveXcmMaxWeight rejects weights above uint64", async () => {
  const gateway = new BlockchainGateway({ enabled: false });

  await assert.rejects(
    () => gateway.resolveXcmMaxWeight(
      { refTime: "18446744073709551616", proofSize: 0 },
      "0x1234",
      "requestStrategyDeposit"
    ),
    ValidationError
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
    { refTime: 70n, proofSize: 4n }
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
    specHash: `0x${"1".repeat(64)}`,
    schemaHash: `0x${"0".repeat(64)}`,
    schemaUrl: "",
    schemaIssuer: "0x0000000000000000000000000000000000000000",
    schemaSignature: "0x",
    protocolFeeWaived: false
  }]);
});

test("createSinglePayoutJobForJob forwards registered external schema metadata", async () => {
  const gateway = gatewayWithDot();
  const calls = [];
  gateway.escrowContract = {
    async createSinglePayoutJob() {
      throw new Error("plain rc1 signature should not be used");
    },
    [CREATE_SINGLE_PAYOUT_WITH_SCHEMA]: async (...args) => {
      calls.push(args);
      return { async wait() {} };
    }
  };
  const schemaHash = `0x${"2".repeat(64)}`;
  const schemaIssuer = "0x4444444444444444444444444444444444444444";
  const schemaSignature = "0x1234";

  await gateway.createSinglePayoutJobForJob(
    {
      outputSchemaRef: "schema://jobs/external-output",
      schemaRegistrations: [{
        schemaRef: "schema://jobs/external-output",
        registrationVersion: EXTERNAL_SCHEMA_EIP712_VERSION,
        schemaHash,
        schemaUrl: "https://schemas.example.com/external-output.json",
        schemaIssuer,
        signature: schemaSignature
      }]
    },
    "rc1",
    gateway.toJobId("external-output-job"),
    DOT_ASSET.address,
    5_000_000_000_000_000_000n,
    0,
    0,
    3600,
    encodeBytes32String("BENCH"),
    encodeBytes32String("EXT"),
    `0x${"1".repeat(64)}`
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][9], {
    schemaHash,
    schemaUrl: "https://schemas.example.com/external-output.json",
    schemaIssuer,
    schemaSignature
  });
});

test("fee-waived curated jobs retain their registered external schema", async () => {
  const gateway = gatewayWithDot();
  const calls = [];
  gateway.escrowContract = {
    [CREATE_SINGLE_PAYOUT_FEE_WAIVED_WITH_SCHEMA]: async (...args) => {
      calls.push(args);
      return { async wait() {} };
    }
  };
  const schemaHash = `0x${"3".repeat(64)}`;
  const schemaIssuer = "0x4444444444444444444444444444444444444444";
  const registration = {
    schemaRef: "schema://jobs/curated-output",
    registrationVersion: EXTERNAL_SCHEMA_EIP712_VERSION,
    schemaHash,
    schemaUrl: "https://schemas.example.com/curated-output.json",
    schemaIssuer,
    signature: "0x1234"
  };

  await gateway.createSinglePayoutJobForJob(
    {
      onboardingWaiverEligible: true,
      outputSchemaRef: registration.schemaRef,
      schemaRegistrations: [registration]
    },
    "rc1",
    gateway.toJobId("curated-output-job"),
    DOT_ASSET.address,
    5_000_000_000_000_000_000n,
    0,
    0,
    3600,
    encodeBytes32String("BENCH"),
    encodeBytes32String("CURATED"),
    `0x${"1".repeat(64)}`
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][9], {
    schemaHash,
    schemaUrl: registration.schemaUrl,
    schemaIssuer,
    schemaSignature: registration.signature
  });
});

test("fee-waived canary jobs use the v1 creation path while v1 remains live", async () => {
  const gateway = gatewayWithDot();
  const calls = [];
  gateway.v1EscrowContract = {
    async createSinglePayoutJob(...args) {
      calls.push(args);
      return { async wait() {} };
    }
  };
  gateway.escrowContract = {
    async createSinglePayoutJobFeeWaived() {
      throw new Error("v2 fee-waived creation must not be broadcast to EscrowCore v1");
    }
  };

  await gateway.createSinglePayoutJobForJob(
    { onboardingWaiverEligible: true },
    "v1",
    gateway.toJobId("worker-canary-v1"),
    DOT_ASSET.address,
    100_000_000_000_000_000n,
    0,
    0,
    3600,
    encodeBytes32String("BENCH"),
    encodeBytes32String("CODING"),
    `0x${"1".repeat(64)}`
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 9);
});

test("v1 drain routing sends lifecycle writes to the old EscrowCore", async () => {
  const legacyEscrowCoreAddress = "0x1111111111111111111111111111111111111111";
  const gateway = new BlockchainGateway({
    enabled: false,
    escrowCoreAddress: "0x2222222222222222222222222222222222222222",
    legacyEscrowCoreAddress
  });
  const calls = [];
  gateway.signer = { async getAddress() { return "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; } };
  gateway.escrowContract = {
    async claimJob() {
      throw new Error("v1 job must not be written through v2");
    }
  };
  gateway.drainingEscrowContract = {
    async claimJobFor(...args) {
      calls.push(args);
      return { async wait() { return { blockNumber: 9, status: 1 }; } };
    }
  };
  gateway.readEscrowJob = async () => ({
    escrowAddress: legacyEscrowCoreAddress,
    state: 1
  });

  await gateway.claimJob("draining-v1-job", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.deepEqual(calls, [[
    gateway.toJobId("draining-v1-job"),
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  ]]);
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
