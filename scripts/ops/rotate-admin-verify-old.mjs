#!/usr/bin/env node

/**
 * Verify that the SIGNER_PRIVATE_KEY in a dotenv file derives to the
 * leaked admin address. Used as a pre-check before the rotation drain
 * so we don't end up trying to use a non-matching key for the withdraw
 * and transfer.
 *
 * The key is loaded in-process via fs.readFileSync, hashed by ethers,
 * and only the derived address (or a match/mismatch result) is printed.
 *
 * Usage:
 *   node scripts/ops/rotate-admin-verify-old.mjs \
 *     --env-file /Users/pascalkuriger/repo/Polkadot/mcp-server/.env.local \
 *     --expect 0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519
 */

import { Wallet } from "ethers";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKeyFromEnvFile, isAddress, ciEqual } from "./rotate-admin-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { envKey: "SIGNER_PRIVATE_KEY" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--env-file") args.envFile = resolve(argv[++i]);
    else if (arg === "--env-key") args.envKey = argv[++i];
    else if (arg === "--expect") args.expect = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/ops/rotate-admin-verify-old.mjs --env-file PATH --expect 0xADDR",
      "",
      "Reads the private key (default name SIGNER_PRIVATE_KEY) from PATH in-process,",
      "derives its EVM address, and asserts it matches the --expect address.",
      "Prints addresses only; never echoes key material."
    ].join("\n")
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.envFile) {
    console.error("--env-file is required.");
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (!args.expect || !isAddress(args.expect)) {
    console.error("--expect ADDRESS (0x + 20 bytes) is required.");
    process.exitCode = 1;
    return;
  }

  let privateKey;
  try {
    privateKey = loadKeyFromEnvFile(args.envFile, args.envKey);
  } catch (error) {
    console.error(`--env-file load failed: ${error?.message ?? error}`);
    process.exitCode = 1;
    return;
  }

  const wallet = new Wallet(privateKey);
  const derived = wallet.address;

  console.log("# rotate-admin-verify-old");
  console.log(`env file:    ${args.envFile}`);
  console.log(`env key:     ${args.envKey}`);
  console.log(`expect:      ${args.expect}`);
  console.log(`derived:     ${derived}`);

  if (ciEqual(derived, args.expect)) {
    console.log("result:      ✅ match — key is the leaked admin EOA");
  } else {
    console.log("result:      ❌ mismatch");
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
