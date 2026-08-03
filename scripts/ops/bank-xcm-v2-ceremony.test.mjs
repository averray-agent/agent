import assert from "node:assert/strict";
import test from "node:test";

import { Interface, getAddress, getCreateAddress, keccak256 } from "ethers";

import {
  BANK_XCM_V2,
  applyBankXcmV2Manifest,
  buildArmCalls,
  buildBankXcmV2Messages,
  buildConfigurationCalls,
  buildRecoveryHomeMessage,
  compact,
  previewRecoveryHomeId,
  truncateAccountId32,
  wrapperAccountId32
} from "./bank-xcm-v2-ceremony-lib.mjs";
import { assertDryRunEvidence } from "./prepare-bank-xcm-v2-multisig.mjs";
import { convertOnEndpoint } from "./capture-hydration-wrapper-origin.mjs";
import { buildDeploymentPlan } from "./deploy-bank-xcm-v2.mjs";
import { buildManifestCandidate } from "./record-bank-xcm-v2-deployment.mjs";

const WRAPPER = "0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9";
const ADAPTER = "0x1111111111111111111111111111111111111111";
const POLICY = "0x226F14252A98BD2eA140271647De20132F09AF20";
const TOKEN = "0x0000053900000000000000000000000001200000";
const AAC = "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57";
const OWNER = "0x01e6eed856e989201f4ff6346e18eab7e46c874c";
const OPERATOR = "0x5a6836c6D4d293F6E5377E6c28054F4171915813";
const CONVERTED = "0x51845ee08e8949d64f0016be27942ce7b6d21df02c3b00104a290ca4e749fc55";

const manifest = {
  profile: "mainnet",
  owner: OWNER,
  verifier: OPERATOR,
  contracts: { treasuryPolicy: POLICY, token: TOKEN, agentAccountCore: AAC, xcmWrapper: null },
  contractProvenance: {},
  deploymentBlocks: {},
  deployers: {},
  strategies: []
};

function bundle() {
  return buildBankXcmV2Messages({
    wrapper: WRAPPER,
    convertedAccountId32: CONVERTED,
    asset: TOKEN,
    treasuryContext: OWNER,
    depositAssets: 150_000n,
    depositSellAmount: 100_000n,
    depositFee: 20_917n,
    withdrawShares: 100_000n,
    withdrawFee: 21_350n,
    homeAmount: 100_000n,
    homeFee: 1_402n,
    depositNonce: 1n,
    withdrawNonce: 2n
  });
}

test("wrapper identity uses the proven H160 + EE x12 image and observer truncate20", () => {
  assert.equal(wrapperAccountId32(WRAPPER), `${WRAPPER.toLowerCase()}${"ee".repeat(12)}`);
  assert.equal(truncateAccountId32(CONVERTED), getAddress(`0x${CONVERTED.slice(2, 42)}`));
});

test("message builder emits exactly four v2 shapes bound to request topics", () => {
  const built = bundle();
  assert.deepEqual(built.messages.map(({ label }) => label), [
    "deposit_funding",
    "deposit_sell",
    "withdraw_sell",
    "withdraw_home"
  ]);
  assert.deepEqual(built.messages.map(({ destination }) => destination), [
    BANK_XCM_V2.localDestination,
    BANK_XCM_V2.hydrationDestination,
    BANK_XCM_V2.hydrationDestination,
    BANK_XCM_V2.hydrationDestination
  ]);
  for (const leg of built.messages) {
    assert.equal(leg.messageHash, keccak256(leg.message));
    assert.ok(leg.message.endsWith(`2c${leg.requestId.slice(2)}`), `${leg.label} must end in SetTopic(requestId)`);
  }
  assert.match(built.messages[0].message, new RegExp(CONVERTED.slice(2), "iu"));
  assert.match(built.messages[3].message, new RegExp(wrapperAccountId32(WRAPPER).slice(2), "iu"));
  assert.deepEqual(built.messages[1].expected, {
    event: "Broadcast.Swapped",
    fillerType: "AAVE",
    assetIn: 22,
    assetOut: 1003
  });
  assert.deepEqual(built.messages[2].expected, {
    event: "Broadcast.Swapped",
    fillerType: "AAVE",
    assetIn: 1003,
    assetOut: 22
  });
});

