#!/usr/bin/env node

/**
 * Emit the polkadot-js-apps multisig.asMulti recipe for one of two
 * possible admin rotations on TreasuryPolicy:
 *
 *   --role set-pauser
 *     multisig.asMulti(revive.call(setPauser(newAdmin)))
 *
 *   --role swap-arbitrator-batch
 *     multisig.asMulti(
 *       utility.batchAll([
 *         revive.call(setArbitrator(newAdmin, true)),
 *         revive.call(setArbitrator(oldAdmin, false))
 *       ])
 *     )
 *
 *   Because TreasuryPolicy.arbitrators is a mapping (not a single slot),
 *   a true rotation requires both an approve and a revoke. Batching keeps
 *   the rotation atomic and avoids a 4-of-4 signing round.
 *
 * The flow is canonical: TreasuryPolicy's owner is the 2-of-3 multisig
 * (SS58 12nHTKYf…), so role mutations must go through
 *   multisig.asMulti(
 *     threshold=2,
 *     otherSignatories=[other two signers in canonical AccountId32 byte order],
 *     maybeTimepoint=<None for first signer, {height,index} for second>,
 *     call=<revive.call | utility.batchAll([revive.call, revive.call])>,
 *     maxWeight=<refTime/proofSize covering the entire inner call tree>
 *   )
 *
 * This script computes the inner EVM calldata (selectors + abi-encoded
 * args), picks the canonical otherSignatories list, and prints a
 * polkadot-js-apps recipe. It does not touch Substrate keys; the actual
 * signing happens in the browser extension via Apps.
 *
 * Usage
 * -----
 *   node scripts/ops/rotate-admin-multisig-payload.mjs \
 *     --role set-pauser \
 *     --new-admin 0x6778F050eAc8313e4dbB176d7BAB44510E833ac8 \
 *     --signer hot   # hot|ledger|vault (the one signing this leg)
 *     [--timepoint-height N --timepoint-index M]  # required when --signer is the second
 *
 *   node scripts/ops/rotate-admin-multisig-payload.mjs \
 *     --role swap-arbitrator-batch \
 *     --new-admin 0x6778F050eAc8313e4dbB176d7BAB44510E833ac8 \
 *     --old-admin 0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519 \
 *     --signer hot
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
  "function setPauser(address newPauser)",
  "function setArbitrator(address arbitrator, bool approved)"
];

function parseArgs(argv) {
  const args = { profile: "testnet" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--role") args.role = argv[++i];
    else if (arg === "--new-admin") args.newAdmin = argv[++i];
    else if (arg === "--old-admin") args.oldAdmin = argv[++i];
    else if (arg === "--signer") args.signer = argv[++i];
    else if (arg === "--profile") args.profile = argv[++i];
    else if (arg === "--timepoint-height") args.tpHeight = argv[++i];
    else if (arg === "--timepoint-index") args.tpIndex = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/ops/rotate-admin-multisig-payload.mjs \\",
      "         --role set-pauser|swap-arbitrator-batch \\",
      "         --new-admin 0xADDR [--old-admin 0xADDR] \\",
      "         --signer hot|ledger|vault \\",
      "         [--timepoint-height N --timepoint-index M]",
      "",
      "Roles:",
      "  set-pauser              single multisig.asMulti(revive.call(setPauser(newAdmin))).",
      "  swap-arbitrator-batch   multisig.asMulti(utility.batchAll([approve new, revoke old])).",
      "                          Requires --old-admin in addition to --new-admin.",
      "",
      "First leg (hot signer): omit --timepoint-*; maybeTimepoint is None.",
      "Second leg (ledger signer): pass --timepoint-height and --timepoint-index",
      "  from the block / extrinsic where the first leg's MultisigNew event fired."
    ].join("\n")
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.role || !["set-pauser", "swap-arbitrator-batch"].includes(args.role)) {
    console.error("--role set-pauser|swap-arbitrator-batch is required.");
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (!args.newAdmin || !isAddress(args.newAdmin)) {
    console.error("--new-admin 0xADDRESS is required.");
    process.exitCode = 1;
    return;
  }
  const newAdmin = getAddress(args.newAdmin);
  let oldAdmin = null;
  if (args.role === "swap-arbitrator-batch") {
    if (!args.oldAdmin || !isAddress(args.oldAdmin)) {
      console.error("--old-admin 0xADDRESS is required for swap-arbitrator-batch.");
      process.exitCode = 1;
      return;
    }
    oldAdmin = getAddress(args.oldAdmin);
  }
  if (!args.signer || !SIGNER_ALIASES[args.signer]) {
    console.error(`--signer must be one of: ${Object.keys(SIGNER_ALIASES).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // --- Inner EVM calldata ----------------------------------------------------
  const iface = new Interface(TREASURY_POLICY_ABI);
  const innerCalls = [];
  if (args.role === "set-pauser") {
    innerCalls.push({
      label: `setPauser(${newAdmin})`,
      data: iface.encodeFunctionData("setPauser", [newAdmin])
    });
  } else {
    innerCalls.push({
      label: `setArbitrator(${newAdmin}, true)  // approve new arbitrator`,
      data: iface.encodeFunctionData("setArbitrator", [newAdmin, true])
    });
    innerCalls.push({
      label: `setArbitrator(${oldAdmin}, false)  // revoke old arbitrator`,
      data: iface.encodeFunctionData("setArbitrator", [oldAdmin, false])
    });
  }

  // --- Deployments + signers -------------------------------------------------
  const { deployments } = await loadDeployments(repoRoot, args.profile);
  const multisigOwnerPath = resolve(repoRoot, "deployments", "testnet-multisig-owner.json");
  const ownerRecord = JSON.parse(await readFile(multisigOwnerPath, "utf8"));

  const signersSorted = [...ownerRecord.signatories].sort((a, b) =>
    a.accountId32.localeCompare(b.accountId32)
  );
  const me = signersSorted.find((s) => s.address === SIGNER_ALIASES[args.signer].ss58);
  if (!me) {
    console.error(
      `--signer ${args.signer} (${SIGNER_ALIASES[args.signer].ss58}) is not in deployments/testnet-multisig-owner.json signatories.`
    );
    process.exitCode = 2;
    return;
  }
  const otherSignatories = signersSorted
    .filter((s) => s.accountId32 !== me.accountId32)
    .map((s) => s.address);

  // --- Timepoint -------------------------------------------------------------
  let timepoint = null;
  if (args.tpHeight !== undefined || args.tpIndex !== undefined) {
    if (args.tpHeight === undefined || args.tpIndex === undefined) {
      console.error("Both --timepoint-height and --timepoint-index must be given together.");
      process.exitCode = 1;
      return;
    }
    timepoint = { height: Number(args.tpHeight), index: Number(args.tpIndex) };
  }

  const treasuryPolicy = deployments.contracts.treasuryPolicy;
  const multisigAddress = ownerRecord.multisig.ss58Address;

  const isBatch = args.role === "swap-arbitrator-batch";
  const reviveRefTime = 4_000_000_000;
  const reviveProofSize = 100_000;
  const storageDepositLimit = 1_000_000_000;
  // maxWeight covers the inner call tree; scale roughly linearly with batch size,
  // plus a safety overhead. Per-revive weight is the cap on each EVM call.
  const maxWeightRefTime = isBatch ? 9_000_000_000 : 4_500_000_000;
  const maxWeightProofSize = isBatch ? 300_000 : 150_000;

  console.log("# rotate-admin-multisig-payload");
  console.log(`profile:                 ${args.profile}`);
  console.log(`role:                    ${args.role}`);
  console.log(`new admin:               ${newAdmin}`);
  if (oldAdmin) console.log(`old admin (to revoke):   ${oldAdmin}`);
  console.log(`treasury policy (H160):  ${treasuryPolicy}`);
  console.log(`owner multisig (SS58):   ${multisigAddress}`);
  console.log(`threshold:               ${ownerRecord.threshold}`);
  console.log(`signing as:              ${SIGNER_ALIASES[args.signer].label} (${me.address})`);
  console.log(`leg:                     ${timepoint ? `countersign (timepoint ${timepoint.height}/${timepoint.index})` : "initiate (timepoint None)"}`);
  console.log("");

  console.log("## Inner EVM calldata (TreasuryPolicy):");
  innerCalls.forEach((call, i) => {
    console.log(`  ${innerCalls.length > 1 ? `[${i + 1}] ` : ""}call:    ${call.label}`);
    console.log(`  ${innerCalls.length > 1 ? "    " : ""}data:    ${call.data}`);
    console.log(`  ${innerCalls.length > 1 ? "    " : ""}length:  ${(call.data.length - 2) / 2} bytes`);
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
  console.log("    threshold:           2");
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
  console.log("     — sign via browser extension (polkadot{.js}, Talisman, SubWallet).");
  console.log("  3. submit extrinsic: multisig > asMulti(threshold, otherSignatories, maybeTimepoint, call, maxWeight)");
  console.log("  4. threshold: 2");
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
  console.log("  9. Submit Transaction → sign with browser extension.");
  if (!timepoint) {
    console.log(" 10. Find the resulting `multisig.NewMultisig` event; record the block height + extrinsic index.");
    console.log("     Pass them back: --timepoint-height <H> --timepoint-index <I> for the Ledger countersign leg.");
  } else {
    console.log(" 10. Find the resulting `multisig.MultisigExecuted` event; record the call hash + block.");
    console.log("     That's the proof the role moved on chain.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`rotate-admin-multisig-payload failed: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
