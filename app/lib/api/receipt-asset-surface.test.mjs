import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adapterUrl = new URL("./receipt-adapters.ts", import.meta.url);
const drawerUrl = new URL("../../components/receipts/ReceiptDrawerBody.tsx", import.meta.url);
const pageUrl = new URL("../../app/(authed)/receipts/page.tsx", import.meta.url);

test("operator receipt detail renders the server-projected asset line outside canonical receipt bytes", async () => {
  const [adapter, drawer, page] = await Promise.all([
    readFile(adapterUrl, "utf8"),
    readFile(drawerUrl, "utf8"),
    readFile(pageUrl, "utf8")
  ]);

  assert.match(adapter, /listRow\?\.assetContext/u);
  assert.match(adapter, /formatReceiptAssetLine/u);
  assert.match(drawer, /<DrawerSection title="Asset">/u);
  assert.match(drawer, /\{assetLine\}/u);
  assert.match(page, /assetLine=\{drawerModel\.assetLine\}/u);
});
