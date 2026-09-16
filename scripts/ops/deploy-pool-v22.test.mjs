import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, Interface, ZeroAddress, getCreateAddress, keccak256 } from "ethers";
import { parseArgs } from "./deploy-deposit-pool.mjs";
import { buildPoolV22Plan, executePoolV22Deployment, runPoolV22, readPoolV22Inputs, readPoolV22PostState } from "./deploy-pool-v22.mjs";
import { deploymentProvenance } from "./ceremony-contract-evidence.mjs";

const DEPLOYER = `0x${"11".repeat(20)}`;
const address = (n) => `0x${String(n).repeat(40)}`;
const bindings = { policy: address(2), asset: address(3), operator: address(4), creditPool: address(5), core: address(6), registry: address(7) };
const manifest = { profile: "mainnet", verifier: bindings.operator, contracts: {
  treasuryPolicy: bindings.policy, token: bindings.asset, creditPool: bindings.creditPool,
  agentAccountCore: bindings.core, strategyAdapterRegistry: bindings.registry, depositPoolV21: address(8),
} };
const artifacts = Object.fromEntries(Object.entries({ pool: ["address", "address", "address", "address", "address"],
  aggregator: ["address", "address"] }).map(([key, types]) => [key, {
  abi: [{ type: "constructor", inputs: types.map((type, i) => ({ name: `arg${i}`, type })), stateMutability: "nonpayable" }],
  bytecode: { object: key === "pool" ? "0x60006000" : "0x60016000" },
  deployedBytecode: { object: "0x6000", immutableReferences: {} },
}]));
const sourceCommit = "a".repeat(40);
const makePlan = () => buildPoolV22Plan({ deployer: DEPLOYER, nonce: 11, bindings, artifacts, sourceCommit });
const decodeArgs = (step) => AbiCoder.defaultAbiCoder().decode(
  artifacts[step.key].abi[0].inputs.map((i) => i.type), `0x${step.transaction.data.slice(artifacts[step.key].bytecode.object.length)}`);

test("T2 explicit artifact selection predicts pool N and aggregator N+1 with exact constructor bindings", async () => {
  assert.equal(parseArgs([]).contract, "DepositPool");
  assert.equal(parseArgs(["--contract", "DepositPoolV22"]).contract, "DepositPoolV22");
  assert.throws(() => parseArgs(["--contract", "DepositPoolV23"]), /--contract/u);
  assert.throws(() => parseArgs(["--contrcat", "DepositPoolV22"]), /Unknown argument/u);
  const plan = await makePlan();
  assert.deepEqual(plan.steps.map((s) => s.contract), ["DepositPoolV22", "AacPoolAggregatorAdapterV22"]);
  assert.equal(plan.steps[0].predictedAddress, getCreateAddress({ from: DEPLOYER, nonce: 11 }));
  assert.equal(plan.steps[1].predictedAddress, getCreateAddress({ from: DEPLOYER, nonce: 12 }));
  assert.deepEqual([...decodeArgs(plan.steps[0])], [bindings.policy, bindings.asset, bindings.operator, ZeroAddress, bindings.creditPool]);
  assert.deepEqual([...decodeArgs(plan.steps[1])], [bindings.core, plan.steps[0].predictedAddress]);
});

test("T2 M1-M3 re-encode to policy approval, registry registration and v22-only aggregator permission", async () => {
  const plan = await makePlan();
  const [pool, agg] = plan.steps.map((s) => s.predictedAddress);
  for (const [i, [signature, to, values]] of [
    ["setApprovedStrategy(address,bool)", bindings.policy, [agg, true]],
    ["registerStrategy(address)", bindings.registry, [agg]],
    ["setAggregatorAdapter(address,bool)", pool, [agg, true]],
  ].entries()) {
    const call = plan.multisig[i];
    assert.equal(call.step, `M${i + 1}`);
    assert.equal(call.to, to);
    assert.equal(call.value, "0");
    assert.equal(call.data, new Interface([`function ${signature}`]).encodeFunctionData(signature, values));
  }
  assert.doesNotMatch(JSON.stringify(plan.multisig), /setStrategyActive/u);
});

