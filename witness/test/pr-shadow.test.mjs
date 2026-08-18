import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { VERDICTS } from "../src/executor.mjs";
import { materializeRepository } from "../src/materialize.mjs";
import {
  SHADOW_LIMITATION,
  buildPrShadowReport,
  derivePrShadowContract,
  evaluatePrShadowStatic,
  flattenPrShadowManifest,
  renderPrShadowMarkdown
} from "../src/pr-shadow.mjs";
import { assertReadOnlyGitHubAudit, createReadOnlyGitHubClient } from "../src/pr-shadow-github.mjs";
import { PullRequestSource } from "../src/pr-shadow-source.mjs";
import { runProcess } from "../src/process.mjs";

const BASE_ENTRY = Object.freeze({
  id: "example/widgets#7",
  repository: "example/widgets",
  number: 7,
  category: "fixture",
  selectionReason: "test",
  check: { id: "suite", command: ["npm", "test"], workingDirectory: "." },
  protectedPaths: [".github/**", "package.json"],
  allowedPaths: ["**"],
  maximumChangedFiles: 100,
  timeoutSeconds: 30
});

const METADATA = Object.freeze({
  repository: "example/widgets",
  number: 7,
  title: "Fixture PR",
  url: "https://github.com/example/widgets/pull/7",
  mergedAt: "2026-08-17T00:00:00Z",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40)
});

async function git(cwd, args) {
  const result = await runProcess("git", args, { cwd, timeoutSeconds: 30 });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function staticFixture(context, { path, content, baseContent }) {
  const root = await mkdtemp(join(tmpdir(), "witness-pr-shadow-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  await mkdir(join(repository, ".github", "workflows"), { recursive: true });
  await mkdir(join(repository, "docs"), { recursive: true });
  await writeFile(join(repository, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  await writeFile(join(repository, ".github", "workflows", "ci.yml"), "name: CI\n");
  await writeFile(join(repository, "docs", "README.md"), "before\n");
  if (baseContent !== undefined) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), baseContent);
  }
  await git(repository, ["init"]);
  await git(repository, ["config", "user.name", "Witness shadow test"]);
  await git(repository, ["config", "user.email", "witness@example.invalid"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "base"]);
  const baseCommit = await git(repository, ["rev-parse", "HEAD"]);
  await writeFile(join(repository, path), content);
  const diff = await git(repository, ["diff", "--binary", "--full-index", "--no-renames", baseCommit, "--"]);
  const patchPath = join(root, "candidate.patch");
  await writeFile(patchPath, `${diff}\n`);
  const baseRoot = join(root, "base");
  await materializeRepository({ repo: repository, commit: baseCommit, destination: baseRoot, cwd: root });
  return {
    patchPath,
    baseRoot,
    candidateRoot: join(root, "candidate"),
    diffText: `${diff}\n`,
    metadata: { ...METADATA, baseCommit }
  };
}

test("derived PR contract is explicitly AV-1+integrity with no author or differential claim", () => {
  const contract = derivePrShadowContract({
    entry: BASE_ENTRY,
    metadata: METADATA,
    diffBytes: Buffer.from("diff")
  });
  assert.equal(contract.assurance.level, "AV-1+integrity");
  assert.equal(contract.assurance.targetedCheck, false);
  assert.equal(contract.assurance.differentialLogicExercised, false);
  assert.equal(contract.pullRequest.contractAuthor, null);
  assert.equal(contract.check.commandResolution.definitionFile, "package.json");
});

test("a real-layout CI change is POLICY_VIOLATION with the causing hunk", async (context) => {
  const fixture = await staticFixture(context, {
    path: ".github/workflows/ci.yml",
    content: "name: CI\non: push\n"
  });
  const result = await evaluatePrShadowStatic({ entry: BASE_ENTRY, ...fixture });
  assert.equal(result.verdict, VERDICTS.POLICY_VIOLATION);
  const violation = result.policyViolations.find((entry) => entry.detection === "protected_path_modified");
  assert.ok(violation);
  assert.equal(violation.diffHunks[0].path, ".github/workflows/ci.yml");
  assert.match(violation.diffHunks[0].hunk, /\+on: push/u);
});

test("a pure documentation PR is statically clean and never POLICY_VIOLATION", async (context) => {
  const fixture = await staticFixture(context, {
    path: "docs/README.md",
    content: "after\n"
  });
  const result = await evaluatePrShadowStatic({ entry: BASE_ENTRY, ...fixture });
  assert.equal(result.verdict, null);
  assert.deepEqual(result.policyViolations, []);
  assert.deepEqual(result.integrityViolations, []);
  assert.deepEqual(result.integrityAmbiguities, []);
});

test("a renamed-and-expanded test is verifier INCONCLUSIVE in the PR shadow", async (context) => {
  const fixture = await staticFixture(context, {
    path: "test/value.test.js",
    baseContent: [
      'import test from "node:test";',
      'test("returns one", () => {});',
      ""
    ].join("\n"),
    content: [
      'import test from "node:test";',
      'test("returns the current value", () => {});',
      'test("returns a number", () => {});',
      ""
    ].join("\n")
  });
  const result = await evaluatePrShadowStatic({ entry: BASE_ENTRY, ...fixture });
  assert.equal(result.verdict, VERDICTS.INCONCLUSIVE);
  assert.equal(result.attribution, "verifier");
  assert.equal(result.reason, "integrity_detection_ambiguous");
  assert.equal(result.workerConsequence, "none");
  assert.equal(result.verifierReputationSignal.kind, "evidence_completeness_gap");
  assert.deepEqual(result.policyViolations, []);
  assert.deepEqual(result.integrityViolations, []);
  assert.equal(result.integrityAmbiguities.length, 1);
  assert.equal(result.integrityAmbiguities[0].detection, "test_deletion");
  assert.match(result.integrityAmbiguities[0].diffHunks[0].hunk, /returns the current value/u);
});

test("rule 5 leaves an unresolvable real-style Make command cleanly INCONCLUSIVE", async (context) => {
  const fixture = await staticFixture(context, {
    path: "docs/README.md",
    content: "after\n"
  });
  const result = await evaluatePrShadowStatic({
    entry: {
      ...BASE_ENTRY,
      check: { id: "gate", command: ["make", "gate"], workingDirectory: "." },
      protectedPaths: ["Makefile"]
    },
    ...fixture
  });
  assert.equal(result.verdict, VERDICTS.INCONCLUSIVE);
  assert.equal(result.reason, "unresolvable_command");
  assert.equal(result.attribution, "contract");
});

test("shadow GitHub transport exposes only GET and clone and rejects mutation-shaped audit", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "witness-pr-shadow-github-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const audit = [];
  const calls = [];
  const client = createReadOnlyGitHubClient({
    audit,
    run: async (program, args) => {
      calls.push({ program, args });
      return args[0] === "api"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              merged_at: METADATA.mergedAt,
              base: { sha: METADATA.baseCommit },
              head: { sha: METADATA.headCommit },
              title: METADATA.title,
              html_url: METADATA.url
            }),
            stderr: "",
            spawnError: null
          }
        : { exitCode: 0, stdout: "", stderr: "", spawnError: null };
    }
  });
  await client.getMergedPullRequest("example/widgets", 7);
  await client.cloneMirror("example/widgets", join(root, "mirror.git"));
  assert.equal(assertReadOnlyGitHubAudit(audit), true);
  assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
    ["api", "--method", "GET"],
    ["repo", "clone", "example/widgets"]
  ]);
  assert.equal(audit[1].args[3], "<temporary-mirror>");
  assert.equal(JSON.stringify(audit).includes(root), false);
  assert.throws(() => assertReadOnlyGitHubAudit([{
    program: "gh",
    args: ["api", "--method", "POST", "repos/example/widgets/statuses"],
    access: "read"
  }]), /not GET-only/u);
});

