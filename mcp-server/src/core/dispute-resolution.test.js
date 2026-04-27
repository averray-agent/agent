import test from "node:test";
import assert from "node:assert/strict";

import {
  ARBITRATOR_SLA_SECONDS,
  buildDisputeResolution,
  normalizeDisputeVerdict
} from "./dispute-resolution.js";
import { ValidationError } from "./errors.js";

test("buildDisputeResolution maps upheld disputes to zero-payout dispute loss", () => {
  const result = buildDisputeResolution({ verdict: "upheld", remainingPayout: 5 });

  assert.equal(result.workerPayout, 0);
  assert.equal(result.reasonCode, "DISPUTE_LOST");
  assert.equal(result.nextSessionStatus, "rejected");
  assert.equal(result.releaseAction, "slash-to-treasury");
});

test("buildDisputeResolution maps dismissed disputes to full worker payout", () => {
  const result = buildDisputeResolution({ verdict: "dismissed", remainingPayout: 5 });

  assert.equal(result.workerPayout, 5);
  assert.equal(result.reasonCode, "DISPUTE_OVERTURNED");
  assert.equal(result.nextSessionStatus, "resolved");
});

test("buildDisputeResolution supports operator-supplied partial payouts", () => {
  const result = buildDisputeResolution({ verdict: "split", remainingPayout: 7, workerPayout: 3 });

  assert.equal(result.workerPayout, 3);
  assert.equal(result.reasonCode, "DISPUTE_PARTIAL");
  assert.equal(result.payoutSource, "operator_supplied");
});

test("buildDisputeResolution has a timeout-shaped worker-favorable outcome", () => {
  const result = buildDisputeResolution({ verdict: "timeout", remainingPayout: 9 });

  assert.equal(result.workerPayout, 9);
  assert.equal(result.reasonCode, "ARB_TIMEOUT");
  assert.equal(result.nextSessionStatus, "resolved");
  assert.equal(ARBITRATOR_SLA_SECONDS, 14 * 24 * 60 * 60);
});

test("normalizeDisputeVerdict rejects unknown values", () => {
  assert.throws(
    () => normalizeDisputeVerdict("maybe"),
    (error) => error instanceof ValidationError && /verdict must be/u.test(error.message)
  );
});
