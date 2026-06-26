#!/usr/bin/env node

/**
 * Emit the polkadot-js-apps multisig.asMulti recipe for wiring a freshly
 * redeployed EscrowCore as both an AgentAccountCore escrow operator and a
 * TreasuryPolicy serviceOperator (and optionally revoking the stale one in
 * the same batch). When AgentAccountCore is redeployed too, pass
 * --new-agent-account so the same batch also approves the fresh AAC as a
 * TreasuryPolicy serviceOperator and targets setEscrowOperator on that
 * fresh AAC.
 *
 * Why a recipe and not an EVM commit:
 *   TreasuryPolicy.owner() is the H160 mapping of the SS58 2-of-3 multisig
 *   12nHTKYfV64pnxsVRB6Cjn6kQPPH64Ehnr8zgqZxvfa8hJvQ. There is no private
 *   key for it — role mutations must go through pallet_multisig.asMulti.
 *
 * Default flow (batched, one multisig round):
 *   multisig.asMulti(
 *     threshold: 2,
 *     otherSignatories: [other two signers in AccountId32 byte order],
 *     maybeTimepoint: <None for first leg, Some({height,index}) for second>,
 *     call: utility.batchAll([
 *       revive.call(TreasuryPolicy.setServiceOperator(newAgentAccount, true)), // only with --new-agent-account
 *       revive.call(NewAgentAccountCore.setEscrowOperator(newEscrow, true)),
 *       revive.call(TreasuryPolicy.setServiceOperator(newEscrow, true)),
 *       revive.call(OldAgentAccountCore.setEscrowOperator(oldEscrow, false)),
 *       revive.call(TreasuryPolicy.setServiceOperator(oldEscrow, false))
 *     ]),
 *     maxWeight: { refTime, proofSize }
 *   )
 *
 *   This mirrors the swap-arbitrator-batch path in
 *   rotate-admin-multisig-payload.mjs — one Hot+Ledger round instead of two.
 *
 * Single-leg variant (pass --skip-revoke):
 *   multisig.asMulti(
 *     call: utility.batchAll([
 *       revive.call(AgentAccountCore.setEscrowOperator(newEscrow, true)),
 *       revive.call(TreasuryPolicy.setServiceOperator(newEscrow, true))
 *     ])
 *   )
 *
 *   Use only if you have a reason to leave the stale EscrowCore wired
 *   (e.g. extended cutover window). Not recommended.
 *
 * Usage
 * -----
 *   # First leg (Hot Wallet, no timepoint):
 *   node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \
 *     --new-escrow 0xNEW --new-agent-account 0xNEW_AAC --signer hot
 *
 *   # Second leg (Ledger, with timepoint from first leg's
 *   # multisig.NewMultisig event):
 *   node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \
 *     --new-escrow 0xNEW --new-agent-account 0xNEW_AAC --signer ledger \
 *     --timepoint-height H --timepoint-index I
 *
 * This script does not touch Substrate keys. The actual signing happens
 * in polkadot-js-apps via the browser extension / Ledger.
 */

import { Interface, getAddress } from "ethers";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeployments, isAddress } from "./rotate-admin-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const DEFAULT_WS = "wss://sys.ibp.network/asset-hub-paseo";

// Asset Hub Paseo runtime: pallet_utility is index 0x28, batchAll is call 0x02.
// Every successful encoding of utility.batchAll([...]) starts with these two
// bytes. The on-chain hex test pins this so a runtime reshuffle gets caught.
export const UTILITY_BATCH_ALL_CALL_INDEX = "0x2802";

const SIGNER_ALIASES = {
  vault: { label: "Polkadot Vault", ss58: "13pav6xpfdapyCAqfRhWZXxUnqDhjrF92dJr3FBwVfBKUKSM" },
  ledger: { label: "Ledger Account", ss58: "148tqwhGxeCva7ZX8RwvaLjCS7HvDJJaSbxfTUwE9Zyc5Xtm" },
  hot: { label: "Hot Wallet", ss58: "14ruuTeh5cXMTr9SLNuLt1NiroQZgt5ZQnwYrhg7K5LHiXQb" }
};

