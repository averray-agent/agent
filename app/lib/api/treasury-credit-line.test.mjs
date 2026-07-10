import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");
const page = readFileSync(resolve(appRoot, "app", "(authed)", "treasury", "page.tsx"), "utf8");
const adapter = readFileSync(resolve(here, "treasury-adapters.ts"), "utf8");
const treasuryDir = resolve(appRoot, "components", "treasury");
const panel = readFileSync(resolve(treasuryDir, "CreditLinePanel.tsx"), "utf8");
const topbar = readFileSync(resolve(treasuryDir, "TreasuryTopbar.tsx"), "utf8");
const creditBuilder = adapter.slice(
  adapter.indexOf("export function buildCreditLine"),
  adapter.indexOf("export function buildRoomVitals")
);

test("treasury requests USDC and includes borrow capacity in page freshness", () => {
  assert.match(page, /useBorrowCapacity\("USDC"\)/u);
  assert.match(page, /creditPresence\s*=\s*feedPresence\(borrowCapacity\)/u);
  assert.match(page, /freshnessFromRequests\(account, strategyPositions, borrowCapacity\)/u);
  assert.match(page, /presence=\{creditPresence\}/u);
});

test("credit line has no fabricated policy cap, live mark, or DOT fallback", () => {
  assert.doesNotMatch(creditBuilder, /["'`]DOT["'`]/u);
  assert.doesNotMatch(creditBuilder, /nextMark|85%/u);
  assert.match(creditBuilder, /const asset = text\(borrow\.asset\)/u);
  assert.match(panel, /cap not emitted by API yet/u);
  assert.doesNotMatch(panel, /Next mark-to-market|85%/u);
});

test("credit line renders explicit non-live and genuinely absent states", () => {
  assert.match(panel, /presence !== "live"/u);
  assert.match(panel, /Borrow-capacity feed/u);
  assert.match(panel, /Borrow capacity not emitted by API yet/u);
  assert.match(panel, /Capacity figures are hidden/u);
});

test("treasury topbar contains no decorative action buttons", () => {
  assert.doesNotMatch(topbar, /Move capital|Propose policy change/u);
  assert.doesNotMatch(topbar, /<button/u);
});

test("treasury components and credit-line path contain no hardcoded DOT symbol", () => {
  const components = readdirSync(treasuryDir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => readFileSync(resolve(treasuryDir, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(`${components}\n${page}\n${creditBuilder}`, /["'`]DOT["'`]/u);
});
