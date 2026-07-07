#!/usr/bin/env node

/**
 * Build the SCALE-encoded utility.batchAll([revive.call, revive.call])
 * for the batched arbitrator swap (Step 4), and the asMulti wrapper for
 * the first leg.
 *
 * Outputs:
 *  - inner batchAll call data hex (paste into Multisig "call data for
 *    final approval" on the second-leg approval)
 *  - inner batchAll call hash (the multisig storage key, also what
 *    NewMultisig event reports)
 *  - full asMulti call data hex (paste in Apps Decode tab to verify
 *    before submitting first leg)
 *
 * Does not sign anything. Connects to a Paseo Asset Hub RPC to load
 * the canonical runtime metadata (so pallet/call indexes are correct
 * for the deployed runtime, not guessed).
 */

import { ApiPromise, WsProvider } from "@polkadot/api";
import { blake2AsHex } from "@polkadot/util-crypto";
import { Interface } from "ethers";

const WS = process.env.PASEO_AH_WS || "wss://asset-hub-paseo-rpc.dwellir.com";

const TREASURY_POLICY = "0xE0b8170137f03F90d681451a97C68A9EAf85e4A7";
const NEW_ADMIN = "0x6778F050eAc8313e4dbB176d7BAB44510E833ac8";
const OLD_ADMIN = "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519";

const MULTISIG_SIGNERS_SORTED = [
  // canonical AccountId32 byte order: Vault < Ledger < Hot
  "13pav6xpfdapyCAqfRhWZXxUnqDhjrF92dJr3FBwVfBKUKSM", // Vault
  "148tqwhGxeCva7ZX8RwvaLjCS7HvDJJaSbxfTUwE9Zyc5Xtm", // Ledger
  "14ruuTeh5cXMTr9SLNuLt1NiroQZgt5ZQnwYrhg7K5LHiXQb"  // Hot Wallet
];
const HOT_WALLET = "14ruuTeh5cXMTr9SLNuLt1NiroQZgt5ZQnwYrhg7K5LHiXQb";
const LEDGER = "148tqwhGxeCva7ZX8RwvaLjCS7HvDJJaSbxfTUwE9Zyc5Xtm";
const VAULT = "13pav6xpfdapyCAqfRhWZXxUnqDhjrF92dJr3FBwVfBKUKSM";

const REVIVE_GAS_LIMIT = { refTime: 4_000_000_000n, proofSize: 100_000n };
const STORAGE_DEPOSIT_LIMIT = 1_000_000_000n;
const MAX_WEIGHT_BATCHED = { refTime: 9_000_000_000n, proofSize: 300_000n };

const TREASURY_POLICY_ABI = [
  "function setArbitrator(address arbitrator, bool approved)"
];

function parseArgs(argv) {
  const args = { signer: "hot" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--signer") args.signer = argv[++i];
    else if (argv[i] === "--ws") args.ws = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wsUrl = args.ws || WS;

  console.log("# rotate-admin-build-batch");
  console.log(`ws:              ${wsUrl}`);

  const provider = new WsProvider(wsUrl);
  const api = await ApiPromise.create({ provider });

  // Compute inner EVM calldata
  const iface = new Interface(TREASURY_POLICY_ABI);
  const approveCalldata = iface.encodeFunctionData("setArbitrator", [NEW_ADMIN, true]);
  const revokeCalldata = iface.encodeFunctionData("setArbitrator", [OLD_ADMIN, false]);

  console.log("");
  console.log("inner [1]: setArbitrator(newAdmin, true)");
  console.log(`  calldata: ${approveCalldata}`);
  console.log("inner [2]: setArbitrator(oldAdmin, false)");
  console.log(`  calldata: ${revokeCalldata}`);

  // Build revive.call extrinsics
  const reviveCall1 = api.tx.revive.call(
    TREASURY_POLICY,
    0,
    REVIVE_GAS_LIMIT,
    STORAGE_DEPOSIT_LIMIT,
    approveCalldata
  );
  const reviveCall2 = api.tx.revive.call(
    TREASURY_POLICY,
    0,
    REVIVE_GAS_LIMIT,
    STORAGE_DEPOSIT_LIMIT,
    revokeCalldata
  );

  console.log("");
  console.log(`revive.call[1] encoded: ${reviveCall1.method.toHex()}`);
  console.log(`revive.call[2] encoded: ${reviveCall2.method.toHex()}`);

  // Wrap in utility.batchAll
  const batchAll = api.tx.utility.batchAll([reviveCall1, reviveCall2]);
  const batchAllCallHex = batchAll.method.toHex();
  const batchAllCallHash = blake2AsHex(batchAll.method.toU8a(), 256);

  console.log("");
  console.log("## INNER CALL (utility.batchAll) — paste this as 'call data for final approval'");
  console.log(`  call hex:  ${batchAllCallHex}`);
  console.log(`  length:    ${(batchAllCallHex.length - 2) / 2} bytes`);
  console.log(`  call hash: ${batchAllCallHash}    ← will appear as NewMultisig event call_hash`);

  // Build asMulti wrapper for the first leg
  const signerSs58 = args.signer === "hot" ? HOT_WALLET : args.signer === "ledger" ? LEDGER : VAULT;
  const otherSignatories = MULTISIG_SIGNERS_SORTED.filter((a) => a !== signerSs58);

  const asMulti = api.tx.multisig.asMulti(
    2,
    otherSignatories,
    null, // maybeTimepoint=None for first leg
    batchAll,
    MAX_WEIGHT_BATCHED
  );

  console.log("");
  console.log(`## FIRST-LEG asMulti (signer = ${args.signer})`);
  console.log(`  otherSignatories: ${otherSignatories.join(", ")}`);
  console.log(`  asMulti call hex: ${asMulti.method.toHex()}`);
  console.log("  (paste into Apps 'Decode' tab to inspect, or construct field-by-field in Extrinsics)");

  console.log("");
  console.log("## polkadot-js-apps recipe (first leg)");
  console.log("  Option A — paste-and-submit:");
  console.log("    1. Apps → Developer → Extrinsics → Decode tab");
  console.log(`    2. Paste: ${asMulti.method.toHex()}`);
  console.log("    3. Verify fields match expectations, then click 'Submission'");
  console.log(`    4. Select signer: ${args.signer === "hot" ? "Hot Wallet" : args.signer === "ledger" ? "Ledger Account" : "Polkadot Vault"}`);
  console.log("    5. Submit Transaction → sign with browser extension.");
  console.log("");
  console.log("  Option B — construct in Extrinsics tab:");
  console.log("    multisig.asMulti(");
  console.log("      threshold: 2,");
  console.log(`      otherSignatories: [${otherSignatories.join(", ")}],`);
  console.log("      maybeTimepoint: None,");
  console.log("      call: utility.batchAll([revive.call(new,true), revive.call(old,false)]),");
  console.log(`      maxWeight: { refTime: ${MAX_WEIGHT_BATCHED.refTime}, proofSize: ${MAX_WEIGHT_BATCHED.proofSize} }`);
  console.log("    )");

  console.log("");
  console.log("## After first-leg submission, the second-leg signer uses Apps' Multisig tab:");
  console.log(`  pending call hash to approve: ${batchAllCallHash}`);
  console.log(`  call data for final approval: ${batchAllCallHex}`);
  console.log("  toggle 'multisig message with call' ON");

  await api.disconnect();
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
