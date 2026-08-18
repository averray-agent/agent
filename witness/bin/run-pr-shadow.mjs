#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPrShadowReport,
  evaluateMergedPullRequest,
  flattenPrShadowManifest,
  renderPrShadowMarkdown
} from "../src/pr-shadow.mjs";
import { assertReadOnlyGitHubAudit, createReadOnlyGitHubClient } from "../src/pr-shadow-github.mjs";
import { PullRequestSource } from "../src/pr-shadow-source.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    manifest: resolve(WITNESS_ROOT, "corpus", "merged-pr-shadow.json"),
    judgements: resolve(WITNESS_ROOT, "corpus", "merged-pr-shadow-judgements.json"),
    out: resolve(WITNESS_ROOT, "evidence", "pr-shadow", "report.json"),
    cacheDir: resolve(WITNESS_ROOT, "cache", "pr-shadow"),
    staticOnly: false,
    allowUnreviewed: false,
    caseId: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--static-only") options.staticOnly = true;
    else if (arg === "--allow-unreviewed") options.allowUnreviewed = true;
    else if (["--manifest", "--judgements", "--out", "--cache-dir", "--case"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--manifest") options.manifest = resolve(value);
      else if (arg === "--judgements") options.judgements = resolve(value);
      else if (arg === "--out") options.out = resolve(value);
      else if (arg === "--cache-dir") options.cacheDir = resolve(value);
      else options.caseId = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function safeName(repository) {
  return repository.replaceAll(/[^A-Za-z0-9_.-]+/gu, "-");
}

function setupFailure(entry, error) {
  return {
    id: entry.id,
    category: entry.category,
    selectionReason: entry.selectionReason,
    contract: null,
    verdict: "INCONCLUSIVE",
    attribution: "infrastructure",
    reason: "case_setup_failure",
    details: error.message,
    patch: null,
    policyViolations: [],
    integrityViolations: [],
    integrityAmbiguities: [],
    checks: null,
    seconds: 0
  };
}

function markdownPath(jsonPath) {
  return jsonPath.endsWith(".json") ? `${jsonPath.slice(0, -5)}.md` : `${jsonPath}.md`;
}

const options = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
const judgements = JSON.parse(await readFile(options.judgements, "utf8"));
let cases = flattenPrShadowManifest(manifest);
if (options.caseId) cases = cases.filter((entry) => entry.id === options.caseId);
if (cases.length === 0) throw new Error(`no PR shadow cases selected${options.caseId ? ` for ${options.caseId}` : ""}`);

await mkdir(options.cacheDir, { recursive: true, mode: 0o700 });
await mkdir(dirname(options.out), { recursive: true, mode: 0o700 });
const githubAudit = [];
const github = createReadOnlyGitHubClient({ audit: githubAudit });
const sources = new Map();

async function sourceFor(repository) {
  if (sources.has(repository)) return sources.get(repository);
  const mirror = resolve(options.cacheDir, "mirrors", `${safeName(repository)}.git`);
  if (!await exists(mirror)) await github.cloneMirror(repository, mirror);
  const source = new PullRequestSource({ repository, mirror });
  sources.set(repository, source);
  return source;
}

const results = [];
for (const [index, entry] of cases.entries()) {
  console.error(`[${index + 1}/${cases.length}] ${entry.id} (${entry.category})`);
  try {
    const metadata = await github.getMergedPullRequest(entry.repository, entry.number);
    const source = await sourceFor(entry.repository);
    const result = await evaluateMergedPullRequest({
      entry,
      metadata,
      source,
      temporaryParent: options.cacheDir,
      cacheDirectory: resolve(options.cacheDir, "dependencies", safeName(entry.repository)),
      staticOnly: options.staticOnly
    }, {
      preflightTemporaryParent: options.cacheDir
    });
    results.push(result);
    console.error(`  ${result.verdict} (${result.reason || "clean"}; ${result.seconds}s)`);
  } catch (error) {
    const result = setupFailure(entry, error);
    results.push(result);
    console.error(`  INCONCLUSIVE (${result.reason}: ${result.details})`);
  }
}

assertReadOnlyGitHubAudit(githubAudit);
const report = buildPrShadowReport({ manifest, results, githubAudit, judgements });
await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(markdownPath(options.out), renderPrShadowMarkdown(report));

const unreviewedViolations = report.policyViolationCases.flatMap((entry) => entry.violations)
  .filter((violation) => violation.judgement.classification === "unreviewed");
const unreviewedAttributions = report.results
  .filter((result) => result.verdict === "INCONCLUSIVE" &&
    result.inconclusiveAttributionJudgement?.accuracy === "unreviewed");
console.log(JSON.stringify({
  falsePositiveRate: report.falsePositiveRate,
  verdictDistribution: report.verdictDistribution,
  policyViolationCases: report.policyViolationCases.map((entry) => entry.id),
  integrityAmbiguities: report.integrityAmbiguityRate,
  integrityAmbiguityCases: report.integrityAmbiguityCases.map((entry) => entry.id),
  inconclusive: report.inconclusiveRate,
  output: options.out,
  markdown: markdownPath(options.out)
}, null, 2));
if (!options.allowUnreviewed && (unreviewedViolations.length > 0 || unreviewedAttributions.length > 0)) {
  console.error(
    `report has ${unreviewedViolations.length} unreviewed violation(s) and ` +
    `${unreviewedAttributions.length} unreviewed INCONCLUSIVE attribution(s)`
  );
  process.exitCode = 2;
}
