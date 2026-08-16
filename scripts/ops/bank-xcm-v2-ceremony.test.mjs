import assert from "node:assert/strict";
import test from "node:test";

import { Interface, getAddress, getCreateAddress, keccak256 } from "ethers";

import {
  BANK_XCM_V2,
  applyBankXcmV2Manifest,
  buildArmCalls,
  buildSuccessionCalls,
  buildBankXcmV2Messages,
  buildConfigurationCalls,
  buildRecoveryHomeMessage,
  buildV221HomeDiagnosticMessage,
  compact,
  previewRecoveryHomeId,
  truncateAccountId32,
  wrapperAccountId32
} from "./bank-xcm-v2-ceremony-lib.mjs";
import {
  assertDryRunEvidence,
  assertPacketGeneration,
  assertRuntimeFlowDisabled,
  assertV221ArmedEmptyState,
  assertV221DeploymentEvidence,
  assertV221HomeDryRunEvidence,
  assertV221SuccessionState
} from "./prepare-bank-xcm-v2-multisig.mjs";
import { captureConversionEvidence, convertOnEndpoint } from "./capture-hydration-wrapper-origin.mjs";
import {
  REVIEWED_ADAPTER_V221_CREATION_CODE_HASH,
  REVIEWED_WRAPPER_V221_CREATION_CODE_HASH,
  WRAPPER_V221_VERSION_SELECTOR,
  assertReviewedV221Artifacts,
  assertManifestRecordsDeployment,
  assertRecordedV221Candidate,
  assertSourceCheckout,
  assertSourceCommitReachable,
  buildDeploymentPlan,
  probeWrapperV221Selector,
  rebuildFoundryArtifacts
} from "./deploy-bank-xcm-v2.mjs";
import {
  buildManifestCandidate,
  forceBankXcmFlowDisabledForNewGeneration
} from "./record-bank-xcm-v2-deployment.mjs";
import { extractAaveQuote } from "./capture-bank-xcm-v22-staging-quote.mjs";
import {
  assertFreshV22StagingQuote,
  assertUnusedV22StagingCandidate,
  buildV22StagingCall
} from "./prepare-bank-xcm-v22-staging-multisig.mjs";

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

test("deploy run cannot exit green until its exact pair is recorded in the manifest", () => {
  assert.equal(assertManifestRecordsDeployment({
    manifest: {
      profile: "mainnet",
      contracts: { xcmWrapper: WRAPPER, hydrationUsdcAdapter: ADAPTER }
    },
    wrapper: WRAPPER,
    adapter: ADAPTER
  }), true);
  assert.throws(
    () => assertManifestRecordsDeployment({
      manifest: {
        profile: "mainnet",
        contracts: {
          xcmWrapper: "0xc846eE73e49A748e59C7Ac8f8742F542a552D24C",
          hydrationUsdcAdapter: "0x5eaF58a3e2819A26B66822529aD92fcec107cc98"
        }
      },
      wrapper: WRAPPER,
      adapter: ADAPTER
    }),
    /is not recorded in deployments\/mainnet\.json/u
  );
});

test("v2.2.1 green-exit gate requires the exact fifth candidate and keeps flow disabled", () => {
  const previousManifest = {
    bankXcmDeploymentHistory: [
      { version: "2.0", wrapper: "0x1000000000000000000000000000000000000001" },
      { version: "2.1-stale-artifact", wrapper: "0x1000000000000000000000000000000000000002" },
      { version: "2.1", wrapper: "0x1000000000000000000000000000000000000003" },
      { version: "2.2", wrapper: "0x1000000000000000000000000000000000000004" }
    ]
  };
  const recordedManifest = {
    profile: "mainnet",
    contracts: { xcmWrapper: WRAPPER, hydrationUsdcAdapter: ADAPTER },
    bankXcmDeploymentHistory: [
      ...previousManifest.bankXcmDeploymentHistory,
      { version: "2.2.1", wrapper: WRAPPER, adapter: ADAPTER }
    ]
  };
  const candidates = recordedManifest.bankXcmDeploymentHistory.map(({ version, wrapper }) => ({ version, wrapper }));
  const env = `BANK_XCM_FLOW_ENABLED=false\nBANK_LANE_FEED_WRAPPER_CANDIDATES_JSON=${JSON.stringify(candidates)}\n`;
  assert.equal(assertRecordedV221Candidate({
    previousManifest,
    recordedManifest,
    backendEnv: env,
    wrapper: WRAPPER,
    adapter: ADAPTER
  }), true);
  assert.throws(
    () => assertRecordedV221Candidate({
      previousManifest,
      recordedManifest,
      backendEnv: env.replace("BANK_XCM_FLOW_ENABLED=false", "BANK_XCM_FLOW_ENABLED=true"),
      wrapper: WRAPPER,
      adapter: ADAPTER
    }),
    /unexpectedly enabled/u
  );
});

