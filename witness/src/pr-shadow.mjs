import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  applyCandidatePatch,
  evaluateCandidatePolicy,
  inspectCandidatePatch
} from "./candidate-patch.mjs";
import { CLASSIFICATIONS } from "./constants.mjs";
import { VERDICTS } from "./executor.mjs";
import { INTEGRITY_DETECTION_SUPPORT, detectIntegrityViolations } from "./integrity.mjs";
import { createAttemptCopy } from "./materialize.mjs";
import { runPreflight } from "./preflight.mjs";
import { isProtectedPath, resolveJudgingCommandDefinition } from "./verification-contract.mjs";

export const PR_SHADOW_CONTRACT_SCHEMA = "averray.witness.pr-shadow-contract/v1";
export const PR_SHADOW_REPORT_SCHEMA = "averray.witness.pr-shadow-report/v1";
export const ALL_INTEGRITY_DETECTIONS = Object.freeze(Object.keys(INTEGRITY_DETECTION_SUPPORT));
export const SHADOW_LIMITATION =
  "This shadow measures AV-1 plus integrity. It has no targeted check, does not know what each pull request was supposed to fix, and does not exercise AV-2 differential logic.";

const SUCCESSFUL_MATERIALIZATIONS = new Set([
  CLASSIFICATIONS.HERMETIC,
  CLASSIFICATIONS.FROZEN_DEPENDENCIES,
  CLASSIFICATIONS.MOCKED_EXTERNAL_SYSTEM
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function shadowCaseId(repository, number) {
  return `${repository}#${number}`;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new Error(`${label} must be a non-empty string array`);
  }
}

export function flattenPrShadowManifest(manifest) {
  if (manifest?.schemaVersion !== "averray.witness.pr-shadow-corpus/v1") {
    throw new Error("unsupported PR shadow corpus schemaVersion");
  }
  assertString(manifest.frozenAt, "manifest.frozenAt");
  if (!Array.isArray(manifest.repositories) || manifest.repositories.length === 0) {
    throw new Error("manifest.repositories must be non-empty");
  }
  const cases = [];
  const seen = new Set();
  for (const repositoryEntry of manifest.repositories) {
    assertString(repositoryEntry.repository, "repository.repository");
    assertStringArray(repositoryEntry.check?.command, `${repositoryEntry.repository}.check.command`);
    assertString(repositoryEntry.check?.workingDirectory, `${repositoryEntry.repository}.check.workingDirectory`);
    assertStringArray(repositoryEntry.protectedPaths, `${repositoryEntry.repository}.protectedPaths`);
    if (!Array.isArray(repositoryEntry.pullRequests) || repositoryEntry.pullRequests.length === 0) {
      throw new Error(`${repositoryEntry.repository}.pullRequests must be non-empty`);
    }
    for (const pull of repositoryEntry.pullRequests) {
      if (!Number.isSafeInteger(pull.number) || pull.number <= 0) {
        throw new Error(`${repositoryEntry.repository} has an invalid pull request number`);
      }
      const id = shadowCaseId(repositoryEntry.repository, pull.number);
      if (seen.has(id)) throw new Error(`duplicate PR shadow case: ${id}`);
      seen.add(id);
      cases.push({
        id,
        repository: repositoryEntry.repository,
        number: pull.number,
        category: pull.category,
        selectionReason: pull.selectionReason,
        check: {
          id: repositoryEntry.check.id,
          command: [...repositoryEntry.check.command],
          workingDirectory: repositoryEntry.check.workingDirectory
        },
        protectedPaths: [...repositoryEntry.protectedPaths],
        allowedPaths: [...(repositoryEntry.allowedPaths || ["**"])],
        maximumChangedFiles: repositoryEntry.maximumChangedFiles || 1_000,
        timeoutSeconds: repositoryEntry.timeoutSeconds || 300
      });
    }
  }
  return cases;
}

function executorContractFor(entry) {
  return {
    schema_version: PR_SHADOW_CONTRACT_SCHEMA,
    candidate: {
      allowed_paths: entry.allowedPaths,
      protected_paths: entry.protectedPaths,
      maximum_changed_files: entry.maximumChangedFiles
    },
    checks: {
      targeted: [],
      regression: [{
        id: entry.check.id,
        command: entry.check.command,
        working_directory: entry.check.workingDirectory,
        expected: "pass",
        required: true,
        base_state: "green"
      }]
    },
    integrity: {
      judging_commands_immutable: true,
      forbid: ALL_INTEGRITY_DETECTIONS
    }
  };
}

export function derivePrShadowContract({ entry, metadata, diffBytes }) {
  const commandResolution = resolveJudgingCommandDefinition(entry.check.command, {
    workingDirectory: entry.check.workingDirectory
  });
  return {
    schemaVersion: PR_SHADOW_CONTRACT_SCHEMA,
    assurance: {
      level: "AV-1+integrity",
      targetedCheck: false,
      differentialLogicExercised: false,
      limitation: SHADOW_LIMITATION
    },
    pullRequest: {
      repository: metadata.repository,
      number: metadata.number,
      url: metadata.url,
      title: metadata.title,
      mergedAt: metadata.mergedAt,
      baseRefCommit: metadata.baseRefCommit || metadata.baseCommit,
      baseCommit: metadata.baseCommit,
      headCommit: metadata.headCommit,
      contractAuthor: null
    },
    candidate: {
      format: "git_patch",
      diffSha256: sha256(diffBytes),
      diffBytes: diffBytes.length,
      allowedPaths: entry.allowedPaths,
      protectedPaths: entry.protectedPaths,
      maximumChangedFiles: entry.maximumChangedFiles
    },
    check: {
      id: entry.check.id,
      command: entry.check.command,
      workingDirectory: entry.check.workingDirectory,
      commandResolution
    },
    integrity: {
      detections: ALL_INTEGRITY_DETECTIONS
    }
  };
}

function diffBlocks(diffText) {
  const starts = [];
  const lines = diffText.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("diff --git ")) starts.push(index);
  }
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    const block = lines.slice(start, end);
    const match = block[0].match(/^diff --git a\/(\S+) b\/(\S+)$/u);
    return { path: match?.[2] || null, lines: block };
  });
}

