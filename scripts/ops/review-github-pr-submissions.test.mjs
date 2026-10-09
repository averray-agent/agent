import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, review, createReviewRequest, reportReviewError } from "./review-github-pr-submissions.mjs";

test("operator review prints the server 409 body without request credentials", async () => {
  const body = { code: "merge_required", message: "GitHub PR must be merged before approval." };
  const request = createReviewRequest({ baseUrl: "https://api.example.test", token: "fixture-credential",
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => body }) });
  const printed = [];
  await request("POST", "/admin/verifier/run", {}).catch((error) => reportReviewError(error, (line) => printed.push(line)));
  assert.equal(printed.length, 1);
  assert.equal(printed[0], `HTTP 409: ${JSON.stringify(body)}`);
  assert.doesNotMatch(printed[0], /fixture-credential/u);
  reportReviewError(new Error("fixture-credential"), (line) => assert.doesNotMatch(line, /fixture-credential/u));
});

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
  assert.deepEqual(calls.map((c) => c[2]), [{ sessionId: "session", preview: true }, { sessionId: "session", expectOutcome: "disputed" }]);
  assert.throws(() => parseArgs(["--settle", "session"]), /--expect/);
  assert.throws(() => parseArgs(["--list", "--preview", "session"]), /exactly one/);
});

test("list and preview use the read-only admin surfaces", async () => {
  for (const mode of ["list", "preview"]) {
    const calls = [];
    await review({ mode, sessionId: "session" }, { request: async (...args) => { calls.push(args); return {}; }, print: () => {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], mode === "list" ? "/admin/verifier/pending" : "/admin/verifier/run");
    if (mode === "preview") assert.equal(calls[0][2].preview, true);
  }
});

test("parseArgs rejects --run; only --settle with --expect enables settlement", async () => {
  for (const args of [["--run", "session"], ["--run", "session", "--expect", "approved"], ["--run"]]) {
    assert.throws(() => parseArgs(args), /Unknown option: --run/);
  }
  assert.throws(() => parseArgs(["--settle", "session"]), /--expect/);
  assert.throws(() => parseArgs(["--settle", "session", "--expect", "unknown"]), /--expect/);
  const options = parseArgs(["--settle", "session", "--expect", "approved"]);
  assert.equal(options.mode, "settle");
  assert.equal(options.expect, "approved");
  const calls = [];
  await assert.rejects(review({ mode: "run", sessionId: "session" }, {
    request: async (...args) => { calls.push(args); return { outcome: "approved" }; }, print: () => {}
  }), /Unknown review mode: run/);
  assert.deepEqual(calls, []);
});
