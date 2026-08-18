#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  assertInconclusiveAttribution,
  verifierReputationSignalFor,
  workerConsequenceFor
} from "../src/attribution.mjs";
import { inspectCandidatePatch } from "../src/candidate-patch.mjs";
import { detectIntegrityFindings } from "../src/integrity.mjs";
import {
  REAL_TEST_RENAMES,
  declarationPatch
} from "../test/fixtures/integrity/real-test-renames.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = resolve(WITNESS_ROOT, "src");
const BASE_ROOT = resolve(WITNESS_ROOT, "test/fixtures/integrity/base");
const PATCH_ROOT = resolve(WITNESS_ROOT, "test/fixtures/integrity/patches");
const CONTRACT = { integrity: { forbid: ["test_deletion"] } };

const sources = {
  attribution: await readFile(resolve(SOURCE_ROOT, "attribution.mjs"), "utf8"),
  candidate: await readFile(resolve(SOURCE_ROOT, "candidate-patch.mjs"), "utf8"),
  integrity: await readFile(resolve(SOURCE_ROOT, "integrity.mjs"), "utf8")
};

function mutation(source, anchor, replacement) {
  const anchorOccurrences = source.split(anchor).length - 1;
  const mutated = anchorOccurrences === 1 ? source.replace(anchor, replacement) : source;
  return {
    source: mutated,
    anchor,
    anchorOccurrences,
    applied: anchorOccurrences === 1 && mutated !== source && !mutated.includes(anchor)
  };
}

async function loadIntegrityMutant(root, label, changedSource) {
  const directory = resolve(root, label);
  await mkdir(directory);
  for (const file of ["constants.mjs", "verification-contract.mjs"]) {
    await cp(resolve(SOURCE_ROOT, file), resolve(directory, file));
  }
  await writeFile(resolve(directory, "integrity.mjs"), changedSource);
  return import(`${pathToFileURL(resolve(directory, "integrity.mjs")).href}?drill=${label}`);
}

async function loadCandidateMutant(root, label, changedSource) {
  const directory = resolve(root, label);
  await mkdir(directory);
  for (const file of ["constants.mjs", "process.mjs", "verification-contract.mjs"]) {
    await cp(resolve(SOURCE_ROOT, file), resolve(directory, file));
  }
  await writeFile(resolve(directory, "candidate-patch.mjs"), changedSource);
  return import(`${pathToFileURL(resolve(directory, "candidate-patch.mjs")).href}?drill=${label}`);
}

async function loadAttributionMutant(root, label, changedSource) {
  const directory = resolve(root, label);
  await mkdir(directory);
  await writeFile(resolve(directory, "attribution.mjs"), changedSource);
  return import(`${pathToFileURL(resolve(directory, "attribution.mjs")).href}?drill=${label}`);
}

