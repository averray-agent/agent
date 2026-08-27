#!/usr/bin/env node
/**
 * Capture idle-balance allocation consent for the OPERATOR'S OWN wallet,
 * signing with the KMS key (EIP-191 via KmsSigner.signMessage).
 *
 *   node scripts/ops/idle-consent-kms.mjs --status          # read only
 *   node scripts/ops/idle-consent-kms.mjs --quote           # quote + show terms, sign nothing
 *   node scripts/ops/idle-consent-kms.mjs --commit          # quote -> sign -> capture
 *   node scripts/ops/idle-consent-kms.mjs --revoke          # revoke consent
 *
 * Env: API_BASE (default https://api.averray.com), KMS_KEY_ID, AWS_REGION.
 *
 * This captures CONSENT ONLY. It moves no funds. Allocation happens later,
 * and only while IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED is true.
 */
// Resolve against BOTH layouts: the repo (mcp-server/src/...) and the deployed
// backend image, whose Dockerfile copies mcp-server/src to /app/src. That lets
// this run inside agent-mainnet-backend, which is the only place the mainnet
// KMS key can be used (Roles Anywhere; no static access keys exist by design).
const tryImport = async (specifiers) => {
  let last;
  for (const spec of specifiers) {
    try { return await import(spec); } catch (error) { last = error; }
  }
  throw new Error(`could not resolve ${specifiers[0]} in either layout: ${last?.message ?? last}`);
};
const { KmsSigner } = await tryImport([
  "../../mcp-server/src/blockchain/kms-signer.js",
  "/app/src/blockchain/kms-signer.js"
]);
const { buildSiweMessage } = await tryImport([
  "../../mcp-server/src/auth/siwe.js",
  "/app/src/auth/siwe.js"
]);
import { randomUUID } from "node:crypto";

const API = process.env.API_BASE ?? "https://api.averray.com";
const mode = process.argv.find((a) => ["--status", "--quote", "--commit", "--revoke"].includes(a)) ?? "--status";

const signer = new KmsSigner({ keyId: process.env.KMS_KEY_ID, region: process.env.AWS_REGION });
const wallet = await signer.getAddress();
console.log(`signer: ${wallet}`);

const call = async (path, { method = "GET", token, body } = {}) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};

// --- SIWE sign-in with the KMS key -----------------------------------------
const { nonce } = await call(`/auth/nonce?address=${wallet}`);
const domain = new URL(API).host;
const prepared = buildSiweMessage({
  domain, address: wallet, uri: API,
  chainId: Number(process.env.CHAIN_ID ?? 420420419), nonce,
  statement: "Sign in to Averray.", issuedAt: new Date().toISOString()
});
const siweSignature = await signer.signMessage(prepared);
const session = await call("/auth/verify", { method: "POST", body: { message: prepared, signature: siweSignature } });
const token = session.token ?? session.accessToken;
if (!token) throw new Error(`no token in /auth/verify response: ${JSON.stringify(session).slice(0, 200)}`);
console.log("SIWE session established.");

const status = await call("/account/idle-allocation", { token });
console.log("\nstatus:", JSON.stringify(status, null, 2).slice(0, 900));
if (mode === "--status") { console.log("\nREAD ONLY — nothing signed."); process.exit(0); }

if (mode === "--revoke") {
  console.log("\nrevoke:", JSON.stringify(await call("/account/idle-allocation/revoke", { method: "POST", token, body: {} }), null, 2).slice(0, 600));
  process.exit(0);
}

if (status.available !== true) throw new Error(`route not available: ${status.reason ?? "unknown"} — is IDLE_BALANCE_ALLOCATION_ROUTE_LIVE set?`);

const quote = await call("/account/idle-allocation/quote", { method: "POST", token, body: { consentNonce: randomUUID() } });
console.log("\n--- TERMS YOU ARE ABOUT TO CONSENT TO ---");
console.log("fundsMovement :", quote.terms.fundsMovement);
console.log("venue         :", quote.terms.venueDisclosure);
console.log("returnTerms   :", quote.terms.returnTerms);
console.log("termsHash     :", quote.termsHash);
console.log("expires       :", quote.terms.quoteExpiresAt);

if (mode === "--quote") { console.log("\nQUOTE ONLY — nothing signed."); process.exit(0); }

const consentSignature = await signer.signMessage(quote.consent.message);
const result = await call("/account/idle-allocation/consent", {
  method: "POST", token,
  body: { terms: quote.terms, termsHash: quote.termsHash, consentSignature }
});
console.log("\n# CONSENT CAPTURED");
console.log(JSON.stringify(result, null, 2).slice(0, 800));
