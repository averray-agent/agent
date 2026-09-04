import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  REFERENCE_STRATEGY_ID,
  VENUE_PAIR_BINDINGS,
  VENUE_PAIR_FINALITY_CONFIRMATIONS,
  VENUE_PAIR_STRATEGY_NAME,
  assertV21Pool,
  buildVenuePairPlan,
  deriveStrategyIdentity,
  executeVenuePairDeployment,
  finalizePairEvidence,
  parseArgs,
  runVenuePair,
} from "./deploy-venue-pair.mjs";

const SIGNER = "0x5a6836c6D4d293F6E5377E6c28054F4171915813";
const LOSS_REPORTER = "0x0000000000000000000000000000000000000001";

const artifacts = {
  lane: {
    abi: [{
      type: "constructor",
      stateMutability: "nonpayable",
      inputs: [
        { name: "policy_", type: "address" },
        { name: "asset_", type: "address" },
        { name: "strategyId_", type: "bytes32" },
        { name: "wrapper_", type: "address" },
        { name: "agentAccountCore_", type: "address" },
      ],
    }],
    bytecode: { object: "0x60006000" },
  },
  adapter: {
    abi: [{
      type: "constructor",
      stateMutability: "nonpayable",
      inputs: [
        { name: "pool_", type: "address" },
        { name: "lane_", type: "address" },
      ],
    }],
    bytecode: { object: "0x60016000" },
  },
};

const manifest = {
  profile: "mainnet",
  contracts: {
    treasuryPolicy: VENUE_PAIR_BINDINGS.policy,
    token: VENUE_PAIR_BINDINGS.asset,
    xcmWrapper: VENUE_PAIR_BINDINGS.wrapper,
    depositPoolV2: VENUE_PAIR_BINDINGS.pool,
    depositPoolV21: VENUE_PAIR_BINDINGS.pool,
    legacyDepositPoolV2: VENUE_PAIR_BINDINGS.legacyPool,
  },
};

function pairState(plan) {
  return {
    lane: {
      agentAccountCore: plan.adapter.predictedAddress,
      asset: VENUE_PAIR_BINDINGS.asset,
      policy: VENUE_PAIR_BINDINGS.policy,
      strategyId: plan.strategy.id,
      wrapper: VENUE_PAIR_BINDINGS.wrapper,
    },
    adapter: {
      lane: plan.lane.predictedAddress,
      pool: VENUE_PAIR_BINDINGS.pool,
      asset: VENUE_PAIR_BINDINGS.asset,
      policy: VENUE_PAIR_BINDINGS.policy,
      lossReporter: LOSS_REPORTER,
    },
  };
}

async function planAt(nonce = 17) {
  return buildVenuePairPlan({ deployer: SIGNER, nonce, artifacts });
}

test("wrong nonce prediction cannot deploy or report venue-pair success", async () => {
  const plan = await planAt();
  plan.lane.constructorArgs.agentAccountCore = plan.lane.predictedAddress;
  let broadcasts = 0;

  await assert.rejects(
    executeVenuePairDeployment({
      provider: {
        async getTransactionCount() { return plan.startNonce; },
      },
      signer: {
        async sendTransaction() {
          broadcasts += 1;
          throw new Error("must not reach broadcast");
        },
      },
      plan,
    }),
    (error) => error?.code === "venue_pair_scrap"
      && /SCRAP PAIR/u.test(error.message)
      && /constructor cycle mismatch/u.test(error.message),
  );
  assert.equal(broadcasts, 0);
});

test("legacy DepositPool v2 is refused as the venue-pair pool", () => {
  assert.throws(
    () => assertV21Pool(VENUE_PAIR_BINDINGS.legacyPool),
    /Legacy DepositPool v2 is refused/u,
  );
  assert.equal(assertV21Pool(VENUE_PAIR_BINDINGS.pool), VENUE_PAIR_BINDINGS.pool);
});

test("strategy id is derived only after the live ASCII encoding round-trip", () => {
  const identity = deriveStrategyIdentity();
  assert.equal(identity.ascii, VENUE_PAIR_STRATEGY_NAME);
  assert.equal(identity.roundTrip, VENUE_PAIR_STRATEGY_NAME);
  assert.equal(identity.reference.expectedId, REFERENCE_STRATEGY_ID);
  assert.equal(identity.reference.derivedId, REFERENCE_STRATEGY_ID);
  assert.equal(identity.reference.roundTrip, "HYDRATION_USDC_POOL_V1");
  assert.throws(
    () => deriveStrategyIdentity("AAC_IDLE_HYDRATION_V2"),
    /must be exactly AAC_IDLE_HYDRATION_V1/u,
  );
});

