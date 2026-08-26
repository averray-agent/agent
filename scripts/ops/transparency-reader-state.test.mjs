import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const READER = new URL("../../marketing/public/transparency-reader.js", import.meta.url);
const PAGE = new URL("../../marketing/src/pages/transparency.astro", import.meta.url);
const SYNC = new URL("../sync-marketing-site.mjs", import.meta.url);
const DEPLOY = new URL("./deploy-production.sh", import.meta.url);

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
  assert.match(source, />Settled to external wallets \(24h\)</u);
  assert.match(source, /shared\s+self-identity registry/u);
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