test("v2.1 recovery-home builder derives its topic and fixes the wrapper image beneficiary", () => {
  const recovery = buildRecoveryHomeMessage({
    wrapper: WRAPPER,
    convertedAccountId32: CONVERTED,
    amount: 120_000n,
    fee: 1_402n,
    nonce: 7n
  });
  assert.equal(recovery.recoveryId, previewRecoveryHomeId({
    wrapper: WRAPPER,
    convertedAccountId32: CONVERTED,
    amount: 120_000n,
    nonce: 7n
  }));
  assert.equal(recovery.destination, BANK_XCM_V2.hydrationDestination);
  assert.equal(recovery.messageHash, keccak256(recovery.message));
  assert.ok(recovery.message.endsWith(`2c${recovery.recoveryId.slice(2)}`));
  assert.match(recovery.message, new RegExp(wrapperAccountId32(WRAPPER).slice(2), "iu"));
  assert.equal(recovery.expected.forwardedParaId, 1000);
});

test("v2.1 recovery-home builder refuses zero amount, zero nonce, and fee overflow", () => {
  const input = { wrapper: WRAPPER, convertedAccountId32: CONVERTED, amount: 120_000n, fee: 1_402n, nonce: 7n };
  assert.throws(() => buildRecoveryHomeMessage({ ...input, amount: 0n }), /amount.*positive/u);
  assert.throws(() => buildRecoveryHomeMessage({ ...input, nonce: 0n }), /nonce.*positive/u);
  assert.throws(() => buildRecoveryHomeMessage({ ...input, fee: 120_001n }), /fee.*no greater/u);
});

test("message builder refuses a home amount that is not the Withdraw request shares", () => {
  assert.throws(
    () => buildBankXcmV2Messages({
      wrapper: WRAPPER,
      convertedAccountId32: CONVERTED,
      asset: TOKEN,
      treasuryContext: OWNER,
      withdrawShares: 100_000n,
      homeAmount: 107_000n
    }),
    /home amount must equal.*shares/u
  );
});

test("message builder refuses unfunded fee math before emitting bytes", () => {
  assert.throws(
    () => buildBankXcmV2Messages({
      wrapper: WRAPPER,
      convertedAccountId32: CONVERTED,
      asset: TOKEN,
      treasuryContext: OWNER,
      depositAssets: 100_000n,
      depositSellAmount: 100_000n,
      depositFee: 1n
    }),
    /exceeds the funded request assets/u
  );
});

test("compact builder reproduces the canonical bytes pinned by the wrapper tests", () => {
  assert.equal(compact(150_000n).toString("hex"), "c2270900");
  assert.equal(compact(20_917n).toString("hex"), "d6460100");
  assert.equal(compact(21_350n).toString("hex"), "9a4d0100");
  assert.equal(compact(100_000n).toString("hex"), "821a0600");
  assert.equal(compact(1_402n).toString("hex"), "e915");
});

test("deployment plan pins wrapper-first CREATE order, paused constructor, and adapter binding", async () => {
  const deployer = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
  const wrapperArtifact = {
    abi: [{ type: "constructor", inputs: [{ name: "policy_", type: "address" }, { name: "xcmPrecompile_", type: "address" }] }],
    bytecode: { object: "0x60006000" },
    deployedBytecode: { object: "0x6000" }
  };
  const adapterArtifact = {
    abi: [{
      type: "constructor",
      inputs: [
        { name: "policy_", type: "address" },
        { name: "asset_", type: "address" },
        { name: "strategyId_", type: "bytes32" },
        { name: "xcmWrapper_", type: "address" },
        { name: "agentAccountCore_", type: "address" }
      ]
    }],
    bytecode: { object: "0x60006000" },
    deployedBytecode: { object: "0x6000" }
  };
  const provider = {
    getTransactionCount: async () => 7,
    estimateGas: async () => 100n,
    getFeeData: async () => ({ gasPrice: 2n, maxFeePerGas: null }),
    getBalance: async () => 1_000n
  };
  const plan = await buildDeploymentPlan({ manifest, provider, deployer, wrapperArtifact, adapterArtifact });
  assert.equal(plan.wrapper.address, getCreateAddress({ from: deployer, nonce: 7 }));
  assert.equal(plan.adapter.address, getCreateAddress({ from: deployer, nonce: 8 }));
  assert.equal(plan.wrapper.expectedInitialState.dispatchPaused, true);
  assert.equal(plan.wrapper.constructorArgs[1], "0x0000000000000000000000000000000000000000");
  assert.equal(plan.adapter.constructorArgs[3], plan.wrapper.address);
  assert.equal(plan.adapter.constructorArgs[4], AAC);
});

