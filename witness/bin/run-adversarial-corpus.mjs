#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { confusionMatrix } from "../src/confusion-matrix.mjs";
import { runInWitnessContainer, ensureWitnessImage } from "../src/docker.mjs";
import { executeVerificationContract } from "../src/executor.mjs";
import { INTEGRITY_DETECTION_SUPPORT } from "../src/integrity.mjs";
import { makeTreeWritable } from "../src/materialize.mjs";
import { loadVerificationContract } from "../src/verification-contract.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_ROOT = resolve(WITNESS_ROOT, "corpus", "adversarial");
const manifest = JSON.parse(await readFile(resolve(CORPUS_ROOT, "manifest.json"), "utf8"));
const contract = await loadVerificationContract(resolve(CORPUS_ROOT, manifest.contract));
const seedRoot = resolve(CORPUS_ROOT, manifest.seed);
const overlayRoot = manifest.overlay ? resolve(CORPUS_ROOT, manifest.overlay) : null;
const image = await ensureWitnessImage();
const outputIndex = process.argv.indexOf("--out");
const outputPath = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : null;
const quiet = process.argv.includes("--quiet");
const diagnostic = process.argv.includes("--diagnostic");
const caseIndex = process.argv.indexOf("--case");
const caseId = caseIndex >= 0 ? process.argv[caseIndex + 1] : null;
const knownUndetectableNotRepresented = Object.entries(INTEGRITY_DETECTION_SUPPORT)
  .filter(([, support]) => Array.isArray(support.unimplemented) && support.unimplemented.length > 0)
  .map(([detection, support]) => ({ detection, class: support.unimplemented[0] }));

async function materializeSeed({ destination }) {
  await cp(seedRoot, destination, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
  if (overlayRoot) {
    await cp(overlayRoot, destination, { recursive: true, force: true, verbatimSymlinks: true });
  }
  await makeTreeWritable(destination);
  return {
    path: destination,
    commit: manifest.baseCommit,
    source: manifest.repository,
    sourceType: "pinned-corpus-snapshot",
    seconds: 0
  };
}

function simulatedResult(message) {
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    spawnError: message,
    timedOut: false,
    outputTruncated: false,
    seconds: 0,
    containerId: null,
    networkMode: "none",
    networkInterfaces: ["lo"],
    networkAssertionPassed: true
  };
}

function runContainerFor(entry) {
  if (entry.simulate !== "host_failure") return runInWitnessContainer;
  return async (options) => options.phase === "candidate"
    ? simulatedResult("simulated host failure")
    : runInWitnessContainer(options);
}

function summarize(entry, report) {
  const detections = [
    ...report.policyViolations.map((violation) => violation.detection),
    ...report.integrityViolations.map((violation) => violation.detection)
  ];
  const summary = {
    id: entry.id,
    expectedVerdict: entry.expectedVerdict,
    actualVerdict: report.verdict,
    expectedAttribution: entry.expectedAttribution || null,
    actualAttribution: report.attribution,
    expectedReason: entry.expectedReason || null,
    actualReason: report.reason,
    expectedDetection: entry.expectedDetection || null,
    detections,
    matched: entry.expectedVerdict === report.verdict &&
      (!entry.expectedAttribution || entry.expectedAttribution === report.attribution) &&
      (!entry.expectedReason || entry.expectedReason === report.reason) &&
      (!entry.expectedDetection || detections.includes(entry.expectedDetection)),
    baselineContainerIds: report.baseline.flatMap((run) => run.containerIds),
    candidateContainerIds: report.candidate.flatMap((run) => run.containerIds)
  };
  if (diagnostic) {
    summary.baselineChecks = report.baseline.flatMap((run) => run.checks);
    summary.candidateChecks = report.candidate.flatMap((run) => run.checks);
    summary.details = report.details;
    summary.patch = report.patch;
  }
  return summary;
}

const real = [];
const naive = [];
const selectedCases = caseId
  ? manifest.cases.filter((entry) => entry.id === caseId)
  : manifest.cases;
if (caseId && selectedCases.length !== 1) throw new Error(`unknown corpus case: ${caseId}`);
for (const entry of selectedCases) {
  const candidatePatch = resolve(CORPUS_ROOT, entry.patch);
  const dependencies = {
    materialize: materializeSeed,
    ensureImage: async () => image,
    runContainer: runContainerFor(entry),
    // Keep bind sources below the repository, which Docker Desktop shares.
    // Its VM does not expose macOS's per-user /var/folders temp directories.
    temporaryParent: resolve(WITNESS_ROOT, "cache", "adversarial")
  };
  real.push(summarize(entry, await executeVerificationContract({
    contract,
    candidatePatch,
    mode: "real"
  }, dependencies)));
  naive.push(summarize(entry, await executeVerificationContract({
    contract,
    candidatePatch,
    mode: "naive"
  }, dependencies)));
}

const evidence = {
  schemaVersion: manifest.schemaVersion,
  generatedAt: new Date().toISOString(),
  repository: manifest.repository,
  baseCommit: manifest.baseCommit,
  real: {
    results: real,
    confusion: confusionMatrix(real, { knownUndetectableNotRepresented })
  },
  naive: {
    results: naive,
    confusion: confusionMatrix(naive, { knownUndetectableNotRepresented })
  },
  isolationDrill: (() => {
    const correct = real.find((result) => result.id === "pass-correct-fix");
    if (!correct) return { status: "SKIPPED", reason: "pass-correct-fix was not selected" };
    const baseline = correct?.baselineContainerIds || [];
    const candidate = correct?.candidateContainerIds || [];
    const expected = (contract.checks.targeted.length + contract.checks.regression.length) *
      contract.reproducibility.repetitions;
    const distinct = new Set([...baseline, ...candidate]);
    return {
      status: baseline.length === expected && candidate.length === expected &&
        distinct.size === expected * 2 ? "GREEN" : "RED",
      expectedContainersPerPhase: expected,
      baselineContainerIds: baseline,
      candidateContainerIds: candidate
    };
  })()
};
const json = `${JSON.stringify(evidence, null, 2)}\n`;
if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json);
}
if (!quiet) process.stdout.write(json);

const realMatches = real.every((result) => result.matched);
const naiveIsAdversarial = caseId ? true : evidence.naive.confusion.falsePass.count >= 5;
if (!realMatches || !naiveIsAdversarial || (!caseId && evidence.isolationDrill.status !== "GREEN")) process.exitCode = 1;
