import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSessionCanReceiveVerification,
  assertSessionCanTransition,
  buildSessionLifecycle,
  canTransitionSession,
  describeSessionStatus,
  getAllowedSessionTransitions,
  getSessionStateMachineDefinition,
  transitionSession
} from "./session-state-machine.js";

const EXPECTED_TRANSITIONS = {
  "__new__": ["claimed"],
  claimed: ["closed", "expired", "submitted", "timed_out"],
  submitted: ["closed", "disputed", "rejected", "resolved", "timed_out"],
  disputed: ["closed", "rejected", "resolved"],
  resolved: [],
  rejected: [],
  closed: [],
  expired: [],
  timed_out: []
};

const PUBLIC_STATUSES = Object.keys(EXPECTED_TRANSITIONS).filter((status) => status !== "__new__");

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

test("session state machine covers every legal and illegal transition edge", () => {
  for (const [fromStatus, allowedTransitions] of Object.entries(EXPECTED_TRANSITIONS)) {
    assert.deepEqual(getAllowedSessionTransitions(fromStatus).sort(), allowedTransitions);

    for (const nextStatus of PUBLIC_STATUSES) {
      const session = sessionForStatus(fromStatus);
      const allowed = allowedTransitions.includes(nextStatus);

      assert.equal(
        canTransitionSession(session, nextStatus),
        allowed,
        `${fromStatus} -> ${nextStatus} canTransitionSession drifted`
      );

      if (allowed) {
        assert.equal(assertSessionCanTransition(session, nextStatus, { reason: "edge_test" }), true);
        const transitioned = transitionSession(session, nextStatus, {
          reason: "edge_test",
          timestamp: "2026-05-16T12:00:00.000Z",
          metadata: { fromStatus, nextStatus }
        });
        assert.equal(transitioned.status, nextStatus);
        assert.equal(transitioned.statusHistory.at(-1).from, fromStatus === "__new__" ? null : fromStatus);
        assert.equal(transitioned.statusHistory.at(-1).to, nextStatus);
        assert.equal(transitioned.statusHistory.at(-1).reason, "edge_test");
        assert.deepEqual(transitioned.statusHistory.at(-1).metadata, { fromStatus, nextStatus });
      } else {
        assert.throws(
          () => assertSessionCanTransition(session, nextStatus, { reason: "edge_test" }),
          (error) => {
            assert.equal(error.code, "invalid_session_transition");
            assert.equal(error.details.currentStatus, fromStatus);
            assert.equal(error.details.nextStatus, nextStatus);
            assert.equal(error.details.reason, "edge_test");
            assert.deepEqual(error.details.allowedTransitions.sort(), allowedTransitions);
            assert.equal(error.details.currentPhase, describeSessionStatus(fromStatus).phase);
            assert.equal(error.details.terminal, describeSessionStatus(fromStatus).terminal);
            return true;
          },
          `${fromStatus} -> ${nextStatus} should be rejected`
        );
      }
    }
  }
});

test("verification receive guard is limited to verifiable session states", () => {
  for (const status of PUBLIC_STATUSES) {
    const session = sessionForStatus(status);
    if (status === "submitted" || status === "disputed") {
      assert.equal(assertSessionCanReceiveVerification(session, { reason: "verifier_callback" }), true);
      continue;
    }

    assert.throws(
      () => assertSessionCanReceiveVerification(session, { reason: "verifier_callback" }),
      (error) => {
        assert.equal(error.code, "invalid_session_transition");
        assert.equal(error.details.currentStatus, status);
        assert.equal(error.details.nextStatus, "resolved|rejected|disputed");
        assert.equal(error.details.reason, "verifier_callback");
        assert.deepEqual(error.details.allowedTransitions.sort(), EXPECTED_TRANSITIONS[status]);
        assert.equal(error.details.currentPhase, describeSessionStatus(status).phase);
        assert.equal(error.details.terminal, describeSessionStatus(status).terminal);
        return true;
      }
    );
  }
});

function sessionForStatus(status) {
  if (status === "__new__") {
    return { sessionId: "new-session" };
  }
  return {
    sessionId: `${status}-session`,
    status,
    statusHistory: [
      {
        from: null,
        to: status,
        reason: "fixture",
        at: "2026-05-16T11:00:00.000Z"
      }
    ]
  };
}
