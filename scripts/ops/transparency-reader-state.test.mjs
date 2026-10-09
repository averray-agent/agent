import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";

const READER = new URL("../../marketing/public/transparency-reader.js", import.meta.url);
const PAGE = new URL("../../marketing/src/pages/transparency.astro", import.meta.url);
const SYNC = new URL("../sync-marketing-site.mjs", import.meta.url);
const DEPLOY = new URL("./deploy-production.sh", import.meta.url);

test("Record hides an absent retiredV21 card and restores it when present", async () => {
  const card = { hidden: true };
  const window = { matchMedia: () => ({ matches: false }) };
  const document = { querySelector: (selector) => selector === "[data-retired-v21]" ? card : null, querySelectorAll: () => [] };
  const source = (await readFile(READER, "utf8")).replace('  var placeholder = document.querySelector', '  window.testRender = render; return;\n  var placeholder = document.querySelector');
  runInNewContext(source, { window, document });
  window.testRender({ depositPools: {} });
  assert.equal(card.hidden, true);
  window.testRender({ depositPools: { retiredV21: {} } });
  assert.equal(card.hidden, false);
  window.testRender({ depositPools: {} });
  assert.equal(card.hidden, true);
  assert.match(await readFile(PAGE, "utf8"), /data-retired-v21 hidden/);
});

test("transparency reader shows loading before its first fetch and clears it on render", async () => {
  const source = await readFile(READER, "utf8");
  const loadingCall = source.lastIndexOf("showReaderLoading();");
  const firstReadCall = source.lastIndexOf("readOnce();");

  assert.ok(loadingCall >= 0, "loading state call must exist");
  assert.ok(firstReadCall >= 0, "initial read call must exist");
  assert.ok(loadingCall < firstReadCall, "loading must render before the first fetch starts");
  assert.match(source, /line\.textContent = "Loading live figures…"/u);
  assert.match(source, /setReaderState\("live", "Reading now"\);\s+    clearReaderMessage\(\);/u);
});

test("transparency reader failure points directly to the live payload", async () => {
  const source = await readFile(READER, "utf8");

  assert.match(
    source,
    /Figures are served live; they could not be loaded just now — query /u
  );
  assert.match(source, /link\.href = ENDPOINT/u);
  assert.match(source, /document\.createTextNode\(" directly\."\)/u);
  assert.match(source, /catch \(error\) \{[\s\S]*showReaderFailure\(\);/u);
});

test("the Record separates job origin from registry-classified claimant ownership", async () => {
  const source = await readFile(PAGE, "utf8");

  assert.match(source, />Externally posted <b data-value>/u);
  assert.doesNotMatch(source, />External agents <b data-value>/u);
  assert.match(source, /data-read="flow\.settledToExternalWallets24h"/u);
  assert.match(source, />Jobs settled to external wallets \(24h\)</u);
  assert.match(source, /shared\s+self-identity registry/u);
});

test("M1 reader renders typed authors beside wallets, preserves job units, and refuses the old or missing shape", async () => {
  const page = await readFile(PAGE, "utf8");
  assert.match(page, /Five payouts to unmerged pull requests on 2026-10-08 predate the merged-only rule \(live since 2026-10-08 07:21Z\)\./u);
  assert.match(page, /Authors are GitHub accounts bound to a claim, not verified people\./u);
  assert.match(page, /transparency-reader\.js\?v=20261009/u);
  const dom = new JSDOM(page.replace(/^---[\s\S]*?---/u, ""), { runScripts: "outside-only" });
  const { window } = dom;
  window.matchMedia = () => ({ matches: true });
  const source = (await readFile(READER, "utf8")).replace('  var placeholder = document.querySelector', '  window.testRender = render; return;\n  var placeholder = document.querySelector');
  window.eval(source);
  const field = (value, unit, proof = "bound fixture evidence") => ({ value, unit, readAtMs: Date.now(), status: value === null ? "unknown" : "fresh", source: "fixture", proof });
  const payload = { flow: {
    settledToExternalWallets24h: field(13, "jobs"), externalWallets24h: field(9, "wallets"),
    externalAuthors24h: { ...field(1, "authors"), unattributed: field(3, "jobs") },
    githubAuthors: { distinctAuthors: field(1, "authors"), distinctWallets: field(9, "wallets"), unattributedSessions: field(3, "sessions") }
  } };
  const text = (path, selector = "[data-value]") => window.document.querySelector(`[data-read="${path}"] ${selector}`).textContent;
  window.testRender(payload);
  for (const [path, expected] of [["flow.externalWallets24h", "9"], ["flow.externalAuthors24h", "1"],
    ["flow.externalAuthors24h.unattributed", "3"], ["flow.githubAuthors.distinctAuthors", "1"], ["flow.githubAuthors.distinctWallets", "9"], ["flow.settledToExternalWallets24h", "13"]]) assert.equal(text(path), expected);
  assert.equal(text("flow.settledToExternalWallets24h", "[data-unit]"), "jobs");
  window.testRender({ flow: { externalWallets24h: 9, externalAuthors24h: 1, githubAuthors: { distinctAuthors: 1 } } });
  assert.equal(text("flow.externalAuthors24h"), "no read", "old flat counts cannot masquerade as evidence-backed fields");
  assert.equal(text("flow.externalWallets24h"), "no read");
  window.testRender({ flow: { externalAuthors24h: field(null, "authors", "github_author_evidence_missing") } });
  assert.equal(text("flow.externalAuthors24h"), "no read");
  assert.equal(text("flow.externalAuthors24h", "[data-source]"), "github_author_evidence_missing");
  dom.window.close();
});

test("deposit-pool transparency contains two live-read lanes and no baked figure", async () => {
  const source = await readFile(PAGE, "utf8");
  const section = source.match(/<section[^>]*data-deposit-pools[^>]*>([\s\S]*?)<\/section>/u)?.[1];

  assert.ok(section, "deposit-pool transparency section must exist");
  for (const generation of ["live", "legacy"]) {
    assert.match(section, new RegExp(`data-read="depositPools\\.${generation}\\.label"`, "u"));
    assert.match(section, new RegExp(`data-read="depositPools\\.${generation}\\.totalAssets"`, "u"));
    assert.match(section, new RegExp(`data-read="depositPools\\.${generation}\\.bufferAssets"`, "u"));
    assert.match(section, new RegExp(`data-read="depositPools\\.${generation}\\.deployedStatus"`, "u"));
  }
  assert.doesNotMatch(section, /\b[0-9]+(?:\.[0-9]+)?\s*(?:USDC|DOT)\b/iu);
  assert.doesNotMatch(section, /0x[a-fA-F0-9]{40}/u);
});

test("the transparency page and reader remain in both deployment allow-lists", async () => {
  const [sync, deploy] = await Promise.all([readFile(SYNC, "utf8"), readFile(DEPLOY, "utf8")]);
  assert.match(sync, /"transparency-reader\.js"/u);
  assert.match(sync, /"transparency\/index\.html"/u);
  assert.match(deploy, /"transparency\/index\.html \/transparency\/"/u);
  assert.match(deploy, /"transparency-reader\.js \/transparency-reader\.js"/u);
});
