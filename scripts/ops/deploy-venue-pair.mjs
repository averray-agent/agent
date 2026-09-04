#!/usr/bin/env node

/**
 * Deploy the mutually-bound v2.1 Hydration lane and pool adapter.
 *
 * Read-only is the default. The only write mode is:
 *   --commit --use-kms --expected-signer 0x...
 *
 * This script deploys and verifies the pair only. The cold multisig owns the
 * later pool binding; this driver has no pool-binding operation.
 */

import {
  Contract,
  ContractFactory,
  ZeroAddress,
  decodeBytes32String,
  encodeBytes32String,
  getAddress,
  getCreateAddress,
  keccak256,
} from "ethers";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_FINALITY_CONFIRMATIONS,
  FINALITY_TIMEOUT_MS,
  buildFinalityEvidence,
  confirmCanonicalPostState,
  readDeploymentManifest,
  resolveSigner,
} from "./pool-venue-ceremony.mjs";
import {
  createCeremonyRpcContext,
  printCeremonyRpcPreflight,
} from "./ceremony-rpc.mjs";

export const VENUE_PAIR_FINALITY_CONFIRMATIONS = DEFAULT_FINALITY_CONFIRMATIONS;
export const VENUE_PAIR_STRATEGY_NAME = "AAC_IDLE_HYDRATION_V1";
export const REFERENCE_STRATEGY_NAME = "HYDRATION_USDC_POOL_V1";
export const REFERENCE_STRATEGY_ID =
  "0x485944524154494f4e5f555344435f504f4f4c5f563100000000000000000000";
export const VENUE_PAIR_BINDINGS = Object.freeze({
  policy: "0x226F14252A98BD2eA140271647De20132F09AF20",
  asset: "0x0000053900000000000000000000000001200000",
  wrapper: "0xF20b35A3f85EC864127B551ce8A64446fC0ed2Bc",
  pool: "0x9B35A102d656Fb86d798aF81959e09961DEc28E0",
  legacyPool: "0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30",
});

const CONTRACT_ARTIFACTS = Object.freeze({
  lane: ["HydrationUsdcAdapterV22.sol", "HydrationUsdcAdapterV22"],
  adapter: ["HydrationDepositPoolAdapter.sol", "HydrationDepositPoolAdapter"],
});

const LANE_READ_ABI = [
  "function agentAccountCore() view returns (address)",
  "function asset() view returns (address)",
  "function policy() view returns (address)",
  "function strategyId() view returns (bytes32)",
  "function xcmWrapper() view returns (address)",
];

const ADAPTER_READ_ABI = [
  "function lane() view returns (address)",
  "function pool() view returns (address)",
  "function asset() view returns (address)",
  "function policy() view returns (address)",
  "function lossReporter() view returns (address)",
];