test("v2.1 deployment replacement is explicit and records the pair it supersedes", async () => {
  const deployer = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
  const existing = {
    ...manifest,
    contracts: { ...manifest.contracts, xcmWrapper: WRAPPER, hydrationUsdcAdapter: ADAPTER }
  };
  const wrapperArtifact = {
    abi: [{ type: "constructor", inputs: [{ name: "policy_", type: "address" }, { name: "xcmPrecompile_", type: "address" }] }],
    bytecode: { object: "0x60006000" }, deployedBytecode: { object: "0x6000" }
  };
  const adapterArtifact = {
    abi: [{
      type: "constructor",
      inputs: [
        { name: "policy_", type: "address" }, { name: "asset_", type: "address" },
        { name: "strategyId_", type: "bytes32" }, { name: "xcmWrapper_", type: "address" },
        { name: "agentAccountCore_", type: "address" }
      ]
    }],
    bytecode: { object: "0x60006000" }, deployedBytecode: { object: "0x6000" }
  };
  const provider = {
    getTransactionCount: async () => 9,
    estimateGas: async () => 100n,
    getFeeData: async () => ({ gasPrice: 2n, maxFeePerGas: null }),
    getBalance: async () => 1_000n
  };
  await assert.rejects(
    buildDeploymentPlan({ manifest: existing, provider, deployer, wrapperArtifact, adapterArtifact }),
    /refusing a duplicate deployment plan/u
  );
  const plan = await buildDeploymentPlan({
    manifest: existing, provider, deployer, wrapperArtifact, adapterArtifact, replaceExisting: true
  });
  assert.equal(plan.replacement.wrapper, getAddress(WRAPPER));
  assert.equal(plan.replacement.adapter, getAddress(ADAPTER));
  assert.notEqual(plan.wrapper.address, plan.replacement.wrapper);
});

test("paused configuration and arm packets are deliberately separate", () => {
  const configure = buildConfigurationCalls({ manifest, wrapper: WRAPPER, adapter: ADAPTER, convertedAccountId32: CONVERTED });
  const arm = buildArmCalls({ wrapper: WRAPPER });
  assert.equal(configure.length, 4);
  assert.equal(configure.some(({ label }) => /setDispatchPaused/u.test(label)), false);
  assert.match(configure[3].label, /setStrategySettler/u);
  assert.equal(arm.length, 1);
  assert.match(arm[0].label, /setDispatchPaused\(false\)/u);
  const iface = new Interface(["function setDispatchPaused(bool)"]);
  assert.equal(iface.decodeFunctionData("setDispatchPaused", arm[0].data)[0], false);
});

test("request-leg evidence fails closed unless all four exact hashes and assertions pass", () => {
  const built = bundle();
  const evidence = {
    kind: "averray.bankXcmV2DryRunEvidence",
    profile: "mainnet",
    wrapper: built.wrapper,
    convertedAccountId32: built.convertedAccountId32,
    runtimeBlocks: { assetHub: 19_000_001, hydration: 8_000_001 },
    legs: built.messages.map((leg) => ({
      label: leg.label,
      passed: true,
      requestId: leg.requestId,
      messageHash: leg.messageHash,
      rawEvidence: `/tmp/${leg.label}.json`,
      forwardedParaId: leg.expected.forwardedParaId,
      remoteEvent: leg.expected.remoteEvent,
      assetId: leg.expected.assetId,
      event: leg.expected.event,
      fillerType: leg.expected.fillerType,
      assetIn: leg.expected.assetIn,
      assetOut: leg.expected.assetOut
    }))
  };
  assert.equal(assertDryRunEvidence(evidence, built), true);
  evidence.legs[1].messageHash = `0x${"00".repeat(32)}`;
  assert.throws(() => assertDryRunEvidence(evidence, built), /did not pass or bind exact bytes/u);
});

test("arm evidence requires the forwarded-leg remote deposit event and raw output", () => {
  const built = bundle();
  const evidence = {
    kind: "averray.bankXcmV2DryRunEvidence",
    profile: "mainnet",
    wrapper: built.wrapper,
    convertedAccountId32: built.convertedAccountId32,
    runtimeBlocks: { assetHub: 19_000_001, hydration: 8_000_001 },
    legs: built.messages.map((leg) => ({
      label: leg.label,
      passed: true,
      requestId: leg.requestId,
      messageHash: leg.messageHash,
      rawEvidence: `/tmp/${leg.label}.json`,
      ...leg.expected
    }))
  };
  delete evidence.legs[0].remoteEvent;
  assert.throws(() => assertDryRunEvidence(evidence, built), /missing the expected Tokens\.Deposited/u);
  evidence.legs[0].remoteEvent = "Tokens.Deposited";
  evidence.legs[3].rawEvidence = "";
  assert.throws(() => assertDryRunEvidence(evidence, built), /must reference the captured raw output/u);
});

