import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSessionCanTransition,
  buildSessionLifecycle,
  describeSessionStatus,
  getSessionStateMachineDefinition,
  transitionSession
} from "./session-state-machine.js";

test("describeSessionStatus exposes the verification phase and allowed transitions", () => {
  const submitted = describeSessionStatus("submitted");
  assert.equal(submitted.phase, "verification");
  assert.equal(submitted.terminal, false);
  assert.deepEqual(submitted.allowedTransitions.sort(), ["closed", "disputed", "rejected", "resolved", "timed_out"]);
});

test("buildSessionLifecycle derives operator-facing flags from session state", () => {
  const session = transitionSession({ sessionId: "s1" }, "claimed", {
    reason: "job_claimed",
    timestamp: "2026-04-23T10:00:00.000Z"
  });
  const submitted = transitionSession(session, "submitted", {
    reason: "work_submitted",
    timestamp: "2026-04-23T10:05:00.000Z"
  });
  const lifecycle = buildSessionLifecycle(submitted, { outcome: "approved" });

  assert.equal(lifecycle.currentPhase, "verification");
  assert.equal(lifecycle.awaitingVerification, true);
  assert.equal(lifecycle.verificationOutcome, "approved");
  assert.equal(lifecycle.canSubmit, false);
});

test("getSessionStateMachineDefinition returns stable public statuses", () => {
  const statuses = getSessionStateMachineDefinition();
  assert.ok(statuses.some((entry) => entry.status === "claimed"));
  assert.ok(statuses.some((entry) => entry.status === "resolved" && entry.terminal === true));
  assert.ok(!statuses.some((entry) => entry.status === "__new__"));
});

test("transitionSession rejects duplicate and illegal transitions with operator context", () => {
  const claimed = transitionSession({ sessionId: "s1" }, "claimed", {
    reason: "job_claimed",
    timestamp: "2026-04-23T10:00:00.000Z"
  });

  assert.throws(
    () => transitionSession(claimed, "claimed", { reason: "duplicate_claim" }),
    (error) => {
      assert.equal(error.code, "invalid_session_transition");
      assert.equal(error.details.currentStatus, "claimed");
      assert.equal(error.details.nextStatus, "claimed");
      assert.deepEqual(error.details.allowedTransitions.sort(), ["closed", "expired", "submitted", "timed_out"]);
      return true;
    }
  );

  assert.throws(
    () => assertSessionCanTransition(claimed, "resolved", { reason: "skip_submit" }),
    (error) => {
      assert.equal(error.code, "invalid_session_transition");
      assert.equal(error.details.currentPhase, "work");
      assert.equal(error.details.terminal, false);
      return true;
    }
  );
});
