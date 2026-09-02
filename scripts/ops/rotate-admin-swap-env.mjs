#!/usr/bin/env node

/**
 * Swap the SIGNER_PRIVATE_KEY value in a dotenv file with the new admin's
 * key, in-process. Verifies before touching the file:
 *   - the current value derives to the expected (leaked) admin
 *   - the new key file derives to the expected new admin
 *   - the two are different (refuses no-op or accidental copy)
 *
 * Writes atomically (tempfile + rename), preserves all other lines and
 * line endings, and prints addresses only — never echoes key material.
 *
 * Usage:
 *   node scripts/ops/rotate-admin-swap-env.mjs \
 *     --env-file /Users/pascalkuriger/repo/Polkadot/mcp-server/.env.local \
 *     --new-key-file .keys/new-admin-eoa.txt \
 *     --expected-old 0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519 \
 *     --expected-new 0x6778F050eAc8313e4dbB176d7BAB44510E833ac8 \
 *     [--commit]
 */

import { Wallet } from "ethers";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { loadKeyFromEnvFile, loadKeyFromKeysFile, isAddress, ciEqual } from "./rotate-admin-lib.mjs";

function parseArgs(argv) {
  const args = { dryRun: true, envKey: "SIGNER_PRIVATE_KEY" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--env-file") args.envFile = resolve(argv[++i]);
    else if (a === "--env-key") args.envKey = argv[++i];
    else if (a === "--new-key-file") args.newKeyFile = resolve(argv[++i]);
    else if (a === "--expected-old") args.expectedOld = argv[++i];
    else if (a === "--expected-new") args.expectedNew = argv[++i];
    else if (a === "--commit") args.dryRun = false;
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const k of ["envFile", "newKeyFile", "expectedOld", "expectedNew"]) {
    if (!args[k]) {
      console.error(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required.`);
      process.exitCode = 1;
      return;
    }
  }
  if (!isAddress(args.expectedOld) || !isAddress(args.expectedNew)) {
    console.error("--expected-old and --expected-new must be valid 0x addresses.");
    process.exitCode = 1;
    return;
  }
  if (ciEqual(args.expectedOld, args.expectedNew)) {
    console.error("--expected-old and --expected-new must differ.");
    process.exitCode = 1;
    return;
  }

  let oldKey, newKey;
  try {
    oldKey = loadKeyFromEnvFile(args.envFile, args.envKey);
  } catch (e) {
    console.error(`env-file load failed: ${e?.message ?? e}`);
    process.exitCode = 1;
    return;
  }
  try {
    newKey = loadKeyFromKeysFile(args.newKeyFile);
  } catch (e) {
    console.error(`new-key-file load failed: ${e?.message ?? e}`);
    process.exitCode = 1;
    return;
  }

  const oldAddr = new Wallet(oldKey).address;
  const newAddr = new Wallet(newKey).address;

  console.log("# rotate-admin-swap-env");
  console.log(`mode:         ${args.dryRun ? "dry-run" : "commit"}`);
  console.log(`env file:     ${args.envFile}`);
  console.log(`env key:      ${args.envKey}`);
  console.log(`expected old: ${args.expectedOld}`);
  console.log(`derived old:  ${oldAddr}`);
  console.log(`expected new: ${args.expectedNew}`);
  console.log(`derived new:  ${newAddr}`);
  console.log("");

  if (!ciEqual(oldAddr, args.expectedOld)) {
    console.error(`❌ env-file ${args.envKey} derives to ${oldAddr}, expected ${args.expectedOld}. Refusing to swap.`);
    process.exitCode = 2;
    return;
  }
  if (!ciEqual(newAddr, args.expectedNew)) {
    console.error(`❌ new-key-file derives to ${newAddr}, expected ${args.expectedNew}. Refusing to swap.`);
    process.exitCode = 2;
    return;
  }
  if (oldKey === newKey) {
    console.error("❌ old and new keys are identical. Refusing to swap.");
    process.exitCode = 2;
    return;
  }

  console.log("Both addresses derive as expected ✅");
  console.log("");

  // Load file, replace only the SIGNER_PRIVATE_KEY line, preserve others.
  const contents = readFileSync(args.envFile, "utf8");
  const re = new RegExp(`^(${args.envKey}=)(.+)$`, "m");
  const match = contents.match(re);
  if (!match) {
    console.error(`❌ Could not find ${args.envKey}= line in ${args.envFile}.`);
    process.exitCode = 2;
    return;
  }
  const next = contents.replace(re, `${args.envKey}=${newKey}`);
  if (next === contents) {
    console.error("❌ replace produced no change — unexpected.");
    process.exitCode = 2;
    return;
  }

  // Re-verify by re-parsing the new contents
  const reCheck = new RegExp(`^${args.envKey}=(.+)$`, "m");
  const m2 = next.match(reCheck);
  if (!m2 || new Wallet(m2[1].trim()).address.toLowerCase() !== newAddr.toLowerCase()) {
    console.error("❌ post-write re-derive does not match new admin. Aborting.");
    process.exitCode = 2;
    return;
  }

  console.log(`Planned change: SIGNER_PRIVATE_KEY line will be rewritten so it derives to ${newAddr}`);
  console.log(`Total file size: before=${contents.length} bytes, after=${next.length} bytes`);
  console.log("");

  if (args.dryRun) {
    console.log("Dry-run only. Re-run with --commit to write.");
    return;
  }

  // Atomic write
  const tmp = `${args.envFile}.tmp.${process.pid}`;
  writeFileSync(tmp, next, { mode: 0o600 });
  renameSync(tmp, args.envFile);

  // Final read-back verification
  const verify = loadKeyFromEnvFile(args.envFile, args.envKey);
  const verifyAddr = new Wallet(verify).address;
  if (!ciEqual(verifyAddr, args.expectedNew)) {
    console.error(`❌ Post-write read-back derives to ${verifyAddr}, expected ${args.expectedNew}.`);
    process.exitCode = 3;
    return;
  }

  console.log(`✅ Swap committed. ${args.envKey} in ${args.envFile} now derives to ${verifyAddr}.`);
  console.log("");
  console.log("Reminder: restart any process that reads this file (mcp-server, backend, etc.)");
  console.log("so it picks up the new key.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
