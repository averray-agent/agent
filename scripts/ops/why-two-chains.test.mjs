import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test, { before } from "node:test";
import { JSDOM } from "jsdom";
import { assertBaseOnlyX402Surface } from "../../mcp-server/src/payments/x402-discovery.js";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
before(() => execFileSync("npm", ["run", "build:site"], { cwd: root, stdio: "pipe" }));

test("two-chain explainer survives both allow-lists and is linked in the built sitemap and both entry pages", () => {
  assert.match(read("scripts/sync-marketing-site.mjs"), /"why-two-chains\/index\.html"/u);
  assert.match(read("scripts/ops/deploy-production.sh"), /"why-two-chains\/index\.html \/why-two-chains\/"/u);
  assert.match(read("site/sitemap.xml"), /<loc>https:\/\/averray\.com\/why-two-chains\/<\/loc>/u);
  for (const page of ["site/index.html", "site/verify/index.html"]) {
    const dom = new JSDOM(read(page));
    assert.equal(dom.window.document.querySelector('a[href="/why-two-chains/"]').textContent, "Why two chains?");
    dom.window.close();
  }
});

test("two-chain copy fits 150 words, distinguishes the two balances and never bakes a price", () => {
  const dom = new JSDOM(read("site/why-two-chains/index.html"));
  const copy = dom.window.document.querySelector("[data-two-chains-copy]").textContent;
  assert.ok(copy.trim().split(/\s+/u).length <= 150);
  assert.match(copy, /Work settles on Polkadot Hub/u);
  assert.match(copy, /priced in USDC on Base/u);
  assert.match(copy, /does not fund a Hub job or automatically bridge your funds/u);
  assert.doesNotMatch(copy, /\d+(?:\.\d+)?\s*(?:USDC|DOT)|dotUSD|trustless/iu);
  assertBaseOnlyX402Surface(copy);
  assertBaseOnlyX402Surface(JSON.parse(read("discovery/agent-tools.json")));
  dom.window.close();
});
