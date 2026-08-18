#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASE_CHECK_CAUSES,
  BASE_CHECK_ERROR_SUBCAUSES,
  diagnoseBaseCheckUnavailability
} from "../src/pr-shadow.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    before: resolve(WITNESS_ROOT, "evidence", "pr-shadow", "report.json"),
    regressionBaseline: resolve(WITNESS_ROOT, "evidence", "pr-shadow", "post-ambiguity-report.json"),
    after: resolve(WITNESS_ROOT, "evidence", "pr-shadow", "coverage-diagnosis-report.json"),
    adversarial: resolve(WITNESS_ROOT, "evidence", "adversarial-corpus.json"),
    out: resolve(WITNESS_ROOT, "evidence", "pr-shadow", "coverage-comparison.json")
  };
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1];
    if (!value) throw new Error(`${argv[index]} requires a value`);
    if (argv[index] === "--before") options.before = resolve(value);
    else if (argv[index] === "--regression-baseline") options.regressionBaseline = resolve(value);
    else if (argv[index] === "--after") options.after = resolve(value);
    else if (argv[index] === "--adversarial") options.adversarial = resolve(value);
    else if (argv[index] === "--out") options.out = resolve(value);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

function counts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function sortedIds(report) {
  return report.results.map((result) => result.id).sort();
}

function decided(report) {
  return report.results.filter((result) => !["INCONCLUSIVE", null].includes(result.verdict));
}

function detectorFalsePositiveCases(report) {
  return new Set(report.results.flatMap((result) => [
    ...(result.integrityViolations || []),
    ...(result.integrityAmbiguities || [])
  ].filter((finding) => finding.judgement?.classification === "false_positive")
    .map(() => result.id)));
}

const options = parseArgs(process.argv.slice(2));
const [before, regressionBaseline, after, adversarial] = await Promise.all([
  readFile(options.before, "utf8").then(JSON.parse),
  readFile(options.regressionBaseline, "utf8").then(JSON.parse),
  readFile(options.after, "utf8").then(JSON.parse),
  readFile(options.adversarial, "utf8").then(JSON.parse)
]);
const beforeIds = sortedIds(before);
const regressionBaselineIds = sortedIds(regressionBaseline);
const afterIds = sortedIds(after);
if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds) ||
    JSON.stringify(beforeIds) !== JSON.stringify(regressionBaselineIds)) {
  throw new Error("coverage, regression-baseline, and after reports do not contain the same frozen PR cohort");
}

const originalUnavailable = before.results.filter((result) => result.reason === "repository_check_unavailable");
const originalInheritance = before.results.filter((result) => result.reason === "unresolvable_command");
const causeCounts = counts(Object.values(BASE_CHECK_CAUSES));
const subcauseCounts = counts(Object.values(BASE_CHECK_ERROR_SUBCAUSES));
const diagnosedCases = originalUnavailable.map((result) => {
  const diagnosis = diagnoseBaseCheckUnavailability(result.checks?.baseDiagnostic || null);
  causeCounts[diagnosis.cause] += 1;
  if (diagnosis.subcause) subcauseCounts[diagnosis.subcause] += 1;
  return { id: result.id, ...diagnosis };
});
const structural = diagnosedCases.filter((entry) => entry.structural);
const executionArtifacts = diagnosedCases.filter((entry) => !entry.structural);
const afterById = new Map(after.results.map((result) => [result.id, result]));
const inheritanceAfter = originalInheritance.map((result) => {
  const current = afterById.get(result.id);
  return {
    id: result.id,
    beforeReason: result.reason,
    afterVerdict: current?.verdict || null,
    afterReason: current?.reason || null,
    judgingCommandProtected: current?.judgingCommandProtected ?? null,
    baseCheckDiagnosis: current?.baseCheckDiagnosis || null
  };
});
const inheritanceResidualStructural = inheritanceAfter.filter((result) =>
  result.baseCheckDiagnosis?.structural === true
);
const inheritanceResidualArtifacts = inheritanceAfter.filter((result) =>
  result.afterVerdict === "INCONCLUSIVE" && result.baseCheckDiagnosis?.structural === false
);
const inheritanceNowDecided = inheritanceAfter.filter((result) =>
  !["INCONCLUSIVE", null].includes(result.afterVerdict)
);
const inheritanceCauseCounts = counts(Object.values(BASE_CHECK_CAUSES));
const inheritanceSubcauseCounts = counts(Object.values(BASE_CHECK_ERROR_SUBCAUSES));
for (const result of inheritanceAfter) {
  if (result.baseCheckDiagnosis?.cause) inheritanceCauseCounts[result.baseCheckDiagnosis.cause] += 1;
  if (result.baseCheckDiagnosis?.subcause) inheritanceSubcauseCounts[result.baseCheckDiagnosis.subcause] += 1;
}
const detectorFalsePositives = detectorFalsePositiveCases(after);
const adversarialExact = adversarial.real.results.filter((result) => result.matched).length;

