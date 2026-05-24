import test from "node:test";
import assert from "node:assert/strict";

import {
  decisionToVerdict,
  releaseAmountForDecision,
  verdictToDecision,
} from "./dispute-verdicts.js";

test("decisionToVerdict maps operator decisions to backend verdict tokens", () => {
  assert.equal(decisionToVerdict("uphold"), "upheld");
  assert.equal(decisionToVerdict("reject"), "dismissed");
  assert.equal(decisionToVerdict("split"), "split");
});

test("decisionToVerdict rejects unknown decision tokens instead of silently settling", () => {
  assert.throws(
    () => decisionToVerdict("request-more"),
    /Unknown dispute decision/u
  );
});

test("verdictToDecision keeps backend split verdicts explicit in the operator UI", () => {
  assert.equal(verdictToDecision("split"), "split");
  assert.equal(verdictToDecision("partial"), "split");
  assert.equal(verdictToDecision("request-more"), "split");
});

test("verdictToDecision maps resolved verdict aliases and ignores unknown tokens", () => {
  assert.equal(verdictToDecision("upheld"), "uphold");
  assert.equal(verdictToDecision("uphold"), "uphold");
  assert.equal(verdictToDecision("dismissed"), "reject");
  assert.equal(verdictToDecision("rejected"), "reject");
  assert.equal(verdictToDecision("needs-human"), null);
});

test("releaseAmountForDecision mirrors backend default split payout semantics", () => {
  assert.equal(
    releaseAmountForDecision({ decision: "split", remainingPayout: 7, stakeFrozen: 9 }),
    3
  );
  assert.equal(
    releaseAmountForDecision({ decision: "split", remainingPayout: 1, stakeFrozen: 9 }),
    1
  );
  assert.equal(
    releaseAmountForDecision({ decision: "reject", remainingPayout: 7, stakeFrozen: 9 }),
    7
  );
  assert.equal(
    releaseAmountForDecision({ decision: "uphold", remainingPayout: 7, stakeFrozen: 9 }),
    9
  );
});
