import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  MarketingContentDisciplineError,
  assertMarketingContentDiscipline
} from "./check-marketing-content-discipline.mjs";

const REPO_ROOT = new URL("../../", import.meta.url);

function safePages(verifyHtml) {
  const meta = '<meta name="description" content="proof"><meta property="og:title" content="Averray"><meta name="twitter:card" content="summary">';
  return {
    "site/index.html": `${meta}<main>Outcome verification and work receipts.</main>`,
    "site/verify/index.html": `${meta}${verifyHtml}`,
    "site/proof-to-pay/index.html": `${meta}<main>Proof-gated escrow. Release on PASS only.</main>`,
    "site/pool/index.html": `${meta}<main><div data-public-pool><h2 data-pool-yield-heading>Reading live state</h2><p data-pool-risk-statement>Reading live disclosure</p><div data-pool-cta hidden>Open depositor view</div></div><footer>Footer</footer></main>`
  };
}

test("content discipline accepts the required Verify disclosures", () => {
  assert.doesNotThrow(() => assertMarketingContentDiscipline(safePages(
    '<main><span data-verify-inconclusive>Loading live terms…</span> https://api.averray.com/.well-known/x402 https://api.averray.com/verify/profiles<section data-receipt-proof><a href="/receipts/">Open the public receipt route</a></section></main>'
  )));
});

test("hard-coding 5 USDC into verify.astro fails the content-discipline lint by name", async () => {
  const source = await readFile(new URL("marketing/src/pages/verify.astro", REPO_ROOT), "utf8");
  const anchor = "<p data-verify-pricing-status>";
  const mutated = source.replace(anchor, `${anchor}<p>5 USDC</p>`);

  assert.notEqual(mutated, source, "mutation anchor must apply before the drill is trusted");
  assert.match(mutated, /5 USDC/u, "the mutated source must contain the forbidden amount");
  assert.throws(
    () => assertMarketingContentDiscipline(safePages(mutated)),
    (error) => (
      error instanceof MarketingContentDisciplineError
      && error.name === "MarketingContentDisciplineError"
      && /baked amount "5 USDC" is forbidden/u.test(error.message)
    )
  );
});

test("the forbidden Verify claim is rejected", () => {
  const pages = safePages(
    '<main><span data-verify-inconclusive>Loading live terms…</span> https://api.averray.com/.well-known/x402 https://api.averray.com/verify/profiles<section data-receipt-proof><a href="/receipts/">Open receipts</a></section><p>trustless</p></main>'
  );

  assert.throws(
    () => assertMarketingContentDiscipline(pages),
    /forbidden public claim "trustless"/u
  );
});

test("static Verify inconclusive-run wording is rejected in favor of discovery rendering", () => {
  const pages = safePages(
    '<main><span data-verify-inconclusive>Inconclusive runs are never charged.</span> https://api.averray.com/.well-known/x402 https://api.averray.com/verify/profiles<section data-receipt-proof><a href="/receipts/">Open receipts</a></section></main>'
  );

  assert.throws(
    () => assertMarketingContentDiscipline(pages),
    /inconclusive-run wording must be rendered from x402 discovery/u
  );
});

test("Verify pricing parses resources[0].accepts[0] and rejects schema drift", async () => {
  const source = await readFile(new URL("marketing/public/verify-reader.js", REPO_ROOT), "utf8");
  const context = { window: {} };
  runInNewContext(source, context);
  const reader = context.window.AverrayVerifyDiscovery;
  const valid = {
    x402Version: 2,
    resources: [{
      resource: "https://api.averray.com/verify/runs",
      description: "Run a pinned Averray verification profile. Inconclusive runs are never charged.",
      accepts: [{
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        amount: "5000000",
        payTo: "0x1013e3fe3f6deb4e61dc023ff69d420dd9ce8f9f"
      }]
    }]
  };

  const terms = reader.parseDiscovery(valid);
  assert.equal(terms.amount, "5");
  assert.equal(terms.assetLabel, "USDC");
  assert.equal(terms.inconclusiveRuns, "Inconclusive runs are never charged.");
  assert.equal(terms.networkLabel, "Base");
  assert.equal(terms.payTo, valid.resources[0].accepts[0].payTo);
  assert.equal(reader.FALLBACK, "Live pricing could not be loaded.");

  for (const malformed of [
    {},
    { x402Version: 2, resources: [] },
    { x402Version: 2, resources: [{ resource: valid.resources[0].resource, description: "No inconclusive terms.", accepts: valid.resources[0].accepts }] },
    { x402Version: 2, resources: [{ resource: valid.resources[0].resource, accepts: [] }] }
  ]) {
    assert.throws(() => reader.parseDiscovery(malformed));
  }
});

