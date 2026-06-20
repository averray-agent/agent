#!/usr/bin/env node
//
// Seed (or re-seed) a hosted-smoke admin refresh-token 1Password item by doing a
// REAL SIWE login as the admin wallet and capturing the issued refresh cookie.
//
// Why this exists: the refresh token can only be minted by POST /auth/verify
// (the SIWE login flow). No other tool emits it — mint-admin-jwt.mjs only signs
// an access JWT, and get-admin-refresh-token.mjs only *exchanges* an existing
// refresh cookie. This operationalizes the F13 "first capture is a manual human
// SIWE" step (docs/MAINNET_CREDENTIALS_PLAN.md step 17). After seeding,
// get-admin-refresh-token.mjs takes over for per-run exchange + rotation.
//
// Run this LOCALLY where you have op access to the admin key vault (prod-critical
// is human-only). The write to the target item uses YOUR op session, not the
// per-workflow service account — the service account only needs write scope for
// the workflow's later rotation write-back.
//
// Usage:
//   node scripts/ops/seed-admin-refresh-token.mjs \
//     --item op://prod-smoke/admin-refresh-token-schema-proof/password
//
//   # Eyeball the cookie without writing anything (prints it to stdout):
//   node scripts/ops/seed-admin-refresh-token.mjs --dry-run
//
// Flags:
//   --item <op-ref>          Target 1Password item to write (required unless --dry-run).
//                            Created if absent, edited in place if present.
//   --dry-run                Do the login, print the refresh cookie to stdout, write nothing.
//   --api-base-url <url>     Defaults to https://api.averray.com.
//   --admin-key-op <op-ref>  Where to read the admin EOA key. Defaults to
//                            op://prod-critical/admin-eoa-testnet/private key.
//   --admin-key <0x…>        Literal key override (discouraged; prefer --admin-key-op).
//   -h, --help

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { extractRefreshCookie, parseOpRef, readOpSecret } from "./get-admin-refresh-token.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_API_BASE_URL = "https://api.averray.com";
export const DEFAULT_ADMIN_KEY_OP = "op://prod-critical/admin-eoa-testnet/private key";
const TIMEOUT_MS = 20_000;

export async function seedAdminRefreshToken({
  apiBaseUrl = DEFAULT_API_BASE_URL,
  item,
  adminKey,
  adminKeyOp = DEFAULT_ADMIN_KEY_OP,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  readSecretImpl = readOpSecret,
  writeItemImpl = writeOpItem,
  makeWallet = defaultMakeWallet,
  log = (...args) => console.error(...args),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime.");
  }
  if (!dryRun && !stringOrEmpty(item)) {
    throw new Error("--item <op-ref> is required to write the refresh token (or pass --dry-run to print it).");
  }

  const baseUrl = stripTrailingSlash(apiBaseUrl);
  const privateKey = stringOrEmpty(adminKey) || stringOrEmpty(await readSecretImpl(adminKeyOp));
  if (!privateKey) {
    throw new Error(`Admin key is empty (looked at ${adminKey ? "--admin-key" : adminKeyOp}).`);
  }

  const wallet = await makeWallet(privateKey);
  const address = wallet.address;
  log(`SIWE login as ${address} against ${baseUrl}`);

  // 1. nonce → SIWE message
  const nonce = await postJson(fetchImpl, `${baseUrl}/auth/nonce`, { wallet: address });
  if (nonce.status !== 200) {
    throw new Error(`POST /auth/nonce returned HTTP ${nonce.status}: ${describeBody(nonce.body)}`);
  }
  const message = nonce.body?.message;
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("POST /auth/nonce did not return a SIWE message.");
  }

  // 2. sign (EIP-191 personal_sign)
  const signature = await wallet.signMessage(message);

  // 3. verify → access token (body) + refresh_token (Set-Cookie)
  const verify = await postJson(fetchImpl, `${baseUrl}/auth/verify`, { message, signature });
  if (verify.status !== 200) {
    throw new Error(`POST /auth/verify returned HTTP ${verify.status}: ${describeBody(verify.body)}`);
  }
  const token = verify.body?.token;
  if (typeof token !== "string" || token.split(".").length !== 3) {
    throw new Error("POST /auth/verify did not return a bearer token.");
  }
  const roles = Array.isArray(verify.body?.roles) ? verify.body.roles : [];
  if (roles.length === 0) {
    throw new Error(
      `SIWE login for ${address} returned a ROLELESS token (roles: []). A roleless refresh token would ` +
        "mint roleless access tokens — useless for admin-gated hosted proofs. Confirm the wallet is in " +
        "AUTH_ADMIN_WALLETS / AUTH_VERIFIER_WALLETS on the target backend.",
    );
  }

  const refreshToken = extractRefreshCookie(verify.headers);
  if (!refreshToken) {
    throw new Error(
      "POST /auth/verify succeeded but set no refresh_token cookie — is refresh-token issuance enabled on this backend?",
    );
  }
  log(`Login OK — roles: ${roles.join(", ")}; refresh cookie captured (${refreshToken.length} chars).`);

  if (dryRun) {
    return { address, roles, refreshToken, written: false };
  }

  const action = await writeItemImpl(item, refreshToken);
  log(`${action} ${item}`);
  return { address, roles, refreshToken, written: true, item, action };
}

