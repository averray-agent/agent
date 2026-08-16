#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { applyCandidatePatch, inspectCandidatePatch } from "../src/candidate-patch.mjs";
import { detectIntegrityViolations } from "../src/integrity.mjs";
import { INTEGRITY_DRILLS } from "../test/fixtures/integrity/cases.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = resolve(WITNESS_ROOT, "src");
const INTEGRITY_ROOT = resolve(WITNESS_ROOT, "test", "fixtures", "integrity");
const BASE_ROOT = resolve(INTEGRITY_ROOT, "base");
const PATCH_ROOT = resolve(INTEGRITY_ROOT, "patches");
const CONTRACT_PATH = resolve(WITNESS_ROOT, "corpus", "adversarial", "contract.json");
const integritySource = await readFile(resolve(SOURCE_ROOT, "integrity.mjs"), "utf8");
const baseContract = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));

const MUTATION_ANCHORS = Object.freeze({
  test_deletion: "  test_deletion: ({ patch }) => detectTestDeletion(patch),",
  skip_or_xfail_markers_added: "  skip_or_xfail_markers_added: ({ patch }) => detectSkipMarkers(patch),",
  runner_replacement: "  runner_replacement: ({ contract, patch, baseRoot, candidateRoot }) =>\n    detectRunnerReplacement(contract, patch, baseRoot, candidateRoot),",
  assertion_neutering: "  assertion_neutering: ({ patch }) => detectAssertionNeutering(patch),",
  snapshot_rewrite_to_accept_current: "  snapshot_rewrite_to_accept_current: ({ patch, baseRoot }) => detectSnapshotRewrite(patch, baseRoot),",
  coverage_or_lint_exclusion_of_changed_files: "  coverage_or_lint_exclusion_of_changed_files: ({ patch }) => detectCoverageExclusion(patch),",
  error_swallowing_to_force_zero_exit: "  error_swallowing_to_force_zero_exit: ({ patch }) => detectErrorSwallowing(patch)"
});

async function inspect(file) {
  const patch = await inspectCandidatePatch({ patchPath: resolve(PATCH_ROOT, file), baseRoot: BASE_ROOT });
  if (!patch.valid) throw new Error(`${file}: ${patch.reason}`);
  return patch;
}

async function loadMutant(detection, temporaryRoot) {
  const anchor = MUTATION_ANCHORS[detection];
  const anchorOccurrences = integritySource.split(anchor).length - 1;
  const replacement = `  ${detection}: () => [],`;
  const mutatedSource = anchorOccurrences === 1
    ? integritySource.replace(anchor, replacement)
    : integritySource;
  const mutationApplied = anchorOccurrences === 1 &&
    mutatedSource !== integritySource &&
    !mutatedSource.includes(anchor) &&
    mutatedSource.includes(replacement);

  const mutantRoot = resolve(temporaryRoot, detection);
  await mkdir(mutantRoot);
  await cp(resolve(SOURCE_ROOT, "constants.mjs"), resolve(mutantRoot, "constants.mjs"), {
    recursive: false,
    force: false
  });
  await cp(resolve(SOURCE_ROOT, "verification-contract.mjs"), resolve(mutantRoot, "verification-contract.mjs"), {
    recursive: false,
    force: false
  });
  const mutantPath = resolve(mutantRoot, basename("integrity.mjs"));
  await writeFile(mutantPath, mutatedSource);
  const module = await import(`${pathToFileURL(mutantPath).href}?mutation=${encodeURIComponent(detection)}`);
  return { module, anchorOccurrences, mutationApplied };
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "witness-integrity-mutations-"));
const output = {};
try {
  for (const drill of INTEGRITY_DRILLS) {
    const contract = structuredClone(baseContract);
    contract.integrity.forbid = [drill.detection];
    const attack = await inspect(drill.attack);
    const safe = await inspect(drill.safe);
    const candidateRoot = resolve(temporaryRoot, `${drill.detection}-candidate`);
    await cp(BASE_ROOT, candidateRoot, { recursive: true, errorOnExist: true });
    const applied = await applyCandidatePatch({ patch: attack, workspace: candidateRoot });
    if (!applied.applied) throw new Error(`${drill.attack}: ${applied.reason}`);

    const originalAttack = await detectIntegrityViolations({
      contract,
      patch: attack,
      baseRoot: BASE_ROOT,
      candidateRoot
    });
    const originalSafe = await detectIntegrityViolations({
      contract,
      patch: safe,
      baseRoot: BASE_ROOT,
      candidateRoot: BASE_ROOT
    });
    const mutant = await loadMutant(drill.detection, temporaryRoot);
    const mutatedAttack = await mutant.module.detectIntegrityViolations({
      contract,
      patch: attack,
      baseRoot: BASE_ROOT,
      candidateRoot
    });
    const originalNamed = originalAttack.some((entry) => entry.detection === drill.detection);
    const mutantNamed = mutatedAttack.some((entry) => entry.detection === drill.detection);

    output[drill.detection] = {
      mutation: {
        anchorOccurrences: mutant.anchorOccurrences,
        applied: mutant.mutationApplied
      },
      attackWithDetector: {
        status: originalNamed ? "GREEN" : "RED",
        verdict: originalNamed ? "POLICY_VIOLATION" : "PASS",
        detections: originalAttack.map((entry) => entry.detection)
      },
      correctedPatch: {
        status: originalSafe.length === 0 ? "GREEN" : "RED",
        verdict: originalSafe.length === 0 ? "PASS" : "POLICY_VIOLATION",
        detections: originalSafe.map((entry) => entry.detection)
      },
      seenRedWithDetectorDisabled: {
        status: !mutantNamed ? "RED" : "GREEN",
        verdict: mutantNamed ? "POLICY_VIOLATION" : "PASS",
        detections: mutatedAttack.map((entry) => entry.detection)
      }
    };
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: "averray.witness.integrity-drills/v1",
  detections: output
}, null, 2)}\n`);

const passed = Object.values(output).every((result) =>
  result.mutation.anchorOccurrences === 1 &&
  result.mutation.applied === true &&
  result.attackWithDetector.status === "GREEN" &&
  result.correctedPatch.status === "GREEN" &&
  result.seenRedWithDetectorDisabled.status === "RED"
);
if (!passed) process.exitCode = 1;
