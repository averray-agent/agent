import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../../", import.meta.url);
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("lib/api/client.ts", root), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { exports, require: () => ({}) });
const { ApiError, extractApiErrorMessage } = exports;

test("API error formatter preserves merge_required from the server error field", () => {
  assert.equal(extractApiErrorMessage(new ApiError("HTTP 409", 409, { error: "merge_required" })), "merge_required");
  assert.equal(extractApiErrorMessage(new ApiError("HTTP 409", 409, { error: "merge_required", message: "Merge first." })), "merge_required · Merge first.");
  assert.equal(extractApiErrorMessage(new ApiError("HTTP 409", 409, { code: "preferred_code", error: "fallback" })), "preferred_code");
  assert.equal(extractApiErrorMessage(new ApiError("HTTP 409", 409, { error: {} })), "HTTP 409");
});

test("overview labels only overdue warnings as overdue, not upstream read failures", () => {
  const page = readFileSync(new URL("app/(authed)/overview/page.tsx", root), "utf8");
  const expression = page.match(/\{(Array\.isArray\(githubReview\?\.warnings\)[^\n]+?) \? " Warning: GitHub PR review overdue\."/u)?.[1];
  assert.ok(expression, "exercise the actual overview warning predicate");
  for (const [warnings, expected] of [
    [[], false], [[{ code: "github_pr_review_read_failures" }], false],
    [[{ code: "github_pr_review_overdue" }], true],
    [[{ code: "github_pr_review_read_failures" }, { code: "github_pr_review_overdue" }], true]
  ]) assert.equal(vm.runInNewContext(expression, { githubReview: { warnings } }), expected);
});
