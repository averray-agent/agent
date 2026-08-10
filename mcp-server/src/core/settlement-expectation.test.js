import assert from "node:assert/strict";
import test from "node:test";

import { DISPUTE_WINDOW_SECONDS, buildSettlementExpectation } from "./settlement-expectation.js";

// The gap this closes. On 2026-08-10 the live board carried 8 benchmark jobs and 4
// human_fallback ones, and the listing exposed no verifier mode at all — so a third
// of the work routed to human review with a seven-day worst case and looked, to a
// browsing agent, exactly like the work that settles by itself.
test("an automatic mode says so and carries no human-review bound", () => {
  for (const mode of ["benchmark", "deterministic"]) {
    const s = buildSettlementExpectation(mode);
    assert.equal(s.path, "automatic");
    assert.match(s.approval, /No human is involved/u);
    assert.equal("humanReviewWorstCaseSeconds" in s, false, `${mode} must not imply a review bound`);
    assert.equal("worstCase" in s, false);
  }
});

test("human review is bounded by the dispute window, and says a human decides", () => {
  const s = buildSettlementExpectation("human_fallback");
  assert.equal(s.path, "human_review");
  assert.match(s.approval, /no automatic approval/iu);
  assert.equal(s.humanReviewWorstCaseSeconds, DISPUTE_WINDOW_SECONDS);
});

// github_pr approves on its own but degrades to human review, and a worker deserves
// to know that before it starts rather than after it submits.
test("the automatic-with-fallback mode names both outcomes", () => {
  const s = buildSettlementExpectation("github_pr");
  assert.equal(s.path, "automatic_with_human_fallback");
  assert.match(s.worstCase, /human review/iu);
  assert.equal(s.humanReviewWorstCaseSeconds, DISPUTE_WINDOW_SECONDS);
});

// The value is the one read from EscrowCore on 2026-08-10. If the contract's window
// ever changes this figure is wrong, and this test is where that gets noticed.
test("the bound is the seven-day dispute window", () => {
  assert.equal(DISPUTE_WINDOW_SECONDS, 604800);
  assert.equal(DISPUTE_WINDOW_SECONDS / 86400, 7);
});

// An absent block is honest. A guessed one is a confident wrong answer an agent
// would act on, which is worse than saying nothing.
test("an unknown or missing mode produces nothing rather than a guess", () => {
  for (const mode of [undefined, null, "", "  ", "not_a_mode", 42]) {
    assert.equal(buildSettlementExpectation(mode), undefined, `${String(mode)} must not be guessed`);
  }
});

test("the mode is matched case- and whitespace-insensitively", () => {
  assert.equal(buildSettlementExpectation("  BENCHMARK ").path, "automatic");
  assert.equal(buildSettlementExpectation("Human_Fallback").path, "human_review");
});

// Derived on read, never stored — so the expectation cannot drift from the mode it
// describes. Pinning that here because storing it would be the obvious "optimisation".
test("every known mode is derived purely from its name", () => {
  const modes = ["benchmark", "deterministic", "github_pr", "human_fallback"];
  for (const mode of modes) {
    assert.deepEqual(
      buildSettlementExpectation(mode),
      buildSettlementExpectation(mode),
      "derivation must be a pure function of the mode"
    );
    assert.equal(buildSettlementExpectation(mode).verifierMode, mode);
  }
});