function checkedAddress(label, value) {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${label} must be a 20-byte EVM address.`);
  }
}

function sameAddress(left, right) {
  return checkedAddress("address", left) === checkedAddress("address", right);
}

function artifactBytecode(artifact, label) {
  const value = artifact?.bytecode?.object ?? artifact?.bytecode;
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value) || value === "0x") {
    throw new Error(`${label} artifact has no deployable bytecode.`);
  }
  return value;
}

function serialize(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

export function parseArgs(argv) {
  const args = {
    profile: "mainnet",
    artifacts: "out",
    expectedSigner: undefined,
    useKms: false,
    commit: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      return value;
    };
    if (arg === "--profile") args.profile = next();
    else if (arg === "--artifacts") args.artifacts = next();
    else if (arg === "--expected-signer") args.expectedSigner = next();
    else if (arg === "--use-kms") args.useKms = true;
    else if (arg === "--commit") args.commit = true;
    else if (arg === "--dry-run") args.commit = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.help && !args.expectedSigner) {
    throw new Error("--expected-signer is mandatory in dry-run and commit modes.");
  }
  if (args.commit && !args.useKms) {
    throw new Error("--commit requires --use-kms; raw private keys are not accepted.");
  }
  return args;
}

/**
 * Establish the bytes32 convention against the already-live strategy before
 * deriving the new id. Both labels must round-trip without truncation.
 */
export function deriveStrategyIdentity(name = VENUE_PAIR_STRATEGY_NAME) {
  const referenceDerived = encodeBytes32String(REFERENCE_STRATEGY_NAME);
  if (referenceDerived.toLowerCase() !== REFERENCE_STRATEGY_ID.toLowerCase()) {
    throw new Error("Known live strategy id no longer reproduces from its ASCII name.");
  }
  if (decodeBytes32String(referenceDerived) !== REFERENCE_STRATEGY_NAME) {
    throw new Error("Known live strategy id does not round-trip to its ASCII name.");
  }
  if (name !== VENUE_PAIR_STRATEGY_NAME) {
    throw new Error(`Strategy name must be exactly ${VENUE_PAIR_STRATEGY_NAME}.`);
  }
  const id = encodeBytes32String(name);
  const roundTrip = decodeBytes32String(id);
  if (roundTrip !== name) throw new Error("Derived strategy id failed its ASCII round-trip.");
  return {
    ascii: name,
    id,
    roundTrip,
    reference: {
      ascii: REFERENCE_STRATEGY_NAME,
      expectedId: REFERENCE_STRATEGY_ID,
      derivedId: referenceDerived,
      roundTrip: decodeBytes32String(referenceDerived),
    },
  };
}

export function assertManifestBindings(manifest) {
  if (manifest?.profile !== "mainnet") {
    throw new Error("This venue pair is a mainnet ceremony; --profile must resolve mainnet.");
  }
  const checks = [
    ["contracts.treasuryPolicy", manifest?.contracts?.treasuryPolicy, VENUE_PAIR_BINDINGS.policy],
    ["contracts.token", manifest?.contracts?.token, VENUE_PAIR_BINDINGS.asset],
    ["contracts.xcmWrapper", manifest?.contracts?.xcmWrapper, VENUE_PAIR_BINDINGS.wrapper],
    ["contracts.depositPoolV2", manifest?.contracts?.depositPoolV2, VENUE_PAIR_BINDINGS.pool],
    ["contracts.depositPoolV21", manifest?.contracts?.depositPoolV21, VENUE_PAIR_BINDINGS.pool],
    ["contracts.legacyDepositPoolV2", manifest?.contracts?.legacyDepositPoolV2, VENUE_PAIR_BINDINGS.legacyPool],
  ];
  for (const [label, actual, expected] of checks) {
    if (!sameAddress(actual, expected)) {
      throw new Error(`${label} is ${actual ?? "missing"}; expected ${expected}.`);
    }
  }
  if (sameAddress(manifest.contracts.depositPoolV2, manifest.contracts.legacyDepositPoolV2)) {
    throw new Error("Legacy DepositPool v2 is not a permitted venue-pair target.");
  }
  return VENUE_PAIR_BINDINGS;
}

export function assertV21Pool(pool) {
  const resolved = checkedAddress("pool", pool);
  if (sameAddress(resolved, VENUE_PAIR_BINDINGS.legacyPool)) {
    throw new Error("Legacy DepositPool v2 is refused; this pair is exclusively for v2.1.");
  }
  if (!sameAddress(resolved, VENUE_PAIR_BINDINGS.pool)) {
    throw new Error(`Pool ${resolved} is not the ratified v2.1 pool ${VENUE_PAIR_BINDINGS.pool}.`);
  }
  return resolved;
}

export async function readArtifact(artifactsRoot, [sourceName, contractName]) {
  const path = resolve(artifactsRoot, sourceName, `${contractName}.json`);
  let artifact;
  try {
    artifact = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${contractName} artifact at ${path}: ${error?.message ?? error}`);
  }
  artifactBytecode(artifact, contractName);
  return artifact;
}

