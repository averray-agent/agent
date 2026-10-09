import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { bountyDisclosure } from "./bounty-copy.js";

const require = createRequire(import.meta.url);
const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
function compile(source, modules = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
  } }).outputText, { exports, Date, require: (key) => {
    if (modules[key]) return modules[key];
    if (key === "react" || key === "react/jsx-runtime") return require(key);
    if (key === "@/lib/work/bounty-copy.js") return { bountyDisclosure };
    if (key === "@/lib/utils/cn") return { cn: () => "" };
    if (key === "@/lib/format") return { formatAmount: (amount, asset) => `${amount} ${asset}` };
    // Presentational siblings only. The three target cards and their data
    // adapters execute unchanged; no fixture manufactures the disclosure.
    return new Proxy({}, { get: () => ({ children }) => React.createElement(React.Fragment, null, children) });
  } });
  return exports;
}
const modules = {
  "@/lib/api/job-lifecycle": compile(read("lib/api/job-lifecycle.ts")),
  "@/lib/api/claim-status": compile(read("lib/api/claim-status.ts"))
};
const adapters = compile(read("lib/api/run-adapters.ts"), modules);
const { JobCard } = compile(read("components/runs/JobCard.tsx"), modules);
const { RunRowCard } = compile(read("components/runs/RunQueueTable.tsx") + "\nexport { RunRowCard };", modules);
const { WorkJobCard } = compile(read("components/work/WorkJobList.tsx") + "\nexport { WorkJobCard };", modules);
function renderedText(component, props) {
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(component, props)));
  const text = dom.window.document.body.textContent;
  dom.window.close();
  return text;
}

test("tagged board cards distinguish the served Averray reward from an upstream bounty on all three surfaces", () => {
  for (const title of ["[$30 BOUNTY] fix a bug", "bounty: improve docs", "[Bounty $300] parser fix"]) {
    for (const amount of ["2.75", "8.125"]) {
      const job = { id: "fixture-job", title, rewardAmount: amount, rewardAsset: "USDC", stake: 99,
        verifierMode: "github_pr", state: "open" };
      const expected = `Averray pays ${amount} USDC on merge; any upstream bounty is the maintainer's.`;
      const [recommendation] = adapters.buildRecommendationCards([{ jobId: job.id, netReward: 0.1 }], [job]);
      const [row] = adapters.buildRunRows([job]);
      for (const text of [
        renderedText(WorkJobCard, { job: { ...job, reward: { amount: Number(amount), asset: job.rewardAsset } }, nowMs: null, isNew: false }),
        renderedText(JobCard, { job: recommendation, onClaim() {} }),
        renderedText(RunRowCard, { row, selected: false, onSelect() {} })
      ]) assert.ok(text.includes(expected), text);
    }
  }
});

test("untagged titles stay unchanged and unavailable reward evidence never becomes a baked payout", () => {
  for (const title of ["Fix bounty formatting", "Regular task", undefined]) assert.equal(bountyDisclosure(title, 3, "USDC", "github_pr"), null);
  for (const amount of [null, undefined, "", NaN, -1]) {
    assert.equal(bountyDisclosure("bounty: task", amount, "USDC", "github_pr"), "Averray reward unavailable; any upstream bounty is the maintainer's.");
  }
  assert.equal(bountyDisclosure("bounty: task", 7, undefined, "github_pr"), "Averray reward unavailable; any upstream bounty is the maintainer's.");
});

test("B1b only github_pr jobs promise payment on merge on all three board surfaces", () => {
  for (const verifierMode of ["github_pr", "benchmark", "deterministic", "human", undefined, null, "GITHUB_PR"]) {
    const job = { id: "bounty-mode", title: "[$30 BOUNTY] fix", verifierMode,
      rewardAmount: 7.25, rewardAsset: "USDC", state: "open" };
    const [recommendation] = adapters.buildRecommendationCards([{ jobId: job.id }], [job]);
    const [row] = adapters.buildRunRows([job]);
    for (const text of [
      renderedText(WorkJobCard, { job: { ...job, reward: { amount: 7.25, asset: "USDC" } }, nowMs: null, isNew: false }),
      renderedText(JobCard, { job: recommendation, onClaim() {} }),
      renderedText(RunRowCard, { row, selected: false, onSelect() {} })
    ]) assert.equal(text.includes("Averray pays 7.25 USDC on merge"), verifierMode === "github_pr", String(verifierMode));
  }
});
