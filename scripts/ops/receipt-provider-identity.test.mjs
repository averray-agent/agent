import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const REPO_ROOT = new URL("../../", import.meta.url);
const RECEIPT_ID = `0x${"e".repeat(64)}`;
const ACCEPTANCE_WALLET = "0x60385dd643f10934e8f384ac7a04c0d798dfc936";
const BLIND_TESTER_WALLET = "0x97450bf69cb4aeb0b33db3ae51ac2d18224d4b5c";
const source = await readFile(new URL("marketing/public/receipt-reader.js", REPO_ROOT), "utf8");

async function render(provider, classification) {
  const fields = [{ dataset: { field: "execution.provider" }, textContent: "" }];
  const elements = new Map([
    ["[data-receipt-state]", { dataset: { receiptState: "loading" } }],
    ["[data-receipt-status]", { textContent: "", hidden: false }],
    ["[data-receipt]", { hidden: true }],
    ["[data-receipt-guidance]", { hidden: true }],
    ["[data-receipt-raw-url]", { href: "", textContent: "" }],
    ["[data-receipt-json]", { textContent: "" }],
    ["[data-settlement]", { hidden: true }],
    ["[data-provider-class]", { textContent: "unknown" }],
  ]);
  const calls = [];
  const receipt = {
    receiptId: RECEIPT_ID,
    execution: { provider, providerClass: "external" },
    verdict: { outcome: "approved" },
  };
  const context = {
    document: {
      querySelector(selector) { return elements.get(selector) ?? null; },
      querySelectorAll(selector) { return selector === "[data-field]" ? fields : []; },
    },
    window: {
      location: { pathname: `/receipts/${RECEIPT_ID}` },
      AverrayReaderFetch: {
        async readJsonWithRetry(url) {
          calls.push(url);
          return calls.length === 1
            ? receipt
            : {
                wallet: provider,
                identity: {
                  classification,
                  authority: "shared_self_identity_registry",
                },
              };
        },
      },
    },
  };
  vm.runInNewContext(source, context, { filename: "receipt-reader.js" });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (elements.get("[data-receipt-state]").dataset.receiptState === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return { calls, elements, fields, receipt };
}

test("historical acceptance receipt renders its provider as operator-run through the shared registry", async () => {
  const rendered = await render(ACCEPTANCE_WALLET, "operator-run");

  assert.equal(rendered.elements.get("[data-provider-class]").textContent, "operator-run");
  assert.equal(rendered.calls[1], `https://api.averray.com/agents/${ACCEPTANCE_WALLET}`);
  assert.equal(rendered.receipt.execution.providerClass, "external", "immutable receipt content is not rewritten");
  assert.match(rendered.elements.get("[data-receipt-json]").textContent, /"providerClass": "external"/u);
});

test("blind tester receipt renders its provider as external through the shared registry", async () => {
  const rendered = await render(BLIND_TESTER_WALLET, "external");

  assert.equal(rendered.elements.get("[data-provider-class]").textContent, "external");
  assert.equal(rendered.fields[0].textContent, BLIND_TESTER_WALLET);
});
