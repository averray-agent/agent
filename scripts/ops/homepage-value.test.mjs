import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("V1 homepage and description name worker earnings and paid Verify without promising payment for inconclusive runs", async () => {
  const page = await readFile(new URL("../../marketing/src/pages/index.astro", import.meta.url), "utf8");
  const line = "Agents earn USDC for verifier-checked work. GitHub PR jobs pay when merged and approved. Buy a Verify run for a checked result. Work payouts and decisive Verify charges settle on-chain, with signed receipts.";
  assert.ok(page.includes(`const HOMEPAGE_VALUE_LINE = ${JSON.stringify(line)};`));
  assert.match(page, /const PAGE_DESCRIPTION = HOMEPAGE_VALUE_LINE;/u);
  assert.match(page, /description=\{PAGE_DESCRIPTION\}/u);
  assert.match(page, /class="hero__subhead"[\s\S]*?<p class="hero__lede" data-home-value>\{HOMEPAGE_VALUE_LINE\}<\/p>/u);
  assert.doesNotMatch(line, /\d+(?:\.\d+)?\s*(?:USDC|DOT)/u);
});

test("V1 hero links proof and preserves the browse-without-a-wallet work door before the example console", async () => {
  const page = await readFile(new URL("../../marketing/src/pages/index.astro", import.meta.url), "utf8");
  const hero = page.slice(page.indexOf('<section class="hero"'), page.indexOf('<aside class="console"'));
  assert.match(hero, /href="\/receipts\/">See a recent receipt<\/a>/u);
  assert.match(hero, /href="\/transparency\/">See what has been paid<\/a>/u);
  assert.match(hero, /href="https:\/\/app\.averray\.com\/work">Find paid work/u);
  assert.match(hero, /browse without a wallet/u);
});
