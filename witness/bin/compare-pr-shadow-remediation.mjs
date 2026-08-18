#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_CASES = new Set([1149, 1148, 1147, 1146, 1145].map((number) => `averray-agent/agent#${number}`));
const UV_CASE_PREFIX = "averray-agent/agent-harness#";
const REFERENCE_CASE_PREFIX = "depre-dev/averray-reference-agent#";

function parseArgs(argv) {
  const options = {
    baseline: resolve(WITNESS_ROOT, "evidence/pr-shadow/report.json"),
    currentMain: resolve(WITNESS_ROOT, "evidence/pr-shadow/post-ambiguity-report.json"),
    diagnosis: resolve(WITNESS_ROOT, "evidence/pr-shadow/coverage-diagnosis-report.json"),
    after: resolve(WITNESS_ROOT, "evidence/pr-shadow/implementation-ceiling-report.json"),
    adversarial: resolve(WITNESS_ROOT, "evidence/adversarial-pkt-witness-009.json"),
    drills: resolve(WITNESS_ROOT, "evidence/implementation-ceiling-drills-pkt-witness-009.json"),
    out: resolve(WITNESS_ROOT, "evidence/pr-shadow/implementation-ceiling-comparison.json")
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/u, "");
    const value = argv[index + 1];
    if (!Object.hasOwn(options, key) || !value) throw new Error(`${argv[index]} requires a value`);
    options[key] = resolve(value);
  }
  return options;
}

function ids(report) {
  return report.results.map((result) => result.id).sort();
}

function decided(report) {
  return report.results.filter((result) => ![null, "INCONCLUSIVE"].includes(result.verdict));
}

function detectorFalsePositiveCases(report) {
  return report.results.filter((result) => [
    ...(result.integrityViolations || []),
    ...(result.integrityAmbiguities || [])
  ].some((finding) => finding.judgement?.classification === "false_positive"));
}

