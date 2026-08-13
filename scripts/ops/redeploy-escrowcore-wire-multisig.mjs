#!/usr/bin/env node

/**
 * Emit the polkadot-js-apps multisig.asMulti recipe for wiring a freshly
 * redeployed EscrowCore as an AgentAccountCore escrow operator plus the
 * least-privilege TreasuryPolicy roles it needs (and optionally revoking
 * stale roles in the same batch). When AgentAccountCore is redeployed too,
 * pass --new-agent-account so the same batch also approves the fresh AAC
 * as the outflow recorder and targets setEscrowOperator on that fresh AAC.
 *
 * Why a recipe and not an EVM commit:
 *   TreasuryPolicy.owner() is the H160 mapping of the profile's SS58 2-of-3
 *   multisig recorded in deployments/<profile>-multisig-owner.json. There is
 *   no private key for it — role mutations must go through
 *   pallet_multisig.asMulti.
 *
 * Default flow (batched, one multisig round):
 *   multisig.asMulti(
 *     threshold: 2,
 *     otherSignatories: [other two signers in AccountId32 byte order],
 *     maybeTimepoint: <None for first leg, Some({height,index}) for second>,
 *     call: utility.batchAll([
 *       revive.call(TreasuryPolicy.setOutflowRecorder(newAgentAccount, true)), // only with --new-agent-account
 *       revive.call(NewAgentAccountCore.setEscrowOperator(newEscrow, true)),
 *       revive.call(TreasuryPolicy.setSettlementBroker(newEscrow, true)),
 *       revive.call(TreasuryPolicy.setReputationWriter(newEscrow, true)),
 *       revive.call(TreasuryPolicy.setSettlementBroker(backendSigner, true)),
 *       revive.call(TreasuryPolicy.setAgentTransferBroker(backendSigner, true)),
 *       revive.call(TreasuryPolicy.setReputationWriter(backendSigner, true)),
 *       revive.call(OldAgentAccountCore.setEscrowOperator(oldEscrow, false)),
 *       revive.call(TreasuryPolicy.setSettlementBroker(oldEscrow, false)),
 *       revive.call(TreasuryPolicy.setReputationWriter(oldEscrow, false))
 *     ]),
 *     maxWeight: { refTime, proofSize }
 *   )
 *
 *   This mirrors the swap-arbitrator-batch path in
 *   rotate-admin-multisig-payload.mjs — one 2-of-3 hardware round.
 *
 * V2 cutover / v1-drain variant (pass --skip-revoke):
 *   multisig.asMulti(
 *     call: utility.batchAll([
 *       revive.call(TreasuryPolicy.setOutflowRecorder(newAgentAccount, true)), // only with --new-agent-account
 *       revive.call(AgentAccountCore.setEscrowOperator(newEscrow, true)),
 *       revive.call(TreasuryPolicy.setSettlementBroker(newEscrow, true)),
 *       revive.call(TreasuryPolicy.setReputationWriter(newEscrow, true)),
 *       revive.call(TreasuryPolicy.setSettlementBroker(backendSigner, true)),
 *       revive.call(TreasuryPolicy.setAgentTransferBroker(backendSigner, true)),
 *       revive.call(TreasuryPolicy.setReputationWriter(backendSigner, true))
 *     ])
 *   )
 *
 *   This is required for the protocol-fee v2 cutover while open v1 jobs
 *   drain. Revoke the old roles in a later, separately reviewed ceremony
 *   only after both the backend and indexer report no live v1 jobs.
 *
 * Usage
 * -----
 *   # First leg (profile signer, no timepoint):
 *   node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \
 *     --new-escrow 0xNEW --new-agent-account 0xNEW_AAC --signer LABEL
 *
 *   # Second leg (another profile signer, with timepoint from first leg's
 *   # multisig.NewMultisig event):
 *   node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \
 *     --new-escrow 0xNEW --new-agent-account 0xNEW_AAC --signer OTHER_LABEL \
 *     --timepoint-height H --timepoint-index I
 *
 * This script does not touch Substrate keys. The actual signing happens
 * in polkadot-js-apps via the browser extension / Ledger.
 */

import { Contract, Interface, getAddress, hexlify, keccak256 } from "ethers";
import { createKeyMulti, decodeAddress } from "@polkadot/util-crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeployments, isAddress } from "./rotate-admin-lib.mjs";
import {
  createCeremonyRpcContext,
  printCeremonyRpcPreflight
} from "./ceremony-rpc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export const SUBSTRATE_PROFILE_CONFIG = Object.freeze({
  mainnet: Object.freeze({
    chainName: "Polkadot Asset Hub",
    genesisHash: "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f",
    revivePalletIndex: 90,
    wsEnv: "POLKADOT_AH_WS",
    defaultWs: "wss://polkadot-asset-hub-rpc.polkadot.io"
  }),
  testnet: Object.freeze({
    chainName: "Paseo Asset Hub",
    genesisHash: "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
    revivePalletIndex: 100,
    wsEnv: "PASEO_AH_WS",
    defaultWs: "wss://asset-hub-paseo-rpc.n.dwellir.com"
  })
});

