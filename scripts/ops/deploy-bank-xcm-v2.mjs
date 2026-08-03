#!/usr/bin/env node

/**
 * Deploy-only ceremony driver for the phase-1 Hydration bank rail.
 *
 * Default is a read-only plan. `--commit` additionally requires the expected
 * deployer, a concealed 1Password reference, and an exact typed confirmation.
 * It deploys XcmWrapperV2 first and HydrationUsdcAdapter second; it grants no
 * role and leaves XcmWrapperV2.dispatchPaused() == true.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  Contract,
  ContractFactory,
  Wallet,
  ZeroAddress,
  getAddress,
  getCreateAddress,
  isAddress
} from "ethers";

import {
  ADAPTER_ADMIN_ABI,
  BANK_XCM_V2,
  WRAPPER_ADMIN_ABI,
  artifactEvidence,
  loadJson
} from "./bank-xcm-v2-ceremony-lib.mjs";
import {
  createCeremonyRpcContext,
  printCeremonyRpcPreflight
} from "./ceremony-rpc.mjs";
import {
  formatCeremonyBroadcastError,
  loadKeyFromOp
} from "./redeploy-escrowcore.mjs";
import { compareMaskedRuntime } from "./check-contract-provenance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const WRAPPER_ARTIFACT = resolve(repoRoot, "out/XcmWrapperV2.sol/XcmWrapperV2.json");
const ADAPTER_ARTIFACT = resolve(repoRoot, "out/HydrationUsdcAdapter.sol/HydrationUsdcAdapter.json");
const DEFAULT_EXPECTED_DEPLOYER = "0x9Ab8531FBb0948C542a31298FD61335f30064239";

export function parseArgs(argv) {
  const args = { profile: "mainnet", commit: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--profile") args.profile = argv[++index];
    else if (token === "--expected-deployer") args.expectedDeployer = argv[++index];
    else if (token === "--signer-secret-ref") args.signerSecretRef = argv[++index];
    else if (token === "--source-commit") args.sourceCommit = argv[++index];
    else if (token === "--bundle-out") args.bundleOut = argv[++index];
    else if (token === "--commit") args.commit = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage (read-only plan):",
    "  forge build --skip test",
    "  node scripts/ops/deploy-bank-xcm-v2.mjs --profile mainnet \\",
    `    --expected-deployer ${DEFAULT_EXPECTED_DEPLOYER} [--bundle-out /tmp/bank-xcm-v2-plan.json]`,
    "",
    "Commit (Pascal-authorized ceremony only): add --commit and",
    "  --signer-secret-ref op://... --source-commit <full-40-char-commit>",
    "",
    "This command only deploys. It never configures or unpauses the wrapper."
  ].join("\n");
}

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

function validateManifest(manifest) {
  if (manifest.profile !== "mainnet") throw new Error("deployments/mainnet.json profile mismatch.");
  if (manifest.contracts?.xcmWrapper !== null) {
    throw new Error(`manifest contracts.xcmWrapper is already ${manifest.contracts?.xcmWrapper}; refusing a duplicate deployment plan.`);
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

export async function buildDeploymentPlan({ manifest, provider, deployer, wrapperArtifact, adapterArtifact }) {
  validateManifest(manifest);
  const expectedDeployer = getAddress(deployer);
  const nonce = await provider.getTransactionCount(expectedDeployer, "pending");
  const wrapperAddress = getCreateAddress({ from: expectedDeployer, nonce });
  const adapterAddress = getCreateAddress({ from: expectedDeployer, nonce: nonce + 1 });
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
      artifactPath: "out/XcmWrapperV2.sol/XcmWrapperV2.json",
      constructorArgs: [getAddress(manifest.contracts.treasuryPolicy), ZeroAddress],
      deployData: wrapperDeploy.data,
      deployDataBytes: (wrapperDeploy.data.length - 2) / 2,
      estimatedGas: wrapperGas.toString(),
      artifact: artifactEvidence(wrapperArtifact),
      expectedInitialState: { dispatchPaused: true, operator: ZeroAddress, hydrationAccountId32: `0x${"00".repeat(32)}` }
    },
    adapter: {
      address: adapterAddress,
      nonce: nonce + 1,
      artifactPath: "out/HydrationUsdcAdapter.sol/HydrationUsdcAdapter.json",
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
      requiredWeiWith20PercentHeadroom: estimatedWei === null ? null : (estimatedWei * 120n / 100n).toString()
    }
  };
}

function printPlan(plan, sourceCommit) {
  console.log("# bank-xcm-v2 deploy ceremony (NO CONFIGURATION)");
  console.log(`profile / chainId:       ${plan.profile} / ${plan.chainId}`);
  console.log(`source commit:           ${sourceCommit}`);
  console.log(`deployer:                ${plan.deployer}`);
  console.log(`pending nonce:           ${plan.pendingNonce}`);
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
  for (const [label, item] of [["XcmWrapperV2", plan.wrapper], ["HydrationUsdcAdapter", plan.adapter]]) {
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
  console.log("");
  console.log("postcondition: XcmWrapperV2.dispatchPaused() == true; no role/config call is sent");
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
  const observed = {
    wrapper: {
      txHash: receipts.wrapper.hash,
      blockNumber: Number(receipts.wrapper.blockNumber),
      policy: getAddress(await wrapper.policy()),
      xcmPrecompile: getAddress(await wrapper.xcmPrecompile()),
      dispatchPaused: await wrapper.dispatchPaused(),
      operator: getAddress(await wrapper.operator()),
      hydrationAccountId32: await wrapper.hydrationAccountId32(),
      artifactRuntimeMatch: true
    },
    adapter: {
      txHash: receipts.adapter.hash,
      blockNumber: Number(receipts.adapter.blockNumber),
      policy: getAddress(await adapter.policy()),
      asset: getAddress(await adapter.asset()),
      strategyId: await adapter.strategyId(),
      xcmWrapper: getAddress(await adapter.xcmWrapper()),
      agentAccountCore: getAddress(await adapter.agentAccountCore()),
      artifactRuntimeMatch: true
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
  if (args.profile !== "mainnet") throw new Error("Bank gate 4c supports --profile mainnet only.");
  const expectedDeployer = getAddress(args.expectedDeployer ?? DEFAULT_EXPECTED_DEPLOYER);
  const manifest = loadJson(resolve(repoRoot, "deployments/mainnet.json"));
  const wrapperArtifact = loadJson(WRAPPER_ARTIFACT);
  const adapterArtifact = loadJson(ADAPTER_ARTIFACT);
  const sourceCommit = args.sourceCommit ?? currentCommit();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("--source-commit must be a full 40-character commit.");

  const rpc = await createCeremonyRpcContext({ manifest, phase: "bank-xcm-v2-deploy", write: args.commit });
  try {
    printCeremonyRpcPreflight(rpc);
    const plan = await buildDeploymentPlan({ manifest, provider: rpc.provider, deployer: expectedDeployer, wrapperArtifact, adapterArtifact });
    printPlan(plan, sourceCommit);
    const bundle = { schemaVersion: 1, kind: "averray.bankXcmV2DeploymentPlan", sourceCommit, ...plan };
    if (args.bundleOut) {
      writeFileSync(resolve(args.bundleOut), `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx" });
      console.log(`plan bundle written (create-only): ${resolve(args.bundleOut)}`);
    }
    if (!args.commit) {
      console.log("\nDRY RUN ONLY — no transaction signed or broadcast.");
      return bundle;
    }
    if (!args.signerSecretRef) throw new Error("--commit requires --signer-secret-ref op://... .");
    const required = plan.funding.requiredWeiWith20PercentHeadroom;
    if (required === null) throw new Error("Cannot commit without a fee estimate and 20% headroom check.");
    if (BigInt(plan.funding.balanceWei) < BigInt(required)) {
      throw new Error(`deployer balance ${plan.funding.balanceWei} wei is below required ${required} wei (estimate + 20%).`);
    }
    const confirmation = `DEPLOY BANK XCM V2 ${plan.wrapper.address} ${plan.adapter.address}`;
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
      console.log(`\nDEPLOYED PAUSED: ${JSON.stringify(observed, null, 2)}`);
      return { ...bundle, deployment: observed };
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