function record(mutationResult, green, red, details = {}) {
  return {
    mutation: {
      anchor: mutationResult.anchor,
      anchorOccurrences: mutationResult.anchorOccurrences,
      applied: mutationResult.applied
    },
    detectorPresent: { status: green ? "GREEN" : "RED" },
    seenRedWithAnchorMutated: { status: red ? "RED" : "GREEN" },
    ...details
  };
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "witness-ambiguity-drills-"));
const drills = {};
try {
  const ambiguityMutation = mutation(
    sources.integrity,
    "      if (hasComparableReplacementCount(unmatched.removed, unmatched.added)) {",
    "      if (false) {"
  );
  const ambiguityMutant = await loadIntegrityMutant(
    temporaryRoot,
    "declaration-rename",
    ambiguityMutation.source
  );
  const originalRenameResults = await Promise.all(REAL_TEST_RENAMES.map((example) =>
    detectIntegrityFindings({
      contract: CONTRACT,
      patch: declarationPatch(example.path, example.removed, example.added),
      baseRoot: BASE_ROOT,
      candidateRoot: BASE_ROOT
    })
  ));
  const mutatedRenameResults = await Promise.all(REAL_TEST_RENAMES.map((example) =>
    ambiguityMutant.detectIntegrityFindings({
      contract: CONTRACT,
      patch: declarationPatch(example.path, example.removed, example.added),
      baseRoot: BASE_ROOT,
      candidateRoot: BASE_ROOT
    })
  ));
  drills.renamedAndExpandedDeclarations = record(
    ambiguityMutation,
    originalRenameResults.every((result) => result.violations.length === 0 && result.ambiguities.length === 1),
    mutatedRenameResults.every((result) => result.violations.length === 1 && result.ambiguities.length === 0),
    {
      fixtures: REAL_TEST_RENAMES.map((example) => example.name),
      expected: "INCONCLUSIVE/verifier",
      mutatedOutcome: "POLICY_VIOLATION"
    }
  );

  const outrightPatch = declarationPatch(
    "test/value.test.js",
    ['test("returns one", () => {'],
    []
  );
  const outrightMutation = mutation(
    sources.integrity,
    "        findings.push(violation(\n          \"test_deletion\",\n          `test declarations were removed from ${file.path} without a comparable replacement set`,",
    "        findings.push(ambiguity(\n          \"test_deletion\",\n          `test declarations were removed from ${file.path} without a comparable replacement set`,"
  );
  const outrightMutant = await loadIntegrityMutant(
    temporaryRoot,
    "outright-deletion",
    outrightMutation.source
  );
  const originalOutright = await detectIntegrityFindings({
    contract: CONTRACT,
    patch: outrightPatch,
    baseRoot: BASE_ROOT,
    candidateRoot: BASE_ROOT
  });
  const mutatedOutright = await outrightMutant.detectIntegrityFindings({
    contract: CONTRACT,
    patch: outrightPatch,
    baseRoot: BASE_ROOT,
    candidateRoot: BASE_ROOT
  });
  drills.outrightTestDeletion = record(
    outrightMutation,
    originalOutright.violations.length === 1 && originalOutright.ambiguities.length === 0,
    mutatedOutright.violations.length === 0,
    { expected: "POLICY_VIOLATION", mutatedOutcome: "INCONCLUSIVE/verifier" }
  );

  const renameMutation = mutation(
    sources.candidate,
    "      current.renameFromSeen = true;",
    "      current.renameFromSeen = false;"
  );
  const renameMutant = await loadCandidateMutant(
    temporaryRoot,
    "git-file-rename",
    renameMutation.source
  );
  const renameOptions = {
    patchPath: resolve(PATCH_ROOT, "test-file-rename.patch"),
    baseRoot: BASE_ROOT
  };
  const originalRename = await inspectCandidatePatch(renameOptions);
  const mutatedRename = await renameMutant.inspectCandidatePatch(renameOptions);
  drills.gitFileRename = record(
    renameMutation,
    originalRename.valid === true && originalRename.files[0]?.isRenamed === true,
    mutatedRename.valid === false,
    {
      expected: "valid explicit rename; no ambiguity",
      mutatedOutcome: mutatedRename.reason
    }
  );

  const attributionMutation = mutation(
    sources.attribution,
    '  "candidate",\n  "verifier"',
    '  "candidate"'
  );
  const attributionMutant = await loadAttributionMutant(
    temporaryRoot,
    "verifier-attribution",
    attributionMutation.source
  );
  let originalAccepted = true;
  let mutantRejected = false;
  try {
    assertInconclusiveAttribution("INCONCLUSIVE", "verifier");
  } catch {
    originalAccepted = false;
  }
  try {
    attributionMutant.assertInconclusiveAttribution("INCONCLUSIVE", "verifier");
  } catch {
    mutantRejected = true;
  }
  drills.verifierAttribution = record(
    attributionMutation,
    originalAccepted,
    mutantRejected,
    { expected: "accepted fourth INCONCLUSIVE attribution" }
  );

  const consequenceMutation = mutation(
    sources.attribution,
    '  return verdict === "INCONCLUSIVE" ? "none" : null;',
    '  return verdict === "INCONCLUSIVE" ? "candidate-action" : null;'
  );
  const consequenceMutant = await loadAttributionMutant(
    temporaryRoot,
    "worker-consequence",
    consequenceMutation.source
  );
  drills.verifierWorkerConsequence = record(
    consequenceMutation,
    workerConsequenceFor("INCONCLUSIVE") === "none",
    consequenceMutant.workerConsequenceFor("INCONCLUSIVE") !== "none",
    { expected: "workerConsequence: none" }
  );

  const reputationMutation = mutation(
    sources.attribution,
    '    kind: "evidence_completeness_gap",',
    '    kind: "missing_evidence_signal",'
  );
  const reputationMutant = await loadAttributionMutant(
    temporaryRoot,
    "verifier-reputation-signal",
    reputationMutation.source
  );
  const signalInput = {
    verdict: "INCONCLUSIVE",
    attribution: "verifier",
    reason: "integrity_detection_ambiguous",
    details: []
  };
  drills.verifierReputationSignal = record(
    reputationMutation,
    verifierReputationSignalFor(signalInput)?.kind === "evidence_completeness_gap",
    reputationMutant.verifierReputationSignalFor(signalInput)?.kind !== "evidence_completeness_gap",
    { expected: "verifier evidence-completeness reputation signal" }
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

const result = {
  schemaVersion: "averray.witness.ambiguity-drills/v1",
  drills
};
const serialized = `${JSON.stringify(result, null, 2)}\n`;
const outputIndex = process.argv.indexOf("--out");
if (outputIndex >= 0) {
  const output = process.argv[outputIndex + 1];
  if (!output || output.startsWith("--")) throw new Error("--out requires a Witness-relative path");
  await writeFile(resolve(WITNESS_ROOT, output), serialized);
}
process.stdout.write(serialized);

const passed = Object.values(drills).every((drill) =>
  drill.mutation.anchorOccurrences === 1 &&
  drill.mutation.applied === true &&
  drill.detectorPresent.status === "GREEN" &&
  drill.seenRedWithAnchorMutated.status === "RED"
);
if (!passed) process.exitCode = 1;
