import { describeSessionStatus } from "./session-state-machine.js";

export function buildJobStateTimelineEntry(job, sessions) {
  return buildTimelineEntry({
    id: `${job.id}:job-state`,
    type: "job_state",
    at: firstDefined(job.lifecycle?.updatedAt, job.createdAt, job.firedAt, sessions[0]?.updatedAt),
    correlationId: job.id,
    phase: "job",
    source: "state",
    topic: "job.state",
    jobId: job.id,
    sessionId: job.sessionId,
    wallet: job.claimedBy,
    data: compactTimelineData({
      category: job.category,
      tier: job.tier,
      verifierMode: job.verifierMode,
      lifecycle: job.lifecycle,
      claimState: job.claimState,
      effectiveState: job.effectiveState,
      claimable: job.claimable,
      reason: job.reason,
      sessionId: job.sessionId,
      claimedBy: job.claimedBy,
      claimExpiresAt: job.claimExpiresAt
    })
  });
}

export function buildSessionTimelineEntries(session, options = {}) {
  const correlationId = options.correlationId ?? session.sessionId;
  const history = Array.isArray(session.statusHistory) ? session.statusHistory : [];
  if (!history.length) {
    return [buildTimelineEntry({
      id: `${session.sessionId}:session-snapshot`,
      type: "session_snapshot",
      at: firstDefined(session.updatedAt, session.claimedAt),
      correlationId,
      phase: describeSessionStatus(session.status).phase,
      source: "state",
      topic: "session.snapshot",
      severity: timelineSeverityForSessionStatus(session.status),
      jobId: session.jobId,
      sessionId: session.sessionId,
      wallet: session.wallet,
      data: compactTimelineData({
        status: session.status
      })
    })];
  }
  return history.map((entry, index) => buildTimelineEntry({
    id: `${session.sessionId}:transition:${index}`,
    type: "session_transition",
    at: entry.at,
    correlationId,
    phase: describeSessionStatus(entry.to).phase,
    source: "state",
    topic: "session.transition",
    severity: timelineSeverityForSessionStatus(entry.to),
    jobId: session.jobId,
    sessionId: session.sessionId,
    wallet: session.wallet,
    data: {
      ...entry
    }
  }));
}

export function buildVerificationTimelineEntry(session, verificationOverride = undefined, options = {}) {
  const verification = verificationOverride ?? session.verification ?? session.verificationSummary;
  if (!verification) {
    return undefined;
  }
  return buildTimelineEntry({
    id: `${session.sessionId}:verification`,
    type: "verification",
    at: firstDefined(
      verification.session?.updatedAt,
      verification.session?.resolvedAt,
      session.resolvedAt,
      session.updatedAt
    ),
    correlationId: options.correlationId ?? session.sessionId,
    phase: "verification",
    source: "verification",
    topic: "session.verification",
    severity: verification.outcome === "rejected" ? "error" : "info",
    jobId: session.jobId,
    sessionId: session.sessionId,
    wallet: session.wallet,
    data: compactTimelineData({
      outcome: verification.outcome,
      reasonCode: verification.reasonCode,
      handler: verification.handler,
      handlerVersion: verification.handlerVersion,
      verifierPolicyVersion: verification.verifierPolicyVersion,
      verifierConfigVersion: verification.verifierConfigVersion
    })
  });
}

export function buildChildJobTimelineEntry(job, options = {}) {
  return buildTimelineEntry({
    id: `${job.id}:child-job`,
    type: "child_job",
    at: firstDefined(job.createdAt, job.firedAt, job.lifecycle?.updatedAt),
    correlationId: options.correlationId ?? job.parentSessionId ?? job.id,
    phase: "child_job",
    source: "lineage",
    topic: "job.child_created",
    jobId: job.id,
    sessionId: job.parentSessionId,
    data: compactTimelineData({
      parentSessionId: job.parentSessionId,
      category: job.category,
      tier: job.tier,
      verifierMode: job.verifierMode,
      lifecycle: job.lifecycle
    })
  });
}

export function buildChildSessionTimelineEntry(session, options = {}) {
  return buildTimelineEntry({
    id: `${session.sessionId}:child-session`,
    type: "child_session",
    at: firstDefined(session.updatedAt, session.claimedAt),
    correlationId: options.correlationId ?? session.sessionId,
    phase: describeSessionStatus(session.status).phase,
    source: "lineage",
    topic: "session.child_snapshot",
    severity: timelineSeverityForSessionStatus(session.status),
    jobId: session.jobId,
    sessionId: session.sessionId,
    wallet: session.wallet,
    data: compactTimelineData({
      status: session.status
    })
  });
}

export function buildDerivativeJobTimelineEntry(job) {
  return buildTimelineEntry({
    id: `${job.id}:derivative-job`,
    type: "derivative_job",
    at: firstDefined(job.firedAt, job.createdAt, job.lifecycle?.updatedAt),
    correlationId: job.templateId ?? job.id,
    phase: "recurring",
    source: "lineage",
    topic: "job.recurring_fired",
    jobId: job.id,
    data: compactTimelineData({
      templateId: job.templateId,
      firedAt: job.firedAt,
      category: job.category,
      tier: job.tier,
      lifecycle: job.lifecycle
    })
  });
}

export function buildEventBusTimelineEntry(event, index) {
  return buildTimelineEntry({
    id: event.id ?? `event-bus:${index}`,
    type: event.type ?? "event_bus",
    at: event.timestamp,
    correlationId: event.correlationId ?? event.sessionId ?? event.jobId,
    phase: event.phase ?? event.topic,
    source: event.source ?? "event_bus",
    topic: event.topic,
    severity: event.severity ?? "info",
    jobId: event.jobId,
    sessionId: event.sessionId,
    wallet: event.wallet,
    data: compactTimelineData({
      blockNumber: event.blockNumber,
      txHash: event.txHash,
      ...event.data
    })
  });
}

export function buildTimelineEntry({
  id,
  type,
  at,
  correlationId,
  phase,
  source = "state",
  topic,
  severity = "info",
  jobId,
  sessionId,
  wallet,
  data = {}
}) {
  const timestamp = firstDefined(at);
  return {
    id,
    type,
    at: timestamp,
    timestamp,
    correlationId,
    phase,
    source,
    topic,
    severity,
    jobId,
    sessionId,
    wallet,
    data: compactTimelineData({
      topic,
      jobId,
      sessionId,
      wallet,
      ...data
    })
  };
}

export function compareTimelineEntries(left, right) {
  const leftTime = timelineTime(left.at);
  const rightTime = timelineTime(right.at);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left.id ?? "").localeCompare(String(right.id ?? ""));
}

export function compactTimelineData(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function timelineSeverityForSessionStatus(status) {
  if (["failed", "rejected", "slashed"].includes(status)) {
    return "error";
  }
  if (status === "disputed") {
    return "warn";
  }
  return "info";
}

function timelineTime(value) {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}