async function defaultMakeWallet(privateKey) {
  // Lazy import so the module (and its tests) load without ethers installed;
  // ethers is only needed for an actual signing run.
  const { Wallet } = await import("ethers");
  return new Wallet(privateKey);
}

// Create the item if it does not exist yet (first seed), otherwise edit in place
// (re-seed). Uses your local op session — never the per-workflow service account.
export async function writeOpItem(opRef, value) {
  const { vault, item, field } = parseOpRef(opRef);
  if (await opItemExists(vault, item)) {
    await execFileAsync("op", ["item", "edit", item, "--vault", vault, `${field}=${value}`], {
      maxBuffer: 1024 * 1024,
    });
    return "edited";
  }
  await execFileAsync(
    "op",
    ["item", "create", "--category", "password", "--vault", vault, `--title=${item}`, `${field}=${value}`],
    { maxBuffer: 1024 * 1024 },
  );
  return "created";
}

async function opItemExists(vault, item) {
  try {
    await execFileAsync("op", ["item", "get", item, "--vault", vault, "--format", "json"], {
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function postJson(fetchImpl, url, body) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text().catch(() => "");
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function describeBody(body) {
  if (body && typeof body === "object") {
    return JSON.stringify(body);
  }
  const text = String(body ?? "");
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

function parseArgs(argv) {
  const args = { dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--item") args.item = argv[++index];
    else if (arg === "--api-base-url") args.apiBaseUrl = argv[++index];
    else if (arg === "--admin-key-op") args.adminKeyOp = argv[++index];
    else if (arg === "--admin-key") args.adminKey = argv[++index];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage: node scripts/ops/seed-admin-refresh-token.mjs --item <op-ref> [--dry-run]

Does a real SIWE login as the admin wallet and stores the issued refresh cookie
in a 1Password item, seeding the per-consumer refresh token the hosted workflows
exchange via get-admin-refresh-token.mjs.

  --item <op-ref>          Target item to write (required unless --dry-run).
  --dry-run                Print the refresh cookie to stdout; write nothing.
  --api-base-url <url>     Default: ${DEFAULT_API_BASE_URL}
  --admin-key-op <op-ref>  Default: ${DEFAULT_ADMIN_KEY_OP}
  --admin-key <0x…>        Literal key override (discouraged).
  -h, --help
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    const result = await seedAdminRefreshToken({
      apiBaseUrl: args.apiBaseUrl,
      item: args.item,
      adminKey: args.adminKey,
      adminKeyOp: args.adminKeyOp,
      dryRun: args.dryRun,
    });
    if (result.written === false) {
      // --dry-run: stdout is just the cookie (pipeable); diagnostics went to stderr.
      console.log(result.refreshToken);
    }
  })().catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}
