import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { VerificationProfileRegistry } from "./verification-profile-registry.js";
import { X402VerificationPaymentGate } from "../payments/x402-verification-payment-gate.js";
import { buildX402DiscoveryDocument } from "../payments/x402-discovery.js";
import { buildVerifyLlmsSection, VERIFY_TOOL_PAYMENT_DESCRIPTION } from "../core/verify-product-copy.js";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("pricing: the marketing reader consumes every registry price, including changed policy values", async () => {
  const readerSource = read("marketing/public/verify-reader.js");
  const context = { window: {} };
  runInNewContext(readerSource, context);
  const gate = new X402VerificationPaymentGate({ config: { enabled: true, network: "eip155:8453",
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", payTo: "0x" + "1".repeat(40),
    publicOrigin: "https://api.averray.com", captureMarginSeconds: 600 }, provider: {}, tokenContract: {}, captureTokenContract: {} });
  gate.eip712Domain = async () => ({ name: "USD Coin", version: "2" });
  for (const changed of [false, true]) {
    const profiles = new VerificationProfileRegistry().list().map((p, i) => changed
      ? { ...p, price: { ...p.price, amount: String(i + 7), amountRaw: String((i + 7) * 1_000_000) } } : p);
    const discovery = await buildX402DiscoveryDocument({ paymentGate: gate, profiles });
    const terms = context.window.AverrayVerifyDiscovery.parseDiscovery(discovery);
    assert.deepEqual(JSON.parse(JSON.stringify(terms.prices)), profiles.map((p) => ({
      profile: p.ref, amount: p.price.amount, assetLabel: p.price.asset
    })));
    const nodes = new Map();
    const node = (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, { textContent: "", hidden: false,
        replaceChildren(...children) { this.children = children; } });
      return nodes.get(selector);
    };
    const root = { dataset: {}, querySelector: node };
    const browser = { window: { AverrayReaderFetch: { readJsonWithRetry: async () => discovery } }, document: {
      getElementById: () => root, querySelector: node,
      createElement: () => ({}), createTextNode: (textContent) => ({ textContent })
    } };
    runInNewContext(readerSource, browser);
    await new Promise(setImmediate);
    assert.equal(root.dataset.verifyPricingState, "live");
    assert.deepEqual(Array.from(node("[data-verify-prices]").children, (row) => row.textContent),
      profiles.map((p) => `${p.ref}: ${p.price.amount} ${p.price.asset}`));
  }
});

test("pricing: documentation and discovery consumers refer to live registry-backed prices without literals", () => {
  const consumers = [
    "docs/VERIFY_PR_GATE.md",
    "docs/VERIFY_SITE_SIGNALS.md",
    "marketing/src/pages/pricing.astro",
    "marketing/src/pages/terms.astro",
    "marketing/src/content/llms.txt",
    "mcp-server/src/core/verify-pricing.js",
    "marketing/src/pages/verify.astro",
    "marketing/src/pages/verify-listing.json.ts",
    "marketing/public/verify-reader.js",
    "mcp-server/src/core/verify-product-copy.js"
  ];
  const literalPrice = /(?:\b(?:5(?:\.0+)?|0\.25)\s*USDC\b|\b(?:5000000|250000)\b|\$(?:5|0\.25)\b)/iu;
  for (const path of consumers) assert.doesNotMatch(read(path), literalPrice, `${path} must derive prices from discovery or the profile registry`);
  for (const path of ["discovery/agent-tools.json", "discovery/.well-known/agent-tools.json"]) {
    const document = JSON.parse(read(path));
    const selected = JSON.stringify(document, (_key, value) => value);
    // These documents also describe unrelated worker fees; inspect Verify entries only.
    const verify = [...(document.tools ?? []), ...(document.endpoints ?? [])].filter((entry) =>
      /Verification|\/verify\//u.test(entry.name ?? entry.path ?? ""));
    assert.ok(selected.includes("https://api.averray.com/.well-known/x402"));
    assert.ok(verify.length > 0);
    assert.doesNotMatch(JSON.stringify(verify), literalPrice, path);
  }
  assert.doesNotMatch(VERIFY_TOOL_PAYMENT_DESCRIPTION, literalPrice);
  const llms = buildVerifyLlmsSection({ apiUrl: "https://api.averray.com" });
  assert.doesNotMatch(llms, literalPrice);
  assert.match(llms, /selected `accepts\[\]` entry/u);
});
