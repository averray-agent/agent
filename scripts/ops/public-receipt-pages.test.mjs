import assert from "node:assert/strict";
import test, { before } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const ids = [
  "0xe302d62bef7f96686bba5db4cfc44fc5743b5464706f2acbc0e6350929a62ce1",
  "0x8a99c2e19b75a7e3b19e1aefb4448be162e89480d953c20ad813b8dda12797c0"
];

// Assert built HTML, not source interpolation. The ops CI job runs before the
// site build job; build marketing/dist here without replacing served site files.
before(async () => {
  await promisify(execFile)("npm", ["run", "build:marketing"], {
    cwd: fileURLToPath(root), timeout: 120_000, maxBuffer: 2_000_000
  });
});

test("only the two published receipt examples have static pages with real no-JS links", async () => {
  const paths = await readdir(new URL("marketing/src/pages/receipts/", root));
  assert.deepEqual(paths.sort(), ids.map((id) => id + ".astro").sort());
  const sync = await read("scripts/sync-marketing-site.mjs");
  const deploy = await read("scripts/ops/deploy-production.sh");
  const sitemap = await read("marketing/dist/sitemap.xml");
  for (const id of ids) {
    const path = `receipts/${id}/index.html`;
    assert.ok(sync.includes('"' + path + '"'), "sync allow-list: " + id);
    assert.ok(deploy.includes('"' + path + " /receipts/" + id + '/"'), "served-byte smoke: " + id);
    assert.ok(sitemap.includes("/receipts/" + id + "/"));
    const document = new JSDOM(await read("marketing/dist/" + path)).window.document;
    const link = document.querySelector("[data-receipt-raw-url]");
    assert.equal(link.href, "https://api.averray.com/receipts/" + id);
    assert.equal(link.closest("p").hidden, false);
    assert.equal(document.querySelector('noscript a[href="' + link.href + '"]').href, link.href);
    assert.equal(document.querySelector('[data-field="receiptId"]').textContent, id);
    assert.match(document.querySelector('[data-field="execution.provider"]').parentElement.textContent, /Provider\s+\(unknown/);
    assert.doesNotMatch(document.body.textContent, /\{receiptId\}/);
  }
});

test("generic receipt shell has append-id guidance and no dead raw JSON link", async () => {
  const document = new JSDOM(await read("marketing/dist/receipts/index.html")).window.document;
  for (const id of ids) {
    const link = document.querySelector('a[href="/receipts/' + id + '"]');
    assert.ok(link, "published example reachable from index");
    for (let node = link; node; node = node.parentElement) assert.notEqual(node.hidden, true);
  }
  assert.ok([...document.querySelectorAll("noscript")].some((node) =>
    node.textContent.includes("append the receipt id to api.averray.com/receipts/")));
  assert.equal(document.querySelector('a[href="https://api.averray.com/receipts/"]'), null);
  assert.equal(document.querySelector("[data-receipt-raw-url]").hasAttribute("href"), false);
  assert.doesNotMatch(document.body.textContent, /\{receiptId\}/);
  const home = await read("marketing/dist/index.html");
  assert.doesNotMatch(home, /href="https:\/\/api\.averray\.com\/(?:badges|receipts)\/[^"]+"/);
});

test("raw JSON link stays visible after successful reading for static and arbitrary receipt IDs", async () => {
  const reader = await read("marketing/public/receipt-reader.js");
  for (const id of [...ids, "0x" + "9".repeat(64)]) {
    const html = await read(ids.includes(id) ? `marketing/dist/receipts/${id}/index.html` : "marketing/dist/receipts/index.html");
    const dom = new JSDOM(html, { url: "https://averray.com/receipts/" + id, runScripts: "outside-only" });
    const { window } = dom;
    window.AverrayReaderFetch = { readJsonWithRetry: async (url) => {
      assert.equal(url, "https://api.averray.com/receipts/" + id);
      return { receiptId: id, verdict: { outcome: "approved" } };
    } };
    window.eval(reader);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(window.document.querySelector("[data-receipt-state]").dataset.receiptState, "ready");
    assert.equal(window.document.querySelector("[data-receipt-status]").hidden, true);
    const link = window.document.querySelector("[data-receipt-raw-url]");
    assert.equal(link.href, "https://api.averray.com/receipts/" + id);
    assert.equal(link.textContent, "api.averray.com/receipts/" + id);
    for (let node = link; node; node = node.parentElement) assert.notEqual(node.hidden, true);
    dom.window.close();
  }
});