export async function buildVenuePairPlan({ deployer, nonce, artifacts, strategyName = VENUE_PAIR_STRATEGY_NAME }) {
  const signer = checkedAddress("deployer", deployer);
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("Pending deployer nonce must be a non-negative safe integer.");
  const pool = assertV21Pool(VENUE_PAIR_BINDINGS.pool);
  const strategy = deriveStrategyIdentity(strategyName);
  const laneAddress = getCreateAddress({ from: signer, nonce });
  const adapterAddress = getCreateAddress({ from: signer, nonce: nonce + 1 });
  const laneArgs = {
    policy: VENUE_PAIR_BINDINGS.policy,
    asset: VENUE_PAIR_BINDINGS.asset,
    strategyId: strategy.id,
    wrapper: VENUE_PAIR_BINDINGS.wrapper,
    agentAccountCore: adapterAddress,
  };
  const adapterArgs = { pool, lane: laneAddress };
  const laneFactory = new ContractFactory(
    artifacts.lane.abi,
    artifactBytecode(artifacts.lane, "HydrationUsdcAdapterV22"),
  );
  const adapterFactory = new ContractFactory(
    artifacts.adapter.abi,
    artifactBytecode(artifacts.adapter, "HydrationDepositPoolAdapter"),
  );
  const laneTransaction = await laneFactory.getDeployTransaction(...Object.values(laneArgs));
  const adapterTransaction = await adapterFactory.getDeployTransaction(...Object.values(adapterArgs));
  const plan = {
    schemaVersion: 1,
    mode: "deploy-and-verify-only",
    chain: "polkadot-hub-mainnet",
    deployer: signer,
    startNonce: nonce,
    strategy,
    lane: {
      contract: "HydrationUsdcAdapterV22",
      nonce,
      predictedAddress: laneAddress,
      constructorArgs: laneArgs,
      initCodeHash: keccak256(laneTransaction.data),
      initCodeBytes: (laneTransaction.data.length - 2) / 2,
      transaction: { data: laneTransaction.data },
    },
    adapter: {
      contract: "HydrationDepositPoolAdapter",
      nonce: nonce + 1,
      predictedAddress: adapterAddress,
      constructorArgs: adapterArgs,
      initCodeHash: keccak256(adapterTransaction.data),
      initCodeBytes: (adapterTransaction.data.length - 2) / 2,
      transaction: { data: adapterTransaction.data },
    },
    finality: { confirmationsRequired: VENUE_PAIR_FINALITY_CONFIRMATIONS },
    nextStep: "cold multisig review and setVenueAdapter is deliberately outside this driver",
  };
  assertSelfCheckingCycle(plan);
  return plan;
}

export function assertSelfCheckingCycle(plan) {
  const expectedLane = getCreateAddress({ from: plan.deployer, nonce: plan.startNonce });
  const expectedAdapter = getCreateAddress({ from: plan.deployer, nonce: plan.startNonce + 1 });
  const failures = [];
  if (!sameAddress(plan.lane.predictedAddress, expectedLane)) failures.push("lane CREATE address");
  if (!sameAddress(plan.adapter.predictedAddress, expectedAdapter)) failures.push("adapter CREATE address");
  if (!sameAddress(plan.lane.constructorArgs.agentAccountCore, expectedAdapter)) {
    failures.push("lane.agentAccountCore predicted adapter");
  }
  if (!sameAddress(plan.adapter.constructorArgs.lane, expectedLane)) failures.push("adapter.lane deployed lane");
  if (keccak256(plan.lane.transaction.data).toLowerCase() !== plan.lane.initCodeHash.toLowerCase()) {
    failures.push("lane constructor transaction");
  }
  if (keccak256(plan.adapter.transaction.data).toLowerCase() !== plan.adapter.initCodeHash.toLowerCase()) {
    failures.push("adapter constructor transaction");
  }
  assertV21Pool(plan.adapter.constructorArgs.pool);
  if (failures.length > 0) {
    throw new Error(
      `Self-checking constructor cycle mismatch (${failures.join(", ")}); adapter deployment would revert.`,
    );
  }
  return true;
}

export function publicPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    mode: plan.mode,
    chain: plan.chain,
    deployer: plan.deployer,
    startNonce: plan.startNonce,
    strategy: plan.strategy,
    lane: {
      contract: plan.lane.contract,
      nonce: plan.lane.nonce,
      predictedAddress: plan.lane.predictedAddress,
      constructorArgs: plan.lane.constructorArgs,
      initCodeHash: plan.lane.initCodeHash,
      initCodeBytes: plan.lane.initCodeBytes,
    },
    adapter: {
      contract: plan.adapter.contract,
      nonce: plan.adapter.nonce,
      predictedAddress: plan.adapter.predictedAddress,
      constructorArgs: plan.adapter.constructorArgs,
      initCodeHash: plan.adapter.initCodeHash,
      initCodeBytes: plan.adapter.initCodeBytes,
    },
    finality: plan.finality,
    nextStep: plan.nextStep,
  };
}

function contractOverrides(blockTag) {
  return blockTag === undefined ? {} : { blockTag };
}

export async function readLaneState(provider, plan, blockTag) {
  const lane = new Contract(plan.lane.predictedAddress, LANE_READ_ABI, provider);
  const overrides = contractOverrides(blockTag);
  const [agentAccountCore, asset, policy, strategyId, wrapper] = await Promise.all([
    lane.agentAccountCore(overrides),
    lane.asset(overrides),
    lane.policy(overrides),
    lane.strategyId(overrides),
    lane.xcmWrapper(overrides),
  ]);
  return { agentAccountCore, asset, policy, strategyId, wrapper };
}

