import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const READER = new URL("../../marketing/public/transparency-reader.js", import.meta.url);

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