function readProvider(plan, mutations = {}) {
  const poolState = { policy: bindings.policy, asset: bindings.asset, operator: bindings.operator, creditPool: bindings.creditPool, venueAdapter: ZeroAddress };
  const states = {
    [manifest.contracts.depositPoolV21.toLowerCase()]: { ...poolState, ...mutations.sourcePool },
    [bindings.core.toLowerCase()]: { policy: bindings.policy, registry: bindings.registry },
    [bindings.asset.toLowerCase()]: { decimals: 6 },
    [plan.steps[0].predictedAddress.toLowerCase()]: { ...poolState, ...mutations.pool },
    [plan.steps[1].predictedAddress.toLowerCase()]: { agentAccountCore: bindings.core,
      pool: plan.steps[0].predictedAddress, asset: bindings.asset, operator: bindings.operator,
      strategyId: `0x${Buffer.from("AAC_LOCKED_DEPOSIT_POOL_V22").toString("hex").padEnd(64, "0")}`, ...mutations.aggregator },
  };
  return {
    getNetwork: async () => ({ chainId: 420420419n }),
    getBlock: async () => ({ number: 100, hash: `0x${"aa".repeat(32)}` }),
    getCode: async (_address, blockTag) => { assert.equal(blockTag, 100); return "0x6000"; },
    call: async ({ to, data, blockTag }) => {
      assert.equal(blockTag, 100);
      for (const [name, value] of Object.entries(states[to.toLowerCase()] ?? {})) {
        const type = name === "decimals" ? "uint8" : name === "strategyId" ? "bytes32" : "address";
        const iface = new Interface([`function ${name}() view returns (${type})`]);
        if (iface.getFunction(name).selector === data) return iface.encodeFunctionResult(name, [value]);
      }
      throw new Error(`unexpected fixture call ${to} ${data}`);
    },
  };
}

test("T2 constructor inputs are live-read at one block; mismatched operator or wrong chain refuses", async () => {
  const plan = await makePlan();
  const inputs = await readPoolV22Inputs(readProvider(plan), manifest);
  assert.equal(inputs.operator, bindings.operator);
  assert.equal(inputs.readBlock, 100);
  await assert.rejects(readPoolV22Inputs(readProvider(plan, { sourcePool: { operator: DEPLOYER } }), manifest), /operator mismatch/u);
  const p = readProvider(plan); p.getNetwork = async () => ({ chainId: 1n });
  await assert.rejects(readPoolV22Inputs(p, manifest), /mainnet/u);
});

test("T2 post-state checks the aggregator's immutable v22 pool, core and strategy", async () => {
  const plan = await makePlan();
  const step = plan.steps[1];
  await readPoolV22PostState(readProvider(plan), plan, step, 100);
  await assert.rejects(readPoolV22PostState(readProvider(plan, { aggregator: { pool: manifest.contracts.depositPoolV21 } }), plan, step, 100), /aggregator.pool mismatch/u);
  await assert.rejects(readPoolV22PostState(readProvider(plan, { pool: { venueAdapter: DEPLOYER } }), plan, step, 100), /venueAdapter mismatch/u);
});

test("T2 unsigned preview reads pending nonce, prints two hashes and M1-M3, never sends", async () => {
  const lines = [];
  const result = await runPoolV22({ args: { commit: false }, manifest,
    provider: { getTransactionCount: async (who, tag) => { assert.equal(who, DEPLOYER); assert.equal(tag, "pending"); return 11; } },
    identity: { address: DEPLOYER }, artifacts, readInputsImpl: async () => bindings,
    executeImpl: () => assert.fail("dry run cannot execute"), log: (s) => lines.push(s) });
  assert.equal(result.evidence, null);
  assert.equal(result.plan.steps.length, 2);
  for (const word of ["M1", "M2", "M3", "creationBytecodeHash", "DRY RUN"]) assert.ok(lines.join("\n").includes(word));
});