test("dry run signs nothing and prints the complete two-contract plan", async () => {
  const lines = [];
  let signerResolved = 0;
  const args = parseArgs(["--expected-signer", SIGNER]);
  const result = await runVenuePair({
    args,
    manifest,
    rpcContext: {
      provider: {
        async getTransactionCount(address, state) {
          assert.equal(address, SIGNER);
          assert.equal(state, "pending");
          return 23;
        },
      },
    },
    artifacts,
    resolveSignerImpl: async () => {
      signerResolved += 1;
      return { address: SIGNER, signer: null, backend: "dry-run" };
    },
    log: (line) => lines.push(line),
  });

  assert.equal(signerResolved, 1);
  assert.equal(result.evidence, null);
  assert.equal(result.plan.lane.nonce, 23);
  assert.equal(result.plan.adapter.nonce, 24);
  const output = lines.join("\n");
  assert.match(output, /# VENUE PAIR DEPLOYMENT PLAN/u);
  assert.match(output, /HydrationUsdcAdapterV22/u);
  assert.match(output, /HydrationDepositPoolAdapter/u);
  assert.match(output, /agentAccountCore/u);
  assert.match(output, /AAC_IDLE_HYDRATION_V1/u);
  assert.match(output, /DRY RUN ONLY — no signature requested and no transaction broadcast/u);

  const source = await readFile(new URL("./deploy-venue-pair.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /encodeFunctionData\(["']setVenueAdapter/u);
  assert.doesNotMatch(source, /\.setVenueAdapter\s*\(/u);
});

test("committed evidence requires 12 canonical confirmations and a stable block hash", async () => {
  const plan = await planAt();
  const laneHash = `0x${"11".repeat(32)}`;
  const adapterHash = `0x${"22".repeat(32)}`;
  const laneBlockHash = `0x${"aa".repeat(32)}`;
  const adapterBlockHash = `0x${"bb".repeat(32)}`;
  const laneReceipt = {
    hash: laneHash,
    status: 1,
    blockNumber: 100,
    blockHash: laneBlockHash,
    contractAddress: plan.lane.predictedAddress,
  };
  const adapterReceipt = {
    hash: adapterHash,
    status: 1,
    blockNumber: 101,
    blockHash: adapterBlockHash,
    contractAddress: plan.adapter.predictedAddress,
  };
  const fullState = pairState(plan);
  const evidence = await finalizePairEvidence({
    provider: {},
    plan,
    laneInitialReceipt: laneReceipt,
    adapterInitialReceipt: adapterReceipt,
    confirmImpl: async ({ initialReceipt, confirmations, readPostState }) => ({
      receipt: initialReceipt,
      block: { number: initialReceipt.blockNumber, hash: initialReceipt.blockHash },
      postState: await readPostState(initialReceipt.blockNumber),
      confirmationsRequired: confirmations,
      confirmationsWaited: confirmations,
      rereadBlockHash: initialReceipt.blockHash,
      receiptReconfirmed: true,
      postStateReconfirmed: true,
    }),
    readLaneStateImpl: async () => fullState.lane,
    readPairStateImpl: async () => fullState,
    log: () => {},
  });
  assert.equal(VENUE_PAIR_FINALITY_CONFIRMATIONS, 12);
  assert.equal(evidence.lane.finality.confirmationsRequired, 12);
  assert.equal(evidence.adapter.finality.confirmationsWaited, 12);
  assert.equal(evidence.adapter.finality.receiptReconfirmed, true);
  assert.equal(evidence.adapter.finality.postStateReconfirmed, true);

  const movedHash = `0x${"cc".repeat(32)}`;
  await assert.rejects(
    finalizePairEvidence({
      provider: {
        async getTransactionReceipt() { return { ...laneReceipt }; },
        async getBlock() { return { number: laneReceipt.blockNumber, hash: movedHash }; },
        async getBlockNumber() { return 111; },
      },
      plan,
      laneInitialReceipt: laneReceipt,
      adapterInitialReceipt: adapterReceipt,
      readLaneStateImpl: async () => {
        throw new Error("post-state must not be read after a reorg");
      },
      log: () => {},
    }),
    (error) => error?.code === "ceremony_finality_diverged"
      && /REORG WARNING/u.test(error.message)
      && /COMMITTED EVIDENCE WITHHELD/u.test(error.message)
      && error.message.includes(laneBlockHash)
      && error.message.includes(movedHash),
  );
});