function hunksFromBlock(block, evidence) {
  const starts = [];
  for (let index = 0; index < block.lines.length; index += 1) {
    if (block.lines[index].startsWith("@@")) starts.push(index);
  }
  const hunks = starts.map((start, index) => {
    const headerStart = Math.max(0, start - 2);
    const end = starts[index + 1] ?? block.lines.length;
    return block.lines.slice(headerStart, Math.min(end, headerStart + 80)).join("\n");
  });
  if (hunks.length === 0) return [block.lines.slice(0, 80).join("\n")];
  const matching = evidence.length > 0
    ? hunks.filter((hunk) => evidence.some((line) => hunk.includes(line)))
    : [];
  return (matching.length > 0 ? matching : hunks).slice(0, 3);
}

export function diffHunksForViolation(diffText, violation) {
  const blocks = diffBlocks(diffText);
  return (violation.paths || []).flatMap((path) => {
    const block = blocks.find((entry) => entry.path === path);
    return block ? hunksFromBlock(block, violation.evidence || []).map((hunk) => ({ path, hunk })) : [];
  });
}

function violationKey(caseId, violation) {
  return `${caseId}:${violation.detection}:${(violation.paths || []).join(",") || "(no-path)"}`;
}

export async function evaluatePrShadowStatic({
  entry,
  metadata,
  patchPath,
  baseRoot,
  candidateRoot,
  diffText
}) {
  const diffBytes = Buffer.from(diffText, "utf8");
  const contract = derivePrShadowContract({ entry, metadata, diffBytes });
  const inspection = await inspectCandidatePatch({ patchPath, baseRoot });
  if (!inspection.valid) {
    return {
      contract,
      verdict: VERDICTS.INCONCLUSIVE,
      attribution: "contract",
      reason: "head_diff_unmaterializable",
      details: inspection.reason,
      patch: { valid: false, reason: inspection.reason },
      policyViolations: [],
      integrityViolations: []
    };
  }

  await createAttemptCopy(baseRoot, candidateRoot);
  const applied = await applyCandidatePatch({ patch: inspection, workspace: candidateRoot });
  if (!applied.applied) {
    return {
      contract,
      verdict: VERDICTS.INCONCLUSIVE,
      attribution: "contract",
      reason: "head_diff_unmaterializable",
      details: applied.reason,
      patch: { valid: false, reason: applied.reason },
      policyViolations: [],
      integrityViolations: []
    };
  }

  const executorContract = executorContractFor(entry);
  // SEEN-RED anchor: the drill removes this one policy evaluation and proves
  // that a real protected-path pull request would escape.
  const policyViolations = evaluateCandidatePolicy(executorContract, inspection);
  const integrityViolations = await detectIntegrityViolations({
    contract: executorContract,
    patch: inspection,
    baseRoot,
    candidateRoot
  });
  const decorate = (source) => (violation) => ({
    ...violation,
    source,
    key: violationKey(entry.id, violation),
    diffHunks: diffHunksForViolation(diffText, violation)
  });
  const decoratedPolicy = policyViolations.map(decorate("candidate-policy"));
  const decoratedIntegrity = integrityViolations.map(decorate("integrity"));
  const violations = [...decoratedPolicy, ...decoratedIntegrity];
  if (violations.length > 0) {
    return {
      contract,
      verdict: VERDICTS.POLICY_VIOLATION,
      attribution: null,
      reason: "candidate_policy_or_integrity_violation",
      details: violations.map((violation) => violation.detection),
      patch: {
        valid: true,
        bytes: inspection.bytes,
        changedPaths: inspection.changedPaths,
        stats: inspection.stats
      },
      policyViolations: decoratedPolicy,
      integrityViolations: decoratedIntegrity
    };
  }

  const resolution = contract.check.commandResolution;
  if (!resolution.resolved) {
    return {
      contract,
      verdict: VERDICTS.INCONCLUSIVE,
      attribution: "contract",
      reason: "unresolvable_command",
      details: resolution.reason,
      patch: { valid: true, bytes: inspection.bytes, changedPaths: inspection.changedPaths, stats: inspection.stats },
      policyViolations: [],
      integrityViolations: []
    };
  }
  if (resolution.definitionFile !== null && !isProtectedPath(resolution.definitionFile, entry.protectedPaths)) {
    return {
      contract,
      verdict: VERDICTS.INCONCLUSIVE,
      attribution: "contract",
      reason: "unprotected_judging_command",
      details: `${resolution.definitionFile} is not protected by the derived contract`,
      patch: { valid: true, bytes: inspection.bytes, changedPaths: inspection.changedPaths, stats: inspection.stats },
      policyViolations: [],
      integrityViolations: []
    };
  }
  return {
    contract,
    verdict: null,
    attribution: null,
    reason: null,
    details: null,
    patch: { valid: true, bytes: inspection.bytes, changedPaths: inspection.changedPaths, stats: inspection.stats },
    policyViolations: [],
    integrityViolations: []
  };
}