export async function readPairState(provider, plan, blockTag) {
  const adapter = new Contract(plan.adapter.predictedAddress, ADAPTER_READ_ABI, provider);
  const overrides = contractOverrides(blockTag);
  const [lane, pool, asset, policy, lossReporter, laneState] = await Promise.all([
    adapter.lane(overrides),
    adapter.pool(overrides),
    adapter.asset(overrides),
    adapter.policy(overrides),
    adapter.lossReporter(overrides),
    readLaneState(provider, plan, blockTag),
  ]);
  return { adapter: { lane, pool, asset, policy, lossReporter }, lane: laneState };
}

export function assertLaneState(plan, state) {
  const failures = [];
  if (!sameAddress(state.agentAccountCore, plan.adapter.predictedAddress)) failures.push("lane.agentAccountCore");
  if (!sameAddress(state.asset, VENUE_PAIR_BINDINGS.asset)) failures.push("lane.asset");
  if (!sameAddress(state.policy, VENUE_PAIR_BINDINGS.policy)) failures.push("lane.policy");
  if (!sameAddress(state.wrapper, VENUE_PAIR_BINDINGS.wrapper)) failures.push("lane.xcmWrapper");
  if (String(state.strategyId).toLowerCase() !== plan.strategy.id.toLowerCase()) failures.push("lane.strategyId");
  if (failures.length > 0) throw new Error(`Lane verification failed: ${failures.join(", ")}.`);
  return true;
}

export function assertPairState(plan, state) {
  assertLaneState(plan, state.lane);
  const failures = [];
  if (!sameAddress(state.adapter.lane, plan.lane.predictedAddress)) failures.push("adapter.lane");
  if (!sameAddress(state.adapter.pool, VENUE_PAIR_BINDINGS.pool)) failures.push("adapter.pool");
  if (!sameAddress(state.adapter.asset, VENUE_PAIR_BINDINGS.asset)) failures.push("adapter.asset");
  if (!sameAddress(state.adapter.policy, VENUE_PAIR_BINDINGS.policy)) failures.push("adapter.policy");
  if (sameAddress(state.adapter.lossReporter, ZeroAddress)) failures.push("adapter.lossReporter");
  if (!sameAddress(state.lane.asset, state.adapter.asset)) failures.push("lane.asset == adapter.asset");
  if (!sameAddress(state.lane.policy, state.adapter.policy)) failures.push("lane.policy == adapter.policy");
  if (failures.length > 0) throw new Error(`Pair verification failed: ${failures.join(", ")}.`);
  return true;
}

function assertDeploymentReceipt(receipt, expectedAddress, label) {
  if (!receipt || receipt.status !== 1) throw new Error(`${label} deployment did not succeed.`);
  if (!sameAddress(receipt.contractAddress, expectedAddress)) {
    throw new Error(`${label} deployed at ${receipt.contractAddress}, predicted ${expectedAddress}.`);
  }
}

export async function finalizePairEvidence({
  provider,
  plan,
  laneInitialReceipt,
  adapterInitialReceipt,
  confirmImpl = confirmCanonicalPostState,
  readLaneStateImpl = readLaneState,
  readPairStateImpl = readPairState,
  log = console.error,
}) {
  const laneFinality = await confirmImpl({
    provider,
    transactionHash: laneInitialReceipt.hash,
    initialReceipt: laneInitialReceipt,
    confirmations: VENUE_PAIR_FINALITY_CONFIRMATIONS,
    readPostState: async (blockNumber) => {
      const state = await readLaneStateImpl(provider, plan, blockNumber);
      assertLaneState(plan, state);
      return state;
    },
    log,
  });
  const adapterFinality = await confirmImpl({
    provider,
    transactionHash: adapterInitialReceipt.hash,
    initialReceipt: adapterInitialReceipt,
    confirmations: VENUE_PAIR_FINALITY_CONFIRMATIONS,
    readPostState: async (blockNumber) => {
      const state = await readPairStateImpl(provider, plan, blockNumber);
      assertPairState(plan, state);
      return state;
    },
    log,
  });
  return {
    lane: {
      txHash: laneInitialReceipt.hash,
      contractAddress: plan.lane.predictedAddress,
      ...buildFinalityEvidence(laneInitialReceipt, laneFinality),
    },
    adapter: {
      txHash: adapterInitialReceipt.hash,
      contractAddress: plan.adapter.predictedAddress,
      ...buildFinalityEvidence(adapterInitialReceipt, adapterFinality),
    },
    verifiedPostState: adapterFinality.postState,
  };
}

