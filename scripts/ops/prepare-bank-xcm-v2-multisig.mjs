#!/usr/bin/env node

/**
 * Read-only emitter for the two Bank gate-4c multisig packets:
 *
 *   configure — converted account, backend operator, adapter binding, and
 *               strategySettler grant; wrapper remains paused.
 *   arm       — setDispatchPaused(false), emitted for v2.2 only after the G2
 *               bundle and a fresh configured-empty live-state proof pass.
 *
 * It never signs or submits. Hardware signing remains in Nova/Spektr/Apps.
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Interface, ZeroAddress, getAddress } from "ethers";

import {
  ADAPTER_ADMIN_ABI,
  BANK_XCM_V2,
  POLICY_BANK_ABI,
  WRAPPER_ADMIN_ABI,
  buildArmCalls,
  buildBankXcmV2Messages,
  buildRecoveryHomeMessage,
  buildConfigurationCalls,
  loadJson,
  sha256Hex,
  truncateAccountId32,
  wrapperAccountId32
} from "./bank-xcm-v2-ceremony-lib.mjs";
import {
  SUBSTRATE_PROFILE_CONFIG,
  assertOwnerRecordAuthority,
  assertSubstrateProfileEncoding,
  buildOnchainPayload,
  buildPolkadotAppsExtrinsicsUrl,
  resolveProfileSigner,
  verifyEvmCalldataEmbedded
} from "./redeploy-escrowcore-wire-multisig.mjs";
import { createCeremonyRpcContext, printCeremonyRpcPreflight } from "./ceremony-rpc.mjs";
import { probeWrapperV22Selector } from "./deploy-bank-xcm-v2.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const PACKETS = new Set(["configure", "arm"]);
const V22_WRAPPER_STATE_ABI = Object.freeze([
  ...WRAPPER_ADMIN_ABI,
  "event RequestQueued(bytes32 indexed requestId,bytes32 indexed strategyId,uint8 indexed kind,address account,address asset,address recipient,uint256 assets,uint256 shares,uint64 nonce)"
]);
const V22_ADAPTER_STATE_ABI = Object.freeze([
  ...ADAPTER_ADMIN_ABI,
  "function totalShares() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function pendingDepositAssets() view returns (uint256)",
  "function pendingWithdrawalShares() view returns (uint256)",
  "function remoteOperatingFloat() view returns (uint256)"
]);
const ERC20_STATE_ABI = Object.freeze([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)"
]);
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const REQUEST_QUEUED_TOPIC = new Interface(V22_WRAPPER_STATE_ABI).getEvent("RequestQueued").topicHash;

export function parseArgs(argv) {
  const args = {
    profile: "mainnet",
    generation: "2.1",
    packet: "configure",
    ws: SUBSTRATE_PROFILE_CONFIG.mainnet.defaultWs,
    depositAssets: "150000",
    depositSellAmount: "100000",
    depositFee: "20917",
    withdrawShares: "100000",
    withdrawFee: "21350",
    homeAmount: "100000",
    homeFee: "1402",
    recoveryAmount: "100000",
    recoveryFee: "1402",
    recoveryNonce: "1",
    depositNonce: "1",
    withdrawNonce: "2"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--profile") args.profile = argv[++index];
    else if (token === "--generation") args.generation = argv[++index];
    else if (token === "--packet") args.packet = argv[++index];
    else if (token === "--wrapper") args.wrapper = argv[++index];
    else if (token === "--adapter") args.adapter = argv[++index];
    else if (token === "--converted-account") args.convertedAccount = argv[++index];
    else if (token === "--conversion-evidence") args.conversionEvidence = argv[++index];
    else if (token === "--deployment-evidence") args.deploymentEvidence = argv[++index];
    else if (token === "--predeploy-plan") args.predeployPlan = argv[++index];
    else if (token === "--dry-run-evidence") args.dryRunEvidence = argv[++index];
    else if (token === "--messages-out") args.messagesOut = argv[++index];
    else if (token === "--packet-out") args.packetOut = argv[++index];
    else if (token === "--signer") args.signer = argv[++index];
    else if (token === "--timepoint-height") args.timepointHeight = argv[++index];
    else if (token === "--timepoint-index") args.timepointIndex = argv[++index];
    else if (token === "--ws") args.ws = argv[++index];
    else if (token === "--deposit-assets") args.depositAssets = argv[++index];
    else if (token === "--deposit-sell-amount") args.depositSellAmount = argv[++index];
    else if (token === "--deposit-fee") args.depositFee = argv[++index];
    else if (token === "--withdraw-shares") args.withdrawShares = argv[++index];
    else if (token === "--withdraw-fee") args.withdrawFee = argv[++index];
    else if (token === "--home-amount") args.homeAmount = argv[++index];
    else if (token === "--home-fee") args.homeFee = argv[++index];
    else if (token === "--recovery-amount") args.recoveryAmount = argv[++index];
    else if (token === "--recovery-fee") args.recoveryFee = argv[++index];
    else if (token === "--recovery-nonce") args.recoveryNonce = argv[++index];
    else if (token === "--deposit-nonce") args.depositNonce = argv[++index];
    else if (token === "--withdraw-nonce") args.withdrawNonce = argv[++index];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/ops/prepare-bank-xcm-v2-multisig.mjs --profile mainnet \\",
    "    --generation 2.1|2.2 --packet configure|arm --wrapper 0x... --adapter 0x... \\",
    "    --converted-account 0x... --conversion-evidence evidence.json \\",
    "    --signer nova --packet-out docs/evidence/...json \\",
    "    [--timepoint-height H --timepoint-index I]",
    "  [--predeploy-plan /tmp/plan.json]  # configure packet preview only",
    "",
    "Message inputs: --deposit-assets/--deposit-sell-amount/--deposit-fee,",
    "  --withdraw-shares/--withdraw-fee/--home-amount/--home-fee,",
    "  --deposit-nonce/--withdraw-nonce, and",
    "  --recovery-amount/--recovery-fee/--recovery-nonce.",
    "Generation 2.2 arm additionally requires --deployment-evidence. The emitter",
    "revalidates its runtime hashes/probe and a fresh configured-empty chain state.",
    "For v2.1 --packet arm, --dry-run-evidence is mandatory and must bind all five",
    "message hashes to successful forwarded/event assertions. No signing occurs."
  ].join("\n");
}

function stringify(value) {
  return JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2);
}

export function assertPacketGeneration({ generation, packet, messagesOut, dryRunEvidence, deploymentEvidence }) {
  if (!["2.1", "2.2"].includes(generation)) throw new Error("--generation must be 2.1 or 2.2.");
  if (generation === "2.2" && (messagesOut || dryRunEvidence)) {
    throw new Error("v2.2 configure/arm emits no caller-built request messages or upfront per-leg evidence.");
  }
  if (generation === "2.2" && packet === "arm" && !deploymentEvidence) {
    throw new Error("v2.2 arm requires --deployment-evidence plus a fresh configured-empty live-state proof.");
  }
  return true;
}

export function assertV22DeploymentEvidence({ evidence, wrapper, adapter, liveRuntime, liveProbe }) {
  if (evidence?.kind !== "averray.bankXcmV2DeploymentEvidence" || evidence?.profile !== "mainnet" || evidence?.version !== "2.2") {
    throw new Error("v2.2 arm deployment evidence kind/profile/version mismatch.");
  }
  if (getAddress(evidence.wrapper?.address) !== getAddress(wrapper) || getAddress(evidence.adapter?.address) !== getAddress(adapter)) {
    throw new Error("v2.2 arm deployment evidence is not bound to the live pair.");
  }
  if (
    evidence.liveState?.wrapper?.artifactRuntimeMatch !== true ||
    evidence.liveState?.adapter?.artifactRuntimeMatch !== true ||
    evidence.wrapper?.runtimeCodeHash !== liveRuntime.wrapper ||
    evidence.adapter?.runtimeCodeHash !== liveRuntime.adapter
  ) {
    throw new Error("v2.2 arm live runtime hashes do not match the G2 deployment bundle.");
  }
  const recordedProbe = evidence.liveState?.wrapper?.versionProbe;
  if (
    recordedProbe?.selector !== "0x526a213a" ||
    !/^0x[0-9a-f]{64}$/iu.test(recordedProbe?.response ?? "") ||
    liveProbe?.selector !== "0x526a213a" ||
    !/^0x[0-9a-f]{64}$/iu.test(liveProbe?.response ?? "")
  ) {
    throw new Error("v2.2 arm requires both recorded and fresh external selector proof.");
  }
  return {
    sourceCommit: evidence.sourceCommit,
    deploymentVerifiedAt: evidence.verifiedAt,
    runtimeHashes: liveRuntime,
    recordedVersionProbe: recordedProbe,
    freshVersionProbe: liveProbe
  };
}

export function assertV22ArmedEmptyState(snapshot) {
  const zeroFields = [
    "requestQueuedEventCount",
    "adapterTotalShares",
    "adapterTotalAssets",
    "adapterPendingDepositAssets",
    "adapterPendingWithdrawalShares",
    "adapterRemoteOperatingFloat",
    "wrapperTokenBalance",
    "adapterTokenBalance",
    "treasuryAllowanceToAdapter"
  ];
  for (const field of zeroFields) {
    if (BigInt(snapshot?.[field] ?? -1) !== 0n) {
      throw new Error(`v2.2 arm requires ${field}=0; observed ${snapshot?.[field] ?? "<missing>"}.`);
    }
  }
  if (snapshot?.dispatchPaused !== true || snapshot?.policyPaused !== false) {
    throw new Error("v2.2 arm requires policy live and wrapper locally paused.");
  }
  if (snapshot?.flowDisabled !== true) {
    throw new Error("v2.2 arm requires the running backend flow to be provably disabled.");
  }
  return true;
}

export function assertRuntimeFlowDisabled({ health, wrapper, adapter, template }) {
  if (!/^BANK_XCM_FLOW_ENABLED=false$/mu.test(template)) {
    throw new Error("backend mainnet template does not keep BANK_XCM_FLOW_ENABLED=false.");
  }
  if (
    health?.status !== "ok" ||
    Number(health?.auth?.chainId) !== BANK_XCM_V2.chainId ||
    getAddress(health?.addresses?.xcmWrapper) !== getAddress(wrapper) ||
    getAddress(health?.addresses?.hydrationUsdcAdapter) !== getAddress(adapter) ||
    health?.components?.blockchain?.xcmWrapperConfigured !== true ||
    health?.capabilityHealth?.xcmObserver !== "staged"
  ) {
    throw new Error("public production health does not prove this pair loaded with the XCM flow staged/disabled.");
  }
  return {
    healthUrl: "https://api.averray.com/health",
    deployedSha: health.deployedSha,
    chainId: Number(health.auth.chainId),
    wrapper: getAddress(health.addresses.xcmWrapper),
    adapter: getAddress(health.addresses.hydrationUsdcAdapter),
    xcmWrapperConfigured: true,
    xcmObserver: "staged",
    templateSetting: "BANK_XCM_FLOW_ENABLED=false"
  };
}

function assertConversionEvidence(evidence, wrapper, convertedAccount) {
  const expectedOrigin = wrapperAccountId32(wrapper).toLowerCase();
  const expectedConverted = convertedAccount.toLowerCase();
  if (evidence?.kind !== "averray.hydrationLocationConversion" || evidence?.profile !== "mainnet") {
    throw new Error("conversion evidence kind/profile mismatch.");
  }
  if (String(evidence.wrapper).toLowerCase() !== wrapper.toLowerCase() || String(evidence.assetHubOriginAccountId32).toLowerCase() !== expectedOrigin) {
    throw new Error("conversion evidence is not bound to this deployed wrapper origin.");
  }
  if (!Array.isArray(evidence.reads) || evidence.reads.length < 2) {
    throw new Error("conversion evidence requires two independent endpoint reads.");
  }
  const endpoints = new Set();
  for (const read of evidence.reads) {
    endpoints.add(String(read.endpoint));
    if (String(read.convertedAccountId32).toLowerCase() !== expectedConverted) {
      throw new Error(`converted account mismatch from ${read.endpoint}.`);
    }
  }
  if (endpoints.size < 2) throw new Error("conversion evidence endpoints are not independent.");
  return { endpoints: [...endpoints], convertedAccountId32: convertedAccount };
}

export function assertDryRunEvidence(evidence, bundle) {
  if (evidence?.kind !== "averray.bankXcmV2DryRunEvidence" || evidence?.profile !== "mainnet") {
    throw new Error("dry-run evidence kind/profile mismatch.");
  }
  if (String(evidence.wrapper).toLowerCase() !== bundle.wrapper.toLowerCase() || String(evidence.convertedAccountId32).toLowerCase() !== bundle.convertedAccountId32.toLowerCase()) {
    throw new Error("dry-run evidence wrapper/converted-account binding mismatch.");
  }
  if (!Array.isArray(evidence.legs) || evidence.legs.length !== bundle.messages.length) {
    throw new Error(`dry-run evidence must contain exactly ${bundle.messages.length} legs.`);
  }
  if (!Number.isInteger(evidence.runtimeBlocks?.assetHub) || evidence.runtimeBlocks.assetHub <= 0 || !Number.isInteger(evidence.runtimeBlocks?.hydration) || evidence.runtimeBlocks.hydration <= 0) {
    throw new Error("dry-run evidence requires positive Asset Hub and Hydration runtime blocks.");
  }
  for (const expected of bundle.messages) {
    const actual = evidence.legs.find((entry) => entry.label === expected.label);
    if (!actual) throw new Error(`dry-run evidence missing ${expected.label}.`);
    if (actual.passed !== true || String(actual.messageHash).toLowerCase() !== expected.messageHash.toLowerCase() || String(actual.requestId).toLowerCase() !== expected.requestId.toLowerCase()) {
      throw new Error(`dry-run evidence did not pass or bind exact bytes for ${expected.label}.`);
    }
    if (typeof actual.rawEvidence !== "string" || actual.rawEvidence.trim() === "") {
      throw new Error(`dry-run evidence for ${expected.label} must reference the captured raw output.`);
    }
    if (expected.expected.forwardedParaId !== undefined && Number(actual.forwardedParaId) !== expected.expected.forwardedParaId) {
      throw new Error(`${expected.label} did not forward to para ${expected.expected.forwardedParaId}.`);
    }
    if (expected.expected.event !== undefined) {
      if (actual.event !== expected.expected.event || actual.fillerType !== expected.expected.fillerType || Number(actual.assetIn) !== expected.expected.assetIn || Number(actual.assetOut) !== expected.expected.assetOut) {
        throw new Error(`${expected.label} is missing the expected ${expected.expected.event}{${expected.expected.fillerType}} asset pair.`);
      }
    }
    if (expected.expected.remoteEvent !== undefined && (actual.remoteEvent !== expected.expected.remoteEvent || Number(actual.assetId) !== expected.expected.assetId)) {
      throw new Error(`${expected.label} is missing the expected ${expected.expected.remoteEvent} asset ${expected.expected.assetId}.`);
    }
  }
  return true;
}

async function assertLiveState({
  provider,
  manifest,
  wrapperAddress,
  adapterAddress,
  convertedAccount,
  packet,
  generation,
  deploymentEvidence,
  fetchImpl = fetch
}) {
  const wrapper = new Contract(wrapperAddress, V22_WRAPPER_STATE_ABI, provider);
  const adapter = new Contract(adapterAddress, V22_ADAPTER_STATE_ABI, provider);
  const policy = new Contract(getAddress(manifest.contracts.treasuryPolicy), POLICY_BANK_ABI, provider);
  const blockNumber = await provider.getBlockNumber();
  const at = { blockTag: blockNumber };
  const [code, adapterCode, liveOwner, policyPaused, wrapperPolicy, precompile, paused, operator, hydration, boundAdapter, strategySettler, adapterPolicy, adapterAsset, adapterStrategy, adapterWrapper, adapterAac] = await Promise.all([
    provider.getCode(wrapperAddress, blockNumber),
    provider.getCode(adapterAddress, blockNumber),
    policy.owner(at),
    policy.paused(at),
    wrapper.policy(at),
    wrapper.xcmPrecompile(at),
    wrapper.dispatchPaused(at),
    wrapper.operator(at),
    wrapper.hydrationAccountId32(at),
    wrapper.strategyAdapter(BANK_XCM_V2.strategyId, at),
    policy.strategySettler(getAddress(manifest.verifier), at),
    adapter.policy(at),
    adapter.asset(at),
    adapter.strategyId(at),
    adapter.xcmWrapper(at),
    adapter.agentAccountCore(at)
  ]);
  if (code === "0x" || adapterCode === "0x") throw new Error("wrapper or adapter has no deployed bytecode.");
  if (getAddress(liveOwner) !== getAddress(manifest.owner) || getAddress(wrapperPolicy) !== getAddress(manifest.contracts.treasuryPolicy) || getAddress(precompile) !== getAddress(BANK_XCM_V2.xcmPrecompile)) {
    throw new Error("live wrapper authority/immutable preflight mismatch.");
  }
  if (
    getAddress(adapterPolicy) !== getAddress(manifest.contracts.treasuryPolicy) ||
    getAddress(adapterAsset) !== getAddress(manifest.contracts.token) ||
    String(adapterStrategy).toLowerCase() !== BANK_XCM_V2.strategyId.toLowerCase() ||
    getAddress(adapterWrapper) !== wrapperAddress ||
    getAddress(adapterAac) !== getAddress(manifest.contracts.agentAccountCore)
  ) throw new Error("live adapter immutable preflight mismatch.");
  if (paused !== true) throw new Error("wrapper is not locally paused; refusing to emit ceremony material.");
  const targetOperator = getAddress(manifest.verifier);
  if (packet === "configure") {
    if (getAddress(operator) !== ZeroAddress && getAddress(operator) !== targetOperator) throw new Error("wrapper operator is an unexpected address.");
    if (hydration !== `0x${"00".repeat(32)}` && hydration.toLowerCase() !== convertedAccount.toLowerCase()) throw new Error("wrapper Hydration account is an unexpected value.");
    if (getAddress(boundAdapter) !== ZeroAddress && getAddress(boundAdapter) !== adapterAddress) throw new Error("wrapper strategy adapter is an unexpected address.");
  } else if (
    policyPaused !== false ||
    getAddress(operator) !== targetOperator ||
    hydration.toLowerCase() !== convertedAccount.toLowerCase() ||
    getAddress(boundAdapter) !== adapterAddress ||
    strategySettler !== true
  ) {
    throw new Error("arm packet requires the complete paused configuration to already be live.");
  }
  const result = {
    capturedAt: new Date().toISOString(),
    assetHubBlockNumber: blockNumber,
    liveOwner: getAddress(liveOwner),
    policyPaused,
    paused,
    operator: getAddress(operator),
    hydration,
    boundAdapter: getAddress(boundAdapter),
    strategySettler
  };
  if (generation === "2.2" && packet === "arm") {
    if (!deploymentEvidence) throw new Error("v2.2 arm deployment evidence was not loaded.");
    const token = new Contract(getAddress(manifest.contracts.token), ERC20_STATE_ABI, provider);
    const deployBlock = Number(deploymentEvidence.wrapper?.blockNumber);
    if (!Number.isInteger(deployBlock) || deployBlock <= 0 || deployBlock > blockNumber) {
      throw new Error("v2.2 deployment evidence has an invalid wrapper block.");
    }
    const [
      requestLogs,
      totalShares,
      totalAssets,
      pendingDepositAssets,
      pendingWithdrawalShares,
      remoteOperatingFloat,
      wrapperTokenBalance,
      adapterTokenBalance,
      treasuryAllowance,
      freshProbe,
      healthResponse
    ] = await Promise.all([
      provider.getLogs({ address: wrapperAddress, topics: [REQUEST_QUEUED_TOPIC], fromBlock: deployBlock, toBlock: blockNumber }),
      adapter.totalShares(at),
      adapter.totalAssets(at),
      adapter.pendingDepositAssets(at),
      adapter.pendingWithdrawalShares(at),
      adapter.remoteOperatingFloat(at),
      token.balanceOf(wrapperAddress, at),
      token.balanceOf(adapterAddress, at),
      token.allowance(getAddress(manifest.owner), adapterAddress, at),
      probeWrapperV22Selector(provider, wrapperAddress),
      fetchImpl("https://api.averray.com/health")
    ]);
    if (!healthResponse?.ok) throw new Error(`public production health fetch failed (${healthResponse?.status ?? "no status"}).`);
    const health = await healthResponse.json();
    const flow = assertRuntimeFlowDisabled({
      health,
      wrapper: wrapperAddress,
      adapter: adapterAddress,
      template: readFileSync(resolve(repoRoot, "deploy/backend.mainnet.env.template"), "utf8")
    });
    const runtime = {
      wrapper: sha256Hex(code),
      adapter: sha256Hex(adapterCode)
    };
    const verifiedDeployment = assertV22DeploymentEvidence({
      evidence: deploymentEvidence,
      wrapper: wrapperAddress,
      adapter: adapterAddress,
      liveRuntime: runtime,
      liveProbe: freshProbe
    });
    const empty = {
      requestQueuedEventCount: requestLogs.length,
      adapterTotalShares: totalShares.toString(),
      adapterTotalAssets: totalAssets.toString(),
      adapterPendingDepositAssets: pendingDepositAssets.toString(),
      adapterPendingWithdrawalShares: pendingWithdrawalShares.toString(),
      adapterRemoteOperatingFloat: remoteOperatingFloat.toString(),
      wrapperTokenBalance: wrapperTokenBalance.toString(),
      adapterTokenBalance: adapterTokenBalance.toString(),
      treasuryAllowanceToAdapter: treasuryAllowance.toString(),
      dispatchPaused: paused,
      policyPaused,
      flowDisabled: true
    };
    assertV22ArmedEmptyState(empty);
    result.g2Verification = {
      deploymentEvidence: argsafeEvidenceRef(deploymentEvidence),
      deployment: verifiedDeployment,
      configurePostState: {
        operator: getAddress(operator),
        hydrationAccountId32: hydration,
        strategyAdapter: getAddress(boundAdapter),
        strategySettler,
        dispatchPaused: paused,
        policyPaused
      },
      armedEmpty: empty,
      flow
    };
  }
  return result;
}

function argsafeEvidenceRef(evidence) {
  return {
    kind: evidence.kind,
    version: evidence.version,
    sourceCommit: evidence.sourceCommit,
    verifiedAt: evidence.verifiedAt,
    wrapperTxHash: evidence.wrapper?.txHash,
    adapterTxHash: evidence.adapter?.txHash
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.profile !== "mainnet" || !PACKETS.has(args.packet)) throw new Error("profile must be mainnet and packet configure|arm.");
  assertPacketGeneration(args);
  if (args.generation === "2.2" && !args.packetOut) {
    throw new Error("v2.2 configure/arm requires --packet-out so the unsigned SCALE and capture-time liveState are reviewable.");
  }
  if (!args.wrapper || !args.adapter || !args.convertedAccount || !args.conversionEvidence || !args.signer) throw new Error("wrapper, adapter, converted account, conversion evidence, and signer are required.");
  if ((args.timepointHeight !== undefined) !== (args.timepointIndex !== undefined)) throw new Error("timepoint height/index must be supplied together.");
  const wrapper = getAddress(args.wrapper);
  const adapter = getAddress(args.adapter);
  const convertedAccount = String(args.convertedAccount).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(convertedAccount)) throw new Error("--converted-account must be bytes32.");
  const manifest = loadJson(resolve(repoRoot, "deployments/mainnet.json"));
  const ownerRecord = loadJson(resolve(repoRoot, "deployments/mainnet-multisig-owner.json"));
  const deploymentEvidence = args.deploymentEvidence ? loadJson(resolve(args.deploymentEvidence)) : null;
  const conversion = assertConversionEvidence(loadJson(resolve(args.conversionEvidence)), wrapper, convertedAccount);
  const signer = resolveProfileSigner({ ownerRecord, profile: "mainnet", signerLabel: args.signer });
  const messages = args.generation === "2.1" ? buildBankXcmV2Messages({
    wrapper,
    convertedAccountId32: convertedAccount,
    asset: manifest.contracts.token,
    treasuryContext: manifest.owner,
    depositAssets: BigInt(args.depositAssets),
    depositSellAmount: BigInt(args.depositSellAmount),
    depositFee: BigInt(args.depositFee),
    withdrawShares: BigInt(args.withdrawShares),
    withdrawFee: BigInt(args.withdrawFee),
    homeAmount: BigInt(args.homeAmount),
    homeFee: BigInt(args.homeFee),
    depositNonce: BigInt(args.depositNonce),
    withdrawNonce: BigInt(args.withdrawNonce)
  }) : null;
  const recovery = args.generation === "2.1" ? buildRecoveryHomeMessage({
    wrapper,
    convertedAccountId32: convertedAccount,
    amount: BigInt(args.recoveryAmount),
    fee: BigInt(args.recoveryFee),
    nonce: BigInt(args.recoveryNonce)
  }) : null;
  const evidenceBundle = messages ? { ...messages, messages: [...messages.messages, recovery] } : null;
  if (args.messagesOut) {
    await writeFile(resolve(args.messagesOut), `${stringify({ schemaVersion: 2, kind: "averray.bankXcmV2Messages", profile: "mainnet", ...messages, recovery })}\n`, { flag: "wx" });
  }
  if (args.packet === "arm") {
    if (args.generation === "2.1") {
      if (!args.dryRunEvidence) throw new Error("v2.1 arm packet requires --dry-run-evidence.");
      assertDryRunEvidence(loadJson(resolve(args.dryRunEvidence)), evidenceBundle);
    }
  }

  const rpc = await createCeremonyRpcContext({ manifest, phase: `bank-xcm-v2-${args.packet}-owner-check`, write: false });
  let live;
  let authority;
  try {
    printCeremonyRpcPreflight(rpc);
    if (args.predeployPlan) {
      if (args.packet !== "configure") throw new Error("--predeploy-plan may preview only the paused configure packet, never arm.");
      const plan = loadJson(resolve(args.predeployPlan));
      if (
        plan?.kind !== "averray.bankXcmV2DeploymentPlan" ||
        String(plan.wrapper?.address).toLowerCase() !== wrapper.toLowerCase() ||
        String(plan.adapter?.address).toLowerCase() !== adapter.toLowerCase()
      ) throw new Error("predeploy plan is not bound to the supplied predicted wrapper/adapter.");
      const policy = new Contract(getAddress(manifest.contracts.treasuryPolicy), POLICY_BANK_ABI, rpc.provider);
      const liveOwner = getAddress(await policy.owner());
      live = {
        capturedAt: new Date().toISOString(),
        assetHubBlockNumber: await rpc.provider.getBlockNumber(),
        predeployPreview: true,
        liveOwner
      };
      authority = assertOwnerRecordAuthority({ ownerRecord, livePolicyOwner: liveOwner });
    } else {
      live = await assertLiveState({
        provider: rpc.provider,
        manifest,
        wrapperAddress: wrapper,
        adapterAddress: adapter,
        convertedAccount,
        packet: args.packet,
        generation: args.generation,
        deploymentEvidence
      });
      authority = assertOwnerRecordAuthority({ ownerRecord, livePolicyOwner: live.liveOwner });
    }
  } finally {
    await rpc.provider.destroy?.();
  }

  const innerCalls = args.packet === "configure"
    ? buildConfigurationCalls({ manifest, wrapper, adapter, convertedAccountId32: convertedAccount })
    : buildArmCalls({ wrapper });
  if (args.generation === "2.2" && args.packet === "configure") {
    if (innerCalls.length !== 4 || innerCalls.some((call) => call.data.toLowerCase().startsWith("0x1f59d6fb"))) {
      throw new Error("v2.2 G2 configure packet must contain exactly four configuration calls and no unpause selector.");
    }
  }
  if (args.generation === "2.2" && args.packet === "arm") {
    if (innerCalls.length !== 1 || !innerCalls[0].data.toLowerCase().startsWith("0x1f59d6fb")) {
      throw new Error("v2.2 arm packet must contain exactly one setDispatchPaused(false) call.");
    }
  }
  const timepoint = args.timepointHeight === undefined ? null : { height: Number(args.timepointHeight), index: Number(args.timepointIndex) };
  let api;
  let payload;
  let substrate;
  try {
    const [{ ApiPromise, WsProvider }, utilCrypto] = await Promise.all([import("@polkadot/api"), import("@polkadot/util-crypto")]);
    api = await ApiPromise.create({ provider: new WsProvider(args.ws), noInitWarn: true, throwOnConnect: true });
    payload = await buildOnchainPayload({
      api,
      blake2AsHex: utilCrypto.blake2AsHex,
      innerCalls,
      reviveRefTime: 4_000_000_000,
      reviveProofSize: 100_000,
      storageDepositLimit: 1_000_000_000,
      threshold: ownerRecord.threshold,
      otherSignatories: signer.otherSignatories,
      timepoint,
      maxWeightRefTime: 4_500_000_000 * innerCalls.length,
      maxWeightProofSize: 150_000 * innerCalls.length
    });
    substrate = await assertSubstrateProfileEncoding({ api, profile: "mainnet", reviveCallHexes: payload.reviveCallHexes });
  } finally {
    await api?.disconnect?.();
  }
  const embedded = verifyEvmCalldataEmbedded({ outerCallHex: payload.outerCallHex, innerCalls });
  if (embedded.some((entry) => !entry.embedded)) throw new Error("SCALE payload did not embed every reviewed EVM calldata.");

  console.log("# bank-xcm-v2 multisig packet (READ-ONLY)");
  console.log(`generation:              ${args.generation}`);
  console.log(`packet:                  ${args.packet}`);
  console.log(`wrapper:                 ${wrapper}`);
  console.log(`adapter:                 ${adapter}`);
  console.log(`wrapper AH origin:       ${wrapperAccountId32(wrapper)}`);
  console.log(`Hydration converted:     ${convertedAccount}`);
  console.log(`Hydration truncate20:    ${truncateAccountId32(convertedAccount)}`);
  console.log(`conversion endpoints:    ${conversion.endpoints.join(", ")} ✓`);
  console.log(`owner AccountId32:       ${authority.derivedAccountId32} ✓`);
  console.log(`derived/live owner H160: ${authority.derivedOwner} ✓`);
  console.log(`substrate preflight:     ${substrate.chainName}, revive pallet ${substrate.revivePalletIndex} ✓`);
  console.log(`Apps URL:                ${buildPolkadotAppsExtrinsicsUrl(args.ws)}`);
  console.log(`signing as:              ${signer.me.label} (${signer.me.address})`);
  console.log(`timepoint:               ${timepoint ? `${timepoint.height}/${timepoint.index}` : "None (first leg)"}`);
  console.log("");
  console.log("## Inner EVM calls");
  innerCalls.forEach((call, index) => {
    console.log(`[${index + 1}] ${call.label}`);
    console.log(`    to:   ${call.to}`);
    console.log(`    data: ${call.data}`);
  });
  console.log("");
  console.log("## asMulti material");
  console.log(`otherSignatories:        ${JSON.stringify(signer.otherSignatories)}`);
  console.log(`inner call hash:         ${payload.outerCallHash}`);
  console.log(`inner call SCALE:        ${payload.outerCallHex}`);
  console.log(`first/countersign SCALE: ${payload.asMultiHex}`);
  console.log(`embedded cross-check:    ${embedded.map((entry) => `${entry.label}=✓`).join(", ")}`);
  console.log("");
  console.log("## Observer targets");
  console.log(`asset 22:                ${BANK_XCM_V2.observerAssetEndpoint} Tokens.accounts(${convertedAccount}, 22)`);
  console.log(`aUSDC:                   ${BANK_XCM_V2.observerEvmEndpoint} ${BANK_XCM_V2.aUsdcContract}.balanceOf(${truncateAccountId32(convertedAccount)})`);
  console.log("");
  if (evidenceBundle) {
    console.log("## Exact v2.1 message bundle (four request legs + owner recovery)");
    for (const leg of evidenceBundle.messages) {
      console.log(`${leg.label}:`);
      console.log(`  requestId:   ${leg.requestId}`);
      console.log(`  destination: ${leg.destination}`);
      console.log(`  messageHash: ${leg.messageHash}`);
      console.log(`  message:     ${leg.message}`);
      console.log(`  must prove:  ${JSON.stringify(leg.expected)}`);
    }
    console.log("");
  }
  console.log(args.packet === "configure"
    ? `STOP AFTER EXECUTION: v${args.generation} wrapper must remain dispatchPaused=true; no unpause call exists in this packet.`
    : args.generation === "2.2"
      ? "ARM PRECONDITION PASSED: G2 runtime/probe/configuration and fresh armed-empty state matched. Per-leg gates now run just in time. This tool still signed/submitted nothing."
      : "ARM PRECONDITION PASSED: all five exact-message dry-run records matched. This tool still signed/submitted nothing.");
  const packetEvidence = {
    schemaVersion: 1,
    kind: "averray.bankXcmV2MultisigPacket",
    profile: "mainnet",
    generation: args.generation,
    packet: args.packet,
    capturedAt: new Date().toISOString(),
    wrapper,
    adapter,
    convertedAccountId32: convertedAccount,
    conversion,
    liveState: live,
    signer: signer.me,
    otherSignatories: signer.otherSignatories,
    timepoint,
    innerCalls,
    innerCallHash: payload.outerCallHash,
    innerCallScale: payload.outerCallHex,
    asMultiScale: payload.asMultiHex,
    substrate,
    containsUnpause: innerCalls.some((call) => call.data.toLowerCase().startsWith("0x1f59d6fb")),
    armBasis: args.generation === "2.2" && args.packet === "arm" ? live.g2Verification : undefined,
    observerTargets: {
      asset22: { endpoint: BANK_XCM_V2.observerAssetEndpoint, accountId32: convertedAccount, assetId: 22 },
      aUsdc: { endpoint: BANK_XCM_V2.observerEvmEndpoint, contract: BANK_XCM_V2.aUsdcContract, account: truncateAccountId32(convertedAccount) }
    }
  };
  if (args.packetOut) {
    await writeFile(resolve(args.packetOut), `${stringify(packetEvidence)}\n`, { flag: "wx" });
    console.log(`packet evidence written create-only: ${resolve(args.packetOut)}`);
  }
  return { innerCalls, payload, messages, recovery, live, packetEvidence };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`prepare-bank-xcm-v2-multisig failed: ${error.message}`);
    process.exitCode = 1;
  });
}