function execution(plan, { drift = false, code = "0x6000" } = {}) {
  const sends = []; let reads = 0;
  const provider = { getTransactionCount: async () => 11 + reads++ + (drift && reads === 2 ? 1 : 0) };
  const signer = { getAddress: async () => DEPLOYER, sendTransaction: async (tx) => {
    const step = plan.steps[sends.length]; sends.push(tx);
    const hash = `0x${String(sends.length).repeat(64)}`;
    return { hash, wait: async () => ({ hash, status: 1, contractAddress: step.predictedAddress, blockNumber: 100, blockHash: `0x${"aa".repeat(32)}` }) };
  } };
  const confirmImpl = async ({ initialReceipt, confirmations, readPostState }) => {
    assert.equal(confirmations, 12);
    return { receipt: initialReceipt, postState: await readPostState(100), confirmationsRequired: 12, confirmationsWaited: 12,
      rereadBlockHash: initialReceipt.blockHash, receiptReconfirmed: true, postStateReconfirmed: true };
  };
  return { sends, options: { provider, signer, plan, artifacts, confirmImpl,
    readPostStateImpl: async () => ({ code }), log() {} } };
}

test("T2 commit sends exactly two CREATEs, checks nonce twice, and emits canonical runtime evidence", async () => {
  const plan = await makePlan(); const h = execution(plan);
  const evidence = await executePoolV22Deployment(h.options);
  assert.deepEqual(h.sends.map((t) => t.nonce), [11, 12]);
  assert.ok(h.sends.every((t) => !t.to)); // No multisig/registration/binding writes.
  assert.deepEqual(Object.keys(evidence), ["depositPoolV22", "aacPoolAggregatorAdapterV22"]);
  assert.equal(evidence.depositPoolV22.provenance.sourceCommit, sourceCommit);
  assert.equal(evidence.depositPoolV22.provenance.creationBytecodeHash, keccak256(artifacts.pool.bytecode.object));
  assert.match(evidence.aacPoolAggregatorAdapterV22.provenance.runtimeCodeHash, /^sha256:/u);
});

test("T2 nonce drift or bad masked runtime stops before the second CREATE", async () => {
  for (const [options, reason] of [[{ drift: true }, /Nonce drift/u], [{ code: "0x6001" }, /masked runtime/u]]) {
    const h = execution(await makePlan(), options);
    await assert.rejects(executePoolV22Deployment(h.options), reason);
    assert.equal(h.sends.length, 1);
  }
  const plan = await makePlan(); plan.steps[1].transaction.data += "00";
  const h = execution(plan);
  await assert.rejects(executePoolV22Deployment(h.options), /plan changed/u);
  assert.equal(h.sends.length, 0);
});

test("T3 evidence cannot be fabricated from a prediction or wrong runtime", () => {
  const input = { artifact: artifacts.pool, sourceCommit, verifiedAt: "2026-09-16T00:00:00.000Z" };
  assert.throws(() => deploymentProvenance({ ...input, deployedCode: "0x" }), /runtime/u);
  assert.throws(() => deploymentProvenance({ ...input, deployedCode: "0x6001" }), /runtime/u);
  assert.throws(() => deploymentProvenance({ ...input, sourceCommit: "unknown", deployedCode: "0x6000" }), /sourceCommit/u);
});

test("T2 committing runner uses the ceremony write broadcaster, never the read fallback for sends", async () => {
  const wallet = {}; const broadcaster = {}; const provider = { getTransactionCount: async () => 11 };
  const signer = {}; let bound = false;
  await runPoolV22({ args: { commit: true }, manifest, provider, writeBroadcaster: broadcaster,
    identity: { address: DEPLOYER, signerVerified: true, wallet }, artifacts, readInputsImpl: async () => bindings,
    bindSignerImpl: (w, p, b) => {
      assert.equal(w, wallet); assert.equal(p, provider); assert.equal(b, broadcaster); bound = true; return signer;
    }, executeImpl: async (input) => { assert.equal(input.signer, signer); return {}; }, log() {} });
  assert.equal(bound, true);
});
