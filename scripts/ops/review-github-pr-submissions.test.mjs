import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, review } from "./review-github-pr-submissions.mjs";

test("settle prints the same-handler preview and exits two without a settlement call on an outcome mismatch", async () => {
  const calls = [], printed = [];
  const request = async (...args) => { calls.push(args); return { outcome: "disputed", handler: "human_fallback", score: 80 }; };
  const options = parseArgs(["--settle", "session", "--expect", "approved"]);
  assert.equal(await review(options, { request, print: (s) => printed.push(s) }), 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].preview, true);
  assert.equal(JSON.parse(printed[0]).handler, "human_fallback");
  calls.length = 0;
  assert.equal(await review({ ...options, expect: "disputed" }, { request, print: () => {} }), 0);
  assert.deepEqual(calls.map((c) => c[2]), [{ sessionId: "session", preview: true }, { sessionId: "session" }]);
  assert.throws(() => parseArgs(["--settle", "session"]), /--expect/);
  assert.throws(() => parseArgs(["--list", "--run", "session"]), /exactly one/);
});

test("list, preview and explicit run use the admin surfaces", async () => {
  for (const mode of ["list", "preview", "run"]) {
    const calls = [];
    await review({ mode, sessionId: "session" }, { request: async (...args) => { calls.push(args); return {}; }, print: () => {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], mode === "list" ? "/admin/verifier/pending" : "/admin/verifier/run");
    if (mode === "preview") assert.equal(calls[0][2].preview, true);
  }
});
