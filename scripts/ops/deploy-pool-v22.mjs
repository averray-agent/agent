// The explicit DepositPoolV22 mode of deploy-deposit-pool.mjs. No legacy path
// or production manifest is changed by planning/deploying these two contracts.
import { Contract, ContractFactory, Interface, ZeroAddress, encodeBytes32String, getAddress, getCreateAddress, keccak256 } from "ethers";
import { readArtifact, assertArtifactSourceCommit } from "./deploy-venue-pair.mjs";
import { confirmCanonicalPostState, buildFinalityEvidence, DEFAULT_FINALITY_CONFIRMATIONS, FINALITY_TIMEOUT_MS } from "./pool-venue-ceremony.mjs";
import { assertDeploymentArtifact, deploymentProvenance } from "./ceremony-contract-evidence.mjs";
import { createCeremonyRpcContext, printCeremonyRpcPreflight } from "./ceremony-rpc.mjs";
import { bindSignerToWriteBroadcaster } from "../../mcp-server/src/blockchain/rpc-provider.js";

export const POOL_V22_ARTIFACTS = Object.freeze({
  pool: ["DepositPoolV22.sol", "DepositPoolV22"],
  aggregator: ["AacPoolAggregatorAdapterV22.sol", "AacPoolAggregatorAdapterV22"],
});
const POOL_READ_ABI = ["function policy() view returns (address)", "function asset() view returns (address)",
  "function operator() view returns (address)", "function venueAdapter() view returns (address)", "function creditPool() view returns (address)"];
const AGGREGATOR_READ_ABI = ["function agentAccountCore() view returns (address)", "function pool() view returns (address)",
  "function operator() view returns (address)", "function asset() view returns (address)", "function strategyId() view returns (bytes32)"];
const json = (value) => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v, 2);
function address(value, label) {
  try { const a = getAddress(value); if (a !== ZeroAddress) return a; } catch { /* fail closed */ }
  throw new Error(`${label} must be a nonzero EVM address.`);
}
function equal(actual, expected, label) {
  if (getAddress(actual) !== getAddress(expected)) throw new Error(`${label} mismatch: ${actual}, expected ${expected}.`);
}

export async function readPoolV22Inputs(provider, manifest) {
  if (manifest.profile !== "mainnet" || Number((await provider.getNetwork()).chainId) !== 420420419) {
    throw new Error("Pool v2.2 ceremony requires Polkadot Hub mainnet.");
  }
  const c = manifest.contracts;
  if (c.depositPoolV22 || c.aacPoolAggregatorAdapterV22) throw new Error("v2.2 deployment already recorded; refusing a duplicate ceremony.");
  const bindings = Object.fromEntries(Object.entries({ policy: c.treasuryPolicy, asset: c.token,
    operator: manifest.verifier, creditPool: c.creditPool, core: c.agentAccountCore,
    registry: c.strategyAdapterRegistry }).map(([key, value]) => [key, address(value, key)]));
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("Live constructor-read block unavailable.");
  const tag = { blockTag: block.number };
  const oldPool = new Contract(address(c.depositPoolV21, "contracts.depositPoolV21"), POOL_READ_ABI, provider);
  for (const key of ["policy", "asset", "operator", "creditPool"]) equal(await oldPool[key](tag), bindings[key], `v2.1 ${key}`);
  const core = new Contract(bindings.core, ["function policy() view returns (address)", "function registry() view returns (address)"], provider);
  equal(await core.policy(tag), bindings.policy, "AAC policy");
  equal(await core.registry(tag), bindings.registry, "AAC registry");
  const asset = new Contract(bindings.asset, ["function decimals() view returns (uint8)"], provider);
  if (Number(await asset.decimals(tag)) !== 6) throw new Error("Asset must have six decimals.");
  return { ...bindings, readBlock: block.number, readBlockHash: block.hash };
}

export function aggregatorMultisigCalls(bindings, pool, aggregator) {
  return [
    ["M1", bindings.policy, "setApprovedStrategy(address,bool)", [aggregator, true]],
    ["M2", bindings.registry, "registerStrategy(address)", [aggregator]],
    ["M3", pool, "setAggregatorAdapter(address,bool)", [aggregator, true]],
  ].map(([step, to, signature, values]) => ({ step, to, value: "0", signature,
    data: new Interface([`function ${signature}`]).encodeFunctionData(signature, values) }));
}

