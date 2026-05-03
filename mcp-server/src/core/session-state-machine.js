import { ConflictError } from "./errors.js";

const ALLOWED_TRANSITIONS = new Map([
  ["__new__", new Set(["claimed"])],
  ["claimed", new Set(["submitted", "expired", "timed_out", "closed"])],
  ["submitted", new Set(["resolved", "rejected", "disputed", "timed_out", "closed"])],
  ["disputed", new Set(["resolved", "rejected", "closed"])],
  ["resolved", new Set()],
  ["rejected", new Set()],
  ["closed", new Set()],
  ["expired", new Set()],
  ["timed_out", new Set()]
]);

const STATUS_METADATA = {
  "__new__": {
    label: "New",
    phase: "claim",
    terminal: false,
    outcome: "not_started"
  },
  claimed: {
    label: "Claimed",
    phase: "work",
    terminal: false,
    outcome: "in_progress"
  },
  submitted: {
    label: "Submitted",
    phase: "verification",
    terminal: false,
    outcome: "awaiting_verification"
  },
  disputed: {
    label: "Disputed",
    phase: "verification",
    terminal: false,
    outcome: "operator_attention"
  },
  resolved: {
    label: "Resolved",
    phase: "terminal",
    terminal: true,
    outcome: "approved"
  },
  rejected: {
    label: "Rejected",
    phase: "terminal",
    terminal: true,
    outcome: "rejected"
  },
  closed: {
    label: "Closed",
    phase: "terminal",
    terminal: true,
    outcome: "closed"
  },
  expired: {
    label: "Expired",
    phase: "terminal",
    terminal: true,
    outcome: "expired"
  },
  timed_out: {
    label: "Timed out",
    phase: "terminal",
    terminal: true,
    outcome: "timed_out"
  }
};

export function transitionSession(session, nextStatus, { reason, timestamp = new Date().toISOString(), metadata = undefined } = {}) {
  const currentStatus = session?.status ?? "__new__";
  assertSessionCanTransition(session, nextStatus, { reason });

  const history = [...(session?.statusHistory ?? []), compact({
    from: currentStatus === "__new__" ? null : currentStatus,
    to: nextStatus,
    reason,
    at: timestamp,
    metadata
  })];

  return compact({
    ...session,
    status: nextStatus,
    statusHistory: history,
    claimedAt: nextStatus === "claimed" ? timestamp : session?.claimedAt,
    submittedAt: nextStatus === "submitted" ? timestamp : session?.submittedAt,
    resolvedAt: nextStatus === "resolved" ? timestamp : session?.resolvedAt,
    rejectedAt: nextStatus === "rejected" ? timestamp : session?.rejectedAt,
    disputedAt: nextStatus === "disputed" ? timestamp : session?.disputedAt,
    closedAt: nextStatus === "closed" ? timestamp : session?.closedAt,
    expiredAt: nextStatus === "expired" ? timestamp : session?.expiredAt,
    timedOutAt: nextStatus === "timed_out" ? timestamp : session?.timedOutAt
  });
}

export function canTransitionSession(session, nextStatus) {
  const currentStatus = session?.status ?? "__new__";
  return (ALLOWED_TRANSITIONS.get(currentStatus) ?? new Set()).has(nextStatus);
}

export function assertSessionCanTransition(session, nextStatus, { reason = undefined } = {}) {
  const currentStatus = session?.status ?? "__new__";
  const allowedTransitions = getAllowedSessionTransitions(currentStatus);
  if (allowedTransitions.includes(nextStatus)) {
    return true;
  }
  throw new ConflictError(
    `Invalid session transition: ${currentStatus} -> ${nextStatus}`,
    "invalid_session_transition",
    {
      currentStatus,
      nextStatus,
      reason,
      allowedTransitions,
      currentPhase: describeSessionStatus(currentStatus).phase,
      terminal: describeSessionStatus(currentStatus).terminal
    }
  );
}

export function assertSessionCanReceiveVerification(session, { reason = "verification_resolved" } = {}) {
  const currentStatus = session?.status ?? "__new__";
  if (currentStatus === "submitted" || currentStatus === "disputed") {
    return true;
  }
  throw new ConflictError(
    `Session ${session?.sessionId ?? "<unknown>"} cannot receive verification while ${currentStatus}.`,
    "invalid_session_transition",
    {
      currentStatus,
      nextStatus: "resolved|rejected|disputed",
      reason,
      allowedTransitions: getAllowedSessionTransitions(currentStatus),
      currentPhase: describeSessionStatus(currentStatus).phase,
      terminal: describeSessionStatus(currentStatus).terminal
    }
  );
}

export function getAllowedSessionTransitions(status = "__new__") {
  return [...(ALLOWED_TRANSITIONS.get(status) ?? new Set())];
}

export function describeSessionStatus(status = "__new__") {
  const key = STATUS_METADATA[status] ? status : "__new__";
  const metadata = STATUS_METADATA[key];
  return {
    status: key,
    label: metadata.label,
    phase: metadata.phase,
    terminal: metadata.terminal,
    outcome: metadata.outcome,
    allowedTransitions: getAllowedSessionTransitions(key)
  };
}

export function buildSessionLifecycle(session = {}, verification = undefined) {
  const status = describeSessionStatus(session?.status ?? "__new__");
  const verificationOutcome = verification?.outcome;
  const finalOutcome = verificationOutcome
    ? verificationOutcome
    : status.terminal
      ? status.outcome
      : undefined;
  return {
    currentStatus: status.status,
    currentLabel: status.label,
    currentPhase: status.phase,
    terminal: status.terminal,
    allowedTransitions: status.allowedTransitions,
    verificationOutcome,
    finalOutcome,
    canSubmit: status.status === "claimed",
    awaitingVerification: status.status === "submitted" || status.status === "disputed",
    needsOperatorAttention: status.status === "disputed",
    timestamps: compact({
      claimedAt: session?.claimedAt,
      submittedAt: session?.submittedAt,
      resolvedAt: session?.resolvedAt,
      rejectedAt: session?.rejectedAt,
      disputedAt: session?.disputedAt,
      closedAt: session?.closedAt,
      expiredAt: session?.expiredAt,
      timedOutAt: session?.timedOutAt,
      updatedAt: session?.updatedAt
    })
  };
}

export function getSessionStateMachineDefinition() {
  return Object.keys(STATUS_METADATA)
    .filter((status) => status !== "__new__")
    .map((status) => describeSessionStatus(status));
}

function compact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}
