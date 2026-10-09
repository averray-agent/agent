import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const MARKETING_CONTENT_FILES = Object.freeze([
  "site/index.html",
  "site/verify/index.html",
  "site/proof-to-pay/index.html",
  "site/why-two-chains/index.html",
  "site/pool/index.html"
]);

const FORBIDDEN_TERMS = Object.freeze([
  ["certification", /certification/iu],
  ["AI agent verification", /AI agent verification/iu],
  ["trusted by", /trusted by/iu],
  ["trustless", /\btrustless\b/iu],
  ["customers", /customers/iu],
  ["testimonial", /testimonial/iu],
  ["revenue", /revenue/iu]
]);

const BAKED_AMOUNT = /\b[0-9]+(?:\.[0-9]+)?\s?(?:USDC|DOT)\b/iu;
const AMOUNT_PAGES = ["site/verify/index.html", "site/proof-to-pay/index.html", "site/why-two-chains/index.html", "site/pool/index.html", "site/transparency/index.html"];

export function assertPoolRecordTruth(pages) {
  for (const path of ["site/transparency/index.html", "site/pool/index.html"]) {
    if (typeof pages[path] !== "string") fail(`${path}: built page is missing`);
    const text = pages[path].replace(/<[^>]*>/gu, " ").replace(/&(?:nbsp|#160|#xA0);/giu, " ");
    if (/\d+(?:\.\d+)?\s*(?:USDC|DOT)\b/iu.test(text)) fail(`${path}: baked amount in whole page`);
    if ((text.match(/0x[a-fA-F0-9]{40}\b/gu) ?? []).length > 0) fail(`${path}: baked pool address in whole page`);
  }
}

export class MarketingContentDisciplineError extends Error {
  constructor(message) {
    super(message);
    this.name = "MarketingContentDisciplineError";
  }
}

function fail(message) {
  throw new MarketingContentDisciplineError(message);
}

export function assertMarketingContentDiscipline(pages) {
  for (const relativePath of MARKETING_CONTENT_FILES) {
    const html = pages[relativePath];
    if (typeof html !== "string") fail(`${relativePath}: built page is missing`);
    if (!/<meta\s+property="og:title"/iu.test(html)) fail(`${relativePath}: og:title is missing`);
    if (!/<meta\s+name="twitter:card"\s+content="summary"/iu.test(html)) {
      fail(`${relativePath}: twitter:card summary is missing`);
    }
    if (!/<meta\s+name="description"/iu.test(html)) fail(`${relativePath}: description meta is missing`);
    for (const [label, pattern] of FORBIDDEN_TERMS) {
      if (pattern.test(html)) fail(`${relativePath}: forbidden public claim "${label}"`);
    }
  }

  for (const relativePath of AMOUNT_PAGES) {
    if (typeof pages[relativePath] !== "string") fail(`${relativePath}: built page is missing`);
    const amount = pages[relativePath].match(BAKED_AMOUNT);
    if (amount) fail(`${relativePath}: baked amount "${amount[0]}" is forbidden`);
  }

  assertPoolRecordTruth(pages);

  const verify = pages["site/verify/index.html"];
  if (!/data-verify-inconclusive(?:\s|>|=)/iu.test(verify)) {
    fail("site/verify/index.html: discovery-rendered inconclusive-run target is missing");
  }
  if (/Inconclusive runs\b/iu.test(verify)) {
    fail("site/verify/index.html: inconclusive-run wording must be rendered from x402 discovery, not baked into markup");
  }
  for (const url of [
    "https://api.averray.com/.well-known/x402",
    "https://api.averray.com/verify/profiles"
  ]) {
    if (!verify.includes(url)) fail(`site/verify/index.html: required live API door is missing: ${url}`);
  }
  const receiptBlock = verify.match(/<section\b[^>]*data-receipt-proof[^>]*>([\s\S]*?)<\/section>/iu)?.[1];
  if (!receiptBlock) fail("site/verify/index.html: receipt proof block is missing");
  if (!/href="\/receipts\/"/iu.test(receiptBlock)) {
    fail("site/verify/index.html: receipt proof block must link the public receipt route");
  }
  if (/href="\/receipts\/0x/iu.test(receiptBlock)) {
    fail("site/verify/index.html: paid-run proof must not be replaced by a demonstration receipt");
  }

  const pool = pages["site/pool/index.html"];
  const poolSurface = pool.match(/<div\b[^>]*data-public-pool[^>]*>([\s\S]*?)<\/div>\s*<footer\b/iu)?.[1];
  if (!poolSurface) fail("site/pool/index.html: public pool surface is missing");
  const poolText = poolSurface.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
  if (/\b[0-9]+(?:\.[0-9]+)?\b/u.test(poolText)) {
    fail("site/pool/index.html: numeric pool figure is baked into markup");
  }
  if (!/data-pool-risk-statement(?:\s|>|=)/iu.test(poolSurface)) {
    fail("site/pool/index.html: API-rendered risk disclosure target is missing");
  }
  if (!/data-pool-yield-attribution(?:\s|>|=)/iu.test(poolSurface)) {
    fail("site/pool/index.html: API-rendered yield attribution target is missing");
  }
  if (/not scheduled|being re-measured|trust-and-capacity|reward entitlement|Flex is a membership/iu.test(poolText)) {
    fail("site/pool/index.html: stale pool history or insider vocabulary is present");
  }
  if (/Technical pilot\. Principal at risk\. No depositor protection\./iu.test(poolSurface)) {
    fail("site/pool/index.html: risk disclosure must be rendered from GET /pool, not baked into markup");
  }
  if (/\b(?:rate|apy|projection)\b|yield\s+date/iu.test(poolText)) {
    fail("site/pool/index.html: forbidden future-performance copy is present");
  }
  const statePosition = poolSurface.indexOf("data-pool-yield-heading");
  const actionPosition = poolSurface.indexOf("data-pool-cta");
  if (statePosition < 0 || actionPosition < 0 || statePosition > actionPosition) {
    fail("site/pool/index.html: live earning state must precede the depositor control");
  }
}

export async function checkBuiltMarketingContent() {
  const pages = Object.fromEntries(await Promise.all([...new Set([...MARKETING_CONTENT_FILES, ...AMOUNT_PAGES])].map(async (relativePath) => [
    relativePath,
    await readFile(resolve(REPO_ROOT, relativePath), "utf8")
  ])));
  assertMarketingContentDiscipline(pages);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await checkBuiltMarketingContent();
  console.log("Marketing content discipline check passed.");
}