const TREASURY_POLICY_ABI = [
  "function setServiceOperator(address account, bool allowed)"
];

const AGENT_ACCOUNT_ABI = [
  "function setEscrowOperator(address escrowOperator, bool approved)"
];

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

export function resolveWs(args) {
  if (args.noWs) return null;
  if (args.ws) return args.ws;
  const envWs = String(process.env.PASEO_AH_WS ?? "").trim();
  return envWs || DEFAULT_WS;
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
      "         --signer hot|ledger|vault \\",
      "         [--timepoint-height N --timepoint-index M] \\",
      "         [--new-agent-account 0xADDR] # when AAC is redeployed too",
      "         [--old-agent-account 0xADDR] # defaults to current deployments/<profile>.json#contracts.agentAccountCore",
      "         [--old-escrow 0xADDR]   # defaults to current deployments/<profile>.json#contracts.escrowCore",
      "         [--skip-revoke]         # emit single-call recipe instead of batched",
      "         [--profile testnet] \\",
      `         [--ws WSS_URL]          # default ${DEFAULT_WS}; env PASEO_AH_WS overrides`,
      "         [--no-ws]               # skip on-chain hex emission; chain-free recipe only",
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
  skipRevoke,
  newAgentAccount,
  oldAgentAccount
}) {
  const activeAgentAccount = newAgentAccount ?? agentAccount;
  const staleAgentAccount = oldAgentAccount ?? agentAccount;
  const calls = [];
  if (newAgentAccount) {
    calls.push({
      label: `TreasuryPolicy.setServiceOperator(${newAgentAccount}, true)  // approve new AgentAccountCore accounting authority`,
      to: treasuryPolicy,
      data: policyIface.encodeFunctionData("setServiceOperator", [newAgentAccount, true])
    });
  }
  calls.push(
    {
      label: `AgentAccountCore.setEscrowOperator(${newEscrow}, true)  // approve new EscrowCore ledger authority`,
      to: activeAgentAccount,
      data: accountIface.encodeFunctionData("setEscrowOperator", [newEscrow, true])
    },
    {
      label: `TreasuryPolicy.setServiceOperator(${newEscrow}, true)  // approve new EscrowCore policy authority`,
      to: treasuryPolicy,
      data: policyIface.encodeFunctionData("setServiceOperator", [newEscrow, true])
    }
  );
  if (!skipRevoke) {
    calls.push({
      label: `AgentAccountCore.setEscrowOperator(${oldEscrow}, false)  // revoke stale EscrowCore ledger authority`,
      to: staleAgentAccount,
      data: accountIface.encodeFunctionData("setEscrowOperator", [oldEscrow, false])
    });
    calls.push({
      label: `TreasuryPolicy.setServiceOperator(${oldEscrow}, false)  // revoke stale EscrowCore policy authority`,
      to: treasuryPolicy,
      data: policyIface.encodeFunctionData("setServiceOperator", [oldEscrow, false])
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
  if (!args.signer || !SIGNER_ALIASES[args.signer]) {
    console.error(`--signer must be one of: ${Object.keys(SIGNER_ALIASES).join(", ")}`);
    process.exitCode = 1;
    return;
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

  if (newEscrow.toLowerCase() === oldEscrow.toLowerCase()) {
    console.error(`--new-escrow and --old-escrow are the same address (${newEscrow}); refusing to emit a no-op recipe.`);
    process.exitCode = 1;
    return;
  }

  // Pick signer + sorted otherSignatories (canonical AccountId32 byte order).
  const signersSorted = [...ownerRecord.signatories].sort((a, b) =>
    a.accountId32.localeCompare(b.accountId32)
  );
  const me = signersSorted.find((s) => s.address === SIGNER_ALIASES[args.signer].ss58);
  if (!me) {
    console.error(
      `--signer ${args.signer} (${SIGNER_ALIASES[args.signer].ss58}) is not in deployments/${args.profile}-multisig-owner.json signatories.`
    );
    process.exitCode = 2;
    return;
  }
  const otherSignatories = signersSorted
    .filter((s) => s.accountId32 !== me.accountId32)
    .map((s) => s.address);

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
    skipRevoke: args.skipRevoke,
    newAgentAccount: args.newAgentAccount ? agentAccount : undefined,
    oldAgentAccount
  });
  const isBatch = innerCalls.length > 1;

  // Weight knobs — mirror rotate-admin-multisig-payload.mjs.
  const reviveRefTime = 4_000_000_000;
  const reviveProofSize = 100_000;
  const storageDepositLimit = 1_000_000_000;
  const maxWeightRefTime = 4_500_000_000 * innerCalls.length;
  const maxWeightProofSize = 150_000 * innerCalls.length;

  console.log("# redeploy-escrowcore-wire-multisig");
  console.log(`profile:                 ${args.profile}`);
  console.log(`new EscrowCore:          ${newEscrow}`);
  if (args.newAgentAccount) console.log(`new AgentAccountCore:    ${agentAccount}`);
  if (!args.skipRevoke) console.log(`old EscrowCore (revoke): ${oldEscrow}`);
  else console.log(`old EscrowCore:          ${oldEscrow}  (left wired; --skip-revoke set)`);
  if (args.newAgentAccount) console.log(`old AgentAccountCore:    ${oldAgentAccount}  (old escrow revoke target)`);
  console.log(`treasury policy (H160):  ${treasuryPolicy}`);
  console.log(`agent account (H160):    ${agentAccount}`);
  console.log(`owner multisig (SS58):   ${ownerRecord.multisig.ss58Address}`);
  console.log(`owner multisig (H160):   ${ownerRecord.multisig.ownerEnvValue}`);
  console.log(`threshold:               ${ownerRecord.threshold}`);
  console.log(`signing as:              ${SIGNER_ALIASES[args.signer].label} (${me.address})`);
  console.log(`leg:                     ${timepoint ? `countersign (timepoint ${timepoint.height}/${timepoint.index})` : "initiate (timepoint None)"}`);
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
  console.log("  1. Open https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Fasset-hub-paseo-rpc.dwellir.com#/extrinsics");
  console.log(`  2. Selected account: ${SIGNER_ALIASES[args.signer].label} (${me.address})`);
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
    console.log("     Re-run this script with --signer ledger --timepoint-height <H> --timepoint-index <I>");
    console.log("     to generate the Ledger countersign recipe.");
  } else {
    console.log(" 10. Find the resulting `multisig.MultisigExecuted` event; record the call hash + block.");
    console.log("     Then run:");
    console.log("       node scripts/ops/redeploy-escrowcore.mjs --phase finalize \\");
    console.log(`         --new-escrow ${newEscrow} \\`);
    console.log("         --deploy-tx 0xDEPLOY_TX --multisig-exec-tx 0xEXEC_TX --commit");
  }

  // ----- On-chain hex emission (optional, requires Paseo AH WS reachability) -----
  const wsUrl = resolveWs(args);
  if (!wsUrl) {
    console.log("");
    console.log("## Inner call hex");
    console.log("  --no-ws was passed; on-chain SCALE encoding skipped.");
    console.log("  The chain-free recipe above is sufficient to construct the call in Apps.");
    return;
  }

  console.log("");
  console.log(`## Connecting to ${wsUrl} to SCALE-encode the inner call…`);
  let api;
  let blake2AsHex;
  try {
    const [{ ApiPromise, WsProvider }, utilCrypto] = await Promise.all([
      import("@polkadot/api"),
      import("@polkadot/util-crypto")
    ]);
    blake2AsHex = utilCrypto.blake2AsHex;
    const provider = new WsProvider(wsUrl);
    api = await ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
  } catch (error) {
    console.log("");
    console.log("## Inner call hex");
    console.log(`  WS connect to ${wsUrl} failed: ${error?.message ?? error}`);
    console.log("  Falling back to chain-free recipe above. To skip this attempt, pass --no-ws.");
    console.log("  To retry with a different endpoint: --ws wss://... or PASEO_AH_WS=wss://...");
    if (api) {
      try { await api.disconnect(); } catch { /* best effort */ }
    }
    return;
  }

  try {
    const payload = await buildOnchainPayload({
      api,
      blake2AsHex,
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
  } finally {
    try { await api.disconnect(); } catch { /* best effort */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`redeploy-escrowcore-wire-multisig failed: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
