#!/usr/bin/env node
//
// Hosted regression guard for the roleless-wallet SIWE→JWT mint.
//
// Background: external agents authenticate with an ORDINARY wallet that
// holds no admin/verifier role. config.resolveRoles returns [] for such
// wallets, so the SIWE handler mints a roleless JWT. When prod went
// ES256-only (JWT_BACKEND=kms), the ES256 sign path REQUIRED a role and
// threw ConfigError → HTTP 500 invalid_configuration for every roleless
// login — i.e. EVERY external agent was locked out at the front door.
// No existing proof caught it because every other hosted proof uses the
// pre-minted multi-role ADMIN_JWT and never exercises the live SIWE mint
// for a roleless wallet.
//
// This proof closes that gap by doing a REAL SIWE login with a FRESH,
// non-admin/non-verifier wallet end to end:
//
//   1. Generate an ephemeral wallet (NOT in AUTH_ADMIN_WALLETS /
//      AUTH_VERIFIER_WALLETS — a brand-new random key never can be).
//   2. POST /auth/nonce { wallet }     → 200 + SIWE message.
//   3. Sign the SIWE message (EIP-191 personal_sign).
//   4. POST /auth/verify { message, signature } → assert 200 + a usable
//      bearer token whose roles claim is [] (roleless). Before the fix
//      this step returns HTTP 500 invalid_configuration.
//   5. GET /account with the bearer token → assert 200 (account:read is
//      a BASE capability every wallet holds), proving the token works
//      for an auth-gated, non-role-gated action.
//
// Run against prod this MUST FAIL before the auth fix and PASS after.
//
// Mirrors the other hosted proofs (check-product-proof-gate.mjs etc.):
// an exported async function + a CLI entry, gated in
// check-hosted-stack.sh behind CHECK_SIWE_FRESH_WALLET_PROOF=1.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Wallet } from "ethers";

const DEFAULT_API_BASE_URL = "https://api.averray.com";
const TIMEOUT_MS = 20_000;

export async function checkSiweFreshWalletProof({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
  makeWallet = () => Wallet.createRandom(),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime.");
  }

  const apiBaseUrl = stripTrailingSlash(env.API_BASE_URL || DEFAULT_API_BASE_URL);
  const evidenceFile = env.SIWE_FRESH_WALLET_PROOF_EVIDENCE_FILE || "";

  // An override private key is supported for reproducible local runs, but
  // the default — a fresh random key every run — is the point: it is
  // guaranteed not to be an admin/verifier wallet and never accrues
  // state, so it always exercises the true roleless front door.
  const overrideKey = (env.SIWE_FRESH_WALLET_PRIVATE_KEY || "").trim();
  const wallet = overrideKey ? new Wallet(overrideKey) : makeWallet();
  const address = wallet.address;

  log(`SIWE fresh-wallet proof against ${apiBaseUrl} (wallet ${address})`);

  // ── 1. nonce ──────────────────────────────────────────────────────
  log("POST /auth/nonce");
  const nonceResult = await postJson(fetchImpl, `${apiBaseUrl}/auth/nonce`, {
    wallet: address,
  });
  assert.equal(
    nonceResult.status,
    200,
    `/auth/nonce expected HTTP 200, got ${nonceResult.status}: ${describeBody(nonceResult.body)}`,
  );
  const message = nonceResult.body?.message;
  assert.ok(
    typeof message === "string" && message.length > 0,
    "/auth/nonce must return a non-empty SIWE message",
  );

  // ── 2. sign (EIP-191 personal_sign) ───────────────────────────────
  const signature = await wallet.signMessage(message);

  // ── 3. verify — the step that 500'd before the fix ────────────────
  log("POST /auth/verify");
  const verifyResult = await postJson(fetchImpl, `${apiBaseUrl}/auth/verify`, {
    message,
    signature,
  });

  // A precise, actionable failure when we hit the exact regression: the
  // signature verified (else this would be 401), but the platform failed
  // to MINT the roleless JWT.
  if (verifyResult.status === 500) {
    const code = verifyResult.body?.error ?? verifyResult.body?.code ?? "";
    throw new Error(
      `/auth/verify returned HTTP 500 (${describeBody(verifyResult.body)}). ` +
        (String(code).includes("invalid_configuration") || code === ""
          ? "This is the roleless-wallet SIWE→JWT mint regression: the ES256 sign path " +
            "rejected a roleless worker token. Fix signTokenFromConfig to make `role` optional."
          : "Unexpected server error while minting the SIWE token."),
    );
  }
  assert.equal(
    verifyResult.status,
    200,
    `/auth/verify expected HTTP 200, got ${verifyResult.status}: ${describeBody(verifyResult.body)}`,
  );

  const token = verifyResult.body?.token;
  assert.ok(
    typeof token === "string" && token.split(".").length === 3,
    "/auth/verify must return a JWT bearer token",
  );
  const roles = verifyResult.body?.roles ?? [];
  assert.ok(Array.isArray(roles), "/auth/verify response roles must be an array");
  assert.equal(
    roles.length,
    0,
    `fresh wallet must be ROLELESS, but /auth/verify returned roles: ${JSON.stringify(roles)}`,
  );
  assert.ok(
    !roles.includes("admin") && !roles.includes("verifier"),
    "fresh wallet must not be granted admin/verifier",
  );

  // ── 4. use the token on an auth-gated, non-role-gated route ───────
  log("GET /account with the minted bearer token");
  const accountResult = await getJson(fetchImpl, `${apiBaseUrl}/account`, token);
  assert.equal(
    accountResult.status,
    200,
    `GET /account with the fresh-wallet token expected HTTP 200, got ${accountResult.status}: ${describeBody(accountResult.body)}`,
  );

  const evidence = {
    proof: "siwe-fresh-wallet",
    apiBaseUrl,
    wallet: address,
    ephemeral: overrideKey.length === 0,
    nonceStatus: nonceResult.status,
    verifyStatus: verifyResult.status,
    accountStatus: accountResult.status,
    roles,
    tokenMinted: true,
    checkedAt: new Date().toISOString(),
  };

  if (evidenceFile) {
    await mkdir(dirname(evidenceFile), { recursive: true });
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    log(`Wrote evidence to ${evidenceFile}`);
  }

  log(
    `SIWE fresh-wallet proof passed — roleless wallet ${address} minted a usable bearer token and reached /account.`,
  );
  return evidence;
}

async function postJson(fetchImpl, url, body) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: response.status, body: await readBody(response) };
}

async function getJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: response.status, body: await readBody(response) };
}

async function readBody(response) {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeBody(body) {
  if (body && typeof body === "object") {
    return JSON.stringify(body);
  }
  const text = String(body ?? "");
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  checkSiweFreshWalletProof().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