test("new Bank generation record forces predecessor flow true to false", () => {
  const rendered = forceBankXcmFlowDisabledForNewGeneration([
    "XCM_WRAPPER_ADDRESS=0x1000000000000000000000000000000000000001",
    "BANK_XCM_FLOW_ENABLED=true",
    "BANK_LANE_FEED_ENABLED=true",
    ""
  ].join("\n"));
  assert.match(rendered, /^BANK_XCM_FLOW_ENABLED=false$/mu);
  assert.doesNotMatch(rendered, /^BANK_XCM_FLOW_ENABLED=true$/mu);
  assert.throws(
    () => forceBankXcmFlowDisabledForNewGeneration("BANK_LANE_FEED_ENABLED=true\n"),
    /exactly one BANK_XCM_FLOW_ENABLED setting; found 0/u
  );
  assert.throws(
    () => forceBankXcmFlowDisabledForNewGeneration("BANK_XCM_FLOW_ENABLED=true\nBANK_XCM_FLOW_ENABLED=false\n"),
    /exactly one BANK_XCM_FLOW_ENABLED setting; found 2/u
  );
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

test("v2.2 deployment replacement is explicit and records the pair it supersedes", async () => {
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

test("deployment provenance refuses a mismatched HEAD or dirty checkout", () => {
  const sourceCommit = "a".repeat(40);
  assert.equal(assertSourceCheckout({ sourceCommit, headCommit: sourceCommit, porcelain: "" }), true);
  assert.throws(
    () => assertSourceCheckout({ sourceCommit, headCommit: "b".repeat(40), porcelain: "" }),
    /does not match --source-commit/u
  );
  assert.throws(
    () => assertSourceCheckout({ sourceCommit, headCommit: sourceCommit, porcelain: " M contracts\/XcmWrapperV2.sol\n" }),
    /checkout is dirty/u
  );
});

test("deployment provenance refuses a source commit not reachable from origin/main", () => {
  const sourceCommit = "a".repeat(40);
  let invocation;
  assert.equal(assertSourceCommitReachable({
    sourceCommit,
    runner: (...args) => { invocation = args; }
  }), true);
  assert.deepEqual(invocation[1], ["merge-base", "--is-ancestor", sourceCommit, "origin/main"]);
  assert.throws(
    () => assertSourceCommitReachable({ sourceCommit, runner: () => { throw new Error("exit 1"); } }),
    /not reachable from origin\/main/u
  );
});

test("deployment rebuilds Foundry artifacts with a forced clean compile", () => {
  let invocation;
  const runner = (...args) => { invocation = args; };
  assert.equal(rebuildFoundryArtifacts({ runner }), true);
  assert.equal(invocation[0], "forge");
  assert.deepEqual(invocation[1], ["build", "--skip", "test", "--force"]);
  assert.equal(invocation[2].stdio, "inherit");
});

test("deployment artifact gate pins both reviewed v2.2.1 creation hashes and the external selector", () => {
  const abi = [
    "function dispatchLeg(bytes32,uint8,uint256)",
    "function previewRecoveryHomeId(bytes32,uint256,uint256,uint64) view returns(bytes32)"
  ];
  const observed = assertReviewedV221Artifacts({
    wrapperAbi: abi,
    wrapperEvidence: { creationCodeHash: REVIEWED_WRAPPER_V221_CREATION_CODE_HASH },
    adapterEvidence: { creationCodeHash: REVIEWED_ADAPTER_V221_CREATION_CODE_HASH }
  });
  assert.equal(observed.previewRecoveryHomeIdSelector, WRAPPER_V221_VERSION_SELECTOR);
  assert.throws(
    () => assertReviewedV221Artifacts({
      wrapperAbi: abi,
      wrapperEvidence: { creationCodeHash: `sha256:${"00".repeat(32)}` },
      adapterEvidence: { creationCodeHash: REVIEWED_ADAPTER_V221_CREATION_CODE_HASH }
    }),
    /does not match reviewed v2.2.1/u
  );
  assert.throws(
    () => assertReviewedV221Artifacts({
      wrapperAbi: ["function dispatchLeg(bytes32,uint8,uint256)"],
      wrapperEvidence: { creationCodeHash: REVIEWED_WRAPPER_V221_CREATION_CODE_HASH },
      adapterEvidence: { creationCodeHash: REVIEWED_ADAPTER_V221_CREATION_CODE_HASH }
    }),
    /does not expose the reviewed v2.2.1/u
  );
});

test("post-deploy gate probes the hard-coded v2.2.1 selector instead of trusting the artifact", async () => {
  let request;
  const response = `0x${"12".repeat(32)}`;
  const observed = await probeWrapperV221Selector({
    call: async (value) => { request = value; return response; }
  }, WRAPPER);
  assert.equal(request.to, getAddress(WRAPPER));
  assert.equal(request.data.slice(0, 10), WRAPPER_V221_VERSION_SELECTOR);
  assert.equal(observed.response, response);
  await assert.rejects(
    probeWrapperV221Selector({ call: async () => { throw new Error("execution reverted"); } }, WRAPPER),
    /does not execute v2.2.1 selector/u
  );
  await assert.rejects(
    probeWrapperV221Selector({ call: async () => `0x${"00".repeat(32)}` }, WRAPPER),
    /invalid v2.2.1 selector response/u
  );
});

test("paused configuration and atomic succession packets are deliberately separate", () => {
  const configure = buildConfigurationCalls({ manifest, wrapper: WRAPPER, adapter: ADAPTER, convertedAccountId32: CONVERTED });
  const arm = buildArmCalls({ wrapper: WRAPPER });
  const succession = buildSuccessionCalls({
    previousWrapper: "0x1000000000000000000000000000000000000004",
    wrapper: WRAPPER
  });
  assert.equal(configure.length, 4);
  assert.equal(configure.some(({ label }) => /setDispatchPaused/u.test(label)), false);
  assert.match(configure[3].label, /setStrategySettler/u);
  assert.equal(arm.length, 1);
  assert.match(arm[0].label, /setDispatchPaused\(false\)/u);
  const iface = new Interface(["function setDispatchPaused(bool)"]);
  assert.equal(iface.decodeFunctionData("setDispatchPaused", arm[0].data)[0], false);
  assert.equal(succession.length, 2);
  assert.equal(iface.decodeFunctionData("setDispatchPaused", succession[0].data)[0], true);
  assert.equal(iface.decodeFunctionData("setDispatchPaused", succession[1].data)[0], false);
});

test("v2.2.1 arm emitter requires G2, prior generation, and request-independent home proof", () => {
  assert.equal(assertPacketGeneration({ generation: "2.2.1", packet: "configure" }), true);
  assert.throws(
    () => assertPacketGeneration({ generation: "2.2.1", packet: "arm" }),
    /requires --previous-wrapper.*--home-dry-run-evidence/u
  );
  assert.equal(assertPacketGeneration({
    generation: "2.2.1",
    packet: "arm",
    deploymentEvidence: "/tmp/g2.json",
    homeDryRunEvidence: "/tmp/home.json",
    previousWrapper: "0x1000000000000000000000000000000000000004"
  }), true);
  assert.throws(
    () => assertPacketGeneration({ generation: "2.2.1", packet: "configure", dryRunEvidence: "/tmp/g3.json" }),
    /no caller-built request messages/u
  );
});

test("v2.2.1 arm deployment bundle is bound to both live runtime hashes and the external selector", () => {
  const runtime = { wrapper: "sha256:wrapper", adapter: "sha256:adapter" };
  const probe = { selector: "0x56112922", response: `0x${"11".repeat(32)}` };
  const evidence = {
    kind: "averray.bankXcmV2DeploymentEvidence",
    profile: "mainnet",
    version: "2.2.1",
    sourceCommit: "abc123",
    verifiedAt: "2026-08-04T00:00:00.000Z",
    wrapper: { address: WRAPPER, runtimeCodeHash: runtime.wrapper },
    adapter: { address: ADAPTER, runtimeCodeHash: runtime.adapter },
    liveState: {
      wrapper: { artifactRuntimeMatch: true, versionProbe: probe },
      adapter: { artifactRuntimeMatch: true }
    }
  };
  assert.equal(assertV221DeploymentEvidence({
    evidence,
    wrapper: WRAPPER,
    adapter: ADAPTER,
    liveRuntime: runtime,
    liveProbe: probe
  }).sourceCommit, "abc123");
  assert.throws(
    () => assertV221DeploymentEvidence({
      evidence,
      wrapper: WRAPPER,
      adapter: ADAPTER,
      liveRuntime: { ...runtime, wrapper: "sha256:drift" },
      liveProbe: probe
    }),
    /runtime hashes/u
  );
});

test("v2.2.1 arm fresh-state gate refuses any request, custody, allowance, or enabled flow", () => {
  const empty = {
    requestQueuedEventCount: 0,
    adapterTotalShares: "0",
    adapterTotalAssets: "0",
    adapterPendingDepositAssets: "0",
    adapterPendingWithdrawalShares: "0",
    adapterRemoteOperatingFloat: "0",
    wrapperTokenBalance: "0",
    adapterTokenBalance: "0",
    treasuryAllowanceToAdapter: "0",
    dispatchPaused: true,
    policyPaused: false,
    flowDisabled: true
  };
  assert.equal(assertV221ArmedEmptyState(empty), true);
  assert.throws(() => assertV221ArmedEmptyState({ ...empty, requestQueuedEventCount: 1 }), /requestQueuedEventCount=0/u);
  assert.throws(() => assertV221ArmedEmptyState({ ...empty, treasuryAllowanceToAdapter: "1" }), /treasuryAllowanceToAdapter=0/u);
  assert.throws(() => assertV221ArmedEmptyState({ ...empty, flowDisabled: false }), /flow.*disabled/u);
});

test("v2.2.1 request-independent home builder is byte-equal to the reviewed request-bound family", () => {
  const requestBound = bundle().messages.find(({ label }) => label === "withdraw_home");
  const diagnostic = buildV221HomeDiagnosticMessage({
    wrapper: WRAPPER,
    amount: 100_000n,
    homeExecutionFee: 1_402n,
    topic: requestBound.requestId
  });
  assert.equal(diagnostic.message, requestBound.message);
  assert.equal(diagnostic.messageHash, requestBound.messageHash);
});

test("v2.2.1 arm requires byte-bound live three-hop home completion with fee below arrival", () => {
  const built = buildV221HomeDiagnosticMessage({
    wrapper: WRAPPER,
    amount: 100_000n,
    homeExecutionFee: 1_400n,
    topic: `0x${"42".repeat(32)}`
  });
  const evidence = {
    kind: "averray.bankXcmV221RequestIndependentHomeProof",
    profile: "mainnet",
    version: "2.2.1",
    liveState: true,
    requestIndependent: true,
    wrapper: WRAPPER,
    adapter: ADAPTER,
    convertedAccountId32: CONVERTED,
    capturedAt: "2026-08-05T00:00:00.000Z",
    evidenceId: "g2-live-home",
    runtimeBlocks: { assetHub: 19_100_000, hydration: 13_480_000 },
    pricing: {
      grossAmountRaw: "100000",
      upstreamFeesRaw: "500",
      quotedArrivalRaw: "99500",
      quoteCapturedAt: "2026-08-05T00:00:00.000Z"
    },
    builder: {
      topic: built.topic,
      homeExecutionFeeRaw: "1400",
      message: built.message,
      messageHash: built.messageHash
    },
    dryRun: {
      message: built.message,
      messageHash: built.messageHash,
      hydrationExecutionComplete: true,
      forwardedParaId: 1000,
      assetHubExecutionComplete: true,
      assetHubDeposit: {
        assetId: 1337,
        beneficiaryAccountId32: wrapperAccountId32(WRAPPER),
        amountRaw: "98100"
      }
    }
  };
  assert.equal(
    assertV221HomeDryRunEvidence({ evidence, wrapper: WRAPPER, adapter: ADAPTER, convertedAccount: CONVERTED }).messageHash,
    built.messageHash
  );
  const byteDrift = structuredClone(evidence);
  byteDrift.dryRun.message = `${built.message.slice(0, -2)}00`;
  assert.throws(
    () => assertV221HomeDryRunEvidence({ evidence: byteDrift, wrapper: WRAPPER, adapter: ADAPTER, convertedAccount: CONVERTED }),
    /not byte-equal/u
  );
  const feeAtArrival = structuredClone(evidence);
  feeAtArrival.builder.homeExecutionFeeRaw = feeAtArrival.pricing.quotedArrivalRaw;
  assert.throws(
    () => assertV221HomeDryRunEvidence({ evidence: feeAtArrival, wrapper: WRAPPER, adapter: ADAPTER, convertedAccount: CONVERTED }),
    /fee < quoted arrival/u
  );
  const noFinalDeposit = structuredClone(evidence);
  noFinalDeposit.dryRun.assetHubExecutionComplete = false;
  assert.throws(
    () => assertV221HomeDryRunEvidence({ evidence: noFinalDeposit, wrapper: WRAPPER, adapter: ADAPTER, convertedAccount: CONVERTED }),
    /final Asset Hub.*deposit/u
  );
});

test("v2.2.1 succession refuses a paused predecessor or unpaused candidate", () => {
  const previousWrapper = "0x1000000000000000000000000000000000000004";
  const history = [{ version: "2.2", wrapper: previousWrapper }];
  assert.equal(assertV221SuccessionState({
    previousWrapper,
    candidateWrapper: WRAPPER,
    previousPaused: false,
    candidatePaused: true,
    history
  }), true);
  assert.throws(() => assertV221SuccessionState({
    previousWrapper,
    candidateWrapper: WRAPPER,
    previousPaused: true,
    candidatePaused: true,
    history
  }), /requires recorded v2.2 armed/u);
});

test("v2.2 arm runtime gate requires the exact deployed pair and flow-disabled surfaces", () => {
  const health = {
    status: "ok",
    deployedSha: "deadbeef",
    auth: { chainId: 420420419 },
    addresses: { xcmWrapper: WRAPPER, hydrationUsdcAdapter: ADAPTER },
    components: { blockchain: { xcmWrapperConfigured: true } },
    capabilityHealth: { xcmObserver: "staged" }
  };
  assert.equal(assertRuntimeFlowDisabled({
    health,
    wrapper: WRAPPER,
    adapter: ADAPTER,
    template: "BANK_XCM_FLOW_ENABLED=false\n"
  }).xcmObserver, "staged");
  assert.throws(
    () => assertRuntimeFlowDisabled({
      health,
      wrapper: WRAPPER,
      adapter: ADAPTER,
      template: "BANK_XCM_FLOW_ENABLED=true\n"
    }),
    /does not keep.*false/u
  );
  assert.throws(
    () => assertRuntimeFlowDisabled({
      health: { ...health, capabilityHealth: { xcmObserver: "enabled" } },
      wrapper: WRAPPER,
      adapter: ADAPTER,
      template: "BANK_XCM_FLOW_ENABLED=false\n"
    }),
    /does not prove/u
  );
});

test("v2.2 staging quote requires fresh live Aave 22→1003 output for the exact sell amount", () => {
  const quote = {
    kind: "averray.bankXcmV22StagingQuote",
    profile: "mainnet",
    liveState: true,
    chain: "Hydration",
    capturedAt: "2026-08-04T20:00:00.000Z",
    quote: { fillerType: "AAVE", assetIn: 22, assetOut: 1003, amountInRaw: "100000", amountOutRaw: "100000" }
  };
  assert.equal(assertFreshV22StagingQuote(quote, {
    sellAmount: 100000n,
    now: Date.parse("2026-08-04T20:05:00.000Z")
  }), 100000n);
  assert.throws(() => assertFreshV22StagingQuote(quote, {
    sellAmount: 100000n,
    now: Date.parse("2026-08-04T21:00:00.000Z")
  }), /stale/u);
  assert.throws(() => assertFreshV22StagingQuote({ ...quote, quote: { ...quote.quote, amountInRaw: "99999" } }, {
    sellAmount: 100000n,
    now: Date.parse("2026-08-04T20:05:00.000Z")
  }), /exact sell amount/u);
});

test("v2.2 staging quote parser binds the substantive Broadcast.Swapped Aave event", () => {
  const human = { Ok: { executionResult: { Ok: {} }, emittedEvents: [{
    section: "broadcast",
    method: "Swapped3",
    data: {
      fillerType: "AAVE",
      inputs: [{ asset: "22", amount: "100,000" }],
      outputs: [{ asset: "1,003", amount: "100,000" }]
    }
  }] } };
  assert.equal(extractAaveQuote(human, 100000n).amountOutRaw, "100000");
  assert.equal(extractAaveQuote(human, 100000n).entryAccrualRaw, "0");
  // Filler-par accrual law (measured live 2026-08-16): both event amounts may
  // exceed the requested input by a bounded index accrual.
  const accruedEvent = { section: "broadcast", method: "Swapped3", data: { fillerType: "AAVE", inputs: [{ asset: "22", amount: "100,004" }], outputs: [{ asset: "1,003", amount: "100,004" }] } };
  const accrued = { ...human, Ok: { ...human.Ok, emittedEvents: [accruedEvent] } };
  assert.equal(extractAaveQuote(accrued, 100000n).entryAccrualRaw, "4");
  const parBreak = { ...human, Ok: { ...human.Ok, emittedEvents: [{ ...accruedEvent, data: { ...accruedEvent.data, outputs: [{ asset: "1,003", amount: "100,003" }] } }] } };
  assert.throws(() => extractAaveQuote(parBreak, 100000n), /filler-par/u);
  assert.throws(() => extractAaveQuote({ ...human, Ok: { ...human.Ok, emittedEvents: [] } }, 100000n), /Swapped/u);
});

test("v2.2 approval is exact and staging binds 100k sell, 40k cap, quote, deadline, and transport margin", () => {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const common = {
    token: TOKEN,
    wrapper: WRAPPER,
    adapter: ADAPTER,
    treasury: OWNER,
    assets: 150000n,
    sellAmount: 100000n,
    minimumOutput: 100000n,
    maxFeePerLeg: 40000n,
    dispatchDeadline: deadline,
    nonce: 1n
  };
  const approve = buildV22StagingCall({ packet: "approve", ...common });
  const tokenIface = new Interface(["function approve(address,uint256)"]);
  const decodedApprove = tokenIface.decodeFunctionData("approve", approve.data);
  assert.equal(decodedApprove[0], getAddress(ADAPTER));
  assert.equal(decodedApprove[1], 150000n);

  const stage = buildV22StagingCall({ packet: "stage", ...common });
  const adapterIface = new Interface(["function stageTreasuryDeposit(address,uint256,uint256,uint256,uint256,uint64,uint64)"]);
  const decoded = adapterIface.decodeFunctionData("stageTreasuryDeposit", stage.data);
  assert.deepEqual([...decoded], [getAddress(OWNER), 150000n, 100000n, 100000n, 40000n, deadline, 1n]);
  assert.equal(stage.decoded.transportHeadroomRaw, "10000");
  assert.throws(() => buildV22StagingCall({ packet: "stage", ...common, assets: 140000n }), /transport headroom/u);
});

test("v2.2 restaging gates the candidate request id instead of rejecting historical terminal requests", () => {
  const requestId = `0x${"ab".repeat(32)}`;
  assert.deepEqual(assertUnusedV22StagingCandidate({
    requestId,
    record: {
      context: { account: "0x0000000000000000000000000000000000000000" },
      status: 0
    }
  }), {
    requestId,
    status: 0,
    account: "0x0000000000000000000000000000000000000000"
  });
  assert.throws(() => assertUnusedV22StagingCandidate({
    requestId,
    record: { context: { account: OWNER }, status: 4 }
  }), /already occupied; increment --nonce/u);
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
    version: "2.0",
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
  assert.equal(next.bankXcmV2Deployment.flowEnabled, false);
  assert.equal(next.bankXcmDeploymentHistory[0].wrapper, getAddress(WRAPPER));
  assert.equal(next.bankXcmDeploymentHistory[0].flowEnabled, false);
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
    version: "2.1",
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
  assert.equal(next.bankXcmDeploymentHistory.length, 2);
  assert.equal(next.bankXcmDeploymentHistory[0].status, "retired_replaced");
  assert.equal(next.bankXcmDeploymentHistory[0].incident.writeOffs[0].raw, "149412");
  assert.deepEqual(next.bankXcmDeploymentHistory[0].retiredCapital, [{ assetId: 22, raw: "149412" }]);
  assert.equal(next.bankXcmDeploymentHistory[1].version, "2.1");
  assert.equal(next.bankXcmDeploymentHistory[1].status, "deployed_paused");
});

test("v2.2 manifest replacement appends the new pair and emits generation-specific keys", () => {
  const previous = applyBankXcmV2Manifest(manifest, {
    version: "2.1",
    sourceCommit: "a".repeat(40),
    deployer: OPERATOR,
    verifiedAt: "2026-08-04T08:00:00.000Z",
    wrapper: {
      address: WRAPPER,
      txHash: `0x${"11".repeat(32)}`,
      blockNumber: 19_100_001,
      abiHash: `sha256:${"12".repeat(32)}`,
      runtimeCodeHash: `sha256:${"13".repeat(32)}`
    },
    adapter: {
      address: ADAPTER,
      txHash: `0x${"21".repeat(32)}`,
      blockNumber: 19_100_002,
      abiHash: `sha256:${"22".repeat(32)}`,
      runtimeCodeHash: `sha256:${"23".repeat(32)}`
    }
  });
  const wrapperV22 = "0x2222222222222222222222222222222222222222";
  const adapterV22 = "0x3333333333333333333333333333333333333333";
  const next = applyBankXcmV2Manifest(previous, {
    version: "2.2",
    sourceCommit: "b".repeat(40),
    deployer: OPERATOR,
    verifiedAt: "2026-08-04T19:00:00.000Z",
    replacementReason: "v2.2 dispatch-time fee pricing",
    wrapper: {
      address: wrapperV22,
      txHash: `0x${"31".repeat(32)}`,
      blockNumber: 19_200_001,
      abiHash: `sha256:${"32".repeat(32)}`,
      runtimeCodeHash: `sha256:${"33".repeat(32)}`
    },
    adapter: {
      address: adapterV22,
      txHash: `0x${"41".repeat(32)}`,
      blockNumber: 19_200_002,
      abiHash: `sha256:${"42".repeat(32)}`,
      runtimeCodeHash: `sha256:${"43".repeat(32)}`
    }
  });

  assert.deepEqual(next.bankXcmDeploymentHistory.map((entry) => entry.version), ["2.1", "2.2"]);
  assert.equal(next.bankXcmDeploymentHistory[1].wrapper, getAddress(wrapperV22));
  assert.equal(next.bankXcmV2Deployment.version, "2.2");
  assert.equal(next.deploymentBlocks.xcmWrapperV2_2, 19_200_001);
  assert.equal(next.deploymentBlocks.hydrationUsdcAdapterV2_2, 19_200_002);
  assert.equal(next.deployers.xcmWrapperV2_2, getAddress(OPERATOR));
  assert.equal(next.deployers.hydrationUsdcAdapterV2_2, getAddress(OPERATOR));
});

test("fresh v2.2.1 generation append forces runtime flow false before its enablement rung", () => {
  const wrapperV221 = "0x4444444444444444444444444444444444444444";
  const adapterV221 = "0x5555555555555555555555555555555555555555";
  const prior = {
    ...manifest,
    contracts: { ...manifest.contracts, xcmWrapper: WRAPPER, hydrationUsdcAdapter: ADAPTER },
    bankXcmDeploymentHistory: [{ version: "2.2", wrapper: WRAPPER, adapter: ADAPTER }],
    bankXcmV2Deployment: { version: "2.2" }
  };
  const next = applyBankXcmV2Manifest(prior, {
    version: "2.2.1",
    sourceCommit: "c".repeat(40),
    deployer: OPERATOR,
    verifiedAt: "2026-08-05T19:00:00.000Z",
    convertedAccountId32: CONVERTED,
    wrapper: {
      address: wrapperV221,
      txHash: `0x${"51".repeat(32)}`,
      blockNumber: 19_300_001,
      abiHash: `sha256:${"52".repeat(32)}`,
      runtimeCodeHash: `sha256:${"53".repeat(32)}`
    },
    adapter: {
      address: adapterV221,
      txHash: `0x${"61".repeat(32)}`,
      blockNumber: 19_300_002,
      abiHash: `sha256:${"62".repeat(32)}`,
      runtimeCodeHash: `sha256:${"63".repeat(32)}`
    }
  });
  assert.deepEqual(next.bankXcmDeploymentHistory.map((entry) => entry.version), ["2.2", "2.2.1"]);
  // Append-time safety is intentionally distinct from the current rendered
  // post-enablement state asserted by bank-lane-feed.test.js.
  assert.equal(next.bankXcmDeploymentHistory[1].flowEnabled, false);
  assert.equal(next.bankXcmV2Deployment.flowEnabled, false);
  assert.equal(next.deploymentBlocks.xcmWrapperV2_2_1, 19_300_001);
  assert.equal(next.deploymentBlocks.hydrationUsdcAdapterV2_2_1, 19_300_002);
  assert.equal(next.deployers.xcmWrapperV2_2_1, getAddress(OPERATOR));
});

test("manifest candidate refuses live runtime drift before recording provenance", async () => {
  const wrapperArtifact = { abi: [], bytecode: { object: "0x6000" }, deployedBytecode: { object: "0x6001", immutableReferences: {} } };
  const adapterArtifact = { abi: [], bytecode: { object: "0x6000" }, deployedBytecode: { object: "0x6002", immutableReferences: {} } };
  const evidence = {
    kind: "averray.bankXcmV2DeploymentEvidence",
    profile: "mainnet",
    version: "2.0",
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

test("conversion capture requires two independent endpoints to agree", async () => {
  const apiFactory = async (endpoint) => ({
    rpc: { system: { chain: async () => "Hydration" } },
    genesisHash: { toHex: () => `0x${"12".repeat(32)}` },
    call: {
      locationToAccountApi: {
        convertLocation: async () => ({
          isSome: true,
          unwrap: () => ({ toHex: () => endpoint.includes("two") ? CONVERTED : CONVERTED })
        })
      }
    },
    disconnect: async () => {}
  });
  const evidence = await captureConversionEvidence({
    wrapper: WRAPPER,
    endpoints: ["wss://one.invalid", "wss://two.invalid"],
    apiFactory
  });
  assert.equal(evidence.reads.length, 2);
  assert.equal(evidence.convertedAccountId32, CONVERTED);

  await assert.rejects(
    captureConversionEvidence({
      wrapper: WRAPPER,
      endpoints: ["wss://one.invalid", "wss://two.invalid"],
      apiFactory: async (endpoint) => ({
        rpc: { system: { chain: async () => "Hydration" } },
        genesisHash: { toHex: () => `0x${"12".repeat(32)}` },
        call: {
          locationToAccountApi: {
            convertLocation: async () => ({
              isSome: true,
              unwrap: () => ({ toHex: () => endpoint.includes("two") ? `0x${"99".repeat(32)}` : CONVERTED })
            })
          }
        },
        disconnect: async () => {}
      })
    }),
    /independent convert_location reads disagree/u
  );
});
