#!/usr/bin/env node

/**
 * Offline mint of an admin / verifier JWT for the Averray backend.
 *
 * Closes a gap that bit us in early ops: when the `ADMIN_JWT` GitHub
 * Actions secret (or any other long-lived ops token) expires, the
 * only previously-documented mint path was the operator app's SIWE
 * sign-in flow followed by manual local-storage extraction. That
 * flow is fine for human operators but breaks any time the deployer
 * wants to refresh tokens consumed by automation (e.g.
 * scripts/ops/run-hosted-worker-loop.mjs).
 *
 * This script signs a JWT locally using the platform's HS256
 * secret. It does NOT contact the running backend — the produced
 * token is verifiable by any backend whose `AUTH_JWT_SECRETS`
 * environment variable contains the same secret used to sign it.
 *
 * Required env (treat as sensitive — source from a vault or
 * password manager, never paste literals into shell history):
 *   AUTH_JWT_SECRETS    — comma-separated list of HS256 secrets.
 *                         The script signs with the first entry,
 *                         matching the rotation pattern in
 *                         mcp-server/src/auth/jwt.js (newest first).
 *   AUTH_JWT_SECRET     — legacy single-secret fallback.
 *
 * Usage:
 *   node scripts/ops/mint-admin-jwt.mjs \
 *     --wallet 0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519 \
 *     --roles admin,verifier \
 *     --expires-in-days 90
 *
 *   # short form: takes the wallet from deployments/<profile>.json
 *   node scripts/ops/mint-admin-jwt.mjs --profile testnet
 *
 * Common workflow (hosted product-proof smoke):
 *   AUTH_JWT_SECRETS=$(op read 'op://Averray/Production/jwt-secret/credential') \
 *     node scripts/ops/mint-admin-jwt.mjs --profile testnet --expires-in-days 30 \
 *   | xargs -I {} gh secret set ADMIN_JWT --body '{}'
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { signToken } from "../../mcp-server/src/auth/jwt.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function parseArgs(argv) {
  const args = {
    wallet: undefined,
    profile: undefined,
    roles: ["admin"],
    expiresInDays: 30,
    quiet: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--wallet") args.wallet = argv[++i];
    else if (flag === "--profile") args.profile = argv[++i];
    else if (flag === "--roles") args.roles = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (flag === "--expires-in-days") args.expiresInDays = Number(argv[++i]);
    else if (flag === "--quiet" || flag === "-q") args.quiet = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
  }
  return args;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/ops/mint-admin-jwt.mjs [options]",
      "",
      "Options:",
      "  --wallet <0x…>          Subject wallet to sign for. Defaults to deployments/<profile>.json#verifier when --profile is given.",
      "  --profile <name>        Read default wallet from deployments/<name>.json (e.g. testnet, mainnet).",
      "  --roles <a,b,c>         Comma-separated role list. Default: admin.",
      "  --expires-in-days <n>   Token lifetime in days. Default: 30.",
      "  --quiet, -q             Print only the JWT (no decoded claims summary).",
      "",
      "Required env:",
      "  AUTH_JWT_SECRETS        Comma-separated HS256 secrets. First entry is the signing key.",
      "  AUTH_JWT_SECRET         Legacy single-secret fallback (only used if AUTH_JWT_SECRETS unset).",
      "",
      "Output:",
      "  When --quiet: stdout is just the JWT (suitable for piping to `gh secret set`, etc.).",
      "  Otherwise: a short summary block + the JWT on the last line."
    ].join("\n")
  );
}

async function loadDefaultWallet(profile) {
  if (!profile) return undefined;
  try {
    const raw = await readFile(resolve(repoRoot, "deployments", `${profile}.json`), "utf8");
    const data = JSON.parse(raw);
    return data.verifier ?? data.deployer ?? undefined;
  } catch (error) {
    throw new Error(`Could not read deployments/${profile}.json: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const wallet = args.wallet ?? (await loadDefaultWallet(args.profile));
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/u.test(wallet)) {
    console.error("--wallet (or --profile that resolves to one) is required and must be a 0x-prefixed 40-char hex address.");
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!Number.isFinite(args.expiresInDays) || args.expiresInDays <= 0 || args.expiresInDays > 365 * 2) {
    console.error("--expires-in-days must be between 1 and 730 (~2 years).");
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(args.roles) || args.roles.length === 0) {
    console.error("--roles must be a non-empty comma-separated list (e.g. admin,verifier).");
    process.exitCode = 1;
    return;
  }

  const secretsRaw = String(process.env.AUTH_JWT_SECRETS ?? process.env.AUTH_JWT_SECRET ?? "").trim();
  if (!secretsRaw) {
    console.error("AUTH_JWT_SECRETS env (or legacy AUTH_JWT_SECRET) is required.");
    console.error("Source it from your vault — never paste the secret as a shell literal:");
    console.error('  AUTH_JWT_SECRETS=$(op read "op://Averray/Production/jwt-secret/credential")');
    process.exitCode = 1;
    return;
  }
  const secrets = secretsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (secrets.length === 0) {
    console.error("AUTH_JWT_SECRETS resolved to an empty list after splitting on commas.");
    process.exitCode = 1;
    return;
  }
  // Sign with the first (newest) secret, mirroring auth/middleware.js
  // verification order. Old tokens issued by previous secrets remain
  // valid until those entries are dropped from the live backend's
  // AUTH_JWT_SECRETS list.
  const signingSecret = secrets[0];
  if (signingSecret.length < 32) {
    console.error(`The first AUTH_JWT_SECRETS entry is ${signingSecret.length} chars long; auth/config.js requires ≥ 32 chars in strict mode. Ensure the env matches the live backend.`);
    process.exitCode = 1;
    return;
  }

  const expiresInSeconds = Math.floor(args.expiresInDays * 24 * 60 * 60);
  const { token, claims } = signToken(
    {
      sub: wallet.toLowerCase(),
      roles: args.roles,
      // No explicit scopes — admin/verifier roles already grant the
      // capabilities ops scripts need. If you need finer-grained
      // scopes for a service token, add them via a fork of this
      // script or thread `--scopes` through the CLI parser.
    },
    { secret: signingSecret, expiresInSeconds }
  );

  if (args.quiet) {
    console.log(token);
    return;
  }

  const expiresAt = new Date(claims.exp * 1000).toISOString();
  const issuedAt = new Date(claims.iat * 1000).toISOString();
  console.error("# admin-jwt mint");
  console.error(`subject:        ${claims.sub}`);
  console.error(`roles:          ${claims.roles?.join(", ") ?? "(none)"}`);
  console.error(`jti:            ${claims.jti}`);
  console.error(`issued:         ${issuedAt}`);
  console.error(`expires:        ${expiresAt}  (${args.expiresInDays} days from now)`);
  console.error(`signed with:    secret index 0 of ${secrets.length} configured secret${secrets.length === 1 ? "" : "s"}`);
  console.error("");
  console.error("# JWT (this line below is the token; paste it into ADMIN_JWT or pipe to `gh secret set`):");
  console.log(token);
}

main().catch((error) => {
  console.error(`mint-admin-jwt failed: ${error?.stack ?? error?.message ?? error}`);
  process.exitCode = 1;
});
