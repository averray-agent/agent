#!/usr/bin/env node

/**
 * Generate a fresh admin EOA secp256k1 key for the rotation.
 *
 * The private key is written to a single-purpose file under `.keys/`
 * (gitignored, mode 0600) — the operator moves it into 1Password at
 * `op://prod-critical/admin-eoa-testnet/private-key` and deletes the file.
 *
 * Only the derived address is printed. The key never leaves the Node
 * process for stdout, stderr, or process env.
 *
 * Refuses to overwrite an existing key file (preserves prior generation
 * for evidence/rollback). If you want a different key, delete the file
 * yourself after confirming you have not used it.
 *
 * Usage:
 *   node scripts/ops/rotate-admin-generate-key.mjs            # writes .keys/new-admin-eoa.txt
 *   node scripts/ops/rotate-admin-generate-key.mjs --out PATH # custom path
 */

import { Wallet } from "ethers";
import { existsSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const DEFAULT_OUT = resolve(repoRoot, ".keys", "new-admin-eoa.txt");

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") args.out = resolve(argv[++i]);
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/ops/rotate-admin-generate-key.mjs [--out PATH]",
      "",
      "Writes a fresh secp256k1 private key to PATH (default .keys/new-admin-eoa.txt)",
      "with mode 0600. Prints the derived address only. Refuses to overwrite an",
      "existing file."
    ].join("\n")
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (existsSync(args.out)) {
    console.error(
      `Refusing to overwrite ${args.out}.\n` +
        `Delete it yourself once you have confirmed the key it holds is not in use.`
    );
    process.exitCode = 1;
    return;
  }

  const dir = dirname(args.out);
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // not fatal — best effort; the file mode itself is the real safety net
  }

  const wallet = Wallet.createRandom();
  writeFileSync(args.out, `${wallet.privateKey}\n`, { mode: 0o600, flag: "wx" });
  try {
    chmodSync(args.out, 0o600);
  } catch {}

  console.log("# rotate-admin-generate-key");
  console.log(`address:    ${wallet.address}`);
  console.log(`written to: ${args.out}  (mode 0600)`);
  console.log("");
  console.log("Next steps for the operator:");
  console.log("  1. Save the key to 1Password:");
  console.log("       op signin");
  console.log("       op item create --vault prod-critical --category 'API Credential' \\");
  console.log("         --title 'admin-eoa-testnet' \\");
  console.log(`         'private key[concealed]=$(cat ${args.out})' \\`);
  console.log(`         'address[text]=${wallet.address}' \\`);
  console.log("         'chain[text]=Paseo Asset Hub TestNet (chainId 420420417)' \\");
  console.log("         'notes[text]=Rotated 2026-05-25 after leaked-key incident; replaces 0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519.'");
  console.log("  2. Verify the 1Password write:");
  console.log("       op read 'op://prod-critical/admin-eoa-testnet/address'");
  console.log(`       # expect: ${wallet.address}`);
  console.log("  3. Delete the temp file:");
  console.log(`       rm ${args.out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
