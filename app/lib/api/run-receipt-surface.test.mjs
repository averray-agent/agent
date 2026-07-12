import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../../app/(authed)/receipts/page.tsx", import.meta.url);
const hooksUrl = new URL("./hooks.ts", import.meta.url);
const adaptersUrl = new URL("./receipt-adapters.ts", import.meta.url);

test("receipts UI treats emitted run receipts as canonical live documents", async () => {
  const [page, hooks, adapters] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(hooksUrl, "utf8"),
    readFile(adaptersUrl, "utf8")
  ]);

  const runShape = page.slice(page.indexOf('kind: "run"'), page.indexOf('kind: "settle"'));
  assert.doesNotMatch(runShape, /emitted:\s*false/u);
  assert.match(page, /useReceiptDetail/u);
  assert.match(hooks, /kind === "run" \? "\/run"/u);
  assert.match(adapters, /objectField\(record, "runReceipt"\)/u);
  assert.match(adapters, /row\.kind === "run"/u);
});