function countBy(values, key) {
  const counts = {};
  for (const value of values) {
    const name = value[key] || "none";
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

function resultSummary(result) {
  const headCheckNetworkModes = (result.checks?.head?.attempts || [])
    .filter((attempt) => attempt.checkAttempt)
    .map((attempt) => attempt.networkMode);
  const baseDiagnosticCheckNetworkModes = (result.checks?.baseDiagnostic?.attempts || [])
    .filter((attempt) => attempt.checkAttempt)
    .map((attempt) => attempt.networkMode);
  return {
    id: result.id,
    verdict: result.verdict,
    reason: result.reason,
    baseCheckDiagnosis: result.baseCheckDiagnosis || null,
    headCheckNetworkModes,
    baseDiagnosticCheckNetworkModes
  };
}

const options = parseArgs(process.argv.slice(2));
const [baseline, currentMain, diagnosis, after, adversarial, drills] = await Promise.all([
  options.baseline,
  options.currentMain,
  options.diagnosis,
  options.after,
  options.adversarial,
  options.drills
].map((path) => readFile(path, "utf8").then(JSON.parse)));
const cohortIds = ids(baseline);
if ([currentMain, diagnosis, after].some((report) => JSON.stringify(ids(report)) !== JSON.stringify(cohortIds))) {
  throw new Error("all measurements must contain the same frozen 20-PR cohort");
}

const afterById = new Map(after.results.map((result) => [result.id, result]));
const originalSixteen = baseline.results.filter((result) => result.verdict === "INCONCLUSIVE")
  .map((result) => afterById.get(result.id));
const fixedArtifacts = originalSixteen.filter((result) => result.verdict !== "INCONCLUSIVE");
const structural = originalSixteen.filter((result) => result.baseCheckDiagnosis?.structural === true);
const unresolvedArtifacts = originalSixteen.filter((result) =>
  result.verdict === "INCONCLUSIVE" && result.baseCheckDiagnosis?.structural !== true);
const residual = after.results.filter((result) => result.verdict === "INCONCLUSIVE");
const structuralResidual = residual.filter((result) => result.baseCheckDiagnosis?.structural === true);
const verifierSemanticResidual = residual.filter((result) => result.reason === "integrity_detection_ambiguous");
const otherResidual = residual.filter((result) =>
  result.baseCheckDiagnosis?.structural !== true && result.reason !== "integrity_detection_ambiguous");
const httpCases = after.results.filter((result) => HTTP_CASES.has(result.id)).map(resultSummary);
const uvCases = after.results.filter((result) => result.id.startsWith(UV_CASE_PREFIX)).map(resultSummary);
const prerequisiteCases = after.results.filter((result) => result.id.startsWith(REFERENCE_CASE_PREFIX) &&
  baseline.results.some((before) => before.id === result.id && before.verdict === "INCONCLUSIVE"))
  .map(resultSummary);
const detectorFalsePositives = detectorFalsePositiveCases(after);
const observedCheckNetworkModes = after.results.flatMap((result) => [
  ...(result.checks?.head?.attempts || []),
  ...(result.checks?.baseDiagnostic?.attempts || [])
]).filter((attempt) => attempt.checkAttempt).map((attempt) => attempt.networkMode);

const comparison = {
  schemaVersion: "averray.witness.implementation-ceiling-comparison/v1",
  generatedAt: new Date().toISOString(),
  sameFrozenCohort: true,
  cohort: { total: cohortIds.length, ids: cohortIds },
  coverageHistory: [
    { measurement: "#1152 baseline", decided: decided(baseline).length, total: cohortIds.length },
    {
      measurement: "current main (#1155, including the #1154 regression)",
      decided: decided(diagnosis).length,
      total: cohortIds.length
    },
    { measurement: "PKT-WITNESS-009", decided: decided(after).length, total: cohortIds.length }
  ],
  originalSixteen: {
    total: originalSixteen.length,
    implementationArtifactsRemoved: fixedArtifacts.length,
    structurallyUndecidable: structural.length,
    unresolvedImplementationArtifacts: unresolvedArtifacts.length,
    artifactCases: fixedArtifacts.map((result) => result.id),
    structuralCases: structural.map((result) => result.id)
  },
  residualInconclusives: {
    total: residual.length,
    structurallyUndecidable: structuralResidual.length,
    verifierSemanticAmbiguities: verifierSemanticResidual.length,
    otherImplementationArtifacts: otherResidual.length,
    byReason: countBy(residual, "reason"),
    byExecutionSubcause: countBy(structuralResidual.map((result) => ({
      subcause: result.baseCheckDiagnosis?.subcause
    })), "subcause"),
    cases: residual.map(resultSummary)
  },
  causeRemediation: {
    uv: {
      before: 6,
      decided: uvCases.filter((result) => result.verdict !== "INCONCLUSIVE").length,
      cases: uvCases
    },
    httpSmoke: {
      before: 5,
      finding: "all five checks use loopback HTTP; bind-mount filesystem latency caused their timeout, not egress denial",
      decided: httpCases.filter((result) => result.verdict !== "INCONCLUSIVE").length,
      cases: httpCases
    },
    missingCiPrerequisites: {
      before: 5,
      finding: "the canonical gate requires privileged Docker/database services or private CI credentials; the Witness does not fake or expose either",
      decided: prerequisiteCases.filter((result) => result.verdict !== "INCONCLUSIVE").length,
      structural: prerequisiteCases.filter((result) => result.baseCheckDiagnosis?.structural === true).length,
      cases: prerequisiteCases
    }
  },
  regressionBar: {
    adversarialExactVerdicts: adversarial.real.confusion.exactVerdicts,
    adversarialTotal: adversarial.real.confusion.total,
    adversarialFalsePasses: adversarial.real.confusion.falsePass.count,
    detectorFalsePositivePullRequests: detectorFalsePositives.length,
    detectorFalsePositiveRatePct: Number(((detectorFalsePositives.length / cohortIds.length) * 100).toFixed(1)),
    policyFalsePositivePullRequests: after.falsePositiveRate.pullRequests,
    policyFalsePositiveRatePct: after.falsePositiveRate.ratePct,
    authoredMakeRule5: drills.authoredRule5Regression.status,
    dockerNetworkMode: drills.egressIsolation.enforced.dockerNetworkMode,
    interfacesInsideContainer: drills.egressIsolation.enforced.interfacesInsideContainer,
    observedShadowCheckNetworkModes: [...new Set(observedCheckNetworkModes)],
    everyObservedShadowCheckUsedNetworkNone: observedCheckNetworkModes.length > 0 &&
      observedCheckNetworkModes.every((mode) => mode === "none")
  }
};

await mkdir(dirname(options.out), { recursive: true });
await writeFile(options.out, `${JSON.stringify(comparison, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);

const pass = cohortIds.length === 20 && originalSixteen.length === 16 &&
  decided(currentMain).length === 2 && decided(diagnosis).length === 2 && decided(after).length === 13 &&
  fixedArtifacts.length === 11 && structural.length === 5 && unresolvedArtifacts.length === 0 &&
  residual.length === 7 && structuralResidual.length === 5 &&
  verifierSemanticResidual.length === 2 && otherResidual.length === 0 &&
  httpCases.length === 5 && uvCases.length === 6 && prerequisiteCases.length === 5 &&
  httpCases.every((result) => result.verdict !== "INCONCLUSIVE") &&
  uvCases.every((result) => result.verdict !== "INCONCLUSIVE") &&
  prerequisiteCases.every((result) => result.baseCheckDiagnosis?.structural === true) &&
  adversarial.real.confusion.exactVerdicts === 15 && adversarial.real.confusion.total === 15 &&
  adversarial.real.confusion.falsePass.count === 0 && detectorFalsePositives.length === 0 &&
  after.falsePositiveRate.ratePct <= 10 && drills.authoredRule5Regression.status === "GREEN" &&
  drills.egressIsolation.enforced.dockerNetworkMode === "none" &&
  comparison.regressionBar.everyObservedShadowCheckUsedNetworkNone;
if (!pass) process.exitCode = 1;
