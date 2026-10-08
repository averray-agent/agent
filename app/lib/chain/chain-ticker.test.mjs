import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

test("review backlog does not degrade a fresh healthy chain chip", () => {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../chain-ticker.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, { exports });
  const nowMs = Date.parse("2026-10-08T12:00:00Z");
  const health = { status: "degraded", serviceHealth: { ok: true }, warnings: [{ code: "github_pr_review_overdue" }],
    components: { blockchain: { ok: true, blockNumber: 123, asOf: new Date(nowMs).toISOString() } } };
  assert.equal(exports.deriveChainTicker({ health, nowMs }).tone, "ok");
  health.components.blockchain.ok = false;
  assert.equal(exports.deriveChainTicker({ health, nowMs }).tone, "degraded");
});
