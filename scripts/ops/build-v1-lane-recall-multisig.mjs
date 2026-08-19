#!/usr/bin/env node

/**
 * Read-only Nova packet builder for the owner-controlled legs of the retired
 * HYDRATION_USDC_V1 recall. It never signs, submits, or accepts a private key.
 *
 *   stage     Leg A: stageTreasuryWithdraw through revive.call
 *   transfer  Leg C: transfer the exact proved arrival to the KMS signer
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, getAddress } from "ethers";

import { createCeremonyRpcContext } from "./ceremony-rpc.mjs";
import {
  SUBSTRATE_PROFILE_CONFIG,
  assertOwnerRecordAuthority,
  assertSubstrateProfileEncoding,
} from "./redeploy-escrowcore-wire-multisig.mjs";
import {
  V1_RECALL,
  assertBookPreflight,
  assertUnusedWithdrawCandidate,
  buildLegCTransferCall,
  buildReviveCallPayload,
  buildStageTreasuryWithdrawCall,
  deriveLegCTransfer,
  deriveTreasuryContext,
  deriveWithdrawRequestId,
  stringify,
} from "./v1-lane-recall-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const DEFAULT_DEPOSIT_EVIDENCE = resolve(
  repoRoot,
  "mcp-server/src/services/fixtures/mainnet-bank-v221-10usdc-deposit-swap.json",
);

const POLICY_ABI = Object.freeze([
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
]);
const ADAPTER_ABI = Object.freeze([
  "function policy() view returns (address)",
  "function asset() view returns (address)",
  "function strategyId() view returns (bytes32)",
  "function xcmWrapper() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function pendingWithdrawalShares() view returns (uint256)",
  "function getAdapterRequest(bytes32) view returns ((uint8 kind,uint8 status,address account,address requester,address recipient,uint256 requestedAssets,uint256 requestedShares,uint256 settledAssets,uint256 settledShares,bytes32 remoteRef,bytes32 failureCode,bool settled))",
]);
const WRAPPER_ABI = Object.freeze([
  "function strategyAdapter(bytes32) view returns (address)",
  "function dispatchPaused() view returns (bool)",
  "function previewRequestId((bytes32 strategyId,uint8 kind,address account,address asset,address recipient,uint256 assets,uint256 shares,uint64 nonce)) view returns (bytes32)",
  "function getRequest(bytes32) view returns (((bytes32 strategyId,uint8 kind,address account,address asset,address recipient,uint256 assets,uint256 shares,uint64 nonce) context,address queuedBy,uint8 status,uint256 settledAssets,uint256 settledShares,bytes32 remoteRef,bytes32 failureCode,uint64 createdAt,uint64 updatedAt))",
]);
const TOKEN_ABI = Object.freeze(["function balanceOf(address) view returns (uint256)"]);

export function parseArgs(argv) {
  const args = {
    leg: argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined,
    profile: undefined,
    nonce: undefined,
    dispatchDeadline: undefined,
    maxFeePerLeg: V1_RECALL.maxFeePerLegRaw.toString(),
    depositEvidence: DEFAULT_DEPOSIT_EVIDENCE,
    legBEvidence: undefined,
    ws: SUBSTRATE_PROFILE_CONFIG.mainnet.defaultWs,
    packetOut: undefined,
    help: false,
  };
  const start = args.leg ? 1 : 0;
  for (let index = start; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      return value;
    };
    if (flag === "--profile") args.profile = next();
    else if (flag === "--nonce") args.nonce = next();
    else if (flag === "--dispatch-deadline") args.dispatchDeadline = next();
    else if (flag === "--max-fee-per-leg") args.maxFeePerLeg = next();
    else if (flag === "--deposit-evidence") args.depositEvidence = next();
    else if (flag === "--leg-b-evidence") args.legBEvidence = next();
    else if (flag === "--ws") args.ws = next();
    else if (flag === "--packet-out") args.packetOut = next();
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/ops/build-v1-lane-recall-multisig.mjs stage --profile mainnet --nonce N --dispatch-deadline UNIX --packet-out FILE",
    "  node scripts/ops/build-v1-lane-recall-multisig.mjs transfer --profile mainnet --leg-b-evidence FILE --packet-out FILE",
    "",
    "Read-only. Emits one revive.call SCALE value and its blake2 call hash for Nova; never signs or submits.",
  ].join("\n");
}

export async function readCompletedEvidence(path) {
  const raw = await readFile(resolve(path), "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.phase === "completed") return parsed;
  } catch {
    // A commit run records append-only JSONL checkpoints so an interrupted XCM
    // leg cannot erase the fact that funds are in flight.
  }
  const completed = raw.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry?.phase === "completed").at(-1);
  if (!completed) throw new Error("Leg B evidence has no completed checkpoint.");
  return completed;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage());
  if (!new Set(["stage", "transfer"]).has(args.leg) || args.profile !== "mainnet" || !args.packetOut) {
    throw new Error(`${usage()}\n\nA leg, --profile mainnet, and --packet-out are mandatory.`);
  }
  if (args.leg === "stage" && (!args.nonce || !args.dispatchDeadline)) {
    throw new Error("Leg A requires a fresh --nonce and --dispatch-deadline.");
  }
  if (args.leg === "transfer" && !args.legBEvidence) throw new Error("Leg C requires --leg-b-evidence.");

  const manifest = JSON.parse(await readFile(resolve(repoRoot, "deployments/mainnet.json"), "utf8"));
  const ownerRecord = JSON.parse(await readFile(resolve(repoRoot, "deployments/mainnet-multisig-owner.json"), "utf8"));
  assertManifest(manifest);
  const rpc = await createCeremonyRpcContext({ manifest, phase: `v1-lane-recall-${args.leg}`, write: false });
  let call;
  let live;
  let requestId = null;
  try {
    const policy = new Contract(manifest.contracts.treasuryPolicy, POLICY_ABI, rpc.provider);
    const adapter = new Contract(V1_RECALL.adapter, ADAPTER_ABI, rpc.provider);
    const wrapper = new Contract(V1_RECALL.wrapper, WRAPPER_ABI, rpc.provider);
    const token = new Contract(V1_RECALL.token, TOKEN_ABI, rpc.provider);
    const blockNumber = await rpc.provider.getBlockNumber();
    const at = { blockTag: blockNumber };
    const [owner, paused, adapterPolicy, adapterAsset, strategyId, adapterWrapper, boundAdapter] = await Promise.all([
      policy.owner(at), policy.paused(at), adapter.policy(at), adapter.asset(at), adapter.strategyId(at),
      adapter.xcmWrapper(at), wrapper.strategyAdapter(V1_RECALL.strategyId, at),
    ]);
    assertOwnerRecordAuthority({ ownerRecord, livePolicyOwner: owner });
    if (
      paused
      || getAddress(owner) !== getAddress(V1_RECALL.owner)
      || getAddress(adapterPolicy) !== getAddress(manifest.contracts.treasuryPolicy)
      || getAddress(adapterAsset) !== getAddress(V1_RECALL.token)
      || String(strategyId).toLowerCase() !== V1_RECALL.strategyId
      || getAddress(adapterWrapper) !== getAddress(V1_RECALL.wrapper)
      || getAddress(boundAdapter) !== getAddress(V1_RECALL.adapter)
    ) throw new Error("Live v1 lane bindings no longer match the reviewed mainnet subject.");

    if (args.leg === "stage") {
      const deadline = BigInt(args.dispatchDeadline);
      if (deadline <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("--dispatch-deadline must be in the future.");
      const depositEvidence = JSON.parse(await readFile(resolve(args.depositEvidence), "utf8"));
      const depositRequestId = depositEvidence?.event?.data?.requestId;
      const [totalAssets, totalShares, pendingWithdrawalShares, adapterRequest, wrapperRequest, dispatchPaused] = await Promise.all([
        adapter.totalAssets(at), adapter.totalShares(at), adapter.pendingWithdrawalShares(at),
        adapter.getAdapterRequest(depositRequestId, at), wrapper.getRequest(depositRequestId, at), wrapper.dispatchPaused(at),
      ]);
      if (dispatchPaused) throw new Error("Wrapper is paused; Leg A cannot stage a dispatchable recall.");
      const book = assertBookPreflight({ totalAssets, totalShares, pendingWithdrawalShares });
      const derivation = deriveTreasuryContext({ depositEvidence, adapterRequest, wrapperRequest, currentTotalShares: totalShares });
      if (derivation.treasuryContext !== getAddress(owner)) throw new Error("Derived treasury context is not the live policy owner.");
      call = buildStageTreasuryWithdrawCall({
        treasuryContext: derivation.treasuryContext,
        shares: totalShares,
        minimumAssets: V1_RECALL.recordedBookRaw,
        remoteFeeBudget: BigInt(args.maxFeePerLeg),
        dispatchDeadline: deadline,
        nonce: BigInt(args.nonce),
      });
      requestId = deriveWithdrawRequestId({ treasuryContext: derivation.treasuryContext, nonce: args.nonce });
      const [chainPreview, candidate] = await Promise.all([
        wrapper.previewRequestId({
          strategyId: V1_RECALL.strategyId,
          kind: 1,
          account: derivation.treasuryContext,
          asset: V1_RECALL.token,
          recipient: V1_RECALL.owner,
          assets: 0n,
          shares: V1_RECALL.allSharesRaw,
          nonce: BigInt(args.nonce),
        }, at),
        wrapper.getRequest(requestId, at),
      ]);
      if (String(chainPreview).toLowerCase() !== requestId) throw new Error("Local withdrawal requestId does not reproduce wrapper.previewRequestId.");
      assertUnusedWithdrawCandidate(candidate);
      await rpc.provider.call({ from: owner, to: call.to, data: call.data, value: 0n, blockTag: blockNumber });
      live = {
        blockNumber,
        depositDerivation: derivation,
        book,
        pendingWithdrawalSharesRaw: pendingWithdrawalShares,
        dispatchPaused,
        candidateRequestId: requestId,
        candidateUnused: true,
        evmCallPreflight: "success",
      };
    } else {
      const evidence = await readCompletedEvidence(args.legBEvidence);
      if (getAddress(evidence?.addresses?.owner) !== getAddress(owner)) throw new Error("Leg B evidence owner does not match the live policy owner.");
      if (getAddress(evidence?.addresses?.settler) !== getAddress(V1_RECALL.settler)) throw new Error("Leg B evidence settler is not the reviewed KMS signer.");
      const currentBalance = await token.balanceOf(owner, at);
      const transfer = deriveLegCTransfer({ evidence, currentMultisigBalance: currentBalance });
      call = buildLegCTransferCall({ amount: transfer.arrivedRaw });
      await rpc.provider.call({ from: owner, to: call.to, data: call.data, value: 0n, blockTag: blockNumber });
      requestId = evidence.requestId;
      live = { blockNumber, legBRequestId: requestId, ...transfer, evmCallPreflight: "success" };
    }
  } finally {
    await rpc.provider.destroy?.();
  }

  let api;
  let payload;
  let substrate;
  try {
    const [{ ApiPromise, WsProvider }, utilCrypto] = await Promise.all([
      import("@polkadot/api"),
      import("@polkadot/util-crypto"),
    ]);
    api = await ApiPromise.create({ provider: new WsProvider(args.ws, 5_000), noInitWarn: true, throwOnConnect: true });
    payload = buildReviveCallPayload({ api, call, blake2AsHex: utilCrypto.blake2AsHex });
    substrate = await assertSubstrateProfileEncoding({ api, profile: "mainnet", reviveCallHexes: [payload.scale] });
  } finally {
    await api?.disconnect?.();
  }

  const packet = {
    schemaVersion: 1,
    kind: "averray.v1LaneRecallMultisigPacket",
    capturedAt: new Date().toISOString(),
    profile: "mainnet",
    leg: args.leg === "stage" ? "A" : "C",
    batchGroup: args.leg === "stage" ? 5 : null,
    requestId,
    authority: "2-of-3 treasury owner multisig",
    live,
    call,
    revive: {
      refTime: V1_RECALL.reviveRefTime,
      proofSize: V1_RECALL.reviveProofSize,
      storageDepositLimit: V1_RECALL.storageDepositLimit,
      methodScale: payload.scale,
      blake2CallHash: payload.callHash,
    },
    substrate,
    signsOrSubmits: false,
  };
  await writeFile(resolve(args.packetOut), `${stringify(packet)}\n`, { flag: "wx" });
  console.log(`# v1 lane recall multisig Leg ${packet.leg} (READ-ONLY)`);
  console.log(`requestId:         ${requestId}`);
  console.log(`to:                ${call.to}`);
  console.log(`EVM calldata:      ${call.data}`);
  console.log(`revive.call SCALE: ${payload.scale}`);
  console.log(`blake2 call hash:  ${payload.callHash}`);
  console.log(`packet:            ${resolve(args.packetOut)}`);
  return packet;
}

function assertManifest(manifest) {
  const checks = [
    [manifest.contracts?.hydrationUsdcAdapter, V1_RECALL.adapter, "v1 adapter"],
    [manifest.contracts?.xcmWrapper, V1_RECALL.wrapper, "wrapper"],
    [manifest.contracts?.depositPoolLane, V1_RECALL.poolLane, "pool lane"],
    [manifest.contracts?.token, V1_RECALL.token, "USDC"],
    [manifest.owner, V1_RECALL.owner, "owner"],
    [manifest.verifier, V1_RECALL.settler, "settler"],
  ];
  for (const [actual, expected, label] of checks) {
    if (getAddress(actual) !== getAddress(expected)) throw new Error(`Manifest ${label} no longer matches the ratified v1 recall subject.`);
  }
  if (String(manifest.bankXcmV2Deployment?.convertedAccountId32).toLowerCase() !== V1_RECALL.convertedAccountId32) {
    throw new Error("Manifest converted Hydration account no longer matches the ratified v1 custody account.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`build-v1-lane-recall-multisig failed: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
