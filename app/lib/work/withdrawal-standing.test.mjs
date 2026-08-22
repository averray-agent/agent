import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDIT_INTEREST_STATEMENT,
  WITHDRAWAL_STANDING_STATEMENT,
  withdrawalStandingFromIntent
} from "./withdrawal-standing.js";

function standing(overrides = {}) {
  return {
    claimTier: "pro",
    claimTierLabel: "claim tier",
    reputationTier: "journeyman",
    badges: 3,
    waiverSlotsRemaining: 1,
    creditInterest: { eligible: true, registered: false },
    registerPath: "/credit/interest",
    creditInterestStatement: CREDIT_INTEREST_STATEMENT,
    persists: true,
    statement: WITHDRAWAL_STANDING_STATEMENT,
    ...overrides
  };
}

test("withdrawal standing card accepts only the live complete eligible projection", () => {
  const result = withdrawalStandingFromIntent({ standing: standing() });
  assert.equal(result.claimTier, "pro");
  assert.equal(result.reputationTier, "journeyman");
  assert.equal(result.badges, 3);
  assert.equal(result.waiverSlotsRemaining, 1);
  assert.equal(result.registerPath, "/credit/interest");
  assert.equal(result.creditInterestStatement, CREDIT_INTEREST_STATEMENT);
});

test("ineligible standing has no credit line or registration path", () => {
  const value = standing({ creditInterest: { eligible: false, registered: false } });
  delete value.registerPath;
  delete value.creditInterestStatement;
  const result = withdrawalStandingFromIntent({
    standing: value
  });
  assert.equal(result.creditInterest.eligible, false);
  assert.equal(Object.hasOwn(result, "registerPath"), false);
  assert.equal(Object.hasOwn(result, "creditInterestStatement"), false);
});

test("withdrawal standing card refuses fallback copy or incomplete live facts", () => {
  assert.equal(withdrawalStandingFromIntent({ standing: standing({ badges: undefined }) }), null);
  assert.equal(withdrawalStandingFromIntent({ standing: standing({ statement: "Your standing remains." }) }), null);
  assert.equal(withdrawalStandingFromIntent({ standing: standing({ registerPath: undefined }) }), null);
});
