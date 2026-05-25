/**
 * Shared helpers for the admin EOA rotation scripts.
 *
 * The leaked-key constraint is: never echo private key material to stdout,
 * stderr, or process env. All keys flow through Node fs reads / writes into
 * an ethers `Wallet` object and back out as a derived address only.
 *
 * Mirrors the in-process loader pattern of `admin-topup-kms-signer.mjs`
 * (commit 07ca5a4 on branch claude/kms-signer-topup) so a future audit can
 * trace the safety story to one canonical helper.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PRIVATE_KEY_RE = /^0x[a-fA-F0-9]{64}$/u;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;

export function isPrivateKeyHex(value) {
  return typeof value === "string" && PRIVATE_KEY_RE.test(value);
}

export function isAddress(value) {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

export function loadKeyFromEnvFile(filePath, envKey = "SIGNER_PRIVATE_KEY") {
  const contents = readFileSync(filePath, "utf8");
  const re = new RegExp(`^${envKey}=(.+)$`, "m");
  const match = contents.match(re);
  if (!match) throw new Error(`${envKey} not found in ${filePath}`);
  let raw = match[1].trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
  }
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!PRIVATE_KEY_RE.test(hex)) {
    throw new Error(
      `Key in ${filePath} (${envKey}) is not a valid 32-byte hex private key`
    );
  }
  return hex;
}

export function loadKeyFromKeysFile(filePath) {
  const contents = readFileSync(filePath, "utf8").trim();
  const hex = contents.startsWith("0x") ? contents : `0x${contents}`;
  if (!PRIVATE_KEY_RE.test(hex)) {
    throw new Error(`File ${filePath} does not contain a valid 32-byte hex private key`);
  }
  return hex;
}

export async function loadDeployments(repoRoot, profile = "testnet") {
  const deploymentsPath = resolve(repoRoot, "deployments", `${profile}.json`);
  const text = await readFile(deploymentsPath, "utf8");
  return { deployments: JSON.parse(text), deploymentsPath };
}

export function formatUsdc(baseUnits) {
  const big = BigInt(baseUnits);
  const whole = big / 1_000_000n;
  const fraction = big % 1_000_000n;
  const fractionText = fraction.toString().padStart(6, "0").replace(/0+$/u, "");
  return fractionText ? `${whole}.${fractionText}` : whole.toString();
}

export function ciEqual(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}