export async function executeVenuePairDeployment({
  provider,
  signer,
  plan,
  finalizeImpl = finalizePairEvidence,
  log = console.log,
}) {
  try {
    assertSelfCheckingCycle(plan);
    const nonceBeforeLane = await provider.getTransactionCount(plan.deployer, "pending");
    if (nonceBeforeLane !== plan.startNonce) {
      throw new Error(`nonce drift before lane: expected ${plan.startNonce}, chain says ${nonceBeforeLane}.`);
    }
    const laneTx = await signer.sendTransaction({ data: plan.lane.transaction.data, nonce: plan.lane.nonce });
    const laneReceipt = await laneTx.wait(1, FINALITY_TIMEOUT_MS);
    assertDeploymentReceipt(laneReceipt, plan.lane.predictedAddress, "lane");
    log(`lane deployed:    ${plan.lane.predictedAddress} (tx ${laneTx.hash})`);

    const nonceBeforeAdapter = await provider.getTransactionCount(plan.deployer, "pending");
    if (nonceBeforeAdapter !== plan.adapter.nonce) {
      throw new Error(`nonce drift before adapter: expected ${plan.adapter.nonce}, chain says ${nonceBeforeAdapter}.`);
    }
    const adapterTx = await signer.sendTransaction({ data: plan.adapter.transaction.data, nonce: plan.adapter.nonce });
    const adapterReceipt = await adapterTx.wait(1, FINALITY_TIMEOUT_MS);
    assertDeploymentReceipt(adapterReceipt, plan.adapter.predictedAddress, "adapter");
    log(`adapter deployed: ${plan.adapter.predictedAddress} (tx ${adapterTx.hash})`);

    const evidence = await finalizeImpl({ provider, plan, laneInitialReceipt: laneReceipt, adapterInitialReceipt: adapterReceipt });
    assertPairState(plan, evidence.verifiedPostState);
    return evidence;
  } catch (error) {
    const scrap = new Error(
      `SCRAP PAIR — lane ${plan.lane.predictedAddress}; adapter ${plan.adapter.predictedAddress}. `
      + `Never bind this pair. ${error?.message ?? error}`,
    );
    scrap.code = "venue_pair_scrap";
    scrap.cause = error;
    throw scrap;
  }
}

export async function runVenuePair({
  args,
  manifest,
  rpcContext,
  artifacts,
  resolveSignerImpl = resolveSigner,
  log = console.log,
}) {
  assertManifestBindings(manifest);
  const identity = await resolveSignerImpl(args, rpcContext.provider);
  const startNonce = await rpcContext.provider.getTransactionCount(identity.address, "pending");
  const plan = await buildVenuePairPlan({ deployer: identity.address, nonce: startNonce, artifacts });
  log("# VENUE PAIR DEPLOYMENT PLAN");
  log(serialize(publicPlan(plan)));
  if (!args.commit) {
    log("DRY RUN ONLY — no signature requested and no transaction broadcast.");
    return { plan, evidence: null };
  }
  const evidence = await executeVenuePairDeployment({
    provider: rpcContext.provider,
    signer: identity.signer,
    plan,
    log,
  });
  log("# COMMITTED EVIDENCE");
  log(serialize({ schemaVersion: 1, kind: "venue-pair-deployment", plan: publicPlan(plan), evidence }));
  return { plan, evidence };
}

function usage() {
  console.log(`Usage:
  node scripts/ops/deploy-venue-pair.mjs --expected-signer 0x... [--profile mainnet] [--artifacts out]
  node scripts/ops/deploy-venue-pair.mjs --commit --use-kms --expected-signer 0x...

Dry-run is the default. The driver deploys and verifies only; pool binding is a later cold-multisig action.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  const manifest = await readDeploymentManifest(args.profile);
  const rpcContext = await createCeremonyRpcContext({
    manifest,
    phase: args.commit ? "venue-pair-commit" : "venue-pair-dry-run",
    write: args.commit,
  });
  printCeremonyRpcPreflight(rpcContext);
  const artifacts = {
    lane: await readArtifact(args.artifacts, CONTRACT_ARTIFACTS.lane),
    adapter: await readArtifact(args.artifacts, CONTRACT_ARTIFACTS.adapter),
  };
  await runVenuePair({ args, manifest, rpcContext, artifacts });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}
