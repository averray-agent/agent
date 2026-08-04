#!/usr/bin/env node

/**
 * Deploy-and-record ceremony driver for the phase-1 Hydration bank rail.
 *
 * Default is a read-only plan. `--commit` additionally requires the expected
 * deployer, a concealed 1Password reference, and an exact typed confirmation.
 * It deploys XcmWrapperV22 first and HydrationUsdcAdapterV22 second; it grants
 * no role and leaves XcmWrapperV22.dispatchPaused() == true. A commit cannot
 * report success until conversion evidence, the manifest, and rendered envs
 * record the exact deployed pair.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  AbiCoder,
  Contract,
  ContractFactory,
  Interface,
  Wallet,
  ZeroAddress,
  concat,
  getAddress,
  getCreateAddress,
  isAddress
} from "ethers";

import {
  ADAPTER_ADMIN_ABI,
  BANK_XCM_V2,
  WRAPPER_ADMIN_ABI,
  artifactEvidence,
  loadJson,
  sha256Hex,
  wrapperAccountId32
} from "./bank-xcm-v2-ceremony-lib.mjs";
import { encodeAddress } from "@polkadot/util-crypto";
import { captureConversionEvidence } from "./capture-hydration-wrapper-origin.mjs";
import {
  createCeremonyRpcContext,
  printCeremonyRpcPreflight
} from "./ceremony-rpc.mjs";
import {
  formatCeremonyBroadcastError,
  loadKeyFromOp
} from "./redeploy-escrowcore.mjs";
import { compareMaskedRuntime } from "./check-contract-provenance.mjs";
import {
  buildManifestCandidate,
  writeManifestAndRenderedEnv
} from "./record-bank-xcm-v2-deployment.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const WRAPPER_ARTIFACT = resolve(repoRoot, "out/XcmWrapperV22.sol/XcmWrapperV22.json");
const ADAPTER_ARTIFACT = resolve(repoRoot, "out/HydrationUsdcAdapterV22.sol/HydrationUsdcAdapterV22.json");
const DEFAULT_EXPECTED_DEPLOYER = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
export const REVIEWED_WRAPPER_V22_CREATION_CODE_HASH = "sha256:900a719c2fe6b41db8e3bc154177b044f6c9bc8e950387aff592a16f6214a086";
export const REVIEWED_ADAPTER_V22_CREATION_CODE_HASH = "sha256:b1ce42c403163d7e06f4e12e4d6177f21634c1053eb0d6ef2cb60135c986dc99";
export const WRAPPER_V22_VERSION_SELECTOR = "0x526a213a";
const WRAPPER_V22_PROBE_REQUEST_ID = `0x${"22".repeat(32)}`;
const WRAPPER_V22_PROBE_AMOUNT = 100_000n;
const WRAPPER_V22_PROBE_NONCE = 1n;

export function parseArgs(argv) {
  const args = { profile: "mainnet", commit: false, replaceExisting: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--profile") args.profile = argv[++index];
    else if (token === "--expected-deployer") args.expectedDeployer = argv[++index];
    else if (token === "--signer-secret-ref") args.signerSecretRef = argv[++index];
    else if (token === "--source-commit") args.sourceCommit = argv[++index];
    else if (token === "--bundle-out") args.bundleOut = argv[++index];
    else if (token === "--deployment-evidence-out") args.deploymentEvidenceOut = argv[++index];
    else if (token === "--conversion-evidence-out") args.conversionEvidenceOut = argv[++index];
    else if (token === "--replace-existing") args.replaceExisting = true;
    else if (token === "--commit") args.commit = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage (read-only plan):",
    "  node scripts/ops/deploy-bank-xcm-v2.mjs --profile mainnet \\",
    `    --expected-deployer ${DEFAULT_EXPECTED_DEPLOYER} --source-commit <full-40-char-commit> \\`,
    "    [--bundle-out /tmp/bank-xcm-v22-plan.json]",
    "    [--replace-existing]  # required for the reviewed v2.2 replacement",
    "",
    "Commit (Pascal-authorized ceremony only): add --commit and",
    "  --signer-secret-ref op://... --deployment-evidence-out docs/evidence/...json \\",
    "  --conversion-evidence-out docs/evidence/...json",
    "",
    "The command refuses a dirty/mismatched checkout and force-rebuilds its",
    "Foundry artifacts before planning or signing. A successful commit also",
    "captures two-endpoint conversion evidence, records deployments/mainnet.json,",
    "and regenerates the paired env templates. It never configures or unpauses."
  ].join("\n");
}

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

function currentStatus() {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
}

function createOnlyEvidencePath(value, label) {
  const absolute = resolve(String(value ?? ""));
  const repoRelative = relative(repoRoot, absolute);
  if (!repoRelative || repoRelative.startsWith("..") || resolve(repoRoot, repoRelative) !== absolute) {
    throw new Error(`${label} must be a create-only path inside the reviewed checkout.`);
  }
  if (existsSync(absolute)) throw new Error(`${label} already exists; choose a fresh create-only evidence path before signing.`);
  try {
    accessSync(dirname(absolute), fsConstants.W_OK);
  } catch {
    throw new Error(`${label} parent directory is not writable; fix the evidence path before signing.`);
  }
  return { absolute, repoRelative };
}

function writeCreateOnlyJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

export function assertSourceCheckout({ sourceCommit, headCommit, porcelain }) {
  const expected = String(sourceCommit ?? "").trim().toLowerCase();
  const head = String(headCommit ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(expected)) {
    throw new Error("--source-commit must be a full 40-character commit.");
  }
  if (head !== expected) {
    throw new Error(`checkout HEAD ${head || "<unknown>"} does not match --source-commit ${expected}; refusing provenance label drift.`);
  }
  if (String(porcelain ?? "").trim() !== "") {
    throw new Error("checkout is dirty; refusing to build or deploy provenance from modified/untracked source.");
  }
  return true;
}

export function assertSourceCommitReachable({ sourceCommit, runner = execFileSync } = {}) {
  try {
    runner("git", ["merge-base", "--is-ancestor", sourceCommit, "origin/main"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe"
    });
  } catch {
    throw new Error(`source commit ${sourceCommit} is not reachable from origin/main; merge the reviewed ceremony code first.`);
  }
  return true;
}

export function rebuildFoundryArtifacts({ runner = execFileSync } = {}) {
  runner("forge", ["build", "--skip", "test", "--force"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit"
  });
  return true;
}

export function assertReviewedV22Artifacts({ wrapperAbi, wrapperEvidence, adapterEvidence }) {
  if (wrapperEvidence?.creationCodeHash !== REVIEWED_WRAPPER_V22_CREATION_CODE_HASH) {
    throw new Error(
      `XcmWrapperV22 creation hash ${wrapperEvidence?.creationCodeHash ?? "<missing>"} does not match reviewed v2.2 ${REVIEWED_WRAPPER_V22_CREATION_CODE_HASH}.`
    );
  }
  if (adapterEvidence?.creationCodeHash !== REVIEWED_ADAPTER_V22_CREATION_CODE_HASH) {
    throw new Error(
      `HydrationUsdcAdapterV22 creation hash ${adapterEvidence?.creationCodeHash ?? "<missing>"} does not match reviewed v2.2 ${REVIEWED_ADAPTER_V22_CREATION_CODE_HASH}.`
    );
  }
  let dispatch;
  let preview;
  try {
    const iface = new Interface(wrapperAbi);
    dispatch = iface.getFunction("dispatchLeg(bytes32,uint8,uint256)");
    preview = iface.getFunction("previewRecoveryHomeId(bytes32,uint256,uint64)");
  } catch {
    throw new Error("XcmWrapperV22 artifact ABI does not expose the reviewed constructive dispatch/recovery surface.");
  }
  if (!dispatch || !preview || preview.selector.toLowerCase() !== WRAPPER_V22_VERSION_SELECTOR) {
    throw new Error("XcmWrapperV22 artifact ABI does not expose the reviewed v2.2 version selector.");
  }
  return {
    wrapperCreationCodeHash: wrapperEvidence.creationCodeHash,
    adapterCreationCodeHash: adapterEvidence.creationCodeHash,
    dispatchLegSelector: dispatch.selector,
    previewRecoveryHomeIdSelector: preview.selector
  };
}

export async function probeWrapperV22Selector(provider, wrapperAddress) {
  const args = AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256", "uint64"],
    [WRAPPER_V22_PROBE_REQUEST_ID, WRAPPER_V22_PROBE_AMOUNT, WRAPPER_V22_PROBE_NONCE]
  );
  const calldata = concat([WRAPPER_V22_VERSION_SELECTOR, args]);
  let response;
  try {
    response = await provider.call({ to: getAddress(wrapperAddress), data: calldata });
  } catch (error) {
    throw new Error(
      `deployed wrapper does not execute v2.2 selector ${WRAPPER_V22_VERSION_SELECTOR}: ${error?.shortMessage ?? error?.message ?? error}`
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/u.test(response) || /^0x0{64}$/u.test(response)) {
    throw new Error(`deployed wrapper returned invalid v2.2 selector response: ${response}.`);
  }
  return {
    selector: WRAPPER_V22_VERSION_SELECTOR,
    calldata,
    response,
    probeRequestId: WRAPPER_V22_PROBE_REQUEST_ID,
    probeAmount: WRAPPER_V22_PROBE_AMOUNT.toString(),
    probeNonce: WRAPPER_V22_PROBE_NONCE.toString()
  };
}

function validateManifest(manifest, replaceExisting) {
  if (manifest.profile !== "mainnet") throw new Error("deployments/mainnet.json profile mismatch.");
  const hasExisting = manifest.contracts?.xcmWrapper !== null && manifest.contracts?.xcmWrapper !== undefined;
  if (hasExisting && !replaceExisting) {
    throw new Error(`manifest contracts.xcmWrapper is already ${manifest.contracts?.xcmWrapper}; refusing a duplicate deployment plan.`);
  }
  if (replaceExisting && (!hasExisting || !isAddress(manifest.contracts?.hydrationUsdcAdapter))) {
    throw new Error("--replace-existing requires a recorded live wrapper and adapter pair.");
  }
  for (const [label, value] of Object.entries({
    treasuryPolicy: manifest.contracts?.treasuryPolicy,
    token: manifest.contracts?.token,
    agentAccountCore: manifest.contracts?.agentAccountCore,
    backendOperator: manifest.verifier,
    owner: manifest.owner
  })) {
    if (!isAddress(value)) throw new Error(`manifest ${label} is not an H160 address.`);
  }
}

export function assertManifestRecordsDeployment({ manifest, wrapper, adapter }) {
  const declaredWrapper = manifest?.contracts?.xcmWrapper;
  const declaredAdapter = manifest?.contracts?.hydrationUsdcAdapter;
  if (
    !isAddress(declaredWrapper)
    || !isAddress(declaredAdapter)
    || getAddress(declaredWrapper) !== getAddress(wrapper)
    || getAddress(declaredAdapter) !== getAddress(adapter)
  ) {
    throw new Error(
      `deployed Bank pair ${getAddress(wrapper)} / ${getAddress(adapter)} is not recorded in deployments/${manifest?.profile ?? "<unknown>"}.json; refusing a green deploy run.`
    );
  }
  return true;
}

export function assertRecordedV22Candidate({ previousManifest, recordedManifest, backendEnv, wrapper, adapter }) {
  assertManifestRecordsDeployment({ manifest: recordedManifest, wrapper, adapter });
  if ((recordedManifest.bankXcmDeploymentHistory?.length ?? 0) !== (previousManifest.bankXcmDeploymentHistory?.length ?? 0) + 1) {
    throw new Error("paired manifest did not append exactly one v2.2 wrapper generation.");
  }
  const newest = recordedManifest.bankXcmDeploymentHistory.at(-1);
  if (newest?.version !== "2.2" || !isAddress(newest?.wrapper) || getAddress(newest.wrapper) !== getAddress(wrapper)) {
    throw new Error("paired manifest history does not end with the exact v2.2 wrapper.");
  }
  if (!String(backendEnv).includes("BANK_XCM_FLOW_ENABLED=false")) {
    throw new Error("paired env render unexpectedly enabled the Bank flow before G3.");
  }
  const candidatesLine = String(backendEnv).match(/^BANK_LANE_FEED_WRAPPER_CANDIDATES_JSON=(.+)$/mu)?.[1];
  const candidates = candidatesLine ? JSON.parse(candidatesLine) : [];
  if (candidates.length !== 4 || !candidates.some((entry) => isAddress(entry?.wrapper) && getAddress(entry.wrapper) === getAddress(wrapper))) {
    throw new Error("paired env render did not record v2.2 as the fourth wrapper candidate.");
  }
  return true;
}

export async function buildDeploymentPlan({ manifest, provider, deployer, wrapperArtifact, adapterArtifact, replaceExisting = false }) {
  validateManifest(manifest, replaceExisting);
  const expectedDeployer = getAddress(deployer);
  const nonce = await provider.getTransactionCount(expectedDeployer, "pending");
  const wrapperAddress = getCreateAddress({ from: expectedDeployer, nonce });
  const adapterAddress = getCreateAddress({ from: expectedDeployer, nonce: nonce + 1 });
  const wrapperPostageAccountId32 = wrapperAccountId32(wrapperAddress);
  const wrapperFactory = new ContractFactory(wrapperArtifact.abi, wrapperArtifact.bytecode.object);
  const adapterFactory = new ContractFactory(adapterArtifact.abi, adapterArtifact.bytecode.object);
  const wrapperDeploy = await wrapperFactory.getDeployTransaction(
    getAddress(manifest.contracts.treasuryPolicy),
    ZeroAddress
  );
  const adapterDeploy = await adapterFactory.getDeployTransaction(
    getAddress(manifest.contracts.treasuryPolicy),
    getAddress(manifest.contracts.token),
    BANK_XCM_V2.strategyId,
    wrapperAddress,
    getAddress(manifest.contracts.agentAccountCore)
  );
  const wrapperGas = await provider.estimateGas({ from: expectedDeployer, data: wrapperDeploy.data });
  const adapterGas = await provider.estimateGas({ from: expectedDeployer, data: adapterDeploy.data });
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
  const estimatedWei = gasPrice === null ? null : (wrapperGas + adapterGas) * gasPrice;
  const balanceWei = await provider.getBalance(expectedDeployer);
  return {
    profile: manifest.profile,
    chainId: BANK_XCM_V2.chainId,
    deployer: expectedDeployer,
    pendingNonce: nonce,
    replacement: replaceExisting ? {
      wrapper: getAddress(manifest.contracts.xcmWrapper),
      adapter: getAddress(manifest.contracts.hydrationUsdcAdapter),
      reason: "v2.2: dispatch-time fee bounds, chain-derived watcher state, and request-scoped recovery accounting"
    } : null,
    constants: {
      treasuryPolicy: getAddress(manifest.contracts.treasuryPolicy),
      owner: getAddress(manifest.owner),
      usdc: getAddress(manifest.contracts.token),
      agentAccountCore: getAddress(manifest.contracts.agentAccountCore),
      backendOperator: getAddress(manifest.verifier),
      strategyId: BANK_XCM_V2.strategyId,
      strategyLabel: BANK_XCM_V2.strategyLabel,
      xcmPrecompileConstructorArg: ZeroAddress,
      xcmPrecompileResolved: BANK_XCM_V2.xcmPrecompile,
      hydrationParaId: BANK_XCM_V2.hydrationParaId,
      hydrationUsdcAssetId: BANK_XCM_V2.hydrationUsdcAssetId,
      hydrationAUsdcAssetId: BANK_XCM_V2.hydrationAUsdcAssetId,
      hydrationRouterPalletIndex: BANK_XCM_V2.hydrationRouterPalletIndex,
      hydrationRouterCallIndex: BANK_XCM_V2.hydrationRouterCallIndex
    },
    wrapper: {
      address: wrapperAddress,
      nonce,
      artifactPath: "out/XcmWrapperV22.sol/XcmWrapperV22.json",
      constructorArgs: [getAddress(manifest.contracts.treasuryPolicy), ZeroAddress],
      deployData: wrapperDeploy.data,
      deployDataBytes: (wrapperDeploy.data.length - 2) / 2,
      estimatedGas: wrapperGas.toString(),
      artifact: artifactEvidence(wrapperArtifact),
      postage: {
        accountId32: wrapperPostageAccountId32,
        ss58: encodeAddress(wrapperPostageAccountId32, 0),
        exactAmountDot: "0.30",
        exactAmountPlanck: "3000000000"
      },
      expectedInitialState: { dispatchPaused: true, operator: ZeroAddress, hydrationAccountId32: `0x${"00".repeat(32)}` }
    },
    adapter: {
      address: adapterAddress,
      nonce: nonce + 1,
      artifactPath: "out/HydrationUsdcAdapterV22.sol/HydrationUsdcAdapterV22.json",
      constructorArgs: [
        getAddress(manifest.contracts.treasuryPolicy),
        getAddress(manifest.contracts.token),
        BANK_XCM_V2.strategyId,
        wrapperAddress,
        getAddress(manifest.contracts.agentAccountCore)
      ],
      deployData: adapterDeploy.data,
      deployDataBytes: (adapterDeploy.data.length - 2) / 2,
      estimatedGas: adapterGas.toString(),
      artifact: artifactEvidence(adapterArtifact)
    },
    funding: {
      balanceWei: balanceWei.toString(),
      gasPriceWei: gasPrice?.toString() ?? null,
      estimatedWei: estimatedWei?.toString() ?? null,
      requiredWeiWith20PercentHeadroom: estimatedWei === null ? null : (estimatedWei * 120n / 100n).toString(),
      headroomGatePassed: estimatedWei === null ? false : balanceWei >= (estimatedWei * 120n / 100n)
    }
  };
}

function printPlan(plan, sourceCommit) {
  console.log("# Bank XCM v2.2 deploy-and-record ceremony (NO CONFIGURATION)");
  console.log(`profile / chainId:       ${plan.profile} / ${plan.chainId}`);
  console.log(`source commit:           ${sourceCommit}`);
  console.log(`deployer:                ${plan.deployer}`);
  console.log(`pending nonce:           ${plan.pendingNonce}`);
  if (plan.replacement) {
    console.log(`replaces wrapper:        ${plan.replacement.wrapper}`);
    console.log(`replaces adapter:        ${plan.replacement.adapter}`);
    console.log(`replacement reason:      ${plan.replacement.reason}`);
  }
  console.log(`TreasuryPolicy:          ${plan.constants.treasuryPolicy}`);
  console.log(`TreasuryPolicy.owner:    ${plan.constants.owner}`);
  console.log(`USDC:                    ${plan.constants.usdc}`);
  console.log(`future AAC binding:      ${plan.constants.agentAccountCore}`);
  console.log(`backend operator:        ${plan.constants.backendOperator}`);
  console.log(`strategy:                ${plan.constants.strategyLabel} (${plan.constants.strategyId})`);
  console.log(`Hydration:               para ${plan.constants.hydrationParaId}, asset ${plan.constants.hydrationUsdcAssetId}, aUSDC ${plan.constants.hydrationAUsdcAssetId}`);
  console.log(`Router:                  pallet ${plan.constants.hydrationRouterPalletIndex}, call ${plan.constants.hydrationRouterCallIndex}`);
  console.log(`XCM precompile:          ${plan.constants.xcmPrecompileResolved}`);
  console.log("");
  for (const [label, item] of [["XcmWrapperV22", plan.wrapper], ["HydrationUsdcAdapterV22", plan.adapter]]) {
    console.log(`## ${label}`);
    console.log(`predicted address:       ${item.address}`);
    console.log(`CREATE nonce:            ${item.nonce}`);
    console.log(`artifact:                ${item.artifactPath}`);
    console.log(`constructor args:        ${JSON.stringify(item.constructorArgs)}`);
    console.log(`creation code hash:      ${item.artifact.creationCodeHash}`);
    console.log(`compiled runtime hash:   ${item.artifact.compiledRuntimeCodeHash}`);
    console.log(`ABI hash:                ${item.artifact.abiHash}`);
    console.log(`deploy data bytes:       ${item.deployDataBytes}`);
    console.log(`estimated gas:           ${item.estimatedGas}`);
    console.log(`deploy calldata:         ${item.deployData}`);
    console.log("");
  }
  console.log("## Funding estimate");
  console.log(`deployer balance wei:    ${plan.funding.balanceWei}`);
  console.log(`estimated wei:           ${plan.funding.estimatedWei ?? "unavailable"}`);
  console.log(`20% headroom wei:        ${plan.funding.requiredWeiWith20PercentHeadroom ?? "unavailable"}`);
  console.log(`funding gate:            ${plan.funding.headroomGatePassed ? "PASS" : "FAIL — fund before --commit"}`);
  console.log("");
  console.log("## Postage (only after the selector probe passes)");
  console.log(`wrapper image AccountId: ${plan.wrapper.postage.accountId32}`);
  console.log(`wrapper image SS58:      ${plan.wrapper.postage.ss58}`);
  console.log(`exact postage:           ${plan.wrapper.postage.exactAmountDot} DOT (${plan.wrapper.postage.exactAmountPlanck} planck)`);
  console.log("");
  console.log("postcondition: XcmWrapperV22.dispatchPaused() == true; no role/config call is sent");
  console.log("green-exit gate: conversion evidence + manifest + paired env render record this exact pair");
}

async function verifyDeployment(provider, plan, receipts, { wrapperArtifact, adapterArtifact }) {
  const wrapper = new Contract(plan.wrapper.address, WRAPPER_ADMIN_ABI, provider);
  const adapter = new Contract(plan.adapter.address, ADAPTER_ADMIN_ABI, provider);
  const [wrapperCode, adapterCode] = await Promise.all([
    provider.getCode(plan.wrapper.address),
    provider.getCode(plan.adapter.address)
  ]);
  const wrapperRuntime = compareMaskedRuntime(
    wrapperArtifact.deployedBytecode.object,
    wrapperCode,
    wrapperArtifact.deployedBytecode.immutableReferences ?? {}
  );
  const adapterRuntime = compareMaskedRuntime(
    adapterArtifact.deployedBytecode.object,
    adapterCode,
    adapterArtifact.deployedBytecode.immutableReferences ?? {}
  );
  if (!wrapperRuntime.matches || !adapterRuntime.matches) {
    throw new Error("deployed runtime does not match the reviewed Foundry artifacts outside declared immutable slots.");
  }
  // This check deliberately does not derive from the just-built artifact. A
  // stale checkout can produce a self-consistent artifact/runtime pair; the
  // hard-coded v2.2 selector is the external version fact that catches it.
  const versionProbe = await probeWrapperV22Selector(provider, plan.wrapper.address);
  const observed = {
    wrapper: {
      txHash: receipts.wrapper.hash,
      blockNumber: Number(receipts.wrapper.blockNumber),
      policy: getAddress(await wrapper.policy()),
      xcmPrecompile: getAddress(await wrapper.xcmPrecompile()),
      dispatchPaused: await wrapper.dispatchPaused(),
      operator: getAddress(await wrapper.operator()),
      hydrationAccountId32: await wrapper.hydrationAccountId32(),
      artifactRuntimeMatch: true,
      abiHash: artifactEvidence(wrapperArtifact).abiHash,
      runtimeCodeHash: sha256Hex(wrapperCode),
      versionProbe
    },
    adapter: {
      txHash: receipts.adapter.hash,
      blockNumber: Number(receipts.adapter.blockNumber),
      policy: getAddress(await adapter.policy()),
      asset: getAddress(await adapter.asset()),
      strategyId: await adapter.strategyId(),
      xcmWrapper: getAddress(await adapter.xcmWrapper()),
      agentAccountCore: getAddress(await adapter.agentAccountCore()),
      artifactRuntimeMatch: true,
      abiHash: artifactEvidence(adapterArtifact).abiHash,
      runtimeCodeHash: sha256Hex(adapterCode)
    }
  };
  if (observed.wrapper.dispatchPaused !== true || observed.wrapper.operator !== ZeroAddress || observed.wrapper.hydrationAccountId32 !== `0x${"00".repeat(32)}`) {
    throw new Error(`wrapper did not deploy locally paused/unconfigured: ${JSON.stringify(observed.wrapper)}`);
  }
  const expected = plan.constants;
  if (
    observed.wrapper.policy !== expected.treasuryPolicy ||
    observed.wrapper.xcmPrecompile !== getAddress(expected.xcmPrecompileResolved) ||
    observed.adapter.policy !== expected.treasuryPolicy ||
    observed.adapter.asset !== expected.usdc ||
    observed.adapter.strategyId.toLowerCase() !== expected.strategyId.toLowerCase() ||
    observed.adapter.xcmWrapper !== plan.wrapper.address ||
    observed.adapter.agentAccountCore !== expected.agentAccountCore
  ) throw new Error(`deployed immutable/state verification failed: ${JSON.stringify(observed)}`);
  return observed;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.profile !== "mainnet") throw new Error("Bank v2.2 G2 supports --profile mainnet only.");
  if (!args.sourceCommit) throw new Error("--source-commit is required for both preview and commit modes.");
  const sourceCommit = String(args.sourceCommit).trim().toLowerCase();
  assertSourceCheckout({ sourceCommit, headCommit: currentCommit(), porcelain: currentStatus() });
  assertSourceCommitReachable({ sourceCommit });
  rebuildFoundryArtifacts();
  // Re-check after the toolchain runs so a build hook or generated tracked
  // output cannot make the eventual provenance differ from the reviewed tree.
  assertSourceCheckout({ sourceCommit, headCommit: currentCommit(), porcelain: currentStatus() });
  assertSourceCommitReachable({ sourceCommit });
  const expectedDeployer = getAddress(args.expectedDeployer ?? DEFAULT_EXPECTED_DEPLOYER);
  const manifest = loadJson(resolve(repoRoot, "deployments/mainnet.json"));
  const wrapperArtifact = loadJson(WRAPPER_ARTIFACT);
  const adapterArtifact = loadJson(ADAPTER_ARTIFACT);
  const reviewedArtifacts = assertReviewedV22Artifacts({
    wrapperAbi: wrapperArtifact.abi,
    wrapperEvidence: artifactEvidence(wrapperArtifact),
    adapterEvidence: artifactEvidence(adapterArtifact)
  });

  const rpc = await createCeremonyRpcContext({ manifest, phase: "bank-xcm-v2-deploy", write: args.commit });
  try {
    printCeremonyRpcPreflight(rpc);
    const plan = await buildDeploymentPlan({
      manifest,
      provider: rpc.provider,
      deployer: expectedDeployer,
      wrapperArtifact,
      adapterArtifact,
      replaceExisting: args.replaceExisting
    });
    printPlan(plan, sourceCommit);
    const bundle = {
      schemaVersion: plan.replacement ? 2 : 1,
      kind: "averray.bankXcmV2DeploymentPlan",
      sourceCommit,
      sourceCheckoutVerified: true,
      artifactsForceRebuilt: true,
      reviewedArtifacts,
      ...plan
    };
    if (args.bundleOut) {
      writeFileSync(resolve(args.bundleOut), `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx" });
      console.log(`plan bundle written (create-only): ${resolve(args.bundleOut)}`);
    }
    if (!args.commit) {
      console.log("\nDRY RUN ONLY — no transaction signed or broadcast.");
      return bundle;
    }
    if (!args.signerSecretRef) throw new Error("--commit requires --signer-secret-ref op://... .");
    if (!args.deploymentEvidenceOut || !args.conversionEvidenceOut) {
      throw new Error("--commit requires --deployment-evidence-out and --conversion-evidence-out; a deploy may not exit green unrecorded.");
    }
    const deploymentEvidencePath = createOnlyEvidencePath(args.deploymentEvidenceOut, "--deployment-evidence-out");
    const conversionEvidencePath = createOnlyEvidencePath(args.conversionEvidenceOut, "--conversion-evidence-out");
    const required = plan.funding.requiredWeiWith20PercentHeadroom;
    if (required === null) throw new Error("Cannot commit without a fee estimate and 20% headroom check.");
    if (BigInt(plan.funding.balanceWei) < BigInt(required)) {
      throw new Error(`deployer balance ${plan.funding.balanceWei} wei is below required ${required} wei (estimate + 20%).`);
    }
    const confirmation = `DEPLOY BANK XCM V2.2 AND RECORD ${plan.wrapper.address} ${plan.adapter.address}`;
    console.log(`\nType exactly: ${confirmation}`);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question("> ");
    prompt.close();
    if (answer !== confirmation) throw new Error("typed confirmation mismatch; nothing signed.");

    const secret = loadKeyFromOp(args.signerSecretRef);
    const wallet = new Wallet(secret, rpc.provider);
    if (wallet.address !== expectedDeployer) throw new Error(`concealed signer ${wallet.address} does not match expected deployer ${expectedDeployer}.`);
    let wrapperResponse;
    let adapterResponse;
    try {
      wrapperResponse = await wallet.sendTransaction({ data: plan.wrapper.deployData, nonce: plan.wrapper.nonce });
      const wrapperReceipt = await wrapperResponse.wait();
      if (getAddress(wrapperReceipt.contractAddress) !== plan.wrapper.address) throw new Error("wrapper CREATE address differed from prediction.");
      adapterResponse = await wallet.sendTransaction({ data: plan.adapter.deployData, nonce: plan.adapter.nonce });
      const adapterReceipt = await adapterResponse.wait();
      if (getAddress(adapterReceipt.contractAddress) !== plan.adapter.address) throw new Error("adapter CREATE address differed from prediction.");
      const observed = await verifyDeployment(
        rpc.provider,
        plan,
        { wrapper: wrapperReceipt, adapter: adapterReceipt },
        { wrapperArtifact, adapterArtifact }
      );
      const { ApiPromise, HttpProvider, WsProvider } = await import("@polkadot/api");
      const conversion = await captureConversionEvidence({
        wrapper: plan.wrapper.address,
        endpoints: BANK_XCM_V2.hydrationConversionEndpoints,
        apiFactory: (endpoint) => ApiPromise.create({
          provider: endpoint.startsWith("https://") ? new HttpProvider(endpoint) : new WsProvider(endpoint),
          noInitWarn: true,
          throwOnConnect: true
        })
      });
      writeCreateOnlyJson(conversionEvidencePath.absolute, conversion);

      const capturedAt = new Date().toISOString();
      const deploymentEvidence = {
        schemaVersion: 1,
        kind: "averray.bankXcmV2DeploymentEvidence",
        profile: "mainnet",
        version: "2.2",
        sourceCommit,
        deployer: expectedDeployer,
        verifiedAt: capturedAt,
        replacementReason: plan.replacement?.reason ?? null,
        convertedAccountId32: conversion.convertedAccountId32,
        conversionEvidence: {
          artifact: conversionEvidencePath.repoRelative,
          endpointCount: conversion.reads.length,
          endpoints: conversion.reads.map((entry) => entry.endpoint),
          capturedAt
        },
        liveState: {
          capturedAt,
          assetHubBlockNumber: await rpc.provider.getBlockNumber(),
          wrapper: observed.wrapper,
          adapter: observed.adapter
        },
        wrapper: {
          address: plan.wrapper.address,
          txHash: observed.wrapper.txHash,
          blockNumber: observed.wrapper.blockNumber,
          abiHash: observed.wrapper.abiHash,
          runtimeCodeHash: observed.wrapper.runtimeCodeHash
        },
        adapter: {
          address: plan.adapter.address,
          txHash: observed.adapter.txHash,
          blockNumber: observed.adapter.blockNumber,
          abiHash: observed.adapter.abiHash,
          runtimeCodeHash: observed.adapter.runtimeCodeHash
        }
      };
      writeCreateOnlyJson(deploymentEvidencePath.absolute, deploymentEvidence);

      const candidate = await buildManifestCandidate({
        manifest,
        evidence: deploymentEvidence,
        provider: rpc.provider,
        wrapperArtifact,
        adapterArtifact
      });
      const written = writeManifestAndRenderedEnv(candidate);
      const recordedManifest = loadJson(resolve(repoRoot, "deployments/mainnet.json"));
      const backendEnv = readFileSync(resolve(repoRoot, "deploy/backend.mainnet.env.template"), "utf8");
      assertRecordedV22Candidate({
        previousManifest: manifest,
        recordedManifest,
        backendEnv,
        wrapper: plan.wrapper.address,
        adapter: plan.adapter.address
      });
      console.log(`\nDEPLOYED PAUSED: ${JSON.stringify(observed, null, 2)}`);
      console.log(`conversion evidence:     ${conversionEvidencePath.repoRelative}`);
      console.log(`deployment evidence:     ${deploymentEvidencePath.repoRelative}`);
      console.log(`paired record/env paths: ${[written.manifestPath, ...written.generatedPaths].join(", ")}`);
      console.log("RECORDED PAUSED — exact pair is now the manifest/env subject; BANK_XCM_FLOW_ENABLED remains false.");
      return { ...bundle, deployment: observed, conversion, deploymentEvidence, recorded: written };
    } catch (error) {
      throw new Error(formatCeremonyBroadcastError(error));
    }
  } finally {
    await rpc.provider.destroy?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`deploy-bank-xcm-v2 failed: ${error.message}`);
    process.exitCode = 1;
  });
}