function commandForShell(command) {
  return command.map((part) => `'${part.replaceAll("'", `'"'"'`)}'`).join(" ");
}

function preflightPassed(report) {
  return SUCCESSFUL_MATERIALIZATIONS.has(report.classification) && report.basePassed === true;
}

function preflightRanAndFailed(report) {
  return SUCCESSFUL_MATERIALIZATIONS.has(report.classification) && report.basePassed === false;
}

function infrastructureFailure(report) {
  const text = `${report.classificationReason || ""} ${report.observedFailureReason || ""}`.toLowerCase();
  return [
    "docker is unavailable",
    "sandbox toolchain unavailable",
    "networkmode none",
    "host failure",
    "toolchain executable is missing",
    "required executable is missing",
    "timed out"
  ].some((fragment) => text.includes(fragment));
}

function compactPreflight(report) {
  return {
    commit: report.commit,
    classification: report.classification,
    classificationReason: report.classificationReason,
    checkCommandExists: report.checkCommandExists,
    checkDefinition: report.check,
    baseExitStatus: report.baseExitStatus,
    basePassed: report.basePassed,
    toolchain: report.toolchain,
    dependencyPreparation: report.dependencyPreparation,
    sandbox: report.sandbox,
    attempts: report.attempts,
    totalSeconds: report.totalSeconds
  };
}

async function runCommitCheck({ entry, source, commit, cacheDirectory, dependencies }) {
  const report = await (dependencies.runPreflight || runPreflight)({
    repo: entry.repository,
    check: commandForShell(entry.check.command),
    workingDirectory: entry.check.workingDirectory,
    protectedPaths: entry.protectedPaths,
    timeoutSeconds: entry.timeoutSeconds
  }, {
    materialize: ({ destination }) => source.materialize(commit, destination),
    cacheDirectory,
    ensureImage: dependencies.ensureImage,
    runContainer: dependencies.runContainer,
    temporaryParent: dependencies.preflightTemporaryParent
  });
  return report;
}

export async function evaluateMergedPullRequest({
  entry,
  metadata,
  source,
  temporaryParent,
  cacheDirectory,
  staticOnly = false
}, dependencies = {}) {
  const started = performance.now();
  const caseRoot = await mkdtemp(join(temporaryParent, "case-"));
  try {
    const preparedMetadata = await source.prepare(metadata);
    const baseRoot = join(caseRoot, "base");
    const candidateRoot = join(caseRoot, "candidate");
    const patchPath = await source.writeDiff({
      baseCommit: preparedMetadata.baseCommit,
      headCommit: preparedMetadata.headCommit,
      destination: join(caseRoot, "candidate.patch")
    });
    await source.materialize(preparedMetadata.baseCommit, baseRoot);
    const diffText = await readFile(patchPath, "utf8");
    const result = await evaluatePrShadowStatic({
      entry,
      metadata: preparedMetadata,
      patchPath,
      baseRoot,
      candidateRoot,
      diffText
    });
    if (result.verdict !== null) {
      return { ...result, id: entry.id, category: entry.category, selectionReason: entry.selectionReason,
        seconds: Number(((performance.now() - started) / 1_000).toFixed(3)), checks: null };
    }
    if (staticOnly) {
      return {
        ...result,
        id: entry.id,
        category: entry.category,
        selectionReason: entry.selectionReason,
        verdict: VERDICTS.INCONCLUSIVE,
        attribution: "infrastructure",
        reason: "check_execution_skipped",
        details: "static-only shadow run intentionally skipped repository execution",
        seconds: Number(((performance.now() - started) / 1_000).toFixed(3)),
        checks: null
      };
    }

    const head = await runCommitCheck({
      entry,
      source,
      commit: preparedMetadata.headCommit,
      cacheDirectory,
      dependencies
    });
    if (preflightPassed(head)) {
      return {
        ...result,
        id: entry.id,
        category: entry.category,
        selectionReason: entry.selectionReason,
        verdict: VERDICTS.PASS,
        seconds: Number(((performance.now() - started) / 1_000).toFixed(3)),
        checks: { head: compactPreflight(head), baseDiagnostic: null }
      };
    }

    const base = await runCommitCheck({
      entry,
      source,
      commit: preparedMetadata.baseCommit,
      cacheDirectory,
      dependencies
    });
    if (preflightPassed(base) && preflightRanAndFailed(head)) {
      return {
        ...result,
        id: entry.id,
        category: entry.category,
        selectionReason: entry.selectionReason,
        verdict: VERDICTS.FAIL,
        reason: "required_check_failed",
        details: "the repository check passed at the PR base and failed at the PR head",
        seconds: Number(((performance.now() - started) / 1_000).toFixed(3)),
        checks: { head: compactPreflight(head), baseDiagnostic: compactPreflight(base) }
      };
    }
    const attribution = preflightPassed(base)
      ? "candidate"
      : infrastructureFailure(head) && infrastructureFailure(base)
        ? "infrastructure"
        : "contract";
    return {
      ...result,
      id: entry.id,
      category: entry.category,
      selectionReason: entry.selectionReason,
      verdict: VERDICTS.INCONCLUSIVE,
      attribution,
      reason: preflightPassed(base) ? "candidate_materialization_failure" : "repository_check_unavailable",
      details: preflightPassed(base)
        ? "base materialized and passed, but the PR head could not produce a trusted check result"
        : "the derived assumption that the repository check is runnable and green could not be established",
      seconds: Number(((performance.now() - started) / 1_000).toFixed(3)),
      checks: { head: compactPreflight(head), baseDiagnostic: compactPreflight(base) }
    };
  } catch (error) {
    return {
      id: entry.id,
      category: entry.category,
      selectionReason: entry.selectionReason,
      contract: null,
      verdict: VERDICTS.INCONCLUSIVE,
      attribution: "infrastructure",
      reason: "materialization_failure",
      details: error.message,
      patch: null,
      policyViolations: [],
      integrityViolations: [],
      checks: null,
      seconds: Number(((performance.now() - started) / 1_000).toFixed(3))
    };
  } finally {
    await rm(caseRoot, { recursive: true, force: true });
  }
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

function percent(numerator, denominator) {
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(1));
}

export function buildPrShadowReport({ manifest, results, githubAudit, judgements = {} }) {
  const reviewedResults = results.map((result) => {
    const reviewViolations = (violations) => violations.map((violation) => ({
      ...violation,
      judgement: judgements.policyViolations?.[violation.key] || {
        classification: "unreviewed",
        rationale: "No human judgement was supplied."
      }
    }));
    return {
      ...result,
      policyViolations: reviewViolations(result.policyViolations || []),
      integrityViolations: reviewViolations(result.integrityViolations || []),
      inconclusiveAttributionJudgement: result.verdict === VERDICTS.INCONCLUSIVE
        ? judgements.inconclusiveAttribution?.[result.id] || {
            accuracy: "unreviewed",
            rationale: "No human attribution judgement was supplied."
          }
        : null
    };
  });
  const allViolations = reviewedResults.flatMap((result) => [
    ...result.policyViolations,
    ...result.integrityViolations
  ].map((violation) => ({ result, violation })));
  const falsePositiveCases = new Set(allViolations
    .filter(({ violation }) => violation.judgement.classification === "false_positive")
    .map(({ result }) => result.id));
  const policyCases = reviewedResults.filter((result) => result.verdict === VERDICTS.POLICY_VIOLATION);
  const inconclusive = reviewedResults.filter((result) => result.verdict === VERDICTS.INCONCLUSIVE);
  const detectionNames = [...new Set([
    "protected_path_modified",
    ...ALL_INTEGRITY_DETECTIONS,
    ...allViolations.map(({ violation }) => violation.detection)
  ])].sort();
  const perDetection = Object.fromEntries(detectionNames.map((detection) => {
    const entries = allViolations.filter(({ violation }) => violation.detection === detection);
    const firedCases = new Set(entries.map(({ result }) => result.id));
    const falseCases = new Set(entries
      .filter(({ violation }) => violation.judgement.classification === "false_positive")
      .map(({ result }) => result.id));
    return [detection, {
      firedPullRequests: firedCases.size,
      firedRatePct: percent(firedCases.size, reviewedResults.length),
      falsePositivePullRequests: falseCases.size,
      falsePositiveRatePct: percent(falseCases.size, reviewedResults.length),
      trueFindingPullRequests: new Set(entries
        .filter(({ violation }) => violation.judgement.classification === "true_finding")
        .map(({ result }) => result.id)).size
    }];
  }));
  const reviewedAttributions = inconclusive
    .map((result) => result.inconclusiveAttributionJudgement?.accuracy)
    .filter((accuracy) => accuracy && accuracy !== "unreviewed");
  const verdictCounts = countBy(reviewedResults.map((result) => result.verdict));
  return {
    schemaVersion: PR_SHADOW_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    corpus: {
      frozenAt: manifest.frozenAt,
      selectionMethod: manifest.selectionMethod,
      total: reviewedResults.length,
      repositories: countBy(reviewedResults.map((result) => result.id.split("#")[0]))
    },
    assurance: {
      level: "AV-1+integrity",
      targetedCheck: false,
      differentialLogicExercised: false,
      integrityDetectionsEvaluated: ALL_INTEGRITY_DETECTIONS,
      limitation: SHADOW_LIMITATION
    },
    shadowMode: {
      githubAccess: "read-only",
      commentsPosted: 0,
      statusesPosted: 0,
      submissionsMade: 0,
      remotePushes: 0,
      auditedOperations: githubAudit
    },
    verdictDistribution: Object.fromEntries(
      Object.values(VERDICTS).map((verdict) => [verdict, verdictCounts[verdict] || 0])
    ),
    policyViolationRate: {
      pullRequests: policyCases.length,
      total: reviewedResults.length,
      ratePct: percent(policyCases.length, reviewedResults.length)
    },
    falsePositiveRate: {
      pullRequests: falsePositiveCases.size,
      total: reviewedResults.length,
      ratePct: percent(falsePositiveCases.size, reviewedResults.length),
      definition: "distinct legitimate merged PRs with at least one adjudicated false-positive violation / all shadowed PRs"
    },
    falsePositiveRatePerDetection: perDetection,
    unevaluableSummary: {
      total: inconclusive.length,
      byReason: countBy(inconclusive.map((result) => result.reason)),
      byAttribution: countBy(inconclusive.map((result) => result.attribution))
    },
    unevaluable: inconclusive.map((result) => ({
      id: result.id,
      reason: result.reason,
      attribution: result.attribution,
      details: result.details,
      attributionJudgement: result.inconclusiveAttributionJudgement
    })),
    inconclusiveRate: {
      pullRequests: inconclusive.length,
      total: reviewedResults.length,
      ratePct: percent(inconclusive.length, reviewedResults.length)
    },
    inconclusiveAttributionAccuracy: {
      reviewed: reviewedAttributions.length,
      accurate: reviewedAttributions.filter((accuracy) => accuracy === "accurate").length,
      inaccurate: reviewedAttributions.filter((accuracy) => accuracy === "inaccurate").length,
      accuracyPct: percent(
        reviewedAttributions.filter((accuracy) => accuracy === "accurate").length,
        reviewedAttributions.length
      )
    },
    policyViolationCases: policyCases.map((result) => ({
      id: result.id,
      url: result.contract?.pullRequest.url || null,
      title: result.contract?.pullRequest.title || null,
      violations: [...result.policyViolations, ...result.integrityViolations]
    })),
    results: reviewedResults
  };
}

export function renderPrShadowMarkdown(report) {
  const lines = [
    "# Witness merged-PR shadow report",
    "",
    `**False-positive rate: ${report.falsePositiveRate.pullRequests}/${report.falsePositiveRate.total} (${report.falsePositiveRate.ratePct}%).**`,
    "",
    `Policy-violation verdicts: ${report.policyViolationRate.pullRequests}/${report.policyViolationRate.total} (${report.policyViolationRate.ratePct}%).`,
    "",
    "## Honest assurance boundary",
    "",
    report.assurance.limitation,
    "",
    "## Verdict distribution",
    "",
    ...Object.entries(report.verdictDistribution).map(([verdict, count]) => `- ${verdict}: ${count}`),
    "",
    "## Individual POLICY_VIOLATION cases",
    ""
  ];
  if (report.policyViolationCases.length === 0) lines.push("None.", "");
  for (const entry of report.policyViolationCases) {
    lines.push(`### ${entry.id} — ${entry.title || "title unavailable"}`, "");
    for (const violation of entry.violations) {
      lines.push(
        `- Detection: ${violation.detection}`,
        `- Judgement: ${violation.judgement.classification}`,
        `- Rationale: ${violation.judgement.rationale}`,
        `- Message: ${violation.message}`,
        ""
      );
      for (const hunk of violation.diffHunks) {
        const markdownHunk = hunk.hunk.split("\n").map((line) => line.trimEnd()).join("\n");
        lines.push(`Path: ${hunk.path}`, "", "```diff", markdownHunk, "```", "");
      }
    }
  }
  lines.push(
    "## False-positive rate per detection",
    "",
    "| Detection | Fired PRs | False-positive PRs | False-positive rate | True findings |",
    "|---|---:|---:|---:|---:|"
  );
  for (const [detection, value] of Object.entries(report.falsePositiveRatePerDetection)) {
    lines.push(`| ${detection} | ${value.firedPullRequests} | ${value.falsePositivePullRequests} | ${value.falsePositiveRatePct}% | ${value.trueFindingPullRequests} |`);
  }
  lines.push(
    "",
    "## Unevaluable and INCONCLUSIVE",
    "",
    `INCONCLUSIVE: ${report.inconclusiveRate.pullRequests}/${report.inconclusiveRate.total} (${report.inconclusiveRate.ratePct}%).`,
    ""
  );
  for (const entry of report.unevaluable) {
    lines.push(
      `- ${entry.id}: ${entry.reason} (${entry.attribution}) — ${entry.details}`,
      `  - Attribution judgement: ${entry.attributionJudgement.accuracy} — ${entry.attributionJudgement.rationale}`
    );
  }
  lines.push(
    "",
    `Attribution accuracy: ${report.inconclusiveAttributionAccuracy.accurate}/${report.inconclusiveAttributionAccuracy.reviewed} reviewed (${report.inconclusiveAttributionAccuracy.accuracyPct}%).`,
    "",
    "## Shadow side effects",
    "",
    "GitHub access was GET/clone-only. The runner posted no comments or statuses, submitted no verdicts, and pushed to no evaluated repository.",
    ""
  );
  return `${lines.join("\n").trimEnd()}\n`;
}
