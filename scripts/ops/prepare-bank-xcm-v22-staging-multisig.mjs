#!/usr/bin/env node

/**
 * Read-only v2.2 dust staging packet emitter.
 *
 * `approve` and `stage` are separate multisig operations. This tool never signs
 * or broadcasts and records every live prerequisite that remains unsatisfied.
 */

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Interface, ZeroAddress, getAddress } from "ethers";

import {
  ADAPTER_ADMIN_ABI,
  BANK_XCM_V2,
  POLICY_BANK_ABI,
  WRAPPER_ADMIN_ABI,
  loadJson,
  previewRequestId
} from "./bank-xcm-v2-ceremony-lib.mjs";
import { createCeremonyRpcContext, printCeremonyRpcPreflight } from "./ceremony-rpc.mjs";
import {
  SUBSTRATE_PROFILE_CONFIG,
  assertOwnerRecordAuthority,
  assertSubstrateProfileEncoding,
  buildOnchainPayload,
  resolveProfileSigner,
  verifyEvmCalldataEmbedded
} from "./redeploy-escrowcore-wire-multisig.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const PACKETS = new Set(["approve", "stage"]);
const TOKEN_ABI = Object.freeze([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)"
]);
const ADAPTER_V22_ABI = Object.freeze([
  ...ADAPTER_ADMIN_ABI,
  "function stageTreasuryDeposit(address,uint256,uint256,uint256,uint256,uint64,uint64) returns (bytes32)",
  "function totalShares() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function pendingDepositAssets() view returns (uint256)",
  "function pendingWithdrawalShares() view returns (uint256)"
]);
const WRAPPER_STAGING_ABI = Object.freeze([
  ...WRAPPER_ADMIN_ABI,
  "function getRequest(bytes32 requestId) view returns (((bytes32 strategyId,uint8 kind,address account,address asset,address recipient,uint256 assets,uint256 shares,uint64 nonce) context,address queuedBy,uint8 status,uint256 settledAssets,uint256 settledShares,bytes32 remoteRef,bytes32 failureCode,uint64 createdAt,uint64 updatedAt))"
]);