export async function buildPoolV22Plan({ deployer, nonce, bindings, artifacts, sourceCommit = "unknown" }) {
  deployer = address(deployer, "deployer");
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("Pending nonce must be a non-negative safe integer.");
  for (const key of ["policy", "asset", "operator", "creditPool", "core", "registry"]) address(bindings[key], key);
  const pool = getCreateAddress({ from: deployer, nonce });
  const aggregator = getCreateAddress({ from: deployer, nonce: nonce + 1 });
  const plan = { schemaVersion: 1, kind: "pool-v22-deployment", deployer, startNonce: nonce, sourceCommit: String(sourceCommit).toLowerCase(),
    bindings, steps: [], multisig: aggregatorMultisigCalls(bindings, pool, aggregator) };
  for (const [key, manifestKey, expectedAddress, constructorArgs] of [
    ["pool", "depositPoolV22", pool, [bindings.policy, bindings.asset, bindings.operator, ZeroAddress, bindings.creditPool]],
    ["aggregator", "aacPoolAggregatorAdapterV22", aggregator, [bindings.core, pool]],
  ]) {
    const artifact = artifacts[key];
    assertDeploymentArtifact(artifact);
    const data = (await new ContractFactory(artifact.abi, artifact.bytecode.object).getDeployTransaction(...constructorArgs)).data;
    plan.steps.push({ key, manifestKey, contract: POOL_V22_ARTIFACTS[key][1], nonce: nonce + plan.steps.length,
      predictedAddress: expectedAddress, constructorArgs, creationBytecodeHash: keccak256(artifact.bytecode.object),
      initCodeHash: keccak256(data), transaction: { data } });
  }
  return plan;
}

export function publicPoolV22Plan(plan) {
  return { ...plan, steps: plan.steps.map(({ transaction: _transaction, ...step }) => step),
    multisigBoundary: "EVM calldata only; Pascal wraps/verifies revive.call and signs M1–M3. This driver sends neither approvals nor registrations." };
}

export async function readPoolV22PostState(provider, plan, step, blockNumber) {
  const pool = new Contract(plan.steps[0].predictedAddress, POOL_READ_ABI, provider);
  const tag = { blockTag: blockNumber };
  const state = {};
  for (const key of ["policy", "asset", "operator", "creditPool", "venueAdapter"]) state[key] = await pool[key](tag);
  for (const key of ["policy", "asset", "operator", "creditPool"]) equal(state[key], plan.bindings[key], `pool.${key}`);
  equal(state.venueAdapter, ZeroAddress, "pool.venueAdapter");
  if (step.key === "aggregator") {
    const aggregator = new Contract(step.predictedAddress, AGGREGATOR_READ_ABI, provider);
    state.aggregator = {};
    for (const key of ["agentAccountCore", "pool", "asset", "operator", "strategyId"]) state.aggregator[key] = await aggregator[key](tag);
    equal(state.aggregator.agentAccountCore, plan.bindings.core, "aggregator.agentAccountCore");
    equal(state.aggregator.pool, plan.steps[0].predictedAddress, "aggregator.pool");
    equal(state.aggregator.asset, plan.bindings.asset, "aggregator.asset");
    equal(state.aggregator.operator, plan.bindings.operator, "aggregator.operator");
    if (state.aggregator.strategyId !== encodeBytes32String("AAC_LOCKED_DEPOSIT_POOL_V22")) throw new Error("aggregator.strategyId mismatch.");
  }
  return { bindings: state, code: await provider.getCode(step.predictedAddress, blockNumber) };
}