const comparison = {
  schemaVersion: "averray.witness.pr-shadow-coverage-diagnosis/v1",
  generatedAt: new Date().toISOString(),
  sameFrozenCohort: true,
  cohort: { total: beforeIds.length, ids: beforeIds },
  coverage: {
    before: {
      decided: decided(before).length,
      total: beforeIds.length,
      inconclusive: before.results.filter((result) => result.verdict === "INCONCLUSIVE").length,
      source: "PKT-WITNESS-006 report preserved by #1152"
    },
    normalizedBefore: {
      decided: decided(regressionBaseline).length,
      total: regressionBaseline.results.length,
      inconclusive: regressionBaseline.results.filter((result) => result.verdict === "INCONCLUSIVE").length,
      source: "current-main baseline after #1154 correctly moved two detector ambiguities to INCONCLUSIVE"
    },
    after: {
      decided: decided(after).length,
      total: afterIds.length,
      inconclusive: after.results.filter((result) => result.verdict === "INCONCLUSIVE").length,
      decisionGainFromShadowRelaxation: decided(after).length - decided(regressionBaseline).length
    }
  },
  originalSixteen: {
    total: originalUnavailable.length + originalInheritance.length,
    structurallyUndecidable: structural.length + inheritanceResidualStructural.length,
    implementationArtifacts: originalUnavailable.length + originalInheritance.length -
      structural.length - inheritanceResidualStructural.length,
    artifactBreakdown: {
      overStrictRule5Inheritance: originalInheritance.length,
      executionEnvironmentOrRecipe: executionArtifacts.length
    },
    note: "The artifact breakdown records the first observed blocker; Rule 5 cases may expose a second blocker once allowed to run."
  },
  originalTenUnavailableBaseChecks: {
    total: originalUnavailable.length,
    byCause: causeCounts,
    executionErrorSubcauses: subcauseCounts,
    cases: diagnosedCases
  },
  originalSixRule5CasesAfterRelaxation: inheritanceAfter,
  rule5RelaxationOutcome: {
    decided: inheritanceNowDecided.length,
    structurallyUndecidable: inheritanceResidualStructural.length,
    implementationArtifacts: inheritanceResidualArtifacts.length,
    byCause: inheritanceCauseCounts,
    executionErrorSubcauses: inheritanceSubcauseCounts
  },
  regressionBar: {
    adversarialExactVerdicts: adversarialExact,
    adversarialTotal: adversarial.real.results.length,
    adversarialFalsePasses: adversarial.real.confusion.falsePass.count,
    detectorFalsePositivePullRequests: detectorFalsePositives.size,
    detectorFalsePositiveRatePct: Number(((detectorFalsePositives.size / afterIds.length) * 100).toFixed(1)),
    policyFalsePositiveRateBeforePct: regressionBaseline.falsePositiveRate.ratePct,
    policyFalsePositivePullRequests: after.falsePositiveRate.pullRequests,
    policyFalsePositiveRatePct: after.falsePositiveRate.ratePct
  }
};

await mkdir(dirname(options.out), { recursive: true });
await writeFile(options.out, `${JSON.stringify(comparison, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);

if (comparison.originalSixteen.total !== 16 || originalUnavailable.length !== 10 || originalInheritance.length !== 6 ||
    adversarialExact !== adversarial.real.results.length || adversarial.real.confusion.falsePass.count !== 0 ||
    adversarial.real.results.length !== 15 ||
    detectorFalsePositives.size !== 0 ||
    after.falsePositiveRate.ratePct > regressionBaseline.falsePositiveRate.ratePct) {
  process.exitCode = 1;
}