function parseArgs(argv) {
  const args = {
    profile: "mainnet",
    packet: "approve",
    signer: "nova",
    ws: SUBSTRATE_PROFILE_CONFIG.mainnet.defaultWs,
    assets: "150000",
    sellAmount: "100000",
    maxFeePerLeg: "40000",
    nonce: "1"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--profile") args.profile = argv[++index];
    else if (token === "--packet") args.packet = argv[++index];
    else if (token === "--wrapper") args.wrapper = argv[++index];
    else if (token === "--adapter") args.adapter = argv[++index];
    else if (token === "--arm-evidence") args.armEvidence = argv[++index];
    else if (token === "--quote-evidence") args.quoteEvidence = argv[++index];
    else if (token === "--assets") args.assets = argv[++index];
    else if (token === "--sell-amount") args.sellAmount = argv[++index];
    else if (token === "--max-fee-per-leg") args.maxFeePerLeg = argv[++index];
    else if (token === "--dispatch-deadline") args.dispatchDeadline = argv[++index];
    else if (token === "--nonce") args.nonce = argv[++index];
    else if (token === "--signer") args.signer = argv[++index];
    else if (token === "--ws") args.ws = argv[++index];
    else if (token === "--packet-out") args.packetOut = argv[++index];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function stringify(value) {
  return JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2);
}

export function assertFreshV22StagingQuote(evidence, { sellAmount, now = Date.now(), maxAgeMs = 30 * 60_000 } = {}) {
  if (
    evidence?.kind !== "averray.bankXcmV22StagingQuote" ||
    evidence?.profile !== "mainnet" ||
    evidence?.liveState !== true ||
    evidence?.chain !== "Hydration" ||
    evidence?.quote?.fillerType !== "AAVE" ||
    Number(evidence?.quote?.assetIn) !== 22 ||
    Number(evidence?.quote?.assetOut) !== 1003 ||
    BigInt(evidence?.quote?.amountInRaw ?? 0) !== BigInt(sellAmount) ||
    BigInt(evidence?.quote?.amountOutRaw ?? 0) <= 0n
  ) throw new Error("fresh Hydration Aave staging quote does not bind 22→1003 and the exact sell amount.");
  const captured = Date.parse(evidence.capturedAt);
  if (!Number.isFinite(captured) || captured > now + 60_000 || now - captured > maxAgeMs) {
    throw new Error("Hydration staging quote is stale; regenerate rather than hand-editing the packet.");
  }
  return BigInt(evidence.quote.amountOutRaw);
}

export function buildV22StagingCall({ packet, token, wrapper, adapter, treasury, assets, sellAmount, minimumOutput, maxFeePerLeg, dispatchDeadline, nonce }) {
  if (!PACKETS.has(packet)) throw new Error("packet must be approve or stage.");
  const amount = BigInt(assets);
  const sell = BigInt(sellAmount);
  const minimum = BigInt(minimumOutput);
  const maximumFee = BigInt(maxFeePerLeg);
  const deadline = BigInt(dispatchDeadline);
  const requestNonce = BigInt(nonce);
  if (amount <= 0n || sell <= 0n || minimum <= 0n || maximumFee <= 0n || requestNonce <= 0n) throw new Error("staging amounts, minimum, fee cap, and nonce must be positive.");
  if (amount < sell + maximumFee) throw new Error("staging assets must cover sellAmount + maxFeePerLeg before transport headroom.");
  if (amount - sell - maximumFee < 10_000n) throw new Error("staging requires explicit transport headroom beyond sellAmount + maxFeePerLeg.");
  if (deadline <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("dispatchDeadline must be in the future.");
  if (packet === "approve") {
    const iface = new Interface(TOKEN_ABI);
    return {
      label: `USDC.approve(${getAddress(adapter)}, ${amount})`,
      to: getAddress(token),
      data: iface.encodeFunctionData("approve", [getAddress(adapter), amount])
    };
  }
  const iface = new Interface(ADAPTER_V22_ABI);
  return {
    label: "HydrationUsdcAdapterV22.stageTreasuryDeposit",
    to: getAddress(adapter),
    data: iface.encodeFunctionData("stageTreasuryDeposit", [
      getAddress(treasury), amount, sell, minimum, maximumFee, deadline, requestNonce
    ]),
    decoded: {
      treasury: getAddress(treasury),
      assets: amount.toString(),
      sellAmount: sell.toString(),
      minimumOutput: minimum.toString(),
      maxFeePerLeg: maximumFee.toString(),
      dispatchDeadline: deadline.toString(),
      nonce: requestNonce.toString(),
      transportHeadroomRaw: (amount - sell - maximumFee).toString(),
      wrapper: getAddress(wrapper)
    }
  };
}

export function assertUnusedV22StagingCandidate({ requestId, record }) {
  const status = Number(record?.status ?? record?.[2] ?? -1);
  const account = record?.context?.account ?? record?.[0]?.account ?? record?.[0]?.[2];
  if (status !== 0 || !account || getAddress(account) !== ZeroAddress) {
    throw new Error(`staging candidate ${requestId} is already occupied; increment --nonce and regenerate.`);
  }
  return { requestId, status, account: ZeroAddress };
}

function assertArmEvidence(evidence, wrapper, adapter) {
  if (
    evidence?.kind !== "averray.bankXcmV2MultisigPacket" || evidence?.generation !== "2.2" ||
    evidence?.packet !== "arm" || evidence?.containsUnpause !== true || evidence?.innerCalls?.length !== 1 ||
    getAddress(evidence.wrapper) !== getAddress(wrapper) || getAddress(evidence.adapter) !== getAddress(adapter) ||
    !String(evidence.innerCalls[0].data).toLowerCase().startsWith("0x1f59d6fb") || !evidence.armBasis
  ) throw new Error("staging packet is not bound to the reviewed v2.2 arm packet.");
  return { capturedAt: evidence.capturedAt, innerCallHash: evidence.innerCallHash, asMultiScale: evidence.asMultiScale };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: prepare-bank-xcm-v22-staging-multisig.mjs --packet approve|stage --wrapper 0x... --adapter 0x... --arm-evidence FILE --dispatch-deadline UNIX --packet-out FILE [--quote-evidence FILE]");
    return;
  }
  if (args.profile !== "mainnet" || !PACKETS.has(args.packet) || !args.wrapper || !args.adapter || !args.armEvidence || !args.dispatchDeadline || !args.packetOut) {
    throw new Error("mainnet, packet, pair, arm evidence, deadline, and packet output are required.");
  }
  const manifest = loadJson(resolve(repoRoot, "deployments/mainnet.json"));
  const ownerRecord = loadJson(resolve(repoRoot, "deployments/mainnet-multisig-owner.json"));
  const wrapperAddress = getAddress(args.wrapper);
  const adapterAddress = getAddress(args.adapter);
  if (getAddress(manifest.contracts.xcmWrapper) !== wrapperAddress || getAddress(manifest.contracts.hydrationUsdcAdapter) !== adapterAddress) {
    throw new Error("packet pair does not match the manifest's v2.2 subject.");
  }
  const arm = assertArmEvidence(loadJson(resolve(args.armEvidence)), wrapperAddress, adapterAddress);
  const sellAmount = BigInt(args.sellAmount);
  const quote = args.quoteEvidence ? loadJson(resolve(args.quoteEvidence)) : null;
  if (args.packet === "stage" && !quote) throw new Error("stage packet requires --quote-evidence.");
  const minimumOutput = args.packet === "stage"
    ? assertFreshV22StagingQuote(quote, { sellAmount })
    : sellAmount;
  const call = buildV22StagingCall({
    packet: args.packet,
    token: manifest.contracts.token,
    wrapper: wrapperAddress,
    adapter: adapterAddress,
    treasury: manifest.owner,
    assets: args.assets,
    sellAmount,
    minimumOutput,
    maxFeePerLeg: args.maxFeePerLeg,
    dispatchDeadline: args.dispatchDeadline,
    nonce: args.nonce
  });

  const rpc = await createCeremonyRpcContext({ manifest, phase: `bank-xcm-v22-${args.packet}-packet`, write: false });
  let live;
  try {
    printCeremonyRpcPreflight(rpc);
    const blockNumber = await rpc.provider.getBlockNumber();
    const at = { blockTag: blockNumber };
    const policy = new Contract(manifest.contracts.treasuryPolicy, POLICY_BANK_ABI, rpc.provider);
    const wrapper = new Contract(wrapperAddress, WRAPPER_STAGING_ABI, rpc.provider);
    const adapter = new Contract(adapterAddress, ADAPTER_V22_ABI, rpc.provider);
    const token = new Contract(manifest.contracts.token, TOKEN_ABI, rpc.provider);
    const requestContext = {
      strategyId: BANK_XCM_V2.strategyId,
      kind: 0,
      account: getAddress(manifest.owner),
      asset: getAddress(manifest.contracts.token),
      recipient: getAddress(manifest.owner),
      assets: BigInt(args.assets),
      shares: 0n,
      nonce: BigInt(args.nonce)
    };
    const candidateRequestId = previewRequestId(requestContext);
    const [owner, policyPaused, dispatchPaused, operator, hydration, boundAdapter, settler, adapterWrapper, balance, allowance, totalShares, totalAssets, pendingDeposits, pendingWithdrawals, candidateRecord] = await Promise.all([
      policy.owner(at), policy.paused(at), wrapper.dispatchPaused(at), wrapper.operator(at), wrapper.hydrationAccountId32(at),
      wrapper.strategyAdapter(BANK_XCM_V2.strategyId, at), policy.strategySettler(manifest.verifier, at), adapter.xcmWrapper(at),
      token.balanceOf(manifest.owner, at), token.allowance(manifest.owner, adapterAddress, at), adapter.totalShares(at), adapter.totalAssets(at),
      adapter.pendingDepositAssets(at), adapter.pendingWithdrawalShares(at),
      wrapper.getRequest(candidateRequestId, at)
    ]);
    assertOwnerRecordAuthority({ ownerRecord, livePolicyOwner: owner });
    if (policyPaused || getAddress(operator) !== getAddress(manifest.verifier) || String(hydration).toLowerCase() !== String(manifest.bankXcmDeploymentHistory.at(-1).convertedAccountId32).toLowerCase() || getAddress(boundAdapter) !== adapterAddress || getAddress(adapterWrapper) !== wrapperAddress || !settler) {
      throw new Error("v2.2 live configuration no longer matches the gated pair.");
    }
    const candidate = assertUnusedV22StagingCandidate({ requestId: candidateRequestId, record: candidateRecord });
    if ([totalShares, totalAssets, pendingDeposits, pendingWithdrawals].some((value) => BigInt(value) !== 0n)) {
      throw new Error("v2.2 staging preparation requires empty adapter accounting.");
    }
    const required = BigInt(args.assets);
    const blockers = [];
    if (dispatchPaused) blockers.push("arm packet has not executed: wrapper remains paused");
    if (BigInt(balance) < required) blockers.push(`treasury needs ${required - BigInt(balance)} additional raw USDC`);
    if (args.packet === "stage" && BigInt(allowance) !== required) blockers.push(`standalone approve must commit exact allowance ${required}`);
    live = {
      capturedAt: new Date().toISOString(), assetHubBlockNumber: blockNumber, policyPaused, dispatchPaused,
      operator: getAddress(operator), hydrationAccountId32: hydration, strategyAdapter: getAddress(boundAdapter), strategySettler: settler,
      treasuryBalanceRaw: balance.toString(), treasuryAllowanceRaw: allowance.toString(),
      candidateRequestId: candidate.requestId, candidateRequestStatus: candidate.status,
      candidateRequestAccount: candidate.account, adapterAccountingEmpty: true,
      signingBlockedUntil: blockers
    };
  } finally {
    await rpc.provider.destroy?.();
  }

  const signer = resolveProfileSigner({ ownerRecord, profile: "mainnet", signerLabel: args.signer });
  let api;
  let payload;
  let substrate;
  try {
    const [{ ApiPromise, WsProvider }, utilCrypto] = await Promise.all([import("@polkadot/api"), import("@polkadot/util-crypto")]);
    api = await ApiPromise.create({ provider: new WsProvider(args.ws), noInitWarn: true, throwOnConnect: true });
    const stage = args.packet === "stage";
    payload = await buildOnchainPayload({
      api, blake2AsHex: utilCrypto.blake2AsHex, innerCalls: [call], reviveRefTime: stage ? 40_000_000_000 : 4_000_000_000,
      reviveProofSize: stage ? 2_000_000 : 100_000, storageDepositLimit: stage ? 5_000_000_000 : 1_000_000_000,
      threshold: ownerRecord.threshold, otherSignatories: signer.otherSignatories, timepoint: null,
      maxWeightRefTime: stage ? 45_000_000_000 : 4_500_000_000, maxWeightProofSize: stage ? 2_250_000 : 150_000
    });
    substrate = await assertSubstrateProfileEncoding({ api, profile: "mainnet", reviveCallHexes: payload.reviveCallHexes });
  } finally {
    await api?.disconnect?.();
  }
  if (!verifyEvmCalldataEmbedded({ outerCallHex: payload.outerCallHex, innerCalls: [call] })[0]?.embedded) {
    throw new Error("staging SCALE did not embed the reviewed EVM calldata.");
  }
  const evidence = {
    schemaVersion: 1, kind: "averray.bankXcmV22StagingPacket", profile: "mainnet", packet: args.packet,
    capturedAt: new Date().toISOString(), wrapper: wrapperAddress, adapter: adapterAddress, armEvidence: arm,
    quote: quote ? { capturedAt: quote.capturedAt, blockNumber: quote.blockNumber, endpoint: quote.endpoint, ...quote.quote } : undefined,
    liveState: live, signer: signer.me, otherSignatories: signer.otherSignatories, timepoint: null,
    innerCalls: [call], innerCallHash: payload.outerCallHash, innerCallScale: payload.outerCallHex, asMultiScale: payload.asMultiHex,
    substrate, containsUnpause: false, signsOrSubmits: false
  };
  await writeFile(resolve(args.packetOut), `${stringify(evidence)}\n`, { flag: "wx" });
  console.log("# bank-xcm-v2.2 staging multisig packet (READ-ONLY)");
  console.log(`packet:           ${args.packet}`);
  console.log(`to:               ${call.to}`);
  console.log(`data:             ${call.data}`);
  console.log(`inner call hash:  ${payload.outerCallHash}`);
  console.log(`inner call SCALE: ${payload.outerCallHex}`);
  console.log(`first-leg SCALE:  ${payload.asMultiHex}`);
  console.log(`live blockers:    ${live.signingBlockedUntil.length ? live.signingBlockedUntil.join("; ") : "none"}`);
  console.log(`evidence:         ${resolve(args.packetOut)}`);
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`prepare-bank-xcm-v22-staging-multisig failed: ${error.message}`);
    process.exitCode = 1;
  });
}