// Current Asset Hub runtimes: pallet_utility is index 0x28, batchAll is call
// 0x02. Every successful encoding of utility.batchAll([...]) starts with these
// two bytes. The on-chain hex test pins this so a runtime reshuffle gets caught.
export const UTILITY_BATCH_ALL_CALL_INDEX = "0x2802";

const TREASURY_POLICY_ABI = [
  "function owner() view returns (address)",
  "function setSettlementBroker(address account, bool allowed)",
  "function setAgentTransferBroker(address account, bool allowed)",
  "function setReputationWriter(address account, bool allowed)",
  "function setOutflowRecorder(address account, bool allowed)"
];

const AGENT_ACCOUNT_ABI = [
  "function setEscrowOperator(address escrowOperator, bool approved)"
];

const ESCROW_V3_ADMIN_ABI = [
  "function setFeeSchedule(uint256 retentionFlatRaw,uint16 retentionCapBps,uint16 posterFeeBps,uint256 posterFeeFloorRaw)"
];

export const ESCROW_V3_INITIAL_FEE_SCHEDULE = Object.freeze({
  retentionFlatRaw: 50_000n,
  retentionCapBps: 2_000,
  posterFeeBps: 500,
  posterFeeFloorRaw: 50_000n
});

export function parseArgs(argv) {
  const args = { profile: "testnet", skipRevoke: false, noWs: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--new-escrow") args.newEscrow = argv[++i];
    else if (arg === "--old-escrow") args.oldEscrow = argv[++i];
    else if (arg === "--new-agent-account") args.newAgentAccount = argv[++i];
    else if (arg === "--old-agent-account") args.oldAgentAccount = argv[++i];
    else if (arg === "--signer") args.signer = argv[++i];
    else if (arg === "--profile") args.profile = argv[++i];
    else if (arg === "--timepoint-height") args.tpHeight = argv[++i];
    else if (arg === "--timepoint-index") args.tpIndex = argv[++i];
    else if (arg === "--skip-revoke") args.skipRevoke = true;
    else if (arg === "--ws") args.ws = argv[++i];
    else if (arg === "--no-ws") args.noWs = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function substrateProfileConfig(profile) {
  const config = SUBSTRATE_PROFILE_CONFIG[profile];
  if (!config) {
    throw new Error(
      `No Substrate endpoint is defined for profile ${JSON.stringify(profile)}; ` +
        `expected one of: ${Object.keys(SUBSTRATE_PROFILE_CONFIG).join(", ")}.`
    );
  }
  return config;
}

export function resolveSubstrateEndpoint(args, env = process.env) {
  const config = substrateProfileConfig(args.profile);
  if (args.noWs && args.ws) {
    throw new Error(
      "--ws cannot be combined with --no-ws because the endpoint identity cannot be verified."
    );
  }
  const configured = args.noWs
    ? config.defaultWs
    : String(args.ws ?? env[config.wsEnv] ?? config.defaultWs).trim();
  if (!configured) {
    throw new Error(
      `No Substrate endpoint resolved for profile ${args.profile}; pass --ws or set ${config.wsEnv}.`
    );
  }
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(
      `Invalid Substrate endpoint for profile ${args.profile}: ${JSON.stringify(configured)}.`
    );
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(
      `Substrate endpoint for profile ${args.profile} must use ws:// or wss://, not ${parsed.protocol}.`
    );
  }
  return configured;
}

export function buildPolkadotAppsExtrinsicsUrl(wsUrl) {
  return `https://polkadot.js.org/apps/?rpc=${encodeURIComponent(wsUrl)}#/extrinsics`;
}

function palletIndexToNumber(index) {
  if (typeof index?.toNumber === "function") return index.toNumber();
  const parsed = Number(index?.toString?.() ?? index);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

export async function assertSubstrateProfileEncoding({
  api,
  profile,
  reviveCallHexes
}) {
  const config = substrateProfileConfig(profile);
  const chainName = String(await api.rpc.system.chain());
  const genesisHash = String(api.genesisHash.toHex()).toLowerCase();
  if (genesisHash !== config.genesisHash) {
    throw new Error(
      `Substrate profile self-check failed: connected genesis ${genesisHash} ` +
        `(${chainName}) does not match ${profile} ${config.chainName} ` +
        `(${config.genesisHash}).`
    );
  }

  const revivePallet = api.runtimeMetadata.asLatest.pallets.find(
    (pallet) => String(pallet.name).toLowerCase() === "revive"
  );
  if (!revivePallet) {
    throw new Error(
      `Substrate profile self-check failed: revive pallet is absent from ${profile} metadata.`
    );
  }
  const metadataIndex = palletIndexToNumber(revivePallet.index);
  if (metadataIndex !== config.revivePalletIndex) {
    throw new Error(
      `Substrate profile self-check failed: ${profile} metadata uses revive pallet index ` +
        `${metadataIndex}; expected ${config.revivePalletIndex}.`
    );
  }

  for (const [position, callHex] of reviveCallHexes.entries()) {
    if (!/^0x[0-9a-f]{2}/iu.test(callHex)) {
      throw new Error(
        `Substrate profile self-check failed: revive.call[${position + 1}] has invalid SCALE hex.`
      );
    }
    const encodedIndex = Number.parseInt(callHex.slice(2, 4), 16);
    if (encodedIndex !== metadataIndex) {
      throw new Error(
        `Substrate profile self-check failed: encoded revive.call uses pallet index ` +
          `${encodedIndex} (0x${encodedIndex.toString(16).padStart(2, "0")}), but ` +
          `${profile} metadata uses ${metadataIndex} ` +
          `(0x${metadataIndex.toString(16).padStart(2, "0")}).`
      );
    }
  }

  return {
    chainName,
    genesisHash,
    revivePalletIndex: metadataIndex
  };
}

function assertOwnerRecordShape(ownerRecord, profile) {
  if (ownerRecord?.profile !== profile) {
    throw new Error(
      `Owner record profile ${JSON.stringify(ownerRecord?.profile)} does not match requested profile ${JSON.stringify(profile)}.`
    );
  }
  if (ownerRecord?.status !== "verified") {
    throw new Error(
      `deployments/${profile}-multisig-owner.json must have status=verified before emitting a multisig recipe.`
    );
  }
  if (!Number.isInteger(ownerRecord?.threshold) || ownerRecord.threshold < 2) {
    throw new Error(
      `deployments/${profile}-multisig-owner.json has an invalid threshold.`
    );
  }
  if (!Array.isArray(ownerRecord?.signatories) || ownerRecord.signatories.length < ownerRecord.threshold) {
    throw new Error(
      `deployments/${profile}-multisig-owner.json has too few signatories for threshold ${ownerRecord.threshold}.`
    );
  }
  const labels = ownerRecord.signatories.map((entry) => String(entry?.label ?? "").trim());
  if (labels.some((label) => !/^[a-z][a-z0-9_-]*$/u.test(label))) {
    throw new Error(
      `deployments/${profile}-multisig-owner.json must give every signatory a lowercase label.`
    );
  }
  if (new Set(labels).size !== labels.length) {
    throw new Error(
      `deployments/${profile}-multisig-owner.json contains duplicate signatory labels.`
    );
  }
}

export function resolveProfileSigner({ ownerRecord, profile, signerLabel }) {
  assertOwnerRecordShape(ownerRecord, profile);
  const requested = String(signerLabel ?? "").trim();
  const available = ownerRecord.signatories.map((entry) => entry.label);
  const me = ownerRecord.signatories.find((entry) => entry.label === requested);
  if (!me) {
    throw new Error(
      `--signer ${requested || "<missing>"} is not defined for profile ${profile}; ` +
      `available labels: ${available.join(", ")}.`
    );
  }

  const accountIdSortKey = (entry) => String(entry.accountId32).toLowerCase();
  const signersSorted = [...ownerRecord.signatories].sort((a, b) => {
    const left = accountIdSortKey(a);
    const right = accountIdSortKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const selectedAccountId = accountIdSortKey(me);
  return {
    me,
    available,
    otherSignatories: signersSorted
      .filter((entry) => accountIdSortKey(entry) !== selectedAccountId)
      .map((entry) => entry.address)
  };
}

export function assertOwnerRecordAuthority({ ownerRecord, livePolicyOwner }) {
  const profile = ownerRecord?.profile ?? "unknown";
  assertOwnerRecordShape(ownerRecord, profile);

  const decodedSignatories = ownerRecord.signatories.map((entry) => {
    const decoded = decodeAddress(entry.address);
    const decodedHex = hexlify(decoded).toLowerCase();
    if (decodedHex !== String(entry.accountId32).toLowerCase()) {
      throw new Error(
        `Owner authority self-check failed: ${entry.label} address decodes to ` +
        `${decodedHex}, not record accountId32 ${entry.accountId32}.`
      );
    }
    return decoded;
  });
  const derivedAccountId32 = hexlify(
    createKeyMulti(decodedSignatories, ownerRecord.threshold)
  );
  if (
    derivedAccountId32.toLowerCase() !==
    String(ownerRecord?.multisig?.accountId32 ?? "").toLowerCase()
  ) {
    throw new Error(
      `Owner authority self-check failed: derived multisig AccountId32 ` +
      `${derivedAccountId32} does not match verified owner record ` +
      `${ownerRecord?.multisig?.accountId32 ?? "<missing>"}.`
    );
  }

  const derivedOwner = getAddress(`0x${keccak256(derivedAccountId32).slice(-40)}`);
  const recordedOwner = getAddress(ownerRecord.multisig.ownerEnvValue);
  const onchainOwner = getAddress(livePolicyOwner);
  if (derivedOwner !== recordedOwner) {
    throw new Error(
      `Owner authority self-check failed: derived H160 ${derivedOwner} does not ` +
      `match owner record ${recordedOwner}.`
    );
  }
  if (derivedOwner !== onchainOwner) {
    throw new Error(
      `Owner authority self-check failed: derived H160 ${derivedOwner} does not ` +
      `match live TreasuryPolicy.owner() ${onchainOwner}.`
    );
  }
  return { derivedAccountId32, derivedOwner, livePolicyOwner: onchainOwner };
}

/**
 * Build the SCALE-encoded utility.batchAll([revive.call, ...]) and the
 * matching asMulti wrapper from an already-connected polkadot-js api.
 *
 * Returns the inner call hex (paste into Apps multisig "call data for final
 * approval"), the blake2 call hash (matches multisig.NewMultisig event), the
 * encoded revive.call hex of each leg, and the asMulti hex for the first-leg
 * Decode-and-submit shortcut.
 *
 * Exported so it can be exercised by tests independently of CLI plumbing.
 */
export async function buildOnchainPayload({
  api,
  blake2AsHex,
  innerCalls,
  reviveRefTime,
  reviveProofSize,
  storageDepositLimit,
  threshold,
  otherSignatories,
  timepoint,
  maxWeightRefTime,
  maxWeightProofSize
}) {
  const reviveGas = { refTime: BigInt(reviveRefTime), proofSize: BigInt(reviveProofSize) };
  const deposit = BigInt(storageDepositLimit);

  const reviveCalls = innerCalls.map((call) =>
    api.tx.revive.call(call.to, 0, reviveGas, deposit, call.data)
  );
  const reviveCallHexes = reviveCalls.map((c) => c.method.toHex());

  let outerCall;
  if (reviveCalls.length === 1) {
    outerCall = reviveCalls[0];
  } else {
    outerCall = api.tx.utility.batchAll(reviveCalls);
  }
  const outerCallHex = outerCall.method.toHex();
  const outerCallHash = blake2AsHex(outerCall.method.toU8a(), 256);

  const asMulti = api.tx.multisig.asMulti(
    threshold,
    otherSignatories,
    timepoint
      ? { height: Number(timepoint.height), index: Number(timepoint.index) }
      : null,
    outerCall,
    { refTime: BigInt(maxWeightRefTime), proofSize: BigInt(maxWeightProofSize) }
  );

  return {
    outerCallHex,
    outerCallHash,
    reviveCallHexes,
    asMultiHex: asMulti.method.toHex(),
    isBatch: reviveCalls.length > 1
  };
}

/**
 * Cross-check: each inner EVM calldata that was printed in the chain-free
 * section MUST appear verbatim in the SCALE-encoded outer call. If a
 * runtime metadata change or operator typo silently rewrote what we
 * wrapped, this catches it before anyone signs.
 */
export function verifyEvmCalldataEmbedded({ outerCallHex, innerCalls }) {
  const haystack = outerCallHex.toLowerCase();
  return innerCalls.map((call) => {
    const needle = call.data.toLowerCase().replace(/^0x/u, "");
    return { label: call.label, embedded: haystack.includes(needle) };
  });
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \\",
      "         --new-escrow 0xADDR \\",
      "         --signer LABEL  # from deployments/<profile>-multisig-owner.json \\",
      "         [--timepoint-height N --timepoint-index M] \\",
      "         [--new-agent-account 0xADDR] # when AAC is redeployed too",
      "         [--old-agent-account 0xADDR] # defaults to current deployments/<profile>.json#contracts.agentAccountCore",
      "         [--old-escrow 0xADDR]   # defaults to current deployments/<profile>.json#contracts.escrowCore",
      "         [--skip-revoke]         # keep v1 settlement roles during the drain window",
      "         [--profile testnet] \\",
      "         [--ws WSS_URL]          # optional profile-bound override",
      "                                  # mainnet: POLKADOT_AH_WS; testnet: PASEO_AH_WS",
      "         [--no-ws]               # use the pinned profile endpoint in Apps, but skip SCALE emission",
      "",
      "First leg (initiate): omit --timepoint-*; maybeTimepoint is None.",
      "Second leg (countersign): pass --timepoint-height and --timepoint-index",
      "  from the block / extrinsic where the first leg's multisig.NewMultisig event fired."
    ].join("\n")
  );
}

export function buildInnerCalls({
  policyIface,
  accountIface,
  treasuryPolicy,
  agentAccount,
  newEscrow,
  oldEscrow,
  backendSigner,
  skipRevoke,
  newAgentAccount,
  oldAgentAccount
}) {
  const activeAgentAccount = newAgentAccount ?? agentAccount;
  const staleAgentAccount = oldAgentAccount ?? agentAccount;
  const escrowV3Iface = new Interface(ESCROW_V3_ADMIN_ABI);
  const calls = [];
  if (newAgentAccount) {
    calls.push({
      label: `TreasuryPolicy.setOutflowRecorder(${newAgentAccount}, true)  // approve new AgentAccountCore egress-meter writer`,
      to: treasuryPolicy,
      data: policyIface.encodeFunctionData("setOutflowRecorder", [newAgentAccount, true])
    });
  }
  calls.push(
    {
      label: `EscrowCore.setFeeSchedule(50000, 2000, 500, 50000)  // D4 ratified v3 initials`,
      to: newEscrow,
      data: escrowV3Iface.encodeFunctionData("setFeeSchedule", [
        ESCROW_V3_INITIAL_FEE_SCHEDULE.retentionFlatRaw,
        ESCROW_V3_INITIAL_FEE_SCHEDULE.retentionCapBps,
        ESCROW_V3_INITIAL_FEE_SCHEDULE.posterFeeBps,
        ESCROW_V3_INITIAL_FEE_SCHEDULE.posterFeeFloorRaw
      ])
    },
    {
      label: `AgentAccountCore.setEscrowOperator(${newEscrow}, true)  // approve new EscrowCore ledger authority`,
      to: activeAgentAccount,
      data: accountIface.encodeFunctionData("setEscrowOperator", [newEscrow, true])
    },
    {
      label: `TreasuryPolicy.setSettlementBroker(${newEscrow}, true)  // approve new EscrowCore account-reserve broker`,
      to: treasuryPolicy,
      data: policyIface.encodeFunctionData("setSettlementBroker", [newEscrow, true])
    },
    {
      label: `TreasuryPolicy.setReputationWriter(${newEscrow}, true)  // approve new EscrowCore reputation writer`,
      to: treasuryPolicy,
      data: policyIface.encodeFunctionData("setReputationWriter", [newEscrow, true])
    }
  );
  if (backendSigner) {
    calls.push(
      {
        label: `TreasuryPolicy.setSettlementBroker(${backendSigner}, true)  // approve backend signer brokered escrow entrypoints`,
        to: treasuryPolicy,
        data: policyIface.encodeFunctionData("setSettlementBroker", [backendSigner, true])
      },
      {
        label: `TreasuryPolicy.setAgentTransferBroker(${backendSigner}, true)  // approve backend signer user-authorized agent transfers`,
        to: treasuryPolicy,
        data: policyIface.encodeFunctionData("setAgentTransferBroker", [backendSigner, true])
      },
      {
        label: `TreasuryPolicy.setReputationWriter(${backendSigner}, true)  // approve backend signer direct reputation maintenance`,
        to: treasuryPolicy,
        data: policyIface.encodeFunctionData("setReputationWriter", [backendSigner, true])
      }
    );
  }
  if (!skipRevoke) {
    calls.push({
      label: `AgentAccountCore.setEscrowOperator(${oldEscrow}, false)  // revoke stale EscrowCore ledger authority`,
      to: staleAgentAccount,
      data: accountIface.encodeFunctionData("setEscrowOperator", [oldEscrow, false])
    });
    calls.push({
      label: `TreasuryPolicy.setSettlementBroker(${oldEscrow}, false)  // revoke stale EscrowCore broker authority`,
      to: treasuryPolicy,
      data: policyIface.encodeFunctionData("setSettlementBroker", [oldEscrow, false])
    });
    calls.push({
      label: `TreasuryPolicy.setReputationWriter(${oldEscrow}, false)  // revoke stale EscrowCore reputation authority`,
      to: treasuryPolicy,
      data: policyIface.encodeFunctionData("setReputationWriter", [oldEscrow, false])
    });
  }
  return calls;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.newEscrow || !isAddress(args.newEscrow)) {
    console.error("--new-escrow 0xADDRESS is required.");
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (!args.signer) {
    console.error("--signer LABEL is required.");
    process.exitCode = 1;
    return;
  }
  if (args.profile === "mainnet" && !args.skipRevoke) {
    throw new Error(
      "EscrowCore v3 mainnet wiring requires --skip-revoke: v2 roles remain live while legacy stock drains."
    );
  }
  if ((args.tpHeight !== undefined) !== (args.tpIndex !== undefined)) {
    console.error("Both --timepoint-height and --timepoint-index must be given together (or both omitted for the first leg).");
    process.exitCode = 1;
    return;
  }

  const newEscrow = getAddress(args.newEscrow);

  const { deployments } = await loadDeployments(repoRoot, args.profile);
  const multisigOwnerPath = resolve(repoRoot, "deployments", `${args.profile}-multisig-owner.json`);
  const ownerRecord = JSON.parse(await readFile(multisigOwnerPath, "utf8"));

  const treasuryPolicy = getAddress(deployments.contracts.treasuryPolicy);
  const agentAccount = getAddress(args.newAgentAccount ?? deployments.contracts.agentAccountCore);
  const oldAgentAccount = getAddress(args.oldAgentAccount ?? deployments.contracts.agentAccountCore);
  const oldEscrow = getAddress(args.oldEscrow ?? deployments.contracts.escrowCore);
  const backendSigner = deployments.verifier ? getAddress(deployments.verifier) : null;

  if (newEscrow.toLowerCase() === oldEscrow.toLowerCase()) {
    console.error(`--new-escrow and --old-escrow are the same address (${newEscrow}); refusing to emit a no-op recipe.`);
    process.exitCode = 1;
    return;
  }

  // Resolve the selected device only from this profile's verified owner
  // record. There is deliberately no cross-profile alias fallback.
  const signer = resolveProfileSigner({
    ownerRecord,
    profile: args.profile,
    signerLabel: args.signer
  });
  const { me, otherSignatories } = signer;

  // Prove the selected profile's complete roster controls the live policy
  // before emitting any recipe or calldata. This catches stale aliases,
  // tampered records, wrong-chain RPCs, and owner drift at one boundary.
  const authorityRpc = await createCeremonyRpcContext({
    manifest: deployments,
    phase: "multisig-wire-owner-check",
    write: false
  });
  let authority;
  const authorityPreflightLines = [];
  try {
    const policy = new Contract(treasuryPolicy, TREASURY_POLICY_ABI, authorityRpc.provider);
    const livePolicyOwner = await policy.owner();
    authority = assertOwnerRecordAuthority({ ownerRecord, livePolicyOwner });
    printCeremonyRpcPreflight(authorityRpc, (line) => authorityPreflightLines.push(line));
  } finally {
    await authorityRpc.provider.destroy?.();
  }

  // Optional timepoint for second leg.
  const timepoint = args.tpHeight !== undefined
    ? { height: Number(args.tpHeight), index: Number(args.tpIndex) }
    : null;

  // Build inner EVM calldata.
  const policyIface = new Interface(TREASURY_POLICY_ABI);
  const accountIface = new Interface(AGENT_ACCOUNT_ABI);
  const innerCalls = buildInnerCalls({
    policyIface,
    accountIface,
    treasuryPolicy,
    agentAccount,
    newEscrow,
    oldEscrow,
    backendSigner,
    skipRevoke: args.skipRevoke,
    newAgentAccount: args.newAgentAccount ? agentAccount : undefined,
    oldAgentAccount
  });
  const isBatch = innerCalls.length > 1;

  // Weight knobs — mirror rotate-admin-multisig-payload.mjs.
  // Ceremony 2026-08-13: raised from 4e9/100k after revive.OutOfGas at block
  // 19415173 — v3 compiles with optimizer_runs=1 (size fix), trading gas for
  // size, and setFeeSchedule's four cold SSTOREs blew the historical envelope.
  const reviveRefTime = 25_000_000_000;
  const reviveProofSize = 600_000;
  const storageDepositLimit = 1_000_000_000;
  const maxWeightRefTime = 27_000_000_000 * innerCalls.length;
  const maxWeightProofSize = 650_000 * innerCalls.length;

  // The Apps link and SCALE encoder share one profile-bound endpoint. Unless
  // --no-ws was explicitly requested, validate the connected chain, runtime
  // metadata, and encoded revive pallet byte before printing any recipe.
  const wsUrl = resolveSubstrateEndpoint(args);
  const appsExtrinsicsUrl = buildPolkadotAppsExtrinsicsUrl(wsUrl);
  let payload = null;
  let substrateAuthority = null;
  if (!args.noWs) {
    let api;
    try {
      const [{ ApiPromise, WsProvider }, utilCrypto] = await Promise.all([
        import("@polkadot/api"),
        import("@polkadot/util-crypto")
      ]);
      const provider = new WsProvider(wsUrl);
      api = await ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
      payload = await buildOnchainPayload({
        api,
        blake2AsHex: utilCrypto.blake2AsHex,
        innerCalls,
        reviveRefTime,
        reviveProofSize,
        storageDepositLimit,
        threshold: ownerRecord.threshold,
        otherSignatories,
        timepoint,
        maxWeightRefTime,
        maxWeightProofSize
      });
      substrateAuthority = await assertSubstrateProfileEncoding({
        api,
        profile: args.profile,
        reviveCallHexes: payload.reviveCallHexes
      });
    } catch (error) {
      throw new Error(
        `Substrate pre-emit self-check failed for profile ${args.profile} at ${wsUrl}: ` +
          `${error?.message ?? error}. Refusing to emit a signing recipe. ` +
          "Fix the endpoint or pass --no-ws to request the pinned profile-only Apps recipe."
      );
    } finally {
      if (api) {
        try { await api.disconnect(); } catch { /* best effort */ }
      }
    }
  }

  console.log("# redeploy-escrowcore-wire-multisig");
  console.log(`profile:                 ${args.profile}`);
  console.log(`new EscrowCore:          ${newEscrow}`);
  if (args.newAgentAccount) console.log(`new AgentAccountCore:    ${agentAccount}`);
  if (!args.skipRevoke) console.log(`old EscrowCore (revoke): ${oldEscrow}`);
  else console.log(`old EscrowCore:          ${oldEscrow}  (left wired; --skip-revoke set)`);
  if (args.newAgentAccount) console.log(`old AgentAccountCore:    ${oldAgentAccount}  (old escrow revoke target)`);
  console.log(`treasury policy (H160):  ${treasuryPolicy}`);
  console.log(`agent account (H160):    ${agentAccount}`);
  if (backendSigner) console.log(`backend signer (H160):  ${backendSigner}`);
  console.log(`owner multisig (SS58):   ${ownerRecord.multisig.ss58Address}`);
  console.log(`owner multisig (H160):   ${ownerRecord.multisig.ownerEnvValue}`);
  console.log(`threshold:               ${ownerRecord.threshold}`);
  console.log(`signing as:              ${me.label} (${me.address})`);
  console.log(`leg:                     ${timepoint ? `countersign (timepoint ${timepoint.height}/${timepoint.index})` : "initiate (timepoint None)"}`);
  console.log(`derived owner account:   ${authority.derivedAccountId32} ✓`);
  console.log(`derived/live owner H160: ${authority.derivedOwner} ✓`);
  authorityPreflightLines.forEach((line) => console.log(line));
  console.log(`substrate endpoint:      ${wsUrl}`);
  if (substrateAuthority) {
    console.log(
      `substrate preflight:   ${substrateAuthority.chainName}, revive pallet ` +
        `${substrateAuthority.revivePalletIndex} ✓`
    );
  } else {
    console.log("substrate preflight:   skipped by explicit --no-ws");
  }
  console.log("");

  console.log("## Inner EVM calldata:");
  innerCalls.forEach((call, i) => {
    console.log(`  ${isBatch ? `[${i + 1}] ` : ""}call:    ${call.label}`);
    console.log(`  ${isBatch ? "    " : ""}to:      ${call.to}`);
    console.log(`  ${isBatch ? "    " : ""}data:    ${call.data}`);
    console.log(`  ${isBatch ? "    " : ""}length:  ${(call.data.length - 2) / 2} bytes`);
    if (i < innerCalls.length - 1) console.log("");
  });
  console.log("");

  console.log(`## Wrap as ${isBatch ? `utility.batchAll(${innerCalls.length} revive.call entries)` : "revive.call"}`);
  innerCalls.forEach((call, i) => {
    console.log(`  ${isBatch ? `[${i + 1}] ` : ""}revive.call:`);
    console.log(`    dest (H160):         ${call.to}`);
    console.log("    value:               0");
    console.log("    gasLimit:");
    console.log(`      refTime:           ${reviveRefTime.toLocaleString("en-US")}`);
    console.log(`      proofSize:         ${reviveProofSize.toLocaleString("en-US")}`);
    console.log(`    storageDepositLimit: ${storageDepositLimit.toLocaleString("en-US")}`);
    console.log(`    data:                ${call.data}`);
    if (i < innerCalls.length - 1) console.log("");
  });
  console.log("");

  console.log("## Wrap as multisig.asMulti");
  console.log("  pallet:                multisig");
  console.log("  call:                  asMulti");
  console.log("  args:");
  console.log(`    threshold:           ${ownerRecord.threshold}`);
  console.log("    otherSignatories:");
  for (const addr of otherSignatories) {
    console.log(`                         ${addr}`);
  }
  console.log(`    maybeTimepoint:      ${timepoint ? `Some({height: ${timepoint.height}, index: ${timepoint.index}})` : "None"}`);
  console.log(`    call:                ${isBatch ? "utility.batchAll([…]) from the block above" : "revive.call(…) from the block above"}`);
  console.log("    maxWeight:");
  console.log(`      refTime:           ${maxWeightRefTime.toLocaleString("en-US")}`);
  console.log(`      proofSize:         ${maxWeightProofSize.toLocaleString("en-US")}`);
  console.log("");

  console.log("## polkadot-js-apps recipe");
  console.log(`  1. Open ${appsExtrinsicsUrl}`);
  console.log(`  2. Selected account: ${me.label} (${me.address})`);
  console.log("     — sign via browser extension (polkadot{.js}, Talisman, SubWallet) or Ledger USB.");
  console.log("  3. submit extrinsic: multisig > asMulti(threshold, otherSignatories, maybeTimepoint, call, maxWeight)");
  console.log(`  4. threshold: ${ownerRecord.threshold}`);
  console.log("  5. otherSignatories: add each address below (in this order):");
  for (const addr of otherSignatories) {
    console.log(`     - ${addr}`);
  }
  console.log(`  6. maybeTimepoint: ${timepoint ? `Some — height ${timepoint.height}, index ${timepoint.index}` : "None"}`);
  console.log("  7. call:");
  if (isBatch) {
    console.log("       pallet:    utility");
    console.log("       function:  batchAll");
    console.log(`       calls: (add ${innerCalls.length} revive.call entries)`);
    innerCalls.forEach((call, i) => {
      console.log(`         [${i + 1}]: revive > call`);
      console.log(`              dest:      ${call.to}`);
      console.log("              value:     0");
      console.log(`              gasLimit:  refTime ${reviveRefTime}, proofSize ${reviveProofSize}`);
      console.log(`              storageDepositLimit: ${storageDepositLimit}`);
      console.log(`              data:      ${call.data}`);
    });
  } else {
    console.log("       pallet:    revive");
    console.log("       function:  call");
    console.log(`       dest:      ${innerCalls[0].to}`);
    console.log("       value:     0");
    console.log(`       gasLimit:  refTime ${reviveRefTime}, proofSize ${reviveProofSize}`);
    console.log(`       storageDepositLimit: ${storageDepositLimit}`);
    console.log(`       data:      ${innerCalls[0].data}`);
  }
  console.log(`  8. maxWeight: refTime ${maxWeightRefTime}, proofSize ${maxWeightProofSize}`);
  console.log("  9. Submit Transaction → sign with browser extension / Ledger.");
  if (!timepoint) {
    console.log(" 10. Find the resulting `multisig.NewMultisig` event; record the block height + extrinsic index.");
    const countersigners = ownerRecord.signatories
      .filter(
        (entry) =>
          String(entry.accountId32).toLowerCase() !==
          String(me.accountId32).toLowerCase()
      )
      .map((entry) => entry.label)
      .join("|");
    console.log(`     Re-run this script with --signer <${countersigners}> --timepoint-height <H> --timepoint-index <I>`);
    console.log("     to generate the countersign recipe for the selected second device.");
  } else {
    console.log(" 10. Find the resulting `multisig.MultisigExecuted` event; record the call hash + block.");
    console.log("     Then run:");
    console.log("       node scripts/ops/redeploy-escrowcore.mjs --phase finalize \\");
    console.log(`         --new-escrow ${newEscrow} \\`);
    console.log("         --deploy-tx 0xDEPLOY_TX --multisig-exec-tx 0xEXEC_TX --commit");
  }

  // ----- Profile-verified SCALE emission -----
  if (!payload) {
    console.log("");
    console.log("## Inner call hex");
    console.log("  --no-ws was passed; on-chain SCALE encoding skipped.");
    console.log(
      `  The Apps recipe remains pinned to ${substrateProfileConfig(args.profile).chainName}.`
    );
    return;
  }

  console.log("");
  console.log("## Inner call hex (paste into Apps multisig pending → 'call data for final approval')");
  if (payload.isBatch) {
    payload.reviveCallHexes.forEach((hex, i) => {
      console.log(`  revive.call[${i + 1}] hex: ${hex}`);
    });
    console.log("");
    console.log(`  utility.batchAll hex:  ${payload.outerCallHex}`);
  } else {
    console.log(`  revive.call hex:       ${payload.outerCallHex}`);
  }
  console.log(`  length:                ${(payload.outerCallHex.length - 2) / 2} bytes`);
  console.log(`  blake2 call hash:      ${payload.outerCallHash}`);
  console.log("    ↑ this is the call_hash that will appear in the multisig.NewMultisig event,");
  console.log("      and the storage key for the pending multisig entry. Verify it matches what");
  console.log("      polkadot-js-apps shows under 'Multisig' → 'pending approvals' before the");
  console.log("      second-leg signer countersigns.");

  if (payload.isBatch) {
    const expectedPrefix = UTILITY_BATCH_ALL_CALL_INDEX;
    const actualPrefix = payload.outerCallHex.slice(0, expectedPrefix.length).toLowerCase();
    const prefixOk = actualPrefix === expectedPrefix.toLowerCase();
    console.log("");
    console.log(`  call index check:      ${prefixOk ? "✓" : "✗"} ${actualPrefix} (expected ${expectedPrefix} for utility.batchAll)`);
    if (!prefixOk) {
      console.log("    ↑ runtime metadata may have moved utility.batchAll — do NOT submit until investigated.");
    }
  }

  console.log("");
  console.log("## Cross-check: inner EVM calldata embedded in SCALE blob");
  const embedChecks = verifyEvmCalldataEmbedded({ outerCallHex: payload.outerCallHex, innerCalls });
  embedChecks.forEach((c, i) => {
    console.log(`  [${i + 1}] ${c.embedded ? "✓ embedded" : "✗ MISSING"} — ${c.label}`);
  });
  const anyMissing = embedChecks.some((c) => !c.embedded);
  if (anyMissing) {
    console.log("    ↑ At least one inner EVM calldata is NOT present inside the SCALE call hex.");
    console.log("      The chain-free recipe and the on-chain encoding have drifted — do NOT submit.");
    process.exitCode = 4;
  } else {
    console.log("  → on-chain hash above corresponds to exactly the EVM calldata printed earlier.");
  }

  console.log("");
  console.log("## First-leg shortcut (paste-and-submit asMulti)");
  console.log(`  asMulti hex:           ${payload.asMultiHex}`);
  console.log("  Apps → Developer → Extrinsics → Decode tab → paste this → review → Submission.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`redeploy-escrowcore-wire-multisig failed: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
