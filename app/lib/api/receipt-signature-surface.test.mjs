import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const pageUrl = new URL("../../app/(authed)/receipts/page.tsx", import.meta.url);
const drawerUrl = new URL("../../components/receipts/ReceiptDrawerBody.tsx", import.meta.url);
const adapterUrl = new URL("./receipt-adapters.ts", import.meta.url);

test("receipt signature action declares feed state and all distinct truth outcomes", async () => {
  const [page, drawer, adapter] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(drawerUrl, "utf8"),
    readFile(adapterUrl, "utf8"),
  ]);

  assert.match(page, /badgesPresence\s*=\s*feedPresence\(badgesRequest\)/u);
  assert.match(page, /signaturePresence/u);
  assert.match(drawer, /title:\s*"✓ Verified"/u);
  assert.match(drawer, /title:\s*"✗ Failed"/u);
  assert.match(drawer, /title:\s*"Unsigned \(legacy\)"/u);
  assert.match(drawer, /presence === "locked"/u);
  assert.match(drawer, /presence === "down"/u);
  assert.match(drawer, /disabled=\{Boolean\(disabledReason\)\}/u);
  assert.match(adapter, /selectCanonicalReceiptDocument/u);
  assert.match(adapter, /receiptHasSignature\(raw\) \? "application\/jose\+json" : "application\/json"/u);
});
