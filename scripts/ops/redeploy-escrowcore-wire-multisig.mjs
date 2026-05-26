#!/usr/bin/env node

/**
 * Emit the polkadot-js-apps multisig.asMulti recipe for wiring a freshly
 * redeployed EscrowCore as a TreasuryPolicy serviceOperator (and optionally
 * revoking the stale one in the same batch).
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
 *       revive.call(setServiceOperator(newEscrow, true)),   // approve new
 *       revive.call(setServiceOperator(oldEscrow, false))   // revoke old
 *     ]),
 *     maxWeight: { refTime, proofSize }
 *   )
 *
 *   This mirrors the swap-arbitrator-batch path in
 *   rotate-admin-multisig-payload.mjs — one Hot+Ledger round instead of two.
 *
 * Single-leg variant (pass --skip-revoke):
 *   multisig.asMulti(
 *     call: revive.call(setServiceOperator(newEscrow, true))
 *   )
 *
 *   Use only if you have a reason to leave the stale EscrowCore wired
 *   (e.g. extended cutover window). Not recommended.
 *
 * Usage
 * -----
 *   # First leg (Hot Wallet, no timepoint):
 *   node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \
 *     --new-escrow 0xNEW --signer hot
 *
 *   # Second leg (Ledger, with timepoint from first leg's
 *   # multisig.NewMultisig event):
 *   node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \
 *     --new-escrow 0xNEW --signer ledger \
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

const SIGNER_ALIASES = {
  vault: { label: "Polkadot Vault", ss58: "13pav6xpfdapyCAqfRhWZXxUnqDhjrF92dJr3FBwVfBKUKSM" },
  ledger: { label: "Ledger Account", ss58: "148tqwhGxeCva7ZX8RwvaLjCS7HvDJJaSbxfTUwE9Zyc5Xtm" },
  hot: { label: "Hot Wallet", ss58: "14ruuTeh5cXMTr9SLNuLt1NiroQZgt5ZQnwYrhg7K5LHiXQb" }
};

const TREASURY_POLICY_ABI = [
  "function setServiceOperator(address account, bool allowed)"
];

export function parseArgs(argv) {
  const args = { profile: "testnet", skipRevoke: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--new-escrow") args.newEscrow = argv[++i];
    else if (arg === "--old-escrow") args.oldEscrow = argv[++i];
    else if (arg === "--signer") args.signer = argv[++i];
    else if (arg === "--profile") args.profile = argv[++i];
    else if (arg === "--timepoint-height") args.tpHeight = argv[++i];
    else if (arg === "--timepoint-index") args.tpIndex = argv[++i];
    else if (arg === "--skip-revoke") args.skipRevoke = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \\",
      "         --new-escrow 0xADDR \\",
      "         --signer hot|ledger|vault \\",
      "         [--timepoint-height N --timepoint-index M] \\",
      "         [--old-escrow 0xADDR]   # defaults to current deployments/<profile>.json#contracts.escrowCore",
      "         [--skip-revoke]         # emit single-call recipe instead of batched",
      "         [--profile testnet]",
      "",
      "First leg (initiate): omit --timepoint-*; maybeTimepoint is None.",
      "Second leg (countersign): pass --timepoint-height and --timepoint-index",
      "  from the block / extrinsic where the first leg's multisig.NewMultisig event fired."
    ].join("\n")
  );
}

export function buildInnerCalls({ iface, newEscrow, oldEscrow, skipRevoke }) {
  const calls = [
    {
      label: `setServiceOperator(${newEscrow}, true)  // approve new EscrowCore`,
      data: iface.encodeFunctionData("setServiceOperator", [newEscrow, true])
    }
  ];
  if (!skipRevoke) {
    calls.push({
      label: `setServiceOperator(${oldEscrow}, false)  // revoke stale EscrowCore`,
      data: iface.encodeFunctionData("setServiceOperator", [oldEscrow, false])
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
  const iface = new Interface(TREASURY_POLICY_ABI);
  const innerCalls = buildInnerCalls({ iface, newEscrow, oldEscrow, skipRevoke: args.skipRevoke });
  const isBatch = innerCalls.length > 1;

  // Weight knobs — mirror rotate-admin-multisig-payload.mjs.
  const reviveRefTime = 4_000_000_000;
  const reviveProofSize = 100_000;
  const storageDepositLimit = 1_000_000_000;
  const maxWeightRefTime = isBatch ? 9_000_000_000 : 4_500_000_000;
  const maxWeightProofSize = isBatch ? 300_000 : 150_000;

  console.log("# redeploy-escrowcore-wire-multisig");
  console.log(`profile:                 ${args.profile}`);
  console.log(`new EscrowCore:          ${newEscrow}`);
  if (!args.skipRevoke) console.log(`old EscrowCore (revoke): ${oldEscrow}`);
  else console.log(`old EscrowCore:          ${oldEscrow}  (left wired; --skip-revoke set)`);
  console.log(`treasury policy (H160):  ${treasuryPolicy}`);
  console.log(`owner multisig (SS58):   ${ownerRecord.multisig.ss58Address}`);
  console.log(`owner multisig (H160):   ${ownerRecord.multisig.ownerEnvValue}`);
  console.log(`threshold:               ${ownerRecord.threshold}`);
  console.log(`signing as:              ${SIGNER_ALIASES[args.signer].label} (${me.address})`);
  console.log(`leg:                     ${timepoint ? `countersign (timepoint ${timepoint.height}/${timepoint.index})` : "initiate (timepoint None)"}`);
  console.log("");

  console.log("## Inner EVM calldata (TreasuryPolicy):");
  innerCalls.forEach((call, i) => {
    console.log(`  ${isBatch ? `[${i + 1}] ` : ""}call:    ${call.label}`);
    console.log(`  ${isBatch ? "    " : ""}data:    ${call.data}`);
    console.log(`  ${isBatch ? "    " : ""}length:  ${(call.data.length - 2) / 2} bytes`);
    if (i < innerCalls.length - 1) console.log("");
  });
  console.log("");

  console.log(`## Wrap as ${isBatch ? "utility.batchAll([revive.call, revive.call])" : "revive.call"}`);
  innerCalls.forEach((call, i) => {
    console.log(`  ${isBatch ? `[${i + 1}] ` : ""}revive.call:`);
    console.log(`    dest (H160):         ${treasuryPolicy}`);
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
    console.log("       calls: (add two revive.call entries)");
    innerCalls.forEach((call, i) => {
      console.log(`         [${i + 1}]: revive > call`);
      console.log(`              dest:      ${treasuryPolicy}`);
      console.log("              value:     0");
      console.log(`              gasLimit:  refTime ${reviveRefTime}, proofSize ${reviveProofSize}`);
      console.log(`              storageDepositLimit: ${storageDepositLimit}`);
      console.log(`              data:      ${call.data}`);
    });
  } else {
    console.log("       pallet:    revive");
    console.log("       function:  call");
    console.log(`       dest:      ${treasuryPolicy}`);
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
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`redeploy-escrowcore-wire-multisig failed: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
