#!/usr/bin/env node

/**
 * Read-only emitter for the two Bank gate-4c multisig packets:
 *
 *   configure — converted account, backend operator, adapter binding, and
 *               strategySettler grant; wrapper remains paused.
 *   arm       — setDispatchPaused(false), emitted only after the four request
 *               messages plus recovery-home DryRunApi evidence are supplied.
 *
 * It never signs or submits. Hardware signing remains in Nova/Spektr/Apps.
 */

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, ZeroAddress, getAddress } from "ethers";

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

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const PACKETS = new Set(["configure", "arm"]);

export function parseArgs(argv) {
  const args = {
    profile: "mainnet",
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
    else if (token === "--packet") args.packet = argv[++index];
    else if (token === "--wrapper") args.wrapper = argv[++index];
    else if (token === "--adapter") args.adapter = argv[++index];
    else if (token === "--converted-account") args.convertedAccount = argv[++index];
    else if (token === "--conversion-evidence") args.conversionEvidence = argv[++index];
    else if (token === "--predeploy-plan") args.predeployPlan = argv[++index];
    else if (token === "--dry-run-evidence") args.dryRunEvidence = argv[++index];
    else if (token === "--messages-out") args.messagesOut = argv[++index];
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
    "    --packet configure|arm --wrapper 0x... --adapter 0x... \\",
    "    --converted-account 0x... --conversion-evidence evidence.json \\",
    "    --signer nova [--timepoint-height H --timepoint-index I]",
    "  [--predeploy-plan /tmp/plan.json]  # configure packet preview only",
    "",
    "Message inputs: --deposit-assets/--deposit-sell-amount/--deposit-fee,",
    "  --withdraw-shares/--withdraw-fee/--home-amount/--home-fee,",
    "  --deposit-nonce/--withdraw-nonce, and",
    "  --recovery-amount/--recovery-fee/--recovery-nonce.",
    "For --packet arm, --dry-run-evidence is mandatory and must bind all five",
    "message hashes to successful forwarded/event assertions. No signing occurs."
  ].join("\n");
}

function stringify(value) {
  return JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2);
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

async function assertLiveState({ provider, manifest, wrapperAddress, adapterAddress, convertedAccount, packet }) {
  const wrapper = new Contract(wrapperAddress, WRAPPER_ADMIN_ABI, provider);
  const adapter = new Contract(adapterAddress, ADAPTER_ADMIN_ABI, provider);
  const policy = new Contract(getAddress(manifest.contracts.treasuryPolicy), POLICY_BANK_ABI, provider);
  const [code, adapterCode, liveOwner, policyPaused, wrapperPolicy, precompile, paused, operator, hydration, boundAdapter, strategySettler, adapterPolicy, adapterAsset, adapterStrategy, adapterWrapper, adapterAac] = await Promise.all([
    provider.getCode(wrapperAddress),
    provider.getCode(adapterAddress),
    policy.owner(),
    policy.paused(),
    wrapper.policy(),
    wrapper.xcmPrecompile(),
    wrapper.dispatchPaused(),
    wrapper.operator(),
    wrapper.hydrationAccountId32(),
    wrapper.strategyAdapter(BANK_XCM_V2.strategyId),
    policy.strategySettler(getAddress(manifest.verifier)),
    adapter.policy(),
    adapter.asset(),
    adapter.strategyId(),
    adapter.xcmWrapper(),
    adapter.agentAccountCore()
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
  return { liveOwner: getAddress(liveOwner), policyPaused, paused, operator: getAddress(operator), hydration, boundAdapter: getAddress(boundAdapter), strategySettler };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.profile !== "mainnet" || !PACKETS.has(args.packet)) throw new Error("profile must be mainnet and packet configure|arm.");
  if (!args.wrapper || !args.adapter || !args.convertedAccount || !args.conversionEvidence || !args.signer) throw new Error("wrapper, adapter, converted account, conversion evidence, and signer are required.");
  if ((args.timepointHeight !== undefined) !== (args.timepointIndex !== undefined)) throw new Error("timepoint height/index must be supplied together.");
  const wrapper = getAddress(args.wrapper);
  const adapter = getAddress(args.adapter);
  const convertedAccount = String(args.convertedAccount).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(convertedAccount)) throw new Error("--converted-account must be bytes32.");
  const manifest = loadJson(resolve(repoRoot, "deployments/mainnet.json"));
  const ownerRecord = loadJson(resolve(repoRoot, "deployments/mainnet-multisig-owner.json"));
  const conversion = assertConversionEvidence(loadJson(resolve(args.conversionEvidence)), wrapper, convertedAccount);
  const signer = resolveProfileSigner({ ownerRecord, profile: "mainnet", signerLabel: args.signer });
  const messages = buildBankXcmV2Messages({
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
  });
  const recovery = buildRecoveryHomeMessage({
    wrapper,
    convertedAccountId32: convertedAccount,
    amount: BigInt(args.recoveryAmount),
    fee: BigInt(args.recoveryFee),
    nonce: BigInt(args.recoveryNonce)
  });
  const evidenceBundle = { ...messages, messages: [...messages.messages, recovery] };
  if (args.messagesOut) {
    await writeFile(resolve(args.messagesOut), `${stringify({ schemaVersion: 2, kind: "averray.bankXcmV2Messages", profile: "mainnet", ...messages, recovery })}\n`, { flag: "wx" });
  }
  if (args.packet === "arm") {
    if (!args.dryRunEvidence) throw new Error("arm packet requires --dry-run-evidence.");
    assertDryRunEvidence(loadJson(resolve(args.dryRunEvidence)), evidenceBundle);
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
      live = { predeployPreview: true, liveOwner };
      authority = assertOwnerRecordAuthority({ ownerRecord, livePolicyOwner: liveOwner });
    } else {
      live = await assertLiveState({ provider: rpc.provider, manifest, wrapperAddress: wrapper, adapterAddress: adapter, convertedAccount, packet: args.packet });
      authority = assertOwnerRecordAuthority({ ownerRecord, livePolicyOwner: live.liveOwner });
    }
  } finally {
    await rpc.provider.destroy?.();
  }

  const innerCalls = args.packet === "configure"
    ? buildConfigurationCalls({ manifest, wrapper, adapter, convertedAccountId32: convertedAccount })
    : buildArmCalls({ wrapper });
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
  console.log(`packet:                  ${args.packet}`);
  console.log(`wrapper:                 ${wrapper}`);
  console.log(`adapter:                 ${adapter}`);
  console.log(`wrapper AH origin:       ${messages.wrapperAccountId32}`);
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
  console.log(args.packet === "configure"
    ? "STOP AFTER EXECUTION: wrapper must remain dispatchPaused=true; do not paste the arm packet."
    : "ARM PRECONDITION PASSED: all five exact-message dry-run records matched. This tool still signed/submitted nothing.");
  return { innerCalls, payload, messages, recovery, live };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`prepare-bank-xcm-v2-multisig failed: ${error.message}`);
    process.exitCode = 1;
  });
}
