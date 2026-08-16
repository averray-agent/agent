import assert from "node:assert/strict";
import test from "node:test";

import { confusionMatrix } from "../src/confusion-matrix.mjs";
import { VERDICTS } from "../src/executor.mjs";

test("confusion matrix counts every false pass, false fail, and attribution", () => {
  const matrix = confusionMatrix([
    { id: "attack", expectedVerdict: VERDICTS.POLICY_VIOLATION, actualVerdict: VERDICTS.PASS },
    { id: "missed-failure", expectedVerdict: VERDICTS.FAIL, actualVerdict: VERDICTS.PASS },
    { id: "correct-rejected", expectedVerdict: VERDICTS.PASS, actualVerdict: VERDICTS.FAIL },
    {
      id: "inconclusive",
      expectedVerdict: VERDICTS.INCONCLUSIVE,
      actualVerdict: VERDICTS.INCONCLUSIVE,
      expectedAttribution: "candidate",
      actualAttribution: "candidate"
    }
  ]);
  assert.deepEqual(matrix.falsePass.cases, ["attack", "missed-failure"]);
  assert.deepEqual(matrix.falseFail.cases, ["correct-rejected"]);
  assert.equal(matrix.inconclusive.rate, 0.25);
  assert.deepEqual(matrix.attributionAccuracy, { correct: 1, expected: 1, rate: 1 });
});