export async function executePoolV22Deployment({ provider, signer, plan, artifacts,
  confirmImpl = confirmCanonicalPostState, readPostStateImpl = readPoolV22PostState, log = console.log }) {
  assertArtifactSourceCommit(plan.sourceCommit);
  equal(await signer.getAddress(), plan.deployer, "signer");
  // Rebuild all CREATE inputs, not just the hashes printed beside mutable data.
  const rebuilt = await buildPoolV22Plan({ deployer: plan.deployer, nonce: plan.startNonce,
    bindings: plan.bindings, artifacts, sourceCommit: plan.sourceCommit });
  if (json(rebuilt) !== json(plan)) throw new Error("Pool deployment plan changed; refusing before broadcast.");
  const evidence = {};
  for (const step of plan.steps) {
    const nonce = await provider.getTransactionCount(plan.deployer, "pending");
    if (nonce !== step.nonce) throw new Error(`Nonce drift before ${step.key}; expected ${step.nonce}, got ${nonce}. Stop; do not retry blindly.`);
    const tx = await signer.sendTransaction({ data: step.transaction.data, nonce: step.nonce });
    log(`${step.key} submitted: ${tx.hash}`);
    const receipt = await tx.wait(1, FINALITY_TIMEOUT_MS);
    if (Number(receipt?.status) !== 1) throw new Error(`${step.key} CREATE failed; stop and reconcile ${tx.hash}.`);
    equal(receipt.contractAddress, step.predictedAddress, `${step.key} CREATE address`);
    const finality = await confirmImpl({ provider, transactionHash: tx.hash, initialReceipt: receipt,
      confirmations: DEFAULT_FINALITY_CONFIRMATIONS,
      readPostState: async (blockNumber) => {
        const post = await readPostStateImpl(provider, plan, step, blockNumber);
        return { ...post, provenance: deploymentProvenance({ artifact: artifacts[step.key], deployedCode: post.code,
          sourceCommit: plan.sourceCommit, verifiedAt: new Date().toISOString() }) };
      }, log });
    evidence[step.manifestKey] = { address: step.predictedAddress, txHash: tx.hash,
      ...buildFinalityEvidence(receipt, finality), provenance: finality.postState.provenance };
    log(`${step.key} confirmed: ${step.predictedAddress}`);
  }
  return evidence;
}

export async function runPoolV22({ args, manifest, provider, writeBroadcaster, identity, artifacts,
  bindSignerImpl = bindSignerToWriteBroadcaster,
  readInputsImpl = readPoolV22Inputs, executeImpl = executePoolV22Deployment, log = console.log }) {
  const bindings = await readInputsImpl(provider, manifest);
  const nonce = await provider.getTransactionCount(identity.address, "pending");
  const plan = await buildPoolV22Plan({ deployer: identity.address, nonce, bindings, artifacts, sourceCommit: process.env.DEPLOYED_SHA });
  log("# POOL V2.2 + LOCKED AGGREGATOR PLAN (two CREATEs)");
  log(json(publicPoolV22Plan(plan)));
  if (!args.commit) { log("DRY RUN — no signature requested and nothing broadcast."); return { plan, evidence: null }; }
  if (!identity.signerVerified || !identity.wallet) throw new Error("Verified 1Password signer required for commit.");
  if (!writeBroadcaster) throw new Error("Ceremony write broadcaster required for commit.");
  const evidence = await executeImpl({ provider, signer: bindSignerImpl(identity.wallet, provider, writeBroadcaster), plan, artifacts, log });
  log("# COMMITTED EVIDENCE — proposed manifest entries only; no aliases or env changed");
  log(json(evidence));
  return { plan, evidence };
}

export async function runPoolV22Cli({ args, manifest, resolveDeployer }) {
  const rpcContext = await createCeremonyRpcContext({ manifest: { ...manifest, rpcUrl: args.rpc || process.env.RPC_URL || manifest.rpcUrl },
    phase: args.commit ? "pool-v22-commit" : "pool-v22-dry-run", write: args.commit });
  printCeremonyRpcPreflight(rpcContext);
  const identity = resolveDeployer({ expectedDeployer: args.expectedDeployer,
    signerSecretRef: args.commit ? args.signerSecretRef : undefined, commit: args.commit });
  const artifacts = Object.fromEntries(await Promise.all(Object.entries(POOL_V22_ARTIFACTS)
    .map(async ([key, definition]) => [key, await readArtifact(args.artifacts, definition)])));
  return runPoolV22({ args, manifest, provider: rpcContext.provider, writeBroadcaster: rpcContext.writeBroadcaster, identity, artifacts });
}
