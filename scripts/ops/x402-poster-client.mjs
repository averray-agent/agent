#!/usr/bin/env node
/**
 * A minimal x402 poster client — so we can pay our own ramp before a stranger does.
 *
 * WHY THIS EXISTS
 * The ramp is configured and inert. Arming it without a way to exercise it would
 * mean the first party ever to use a live payment surface is a stranger, spending
 * their own money as our test. This closes that gap.
 *
 * WHAT IT DOES
 *   1. POST the job definition with no payment      → 402 + requirements + challenge
 *   2. Sign the SIWX challenge (EIP-4361 personal_sign)
 *   3. Sign an EIP-3009 transferWithAuthorization (EIP-712) for the exact amount
 *   4. Retry with SIGN-IN-WITH-X and X-PAYMENT headers
 *
 * The message and payload are built from the SERVER'S OWN 402 response and, for the
 * sign-in message, from the server's own buildSiwxEip4361Message. This client
 * therefore cannot drift from what the server verifies — the same discipline the
 * adversarial driver uses when it encodes calldata from the quote's own signature.
 *
 * SAFETY
 *   - The key is read by 1Password reference and never printed. A raw key cannot be
 *     passed in.
 *   - Dry-run by default: it fetches the 402 and prints exactly what it WOULD sign
 *     and send. --commit signs and pays.
 *   - Signing the authorization moves nothing. Only the server's /settle call does,
 *     and only after it has created the job.
 *
 * USAGE
 *   X402_CLIENT_KEY_OP="op://vault/item/credential" \
 *     node scripts/ops/x402-poster-client.mjs --definition-file def.json
 *
 *   ... --definition-file def.json --commit
 */
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

import { Wallet } from "ethers";

import { buildSiwxEip4361Message } from "../../mcp-server/src/auth/siwx.js";

const execFileAsync = promisify(execFile);
const API = (process.env.API_URL ?? "https://api.averray.com").replace(/\/+$/, "");
const POSTING_PATH = "/jobs/draft";
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
};

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
  const ref = String(process.env.X402_CLIENT_KEY_OP ?? "").trim();
  if (!ref.startsWith("op://")) {
    throw new Error("X402_CLIENT_KEY_OP must be a 1Password reference (op://vault/item/field).");
  }
  const { stdout } = await execFileAsync("op", ["read", ref], { encoding: "utf8" });
  const raw = stdout.trim();
  // Guarded: ethers puts the offending VALUE in its error, and here that value is
  // the private key, which an unhandled rejection would print.
  try {
    return new Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
  } catch {
    throw new Error(`${ref} is not a valid private key (32 bytes of hex, with or without 0x).`);
  }
}

const flags = parseArgs(process.argv.slice(2));
const definition = JSON.parse(
  readFileSync(String(flags["definition-file"] ?? "definition.json"), "utf8")
);
const wallet = await loadWallet();
console.error(`payer ${wallet.address}\n`);

// ── 1. ask, and be refused ────────────────────────────────────────────────────
const challengeResponse = await fetch(`${API}${POSTING_PATH}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ definition })
});
const envelope = await challengeResponse.json().catch(() => ({}));

if (challengeResponse.status !== 402) {
  console.log(JSON.stringify({ status: challengeResponse.status, body: envelope }, null, 2));
  console.error(
    challengeResponse.status === 401
      ? "\nGot 401, not 402 — the x402 ramp is not enabled on this host."
      : "\nExpected 402 Payment Required."
  );
  process.exit(1);
}

const accepted = envelope?.accepts?.[0];
const signIn = envelope?.signIn ?? envelope?.extensions?.signIn;
if (!accepted || !signIn?.info) {
  throw new Error("The 402 response carried no payment requirements or no sign-in challenge.");
}

const chain = signIn.supportedChains?.[0] ?? {};
const proofFields = {
  ...signIn.info,
  chainId: String(chain.chainId ?? ""),
  type: String(chain.type ?? "eip191")
};
const message = buildSiwxEip4361Message(proofFields);

// EIP-3009 window: start now, expire inside the server's own advertised timeout so
// an unsettled authorization dies on its own rather than lingering as a live claim
// on the payer's balance.
const validAfter = Math.floor(Date.now() / 1000) - 60;
const validBefore = validAfter + 60 + Number(accepted.maxTimeoutSeconds ?? 60);
const authorization = {
  from: wallet.address,
  to: accepted.payTo,
  value: String(accepted.amount),
  validAfter: String(validAfter),
  validBefore: String(validBefore),
  nonce: `0x${randomBytes(32).toString("hex")}`
};

console.log(JSON.stringify({
  wouldPay: {
    scheme: accepted.scheme,
    network: accepted.network,
    asset: accepted.asset,
    amountRaw: accepted.amount,
    amountUsdc: (Number(accepted.amount) / 1e6).toFixed(6),
    payTo: accepted.payTo
  },
  authorization,
  signInDomain: signIn.info.domain,
  commit: Boolean(flags.commit)
}, null, 2));

if (!flags.commit) {
  console.error("\nDRY RUN — nothing signed, nothing sent. Re-run with --commit to pay.");
  process.exit(0);
}

// ── 2. sign both proofs. Neither moves money. ─────────────────────────────────
const siwxProof = {
  ...proofFields,
  signature: await wallet.signMessage(message)
};

const chainId = Number(String(accepted.network).split(":")[1]);
const domain = {
  name: accepted.extra?.name ?? "USDC",
  version: accepted.extra?.version ?? "2",
  chainId,
  verifyingContract: accepted.asset
};
const signature = await wallet.signTypedData(domain, EIP3009_TYPES, authorization);

const paymentPayload = {
  x402Version: 2,
  accepted,
  payload: { authorization, signature }
};

// ── 3. retry, paying ──────────────────────────────────────────────────────────
const paid = await fetch(`${API}${POSTING_PATH}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "SIGN-IN-WITH-X": Buffer.from(JSON.stringify(siwxProof)).toString("base64"),
    "X-PAYMENT": Buffer.from(JSON.stringify(paymentPayload)).toString("base64")
  },
  body: JSON.stringify({ definition })
});
const body = await paid.json().catch(() => ({}));
console.log(JSON.stringify({ status: paid.status, body }, null, 2));
process.exit(paid.status >= 200 && paid.status < 300 ? 0 : 1);