test("v2.1 arm evidence requires the fifth recovery-home dry-run", () => {
  const built = bundle();
  const recovery = buildRecoveryHomeMessage({
    wrapper: WRAPPER,
    convertedAccountId32: CONVERTED,
    amount: 100_000n,
    fee: 1_402n,
    nonce: 1n
  });
  const v21 = { ...built, messages: [...built.messages, recovery] };
  const evidence = {
    kind: "averray.bankXcmV2DryRunEvidence",
    profile: "mainnet",
    wrapper: built.wrapper,
    convertedAccountId32: built.convertedAccountId32,
    runtimeBlocks: { assetHub: 19_000_001, hydration: 8_000_001 },
    legs: v21.messages.map((leg) => ({
      label: leg.label,
      passed: true,
      requestId: leg.requestId,
      messageHash: leg.messageHash,
      rawEvidence: `/tmp/${leg.label}.json`,
      ...leg.expected
    }))
  };
  assert.equal(assertDryRunEvidence(evidence, v21), true);
  evidence.legs.pop();
  assert.throws(() => assertDryRunEvidence(evidence, v21), /exactly 5 legs/u);
});

test("manifest recorder produces the paired addresses, provenance, blocks, and paused strategy record", () => {
  const next = applyBankXcmV2Manifest(manifest, {
    sourceCommit: "a".repeat(40),
    deployer: "0x9Ab8531FBb0948C542a31298FD61335f30064239",
    verifiedAt: "2026-08-03T12:00:00.000Z",
    wrapper: {
      address: WRAPPER,
      txHash: `0x${"11".repeat(32)}`,
      blockNumber: 19_000_001,
      abiHash: `sha256:${"22".repeat(32)}`,
      runtimeCodeHash: `sha256:${"33".repeat(32)}`
    },
    adapter: {
      address: ADAPTER,
      txHash: `0x${"44".repeat(32)}`,
      blockNumber: 19_000_002,
      abiHash: `sha256:${"55".repeat(32)}`,
      runtimeCodeHash: `sha256:${"66".repeat(32)}`
    }
  });
  assert.equal(next.contracts.xcmWrapper, getAddress(WRAPPER));
  assert.equal(next.contracts.hydrationUsdcAdapter, getAddress(ADAPTER));
  assert.equal(next.deploymentBlocks.xcmWrapperV2, 19_000_001);
  assert.equal(next.strategies[0].status, "paused_pending_dust_proof");
  assert.equal(next.bankXcmV2Deployment.status, "deployed_paused");
});

test("v2.1 manifest replacement preserves v2.0 provenance and records retirement truth", () => {
  const oldWrapper = "0xc846eE73e49A748e59C7Ac8f8742F542a552D24C";
  const oldAdapter = "0x5eaF58a3e2819A26B66822529aD92fcec107cc98";
  const existing = {
    ...manifest,
    contracts: { ...manifest.contracts, xcmWrapper: oldWrapper, hydrationUsdcAdapter: oldAdapter },
    contractProvenance: {
      [oldWrapper]: {
        sourceCommit: "b".repeat(40),
        abiHash: `sha256:${"01".repeat(32)}`,
        runtimeCodeHash: `sha256:${"02".repeat(32)}`,
        verifiedAt: "2026-08-03T12:00:00.000Z"
      }
    },
    deploymentBlocks: { xcmWrapperV2: 19_009_586, hydrationUsdcAdapter: 19_009_588 },
    deployers: { xcmWrapperV2: OPERATOR, hydrationUsdcAdapter: OPERATOR },
    bankXcmV2Deployment: {
      version: "2.0",
      status: "v2_1_redeploy_required",
      deployTxHashes: { wrapper: `0x${"10".repeat(32)}`, adapter: `0x${"20".repeat(32)}` },
      convertedAccountId32: CONVERTED,
      incident: { writeOffs: [{ assetId: 22, raw: "149412" }] }
    }
  };
  const next = applyBankXcmV2Manifest(existing, {
    sourceCommit: "c".repeat(40),
    deployer: "0x9Ab8531FBb0948C542a31298FD61335f30064239",
    verifiedAt: "2026-08-04T08:00:00.000Z",
    replacementReason: "remote send legs must not require Asset-Hub-local XCM weighing",
    wrapper: {
      address: WRAPPER,
      txHash: `0x${"31".repeat(32)}`,
      blockNumber: 19_100_001,
      abiHash: `sha256:${"32".repeat(32)}`,
      runtimeCodeHash: `sha256:${"33".repeat(32)}`
    },
    adapter: {
      address: ADAPTER,
      txHash: `0x${"41".repeat(32)}`,
      blockNumber: 19_100_002,
      abiHash: `sha256:${"42".repeat(32)}`,
      runtimeCodeHash: `sha256:${"43".repeat(32)}`
    }
  });
  assert.equal(next.contracts.xcmWrapper, getAddress(WRAPPER));
  assert.equal(next.bankXcmV2Deployment.version, "2.1");
  assert.equal(next.deploymentBlocks.xcmWrapperV2, 19_009_586);
  assert.equal(next.deploymentBlocks.xcmWrapperV2_1, 19_100_001);
  assert.equal(next.deployers.xcmWrapperV2_1, getAddress("0x9Ab8531FBb0948C542a31298FD61335f30064239"));
  assert.equal(next.contractProvenance[oldWrapper].sourceCommit, "b".repeat(40));
  assert.equal(next.bankXcmDeploymentHistory.length, 1);
  assert.equal(next.bankXcmDeploymentHistory[0].status, "retired_replaced");
  assert.equal(next.bankXcmDeploymentHistory[0].incident.writeOffs[0].raw, "149412");
  assert.deepEqual(next.bankXcmDeploymentHistory[0].retiredCapital, [{ assetId: 22, raw: "149412" }]);
});

