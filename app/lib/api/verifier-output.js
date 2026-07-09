/**
 * Truth-boundary adapter for the runs detail verifier panel.
 *
 * The panel may combine several feeds:
 * - /verifier/result?sessionId=... is public and carries live verifier status.
 * - /badges/:sessionId is public once an approved session has a receipt.
 * - /session and /session/timeline are wallet/session scoped.
 * - /admin/jobs/timeline is richer, but may be locked for roleless viewers.
 *
 * This adapter returns a render state instead of forcing every condition
 * through terminal-looking log lines.
 */

export const NO_SESSION_VERIFIER_MESSAGE =
  "No verifier output yet — this run has not been claimed.";

export const LOCKED_VERIFIER_MESSAGE =
  "Verifier log locked for this session (missing operator role)";

/**
 * @param {object} input
 * @param {string | undefined} input.sessionId
 * @param {string | undefined} input.verifierMode
 * @param {string | undefined} input.claimState
 * @param {unknown} input.sessionPayload
 * @param {"live" | "loading" | "locked" | "down"} input.sessionPresence
 * @param {unknown} input.sessionTimelinePayload
 * @param {"live" | "loading" | "locked" | "down"} input.sessionTimelinePresence
 * @param {unknown} input.verifierResultPayload
 * @param {"live" | "loading" | "locked" | "down"} input.verifierResultPresence
 * @param {unknown} input.badgePayload
 * @param {"live" | "loading" | "locked" | "down"} input.badgePresence
 * @param {unknown} input.jobTimeline
 * @param {"live" | "loading" | "locked" | "down"} input.jobTimelinePresence
 */
export function buildVerifierOutput(input) {
  const sessionId = text(input.sessionId);
  const mode = text(input.verifierMode, "unknown");
  const modeNote = `verifier ${mode}`;
  if (!sessionId) {
    return {
      kind: "empty",
      modeNote,
      message: NO_SESSION_VERIFIER_MESSAGE,
    };
  }

  const session = asRecord(input.sessionPayload);
  const verifierResult = asRecord(input.verifierResultPayload);
  const badge = asRecord(input.badgePayload);
  const badgeAverray = asRecord(badge?.averray);
  const timeline = Array.isArray(asRecord(input.jobTimeline)?.timeline)
    ? asRecord(input.jobTimeline).timeline.map(asRecord)
    : [];
  const sessionTimeline = Array.isArray(asRecord(input.sessionTimelinePayload)?.timeline)
    ? asRecord(input.sessionTimelinePayload).timeline.map(asRecord)
    : [];

  const outcome = text(
    verifierResult?.outcome,
    text(session?.verification?.outcome, text(session?.verificationSummary?.outcome))
  );
  const approvedBadge = Boolean(badgeAverray?.sessionId);
  if (outcome || approvedBadge) {
    return terminalOutput({
      sessionId,
      mode,
      modeNote,
      session,
      verifierResult,
      badgeAverray,
      timeline,
      sessionTimeline,
    });
  }

  const verifierStatus = text(verifierResult?.status);
  const sessionStatus = text(
    verifierResult?.sessionStatus,
    text(session?.status, text(input.claimState))
  );
  if (
    verifierStatus === "verifying" ||
    sessionStatus === "submitted" ||
    sessionStatus === "disputed"
  ) {
    const awaitingSince = text(
      verifierResult?.awaitingSince,
      text(session?.disputedAt, text(session?.submittedAt))
    );
    return {
      kind: "awaiting",
      modeNote,
      runner: `verifier · ${mode}`,
      elapsed: awaitingSince ? `awaiting since ${formatTimestamp(awaitingSince)}` : "awaiting verifier",
      lines: [
        {
          time: timeOnly(awaitingSince),
          level: "info",
          label: "session",
          message: `Session ${sessionId} submitted.`,
        },
        {
          time: timeOnly(awaitingSince),
          level: "warn",
          label: "awaiting",
          message: `${mode} has not produced a verdict yet.`,
        },
      ],
      verdict: {
        status: "Awaiting verification",
        score: "—",
        scoreLabel: "no verdict yet",
      },
    };
  }

  if (
    input.jobTimelinePresence === "locked" ||
    input.sessionPresence === "locked" ||
    input.sessionTimelinePresence === "locked"
  ) {
    return {
      kind: "locked",
      modeNote,
      message: LOCKED_VERIFIER_MESSAGE,
    };
  }

  if (
    input.verifierResultPresence === "loading" ||
    input.sessionPresence === "loading" ||
    input.badgePresence === "loading"
  ) {
    return {
      kind: "loading",
      modeNote,
      message: "Loading verifier status for this session.",
    };
  }

  if (
    input.verifierResultPresence === "down" ||
    input.sessionPresence === "down" ||
    input.sessionTimelinePresence === "down" ||
    input.jobTimelinePresence === "down"
  ) {
    return {
      kind: "down",
      modeNote,
      message: "Verifier status is unavailable right now.",
    };
  }

  return {
    kind: "empty",
    modeNote,
    message: "No verifier output yet — evidence has not been submitted.",
  };
}

