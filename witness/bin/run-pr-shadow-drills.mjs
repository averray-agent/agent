#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { materializeRepository } from "../src/materialize.mjs";
import { evaluatePrShadowStatic } from "../src/pr-shadow.mjs";
import { assertReadOnlyGitHubAudit } from "../src/pr-shadow-github.mjs";
import { runProcess } from "../src/process.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = resolve(WITNESS_ROOT, "src");

function parseArgs(argv) {
  const result = {
    report: resolve(WITNESS_ROOT, "evidence", "pr-shadow", "report.json"),
    out: resolve(WITNESS_ROOT, "evidence", "pr-shadow", "drills.json")
  };
  for (let index = 0; index < argv.length; index += 2) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--report") result.report = resolve(value);
    else if (arg === "--out") result.out = resolve(value);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

async function git(cwd, args) {
  const result = await runProcess("git", args, { cwd, timeoutSeconds: 30 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "git failed");
  return result.stdout.trim();
}

async function mutationFixture(root) {
  const repository = join(root, "repository");
  await mkdir(join(repository, ".github", "workflows"), { recursive: true });
  await writeFile(join(repository, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  await writeFile(join(repository, ".github", "workflows", "ci.yml"), "name: CI\n");
  await git(repository, ["init"]);
  await git(repository, ["config", "user.name", "Witness shadow drill"]);
  await git(repository, ["config", "user.email", "witness@example.invalid"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "base"]);
  const baseCommit = await git(repository, ["rev-parse", "HEAD"]);
  await writeFile(join(repository, ".github", "workflows", "ci.yml"), "name: CI\non: push\n");
  const diffText = `${await git(repository, [
    "diff", "--binary", "--full-index", "--no-renames", baseCommit, "--"
  ])}\n`;
  const patchPath = join(root, "candidate.patch");
  await writeFile(patchPath, diffText);
  const baseRoot = join(root, "base");
  await materializeRepository({ repo: repository, commit: baseCommit, destination: baseRoot, cwd: root });
  return {
    entry: {
      id: "drill/real-layout#1",
      repository: "drill/real-layout",
      number: 1,
      category: "ci-config",
      selectionReason: "mutation drill",
      check: { id: "suite", command: ["npm", "test"], workingDirectory: "." },
      protectedPaths: [".github/**", "package.json"],
      allowedPaths: ["**"],
      maximumChangedFiles: 10,
      timeoutSeconds: 30
    },
    metadata: {
      repository: "drill/real-layout",
      number: 1,
      title: "Protected layout drill",
      url: "https://example.invalid/drill/1",
      mergedAt: "2026-08-17T00:00:00Z",
      baseCommit,
      headCommit: "b".repeat(40)
    },
    patchPath,
    baseRoot,
    diffText
  };
}

async function loadPolicyMutant(root) {
  const source = await readFile(resolve(SOURCE_ROOT, "pr-shadow.mjs"), "utf8");
  const anchor = "  const policyViolations = evaluateCandidatePolicy(executorContract, inspection);";
  const replacement = "  const policyViolations = []; // MUTANT: protected-path policy disabled";
  const anchorOccurrences = source.split(anchor).length - 1;
  const mutated = anchorOccurrences === 1 ? source.replace(anchor, replacement) : source;
  const applied = anchorOccurrences === 1 && mutated !== source && !mutated.includes(anchor);
  const mutantRoot = join(root, "mutant-src");
  await cp(SOURCE_ROOT, mutantRoot, { recursive: true });
  await writeFile(join(mutantRoot, "pr-shadow.mjs"), mutated);
  const module = await import(`${pathToFileURL(join(mutantRoot, "pr-shadow.mjs")).href}?seen-red=1`);
  return { module, anchorOccurrences, applied };
}

const options = parseArgs(process.argv.slice(2));
const report = JSON.parse(await readFile(options.report, "utf8"));
const resultById = new Map(report.results.map((result) => [result.id, result]));
const protectedIds = ["averray-agent/agent#1110", "depre-dev/averray-reference-agent#802"];
const docsIds = ["averray-agent/agent#1149", "averray-agent/agent#1146"];
const protectedCases = protectedIds.map((id) => {
  const result = resultById.get(id);
  const named = [...(result?.policyViolations || []), ...(result?.integrityViolations || [])]
    .some((violation) => violation.detection === "protected_path_modified");
  return { id, status: result?.verdict === "POLICY_VIOLATION" && named ? "GREEN" : "RED" };
});
const documentationCases = docsIds.map((id) => {
  const result = resultById.get(id);
  return {
    id,
    verdict: result?.verdict || null,
    status: result && result.verdict !== "POLICY_VIOLATION" ? "GREEN" : "RED"
  };
});
const sideEffects = {
  status: report.shadowMode.commentsPosted === 0 &&
    report.shadowMode.statusesPosted === 0 &&
    report.shadowMode.submissionsMade === 0 &&
    report.shadowMode.remotePushes === 0 &&
    assertReadOnlyGitHubAudit(report.shadowMode.auditedOperations) ? "GREEN" : "RED",
  commentsPosted: report.shadowMode.commentsPosted,
  statusesPosted: report.shadowMode.statusesPosted,
  submissionsMade: report.shadowMode.submissionsMade,
  remotePushes: report.shadowMode.remotePushes
};

const temporaryRoot = await mkdtemp(join(tmpdir(), "witness-pr-shadow-drill-"));
let seenRed;
try {
  const fixture = await mutationFixture(temporaryRoot);
  const original = await evaluatePrShadowStatic({
    ...fixture,
    candidateRoot: join(temporaryRoot, "original-candidate")
  });
  const mutant = await loadPolicyMutant(temporaryRoot);
  const mutated = await mutant.module.evaluatePrShadowStatic({
    ...fixture,
    candidateRoot: join(temporaryRoot, "mutant-candidate")
  });
  seenRed = {
    mutation: { anchorOccurrences: mutant.anchorOccurrences, applied: mutant.applied },
    detectorPresent: {
      status: original.verdict === "POLICY_VIOLATION" ? "GREEN" : "RED",
      verdict: original.verdict
    },
    detectorDisabled: {
      status: mutated.verdict !== "POLICY_VIOLATION" ? "RED" : "GREEN",
      verdict: mutated.verdict || "STATIC_CLEAN"
    }
  };
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

const evidence = {
  schemaVersion: "averray.witness.pr-shadow-drills/v1",
  protectedRealLayouts: protectedCases,
  pureDocumentation: documentationCases,
  shadowActsOnNothing: sideEffects,
  seenRed
};
await mkdir(dirname(options.out), { recursive: true });
await writeFile(options.out, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

const passed = protectedCases.every((entry) => entry.status === "GREEN") &&
  documentationCases.every((entry) => entry.status === "GREEN") &&
  sideEffects.status === "GREEN" &&
  seenRed.mutation.anchorOccurrences === 1 &&
  seenRed.mutation.applied === true &&
  seenRed.detectorPresent.status === "GREEN" &&
  seenRed.detectorDisabled.status === "RED";
if (!passed) process.exitCode = 1;