test("Verify door links use one label per destination and keep the hero on-page", async () => {
  const source = await readFile(new URL("marketing/src/pages/verify.astro", REPO_ROOT), "utf8");
  const labelsFor = (constantName) => [...source.matchAll(
    new RegExp(`<a[^>]+href=\\{${constantName}\\}[^>]*>([^<]+)<\\/a>`, "gu")
  )].map((match) => match[1].trim());

  assert.deepEqual([...new Set(labelsFor("DISCOVERY_URL"))], ["x402 discovery"]);
  assert.deepEqual([...new Set(labelsFor("PROFILES_URL"))], ["Profiles and worked examples"]);
  assert.match(source, /<CopySnippet label="x402 discovery" value=\{DISCOVERY_URL\} \/>/u);
  assert.match(source, /<CopySnippet label="Profiles and worked examples" value=\{PROFILES_URL\} \/>/u);
  assert.doesNotMatch(source, /Open live profiles|Inspect profiles and worked examples|the discovery document|Open live x402 discovery/u);

  const hero = source.match(/<header class="page-hero">([\s\S]*?)<\/header>/u)?.[1] ?? "";
  assert.match(hero, /href="#verify-purpose">See how Verify works<\/a>/u);
  assert.doesNotMatch(hero, /href=\{(?:DISCOVERY_URL|PROFILES_URL)\}/u);
});

test("Verify cost cards use their middle slot for values without repeating the per-run unit", async () => {
  const [page, reader] = await Promise.all([
    readFile(new URL("marketing/src/pages/verify.astro", REPO_ROOT), "utf8"),
    readFile(new URL("marketing/public/verify-reader.js", REPO_ROOT), "utf8")
  ]);

  assert.match(page, /<p class="pillar__eyebrow">Per run<\/p>\s*<h3 class="pillar__title" data-verify-price>/u);
  assert.match(page, /<p class="pillar__eyebrow">Asset<\/p>\s*<h3 class="pillar__title" data-verify-asset-label>/u);
  assert.match(page, /<p class="pillar__eyebrow">Recipient<\/p>\s*<h3 class="pillar__title verify-term__address"><code data-verify-pay-to>/u);
  assert.doesNotMatch(page, /Published by discovery/u);
  assert.doesNotMatch(reader, /assetLabel \+ " per run"/u);
});

test("marketing build, sync, and deploy gates name both public product pages", async () => {
  const [syncScript, deployScript, workflow] = await Promise.all([
    readFile(new URL("scripts/sync-marketing-site.mjs", REPO_ROOT), "utf8"),
    readFile(new URL("scripts/ops/deploy-production.sh", REPO_ROOT), "utf8"),
    readFile(new URL(".github/workflows/ci.yml", REPO_ROOT), "utf8")
  ]);

  assert.match(syncScript, /"verify-reader\.js"/u);
  assert.match(syncScript, /"reader-fetch\.js"/u);
  assert.match(syncScript, /"verify\/index\.html"/u);
  assert.match(syncScript, /"proof-to-pay\/index\.html"/u);
  assert.match(deployScript, /"verify\/index\.html \/verify\/"/u);
  assert.match(deployScript, /"verify-reader\.js \/verify-reader\.js"/u);
  assert.match(deployScript, /"proof-to-pay\/index\.html \/proof-to-pay\/"/u);
  assert.match(workflow, /npm run build:site\s+          npm run check:site-content/u);
});
