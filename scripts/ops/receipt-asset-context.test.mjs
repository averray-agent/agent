import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { hashWorkReceiptContent } from "../../mcp-server/src/core/work-receipt.js";

const REPO_ROOT = new URL("../../", import.meta.url);

for (const enveloped of [false, true]) test(`public receipt reader renders Hub settlement from ${enveloped ? "an unsigned envelope projection" : "a legacy response"}`, async () => {
  const [source, fixture] = await Promise.all([
    readFile(new URL("marketing/public/receipt-reader.js", REPO_ROOT), "utf8"),
    readFile(new URL("marketing/fixtures/decorated-work-receipt-synthetic.json", REPO_ROOT), "utf8").then(JSON.parse)
  ]);
  const assetLine = { hidden: true, textContent: "" };
  const { result: _result, assetContext: _assetContext, ...canonicalFixture } = fixture;
  assert.equal(hashWorkReceiptContent(canonicalFixture), fixture.receiptId);
  const elements = new Map([
    ["[data-receipt-state]", { dataset: { receiptState: "loading" } }],
    ["[data-receipt-status]", { textContent: "", hidden: false }],
    ["[data-receipt]", { hidden: true }],
    ["[data-receipt-guidance]", { hidden: true }],
    ["[data-receipt-raw-url]", { href: "", textContent: "" }],
    ["[data-receipt-json]", { textContent: "" }],
    ["[data-settlement]", { hidden: true }],
    ["[data-provider-class]", { textContent: "unknown" }],
    ["[data-asset-context]", assetLine]
  ]);
  vm.runInNewContext(source, {
    document: {
      querySelector(selector) { return elements.get(selector) ?? null; },
      querySelectorAll() { return []; }
    },
    window: {
      location: { pathname: `/receipts/${fixture.receiptId}` },
      AverrayReaderFetch: { readJsonWithRetry: async () => enveloped ? {
        schemaVersion: "averray.receipt-envelope.v1",
        document: canonicalFixture,
        unsignedPresentation: { result: fixture.result, assetContext: fixture.assetContext }
      } : fixture }
    }
  }, { filename: "receipt-reader.js" });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (elements.get("[data-receipt-state]").dataset.receiptState === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(assetLine.hidden, false);
  assert.equal(assetLine.textContent, "Settled in Hub USDC · Polkadot Hub (eip155:420420419) · asset 1337");
  if (enveloped) assert.deepEqual(JSON.parse(elements.get("[data-receipt-json]").textContent), canonicalFixture);
});
