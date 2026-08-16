import { VERDICTS } from "./executor.mjs";

const LABELS = Object.freeze([
  VERDICTS.PASS,
  VERDICTS.FAIL,
  VERDICTS.INCONCLUSIVE,
  VERDICTS.POLICY_VIOLATION
]);

export function confusionMatrix(results, { knownUndetectableNotRepresented = [] } = {}) {
  const matrix = Object.fromEntries(LABELS.map((expected) => [
    expected,
    Object.fromEntries(LABELS.map((actual) => [actual, 0]))
  ]));
  for (const result of results) {
    matrix[result.expectedVerdict][result.actualVerdict] += 1;
  }

  const falsePassCases = results
    .filter((result) => result.expectedVerdict !== VERDICTS.PASS && result.actualVerdict === VERDICTS.PASS)
    .map((result) => result.id);
  const falseFailCases = results
    .filter((result) => result.expectedVerdict === VERDICTS.PASS && result.actualVerdict !== VERDICTS.PASS)
    .map((result) => result.id);
  const actualInconclusive = results.filter((result) => result.actualVerdict === VERDICTS.INCONCLUSIVE);
  const expectedInconclusive = results.filter((result) => result.expectedVerdict === VERDICTS.INCONCLUSIVE);
  const attributionCorrect = expectedInconclusive.filter((result) =>
    result.actualVerdict === VERDICTS.INCONCLUSIVE &&
    result.actualAttribution === result.expectedAttribution
  );

  return {
    total: results.length,
    matrix,
    falsePass: {
      count: falsePassCases.length,
      cases: falsePassCases
    },
    falseFail: {
      count: falseFailCases.length,
      cases: falseFailCases
    },
    inconclusive: {
      count: actualInconclusive.length,
      rate: results.length === 0 ? 0 : actualInconclusive.length / results.length
    },
    attributionAccuracy: {
      correct: attributionCorrect.length,
      expected: expectedInconclusive.length,
      rate: expectedInconclusive.length === 0 ? 1 : attributionCorrect.length / expectedInconclusive.length
    },
    exactVerdicts: results.filter((result) => result.expectedVerdict === result.actualVerdict).length,
    scopeQualification: {
      claim: "false-pass counts cover represented detectable classes only",
      knownUndetectableNotRepresented: {
        count: knownUndetectableNotRepresented.length,
        classes: knownUndetectableNotRepresented
      }
    }
  };
}
