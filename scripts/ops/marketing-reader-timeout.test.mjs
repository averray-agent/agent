import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const REPO_ROOT = new URL("../../", import.meta.url);

test("public readers time out and retry a never-resolving fetch exactly once", async () => {
  const source = await readFile(new URL("marketing/public/reader-fetch.js", REPO_ROOT), "utf8");
  const context = { AbortController, clearTimeout, setTimeout };
  context.window = context;
  vm.runInNewContext(source, context, { filename: "reader-fetch.js" });

  let calls = 0;
  const neverResolvingFetch = (_url, options) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("request aborted by timeout")), { once: true });
    });
  };

  await assert.rejects(
    context.AverrayReaderFetch.readJsonWithRetry("https://api.averray.com/test", {}, {
      AbortController,
      clearTimeout,
      fetch: neverResolvingFetch,
      setTimeout,
      timeoutMs: 5
    }),
    /request aborted by timeout/u
  );
  assert.equal(calls, 2, "the initial timed-out read gets one bounded retry");
  assert.equal(context.AverrayReaderFetch.DEFAULT_TIMEOUT_MS, 3000);
});

test("all live marketing readers use the shared bounded reader", async () => {
  const readers = [
    "verify-reader.js",
    "pool-reader.js",
    "trust-providers.js",
    "receipt-reader.js",
    "transparency-reader.js"
  ];
  for (const reader of readers) {
    const source = await readFile(new URL(`marketing/public/${reader}`, REPO_ROOT), "utf8");
    assert.match(source, /AverrayReaderFetch\.readJsonWithRetry/u, `${reader} must use the bounded reader`);
  }
});