function terminalOutput({
  sessionId,
  mode,
  modeNote,
  session,
  verifierResult,
  badgeAverray,
  timeline,
  sessionTimeline,
}) {
  const outcome = text(
    verifierResult?.outcome,
    text(session?.verification?.outcome, "approved")
  );
  const reasonCode = text(
    verifierResult?.reasonCode,
    text(session?.verification?.reasonCode, text(session?.verificationSummary?.reasonCode))
  );
  const handler = text(
    verifierResult?.handler,
    text(session?.verification?.handler, text(session?.verificationSummary?.handler))
  );
  const handlerVersion = text(
    verifierResult?.handlerVersion,
    text(
      session?.verification?.handlerVersion,
      text(session?.verificationSummary?.handlerVersion)
    )
  );
  const completedAt = firstIso([
    badgeAverray?.completedAt,
    verifierResult?.session?.resolvedAt,
    verifierResult?.session?.updatedAt,
    session?.resolvedAt,
    session?.closedAt,
    session?.updatedAt,
    latestTimelineAt(timeline, "verification"),
    latestTimelineAt(sessionTimeline, "verification"),
  ]);
  const submittedAt = firstIso([
    session?.submittedAt,
    latestTimelineAt(timeline, "submitted"),
    latestTimelineAt(sessionTimeline, "submitted"),
  ]);
  const receiptRef = badgeAverray?.sessionId
    ? `/badges/${badgeAverray.sessionId}`
    : `/badges/${sessionId}`;
  const evidenceHash = text(badgeAverray?.evidenceHash, text(verifierResult?.evidenceHash));
  const chainJobId = text(badgeAverray?.chainJobId, text(verifierResult?.chainJobId));
  const lines = [];
  if (submittedAt) {
    lines.push({
      time: timeOnly(submittedAt),
      level: "info",
      label: "submitted",
      message: `Session ${sessionId} entered verification.`,
    });
  }
  lines.push({
    time: timeOnly(completedAt),
    level: outcome === "approved" ? "ok" : "warn",
    label: "verdict",
    message: [sentenceCase(outcome || "verified"), reasonCode].filter(Boolean).join(" · "),
  });
  if (handler || handlerVersion) {
    lines.push({
      time: timeOnly(completedAt),
      level: "info",
      label: "handler",
      message: [handler, handlerVersion].filter(Boolean).join(" · "),
    });
  }
  lines.push({
    time: timeOnly(completedAt),
    level: "ok",
    label: "receipt",
    message: [receiptRef, evidenceHash ? `evidence ${shortHash(evidenceHash)}` : "", chainJobId ? `job ${shortHash(chainJobId)}` : ""]
      .filter(Boolean)
      .join(" · "),
  });

  return {
    kind: "terminal",
    modeNote,
    runner: `verifier · ${mode}${handler ? ` · ${handler}` : ""}`,
    elapsed: completedAt ? `completed ${formatTimestamp(completedAt)}` : "completed",
    lines,
    verdict: {
      status: sentenceCase(outcome || "verified"),
      score: reasonCode || "recorded",
      scoreLabel: receiptRef,
    },
    receiptRef,
    evidenceHash,
    chainJobId,
    completedAt,
    outcome,
    reasonCode,
  };
}

function latestTimelineAt(entries, needle) {
  const normalizedNeedle = String(needle).toLowerCase();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const haystack = [
      entry?.type,
      entry?.source,
      entry?.topic,
      entry?.phase,
      asRecord(entry?.data)?.status,
      asRecord(entry?.data)?.outcome,
    ]
      .map((value) => String(value ?? "").toLowerCase())
      .join(" ");
    if (haystack.includes(normalizedNeedle) && text(entry?.at)) {
      return text(entry.at);
    }
  }
  return "";
}

function firstIso(values) {
  for (const value of values) {
    const raw = text(value);
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return raw;
  }
  return "";
}

function formatTimestamp(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function timeOnly(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function shortHash(value) {
  const raw = text(value);
  if (raw.length <= 16) return raw;
  return `${raw.slice(0, 8)}…${raw.slice(-6)}`;
}

function sentenceCase(value) {
  const raw = text(value).replace(/_/g, " ");
  if (!raw) return "";
  return `${raw.slice(0, 1).toUpperCase()}${raw.slice(1)}`;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
