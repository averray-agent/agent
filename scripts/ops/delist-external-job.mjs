#!/usr/bin/env node
/**
 * Delist an externally-posted job from the catalogue projection.
 *
 * WHAT THIS DOES NOT DO
 * It does NOT touch on-chain escrow. The poster's reserved funding stays reserved
 * in EscrowCore exactly as before. This only removes the catalogue projection so
 * workers stop seeing the listing. Recovering reserved funds is a separate,
 * operator-mediated ~7-day rescue — see posterFacts.withdrawal on
 * GET /poster/onboarding.
 *
 * WHY A SCRIPT
 * There is no delist control in the operator app, and the hosted-smoke helper
 * (get-admin-refresh-token.mjs) consumes a ONE-TIME rotating refresh token that
 * self-rotates for CI — spending it on a manual delist risks desyncing that
 * chain. This signs in directly instead and leaves the smoke credential alone.
 *
 * SAFETY
 *   - The admin key is read by 1Password reference and never printed. A raw key
 *     cannot be passed in, even by accident.
 *   - Dry-run by default. It shows the listing it would remove and stops.
 *   - The admin session is used for exactly one request and never written down.
 *
 * USAGE
 *   ADMIN_KEY_OP="op://vault/item/private key" \
 *     node scripts/ops/delist-external-job.mjs --job-id 0x… [--commit]
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Wallet } from "ethers";

const execFileAsync = promisify(execFile);
const API = (process.env.API_URL ?? "https://api.averray.com").replace(/\/+$/, "");

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    const next = argv[index + 1];
    flags[key] = next && !next.startsWith("--") ? (index += 1, next) : true;
  }
  return flags;
}

async function loadWallet() {
  const ref = String(process.env.ADMIN_KEY_OP ?? "").trim();
  if (!ref.startsWith("op://")) {
    throw new Error("ADMIN_KEY_OP must be a 1Password reference (op://vault/item/field).");
  }
  const { stdout } = await execFileAsync("op", ["read", ref], { encoding: "utf8" });
  const raw = stdout.trim();
  // Guarded: ethers puts the offending VALUE in its error, and that value is the key.
  try {
    return new Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
  } catch {
    throw new Error(`${ref} is not a valid private key (32 bytes of hex, with or without 0x).`);
  }
}

async function signIn(wallet) {
  const nonce = await fetch(`${API}/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: wallet.address })
  }).then((response) => response.json());
  if (!nonce?.message) throw new Error(`/auth/nonce failed: ${JSON.stringify(nonce)}`);

  const verified = await fetch(`${API}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: nonce.message, signature: await wallet.signMessage(nonce.message) })
  }).then((response) => response.json());
  const token = verified?.token ?? verified?.accessToken;
  if (!token) throw new Error(`/auth/verify failed: ${JSON.stringify(verified)}`);
  return { token, roles: verified?.roles ?? [] };
}

async function listing(jobId) {
  const payload = await fetch(`${API}/jobs?source=external`).then((response) => response.json());
  const jobs = payload?.jobs ?? payload?.items ?? [];
  return jobs.find((job) => String(job?.id).toLowerCase() === jobId.toLowerCase());
}

const flags = parseArgs(process.argv.slice(2));
const jobId = String(flags["job-id"] ?? "");
if (!/^0x[0-9a-fA-F]{64}$/u.test(jobId)) {
  console.error("usage: delist-external-job.mjs --job-id 0x<64 hex> [--commit]");
  process.exit(1);
}

const before = await listing(jobId);
console.log(JSON.stringify({
  jobId,
  listedNow: Boolean(before),
  title: before?.title ?? null,
  state: before?.state ?? null,
  claimable: before?.claimable ?? null,
  poster: before?.poster?.wallet ?? null,
  onChainEscrow: "UNTOUCHED — reserved funding stays reserved",
  commit: Boolean(flags.commit)
}, null, 2));

if (!before) {
  console.error("\nNot listed. Nothing to delist.");
  process.exit(0);
}
if (!flags.commit) {
  console.error("\nDRY RUN — nothing sent. Re-run with --commit to delist.");
  process.exit(0);
}

const wallet = await loadWallet();
const { token, roles } = await signIn(wallet);
console.error(`admin ${wallet.address} roles=${JSON.stringify(roles)}`);

const response = await fetch(`${API}/admin/jobs/external/${jobId}/delist`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ reason: String(flags.reason ?? "operator delist") })
});
const body = await response.text();
console.log(JSON.stringify({ http: response.status, body: body.slice(0, 800) }, null, 2));

const after = await listing(jobId);
console.log(JSON.stringify({ stillListed: Boolean(after) }, null, 2));
