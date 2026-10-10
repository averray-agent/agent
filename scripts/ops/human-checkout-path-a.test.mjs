import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";

// Always exercise the tracked memo, independently of cwd or H1_MEMO_PATH.
const memoUrl = new URL("../../docs/HUMAN_CHECKOUT_PATH_A.md", import.meta.url);
const original = readFileSync(memoUrl, "utf8");

function validate(text) {
  const prose = text.replace(/\s+/gu, " ");
  for (const phrase of [
    "## A1 — Coinbase account-based hosted flow",
    "## A2 — Stripe-hosted session flow",
    "Coinbase owns account identity verification",
    "handles KYC/sanctions screening",
    "guest checkout deprecation to 2026-06-30",
    "Base USDC for US consumers only",
    "Swiss consumers are not in Stripe's documented on-ramp regions",
    "a Swiss merchant is documented as eligible to apply",
    "Averray's application approval is **not reported**",
    "As of **2026-10-10**, the on-ramp is in **Public preview**",
    'blockchains: ["base"]',
    'assets: ["USDC"]',
    "required `clientIp`",
    "real end-user IP",
    "`X-Forwarded-For`",
    "CDP project",
    "Secret API key",
    "CDP terms",
    "create and onboard a Stripe account (business verification and Stripe's terms)",
    "No human x402 client exists in Averray today",
    "`eth_signTypedData_v4`",
    "EOA wallet (injected or WalletConnect)",
    "base64-encode it itself",
    "hardware-wallet support are **untested**",
    "Smart-contract wallets cannot pay",
    "no ERC-1271 support",
    "Only after funds arrive",
    'No verdict, no charge" concerns the Verify fee',
    "whether partner KYC affects Averray's obligations is a question for counsel",
    "US money-transmission/state rules",
    "sales taxes on a digital service sold to US buyers",
    "MiCA/EU rules",
    "all **not reported**",
    "H2 remains deferred"
  ]) assert.ok(prose.includes(phrase), `missing memo boundary: ${phrase}`);
  for (const url of [
    "https://docs.stripe.com/stablecoins/availability",
    "https://stripe.com/global",
    "https://docs.stripe.com/crypto/onramp",
    "https://docs.cdp.coinbase.com/api-reference/rest-api/onramp-offramp/create-session-token"
  ]) assert.ok(text.includes(`](${url})`), `missing primary source: ${url}`);
  assert.doesNotMatch(text, /\b\d+(?:\.\d+)?\s+USDC\b/u, "no baked Verify price");
  for (const [, link] of text.matchAll(/\]\(([^)]+)\)/gu)) {
    if (!link.startsWith("https://")) assert.ok(existsSync(new URL(link, memoUrl)), link);
  }
}

test("H1 source/flow boundaries, unknowns and relative links", () => validate(original));

for (const [name, remove, replacement] of [
  ["US-only Base USDC availability warning", "Base USDC for US consumers only", ""],
  ["unknown-as-zero", "all **not reported**", "all 0"],
  ["H2 gate", "H2 remains deferred", ""]
]) test(`H1 mutation: remove ${name} is rejected`, () => {
  const mutated = original.replace(remove, replacement);
  assert.notEqual(mutated, original);
  assert.throws(() => validate(mutated), { code: "ERR_ASSERTION" });
});
