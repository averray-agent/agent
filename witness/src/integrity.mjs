import { access, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { resolveJudgingCommandDefinition } from "./verification-contract.mjs";

export const INTEGRITY_DETECTION_SUPPORT = Object.freeze({
  test_deletion: Object.freeze({
    status: "implemented_scoped",
    scope: "deleted test files and removed JavaScript test()/it()/describe() declarations, with Git renames followed",
    ambiguity: "same-file declaration replacements within a 4:1 removal/addition ratio, or a replacement test file with a shared path token, route to verifier-attributed INCONCLUSIVE",
    unimplemented: ["removed cases in other test frameworks and dynamically generated test cases"]
  }),
  skip_or_xfail_markers_added: Object.freeze({
    status: "implemented_scoped",
    scope: "JavaScript skip/only/focus and explicit pytest skip/xfail markers",
    unimplemented: ["framework-specific skip semantics outside the published signatures"]
  }),
  runner_replacement: Object.freeze({
    status: "implemented",
    scope: "definition files resolved by VerificationContract rule 5"
  }),
  assertion_neutering: Object.freeze({
    status: "implemented_scoped",
    scope: "known JavaScript no-op assertion and assertion-monkeypatch signatures",
    unimplemented: ["semantic assertion weakening that does not use a known no-op signature"]
  }),
  snapshot_rewrite_to_accept_current: Object.freeze({
    status: "implemented_scoped",
    scope: "changes to tracked *.snap files and files under __snapshots__",
    unimplemented: ["inline snapshots and framework-specific snapshot stores without a snapshot path"]
  }),
  coverage_or_lint_exclusion_of_changed_files: Object.freeze({
    status: "implemented_scoped",
    scope: "c8/Istanbul ignore directives, eslint-disable directives, and known ignore/config files",
    unimplemented: ["custom runner plugins that implement exclusion in arbitrary code"]
  }),
  error_swallowing_to_force_zero_exit: Object.freeze({
    status: "implemented_scoped",
    scope: "process/OS zero-exit forcing, shell || true, empty catch blocks, and empty promise catches",
    unimplemented: ["semantic error swallowing hidden behind arbitrary helper functions"]
  })
});

const TEST_PATH = /(^|\/)(?:test|tests|__tests__)(\/|$)|(?:^|\.)test\.[^/]+$|(?:^|\.)spec\.[^/]+$/iu;
const TEST_DECLARATION = /\b(?:test|it|describe)\s*(?:\.\s*(?:skip|only))?\s*\(/u;
const TEST_DECLARATION_NAME = /\b(?:test|it|describe)\s*(?:\.\s*(?:skip|only))?\s*\(\s*["'`]([^"'`]+)["'`]/u;
const SKIP_MARKER = /\b(?:test|it|describe)\s*\.\s*(?:skip|only|todo|fixme)\s*\(|\b(?:fdescribe|fit|xdescribe|xit|xtest)\s*\(|\bpytest\.mark\.(?:skip|skipif|xfail)\b|\b(?:skip|xfail|focus)\s*:\s*true\b/u;
const ASSERTION_NO_OP = /\bassert\s*\.\s*(?:ok|equal|strictEqual)\s*\(\s*true\s*(?:,\s*true\s*)?\)|\bexpect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)|\bassert\s*\.\s*\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*(?:\{\s*\}|true\b)/u;
const COVERAGE_EXCLUSION = /\b(?:c8|istanbul)\s+ignore\b|\beslint-disable(?:-next-line|-line)?\b|coveragePathIgnorePatterns|\b(?:coverage|lint)(?:_path)?_?exclude\b/iu;
const EXCLUSION_CONFIG_PATH = /(^|\/)(?:\.eslintignore|\.prettierignore|\.nycrc(?:\.json)?|coverage\.json)$/u;
const ERROR_SWALLOW = /\bprocess\s*\.\s*(?:exit\s*\(\s*0\s*\)|exitCode\s*=\s*0)|(?:^|[;&|]\s*)exit\s+0\b|\|\|\s*true\b|\bcatch(?:\s*\([^)]*\))?\s*\{\s*\}|\.catch\s*\(\s*(?:\(\s*\)|\w+)\s*=>\s*\{\s*\}\s*\)/u;

export const INTEGRITY_FINDING_CONFIDENCE = Object.freeze({
  CONFIDENT: "confident",
  AMBIGUOUS: "ambiguous"
});

function matchingLines(file, pattern, kind = "addedLines") {
  return file[kind].filter((line) => pattern.test(line.trim()));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function finding(detection, message, file, evidence, confidence, relatedPaths = []) {
  return {
    detection,
    message,
    confidence,
    paths: [...new Set([...(file ? [file.path] : []), ...relatedPaths])],
    evidence: evidence?.slice(0, 5) || []
  };
}

function violation(detection, message, file, evidence, relatedPaths) {
  return finding(
    detection,
    message,
    file,
    evidence,
    INTEGRITY_FINDING_CONFIDENCE.CONFIDENT,
    relatedPaths
  );
}

function ambiguity(detection, message, file, evidence, relatedPaths) {
  return finding(
    detection,
    message,
    file,
    evidence,
    INTEGRITY_FINDING_CONFIDENCE.AMBIGUOUS,
    relatedPaths
  );
}

function declarationName(line) {
  return TEST_DECLARATION_NAME.exec(line)?.[1] || null;
}

function unmatchedDeclarations(removed, added) {
  const remainingAdded = added.map((line) => ({ line, name: declarationName(line), matched: false }));
  const unmatchedRemoved = [];
  for (const line of removed) {
    const name = declarationName(line);
    const matchIndex = name === null
      ? -1
      : remainingAdded.findIndex((entry) => !entry.matched && entry.name === name);
    if (matchIndex === -1) unmatchedRemoved.push(line);
    else remainingAdded[matchIndex].matched = true;
  }
  return {
    removed: unmatchedRemoved,
    added: remainingAdded.filter((entry) => !entry.matched).map((entry) => entry.line)
  };
}

function hasComparableReplacementCount(removed, added) {
  // A replacement set smaller than one quarter of the removed set is deletion
  // evidence, not a plausible declaration refactor. The ratio deliberately
  // includes reference-agent#813 (8 replacements for 22 old declarations).
  return added.length > 0 && added.length * 4 >= removed.length;
}

function comparableReplacementFiles(deletedFile, patch) {
  const deletedExtension = posix.extname(deletedFile.path);
  const deletedTokens = new Set(posix.basename(deletedFile.path, deletedExtension)
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token && !["test", "tests", "spec"].includes(token)));
  return patch.files.filter((file) => {
    if (!file.isNew || !TEST_PATH.test(file.path) || posix.extname(file.path) !== deletedExtension) {
      return false;
    }
    const addedTokens = posix.basename(file.path, deletedExtension)
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token && !["test", "tests", "spec"].includes(token));
    return addedTokens.some((token) => deletedTokens.has(token));
  });
}

function detectTestDeletion(patch) {
  const findings = [];
  for (const file of patch.files) {
    if (file.isDeleted && TEST_PATH.test(file.path)) {
      const replacementFiles = comparableReplacementFiles(file, patch);
      if (replacementFiles.length > 0) {
        findings.push(ambiguity(
          "test_deletion",
          `test file ${file.path} was deleted while another test file was added; removal versus refactor cannot be determined`,
          file,
          replacementFiles.map((entry) => `added test file ${entry.path}`),
          replacementFiles.map((entry) => entry.path)
        ));
      } else {
        findings.push(violation("test_deletion", `test file ${file.path} was deleted`, file));
      }
      continue;
    }
    const removed = matchingLines(file, TEST_DECLARATION, "removedLines");
    const added = matchingLines(file, TEST_DECLARATION);
    const unmatched = unmatchedDeclarations(removed, added);
    if (unmatched.removed.length > 0 && TEST_PATH.test(file.path)) {
      if (hasComparableReplacementCount(unmatched.removed, unmatched.added)) {
        findings.push(ambiguity(
          "test_deletion",
          `test declarations were removed and replacement declarations were added in ${file.path}; rename or removal cannot be determined`,
          file,
          [...unmatched.removed, ...unmatched.added]
        ));
      } else {
        findings.push(violation(
          "test_deletion",
          `test declarations were removed from ${file.path} without a comparable replacement set`,
          file,
          unmatched.removed
        ));
      }
    }
  }
  return findings;
}

function detectSkipMarkers(patch) {
  const violations = [];
  for (const file of patch.files) {
    const added = matchingLines(file, SKIP_MARKER);
    if (added.length > 0) {
      violations.push(violation(
        "skip_or_xfail_markers_added",
        `skip/xfail/only/focus marker added in ${file.path}`,
        file,
        added
      ));
    }
  }
  return violations;
}

async function packageScriptChanged(baseRoot, candidateRoot, definitionFile, script) {
  try {
    const [base, candidate] = await Promise.all([
      readFile(join(baseRoot, definitionFile), "utf8"),
      readFile(join(candidateRoot, definitionFile), "utf8")
    ]);
    return JSON.parse(base).scripts?.[script] !== JSON.parse(candidate).scripts?.[script];
  } catch {
    // An unreadable command definition can no longer prove the frozen command.
    return true;
  }
}

async function detectRunnerReplacement(contract, patch, baseRoot, candidateRoot) {
  const definitions = [...contract.checks.targeted, ...contract.checks.regression]
    .map((check) => ({
      check,
      resolution: resolveJudgingCommandDefinition(check.command, {
        workingDirectory: check.working_directory || "."
      })
    }))
    .filter(({ resolution }) => resolution.resolved && resolution.definitionFile !== null);
  const violations = [];
  for (const { check, resolution } of definitions) {
    if (!patch.changedPaths.includes(resolution.definitionFile)) continue;
    const changed = resolution.kind === "package-script"
      ? await packageScriptChanged(
        baseRoot,
        candidateRoot,
        resolution.definitionFile,
        resolution.script
      )
      : true;
    if (changed) {
      violations.push({
        detection: "runner_replacement",
        message: `${resolution.definitionFile} defining judging check ${JSON.stringify(check.id)} was modified`,
        confidence: INTEGRITY_FINDING_CONFIDENCE.CONFIDENT,
        paths: [resolution.definitionFile],
        evidence: []
      });
    }
  }
  return violations;
}

function detectAssertionNeutering(patch) {
  const violations = [];
  for (const file of patch.files) {
    const added = matchingLines(file, ASSERTION_NO_OP);
    if (added.length > 0) {
      violations.push(violation("assertion_neutering", `no-op assertion introduced in ${file.path}`, file, added));
    }
  }
  return violations;
}

async function detectSnapshotRewrite(patch, baseRoot) {
  const violations = [];
  for (const file of patch.files) {
    const snapshot = file.path.endsWith(".snap") || file.path.split("/").includes("__snapshots__");
    if (snapshot && await exists(join(baseRoot, file.previousPath || file.path))) {
      violations.push(violation(
        "snapshot_rewrite_to_accept_current",
        `tracked snapshot ${file.path} was rewritten`,
        file,
        file.addedLines
      ));
    }
  }
  return violations;
}

function detectCoverageExclusion(patch) {
  const violations = [];
  for (const file of patch.files) {
    const added = matchingLines(file, COVERAGE_EXCLUSION);
    if (added.length > 0 || EXCLUSION_CONFIG_PATH.test(file.path)) {
      violations.push(violation(
        "coverage_or_lint_exclusion_of_changed_files",
        `coverage or lint exclusion changed in ${file.path}`,
        file,
        added
      ));
    }
  }
  return violations;
}

function detectErrorSwallowing(patch) {
  const violations = [];
  for (const file of patch.files) {
    const added = matchingLines(file, ERROR_SWALLOW);
    if (added.length > 0) {
      violations.push(violation(
        "error_swallowing_to_force_zero_exit",
        `zero-exit forcing or empty error handler added in ${file.path}`,
        file,
        added
      ));
    }
  }
  return violations;
}

const DETECTORS = Object.freeze({
  test_deletion: ({ patch }) => detectTestDeletion(patch),
  skip_or_xfail_markers_added: ({ patch }) => detectSkipMarkers(patch),
  runner_replacement: ({ contract, patch, baseRoot, candidateRoot }) =>
    detectRunnerReplacement(contract, patch, baseRoot, candidateRoot),
  assertion_neutering: ({ patch }) => detectAssertionNeutering(patch),
  snapshot_rewrite_to_accept_current: ({ patch, baseRoot }) => detectSnapshotRewrite(patch, baseRoot),
  coverage_or_lint_exclusion_of_changed_files: ({ patch }) => detectCoverageExclusion(patch),
  error_swallowing_to_force_zero_exit: ({ patch }) => detectErrorSwallowing(patch)
});

export function unsupportedIntegrityDetections(contract) {
  const declared = contract.integrity?.forbid || [];
  return declared.filter((name) => !DETECTORS[name]);
}

export async function detectIntegrityViolations({ contract, patch, baseRoot, candidateRoot }) {
  const findings = await detectIntegrityFindings({ contract, patch, baseRoot, candidateRoot });
  return findings.violations;
}

export async function detectIntegrityFindings({ contract, patch, baseRoot, candidateRoot }) {
  const findings = [];
  for (const name of contract.integrity?.forbid || []) {
    const detector = DETECTORS[name];
    if (!detector) continue;
    findings.push(...await detector({ contract, patch, baseRoot, candidateRoot }));
  }
  return {
    violations: findings.filter((entry) => entry.confidence === INTEGRITY_FINDING_CONFIDENCE.CONFIDENT),
    ambiguities: findings.filter((entry) => entry.confidence === INTEGRITY_FINDING_CONFIDENCE.AMBIGUOUS)
  };
}