test("PR source materializes a detached working tree from a bare read-only mirror", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "witness-pr-shadow-source-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "README.md"), "materialized\n");
  await git(repository, ["init"]);
  await git(repository, ["config", "user.name", "Witness shadow source test"]);
  await git(repository, ["config", "user.email", "witness@example.invalid"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "base"]);
  const commit = await git(repository, ["rev-parse", "HEAD"]);
  const defaultBranch = await git(repository, ["branch", "--show-current"]);
  await git(repository, ["switch", "-c", "feature"]);
  await writeFile(join(repository, "FEATURE.md"), "feature\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "feature"]);
  const headCommit = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["update-ref", "refs/pull/7/head", headCommit]);
  await git(repository, ["switch", defaultBranch]);
  await writeFile(join(repository, "MAIN.md"), "main advanced\n");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "main advanced"]);
  const baseRefCommit = await git(repository, ["rev-parse", "HEAD"]);
  const mirror = join(root, "mirror.git");
  await git(root, ["clone", "--mirror", repository, mirror]);
  const source = new PullRequestSource({ repository: "example/widgets", mirror });
  const prepared = await source.prepare({
    ...METADATA,
    baseCommit: baseRefCommit,
    headCommit
  });
  assert.equal(prepared.baseRefCommit, baseRefCommit);
  assert.equal(prepared.baseCommit, commit);
  assert.equal(prepared.headCommit, headCommit);
  const checkout = join(root, "checkout");
  const result = await source.materialize(commit, checkout);
  assert.equal(result.commit, commit);
  assert.equal(await readFile(join(checkout, "README.md"), "utf8"), "materialized\n");
});