test("manifest candidate refuses live runtime drift before recording provenance", async () => {
  const wrapperArtifact = { abi: [], bytecode: { object: "0x6000" }, deployedBytecode: { object: "0x6001", immutableReferences: {} } };
  const adapterArtifact = { abi: [], bytecode: { object: "0x6000" }, deployedBytecode: { object: "0x6002", immutableReferences: {} } };
  const evidence = {
    kind: "averray.bankXcmV2DeploymentEvidence",
    profile: "mainnet",
    sourceCommit: "a".repeat(40),
    deployer: "0x9Ab8531FBb0948C542a31298FD61335f30064239",
    verifiedAt: "2026-08-03T12:00:00.000Z",
    wrapper: { address: WRAPPER, txHash: `0x${"11".repeat(32)}`, blockNumber: 100 },
    adapter: { address: ADAPTER, txHash: `0x${"22".repeat(32)}`, blockNumber: 101 }
  };
  const provider = {
    getCode: async (address) => address.toLowerCase() === WRAPPER.toLowerCase() ? "0x6001" : "0x60ff",
    getTransactionReceipt: async (txHash) => txHash === evidence.wrapper.txHash
      ? { status: 1, blockNumber: 100, contractAddress: WRAPPER }
      : { status: 1, blockNumber: 101, contractAddress: ADAPTER }
  };
  await assert.rejects(
    buildManifestCandidate({ manifest, evidence, provider, wrapperArtifact, adapterArtifact }),
    /adapter live runtime does not match/u
  );
  provider.getCode = async (address) => address.toLowerCase() === WRAPPER.toLowerCase() ? "0x6001" : "0x6002";
  const candidate = await buildManifestCandidate({ manifest, evidence, provider, wrapperArtifact, adapterArtifact });
  assert.equal(candidate.contracts.xcmWrapper, getAddress(WRAPPER));
  assert.equal(candidate.contracts.hydrationUsdcAdapter, getAddress(ADAPTER));
});

test("two-endpoint conversion reader fails honest on missing runtime API and returns the live-shaped account", async () => {
  let disconnected = false;
  const apiFactory = async () => ({
    rpc: { system: { chain: async () => "Hydration" } },
    genesisHash: { toHex: () => `0x${"12".repeat(32)}` },
    call: { locationToAccountApi: { convertLocation: async () => ({ isSome: true, unwrap: () => ({ toHex: () => CONVERTED }) }) } },
    disconnect: async () => { disconnected = true; }
  });
  const result = await convertOnEndpoint({ endpoint: "wss://one.invalid", location: {}, apiFactory });
  assert.equal(result.convertedAccountId32, CONVERTED);
  assert.equal(disconnected, true);
  await assert.rejects(
    convertOnEndpoint({
      endpoint: "wss://bad.invalid",
      location: {},
      apiFactory: async () => ({
        rpc: { system: { chain: async () => "Hydration" } },
        genesisHash: { toHex: () => `0x${"12".repeat(32)}` },
        call: {},
        disconnect: async () => {}
      })
    }),
    /does not expose LocationToAccountApi/u
  );
});
