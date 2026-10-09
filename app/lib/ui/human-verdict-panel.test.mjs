import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const root = new URL("../../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
function load(file, modules) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(read(file), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022
  } }).outputText, { exports, require: (name) => modules[name] ?? require(name) });
  return exports;
}

test("HumanVerdictPanel renders the merge_required 409 message and leaves retry controls enabled", async () => {
  const client = load("lib/api/client.ts", { "../../../sdk/agent-platform-client.js": {}, "@/lib/auth/token-store": {}, "./reader-fetch.js": {} });
  const message = "An upstream-verified merge is required before approving this GitHub PR.";
  const error = new client.ApiError("HTTP 409", 409, { code: "merge_required", message });
  const states = ["approve", "Public rationale long enough for review.", false, "", false];
  let index = 0;
  const { HumanVerdictPanel } = load("components/sessions/HumanVerdictPanel.tsx", {
    react: { useState: () => { const i = index++; return [states[i], (value) => { states[i] = value; }]; } },
    swr: { useSWRConfig: () => ({ mutate: () => assert.fail("failed verdict must not refresh success") }) },
    "@/lib/auth/use-auth": { useAuth: () => ({ roles: ["admin"] }) },
    "@/lib/api/client": { ...client, swrFetcher: async () => { throw error; } },
    "@/components/shell/DetailDrawer": { DrawerSection: ({ children }) => React.createElement("div", null, children) }
  });
  const first = HumanVerdictPanel({ sessionId: "session" });
  await first.props.children.props.onSubmit({ preventDefault() {} });
  index = 0;
  const html = renderToStaticMarkup(HumanVerdictPanel({ sessionId: "session" }));
  assert.match(html, /role="status"/u);
  assert.ok(html.includes(message));
  assert.equal(states[2], false);
  assert.equal(states[4], false);
});

test("overview owns the waiting-for-merge and overdue-review labels from status fields", () => {
  const source = read("app/(authed)/overview/page.tsx");
  assert.match(source, /githubReview\?\.waitingForMerge/u);
  assert.match(source, /githubReview\?\.overdueReview/u);
  assert.match(source, /\$\{waitingForMerge\} waiting for merge/u);
  assert.match(source, /\$\{overdueReview\} overdue review/u);
  assert.doesNotMatch(source, /submitted non-automatic reviews pending/u);
});
