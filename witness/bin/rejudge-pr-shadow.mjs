#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPrShadowReport, renderPrShadowMarkdown } from "../src/pr-shadow.mjs";
import { assertReadOnlyGitHubAudit } from "../src/pr-shadow-github.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    input: resolve(WITNESS_ROOT, "evidence", "pr-shadow", "discovery.json"),
    manifest: resolve(WITNESS_ROOT, "corpus", "merged-pr-shadow.json"),
    judgements: resolve(WITNESS_ROOT, "corpus", "merged-pr-shadow-judgements.json"),
    out: resolve(WITNESS_ROOT, "evidence", "pr-shadow", "report.json")
  };
  for (let index = 0; index < argv.length; index += 2) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--input") options.input = resolve(value);
    else if (arg === "--manifest") options.manifest = resolve(value);
    else if (arg === "--judgements") options.judgements = resolve(value);
    else if (arg === "--out") options.out = resolve(value);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function markdownPath(jsonPath) {
  return jsonPath.endsWith(".json") ? `${jsonPath.slice(0, -5)}.md` : `${jsonPath}.md`;
}

const options = parseArgs(process.argv.slice(2));
const [previous, manifest, judgements] = await Promise.all([
  readFile(options.input, "utf8").then(JSON.parse),
  readFile(options.manifest, "utf8").then(JSON.parse),
  readFile(options.judgements, "utf8").then(JSON.parse)
]);
if (previous.schemaVersion !== "averray.witness.pr-shadow-report/v1" || !Array.isArray(previous.results)) {
  throw new Error("input is not a Witness merged-PR shadow report");
}
const githubAudit = previous.shadowMode?.auditedOperations || [];
assertReadOnlyGitHubAudit(githubAudit);
const report = buildPrShadowReport({ manifest, results: previous.results, githubAudit, judgements });
await mkdir(dirname(options.out), { recursive: true, mode: 0o700 });
await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(markdownPath(options.out), renderPrShadowMarkdown(report));
process.stdout.write(`${JSON.stringify({
  falsePositiveRate: report.falsePositiveRate,
  verdictDistribution: report.verdictDistribution,
  inconclusive: report.inconclusiveRate,
  output: options.out,
  markdown: markdownPath(options.out)
}, null, 2)}\n`);

const unreviewedViolations = report.policyViolationCases.flatMap((entry) => entry.violations)
  .filter((violation) => violation.judgement.classification === "unreviewed");
const unreviewedAttributions = report.results.filter((result) =>
  result.verdict === "INCONCLUSIVE" && result.inconclusiveAttributionJudgement?.accuracy === "unreviewed"
);
if (unreviewedViolations.length > 0 || unreviewedAttributions.length > 0) process.exitCode = 2;