test("batch report leads with adjudicated false positives and every violation case", () => {
  const violation = {
    detection: "protected_path_modified",
    message: ".github/workflows/ci.yml is protected",
    paths: [".github/workflows/ci.yml"],
    evidence: [],
    source: "candidate-policy",
    key: "example/widgets#7:protected_path_modified:.github/workflows/ci.yml",
    diffHunks: [{ path: ".github/workflows/ci.yml", hunk: "@@ -1 +1,2 @@\n name: CI\n+on: push" }]
  };
  const report = buildPrShadowReport({
    manifest: {
      frozenAt: "2026-08-17T00:00:00Z",
      selectionMethod: ["fixture"]
    },
    githubAudit: [],
    judgements: {
      policyViolations: {
        [violation.key]: { classification: "false_positive", rationale: "Authorized CI maintenance." }
      }
    },
    results: [{
      id: "example/widgets#7",
      contract: { pullRequest: { url: METADATA.url, title: METADATA.title } },
      verdict: VERDICTS.POLICY_VIOLATION,
      attribution: null,
      reason: "candidate_policy_or_integrity_violation",
      policyViolations: [violation],
      integrityViolations: []
    }]
  });
  assert.deepEqual(report.falsePositiveRate, {
    pullRequests: 1,
    total: 1,
    ratePct: 100,
    definition: "distinct legitimate merged PRs with at least one adjudicated false-positive violation / all shadowed PRs"
  });
  assert.equal(report.policyViolationCases[0].violations[0].judgement.classification, "false_positive");
  assert.deepEqual(report.verdictDistribution, {
    PASS: 0,
    FAIL: 0,
    INCONCLUSIVE: 0,
    POLICY_VIOLATION: 1
  });
  assert.equal(report.falsePositiveRatePerDetection.assertion_neutering.falsePositiveRatePct, 0);
  assert.deepEqual(report.assurance.integrityDetectionsEvaluated, [
    "test_deletion",
    "skip_or_xfail_markers_added",
    "runner_replacement",
    "assertion_neutering",
    "snapshot_rewrite_to_accept_current",
    "coverage_or_lint_exclusion_of_changed_files",
    "error_swallowing_to_force_zero_exit"
  ]);
  const markdown = renderPrShadowMarkdown(report);
  assert.match(markdown, /False-positive rate: 1\/1 \(100%\)/u);
  assert.match(markdown, /\+on: push/u);
  assert.match(markdown, new RegExp(SHADOW_LIMITATION.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("batch report keeps detector ambiguity separate from POLICY_VIOLATION", () => {
  const finding = {
    detection: "test_deletion",
    message: "rename versus removal cannot be determined",
    confidence: "ambiguous",
    paths: ["test/value.test.js"],
    evidence: ['test("old", () => {})'],
    source: "integrity-ambiguity",
    key: "example/widgets#7:test_deletion:test/value.test.js",
    diffHunks: [{
      path: "test/value.test.js",
      hunk: '@@ -1 +1 @@\n-test("old", () => {})\n+test("new", () => {})'
    }]
  };
  const report = buildPrShadowReport({
    manifest: { frozenAt: "2026-08-17T00:00:00Z", selectionMethod: ["fixture"] },
    githubAudit: [],
    judgements: {
      inconclusiveAttribution: {
        "example/widgets#7": { accuracy: "accurate", rationale: "The diff is ambiguous." }
      }
    },
    results: [{
      id: "example/widgets#7",
      contract: { pullRequest: { url: METADATA.url, title: METADATA.title } },
      verdict: VERDICTS.INCONCLUSIVE,
      attribution: "verifier",
      reason: "integrity_detection_ambiguous",
      policyViolations: [],
      integrityViolations: [],
      integrityAmbiguities: [finding]
    }]
  });
  assert.deepEqual(report.policyViolationRate, { pullRequests: 0, total: 1, ratePct: 0 });
  assert.deepEqual(report.falsePositiveRate, {
    pullRequests: 0,
    total: 1,
    ratePct: 0,
    definition: "distinct legitimate merged PRs with at least one adjudicated false-positive violation / all shadowed PRs"
  });
  assert.deepEqual(report.integrityAmbiguityRate, { pullRequests: 1, total: 1, ratePct: 100 });
  assert.equal(report.integrityAmbiguityCases[0].findings[0].confidence, "ambiguous");
  assert.equal(report.inconclusiveAttributionAccuracy.accurate, 1);
  assert.match(renderPrShadowMarkdown(report), /Detector ambiguities[\s\S]*example\/widgets#7/u);
});

test("the committed corpus is exactly 20 mixed PRs and includes protected and docs drills", async () => {
  const manifest = JSON.parse(await readFile(new URL("../corpus/merged-pr-shadow.json", import.meta.url), "utf8"));
  const cases = flattenPrShadowManifest(manifest);
  assert.equal(cases.length, 20);
  assert.ok(cases.some((entry) => entry.category === "ci-config"));
  assert.ok(cases.some((entry) => entry.category === "test-only"));
  assert.ok(cases.some((entry) => entry.category === "documentation"));
  assert.equal(new Set(cases.map((entry) => entry.repository)).size, 3);
});
