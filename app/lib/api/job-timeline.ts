/**
 * Adapter for `GET /admin/jobs/timeline?jobId=...` (PR #149).
 *
 * The endpoint stitches claim state + sessions + verification +
 * child-job lineage + recurring derivatives + event-bus events into a
 * single chronologically-sorted entry list. Each entry follows the v2
 * envelope from PR #158:
 *
 *   { id, type, at, correlationId, phase, source, topic, severity,
 *     jobId, sessionId, wallet, data }
 *
 * The catalog `LifecycleRail` already shows the 5-stage at-a-glance
 * (Ready → Claimed → Submitted → Verified → Paid). The frontend hook
 * for this endpoint is the source for a richer "everything that
 * happened to this job" panel that surfaces the rail's missing
 * detail: child runs, recurring derivatives, raw event-bus events,
 * verifier reason codes.
 */

export type TimelineSeverity = "info" | "warn" | "error";

export type TimelineSource =
  | "state"
  | "verification"
  | "event_bus"
  | "lineage"
  | "schedule"
  // Anything else the backend adds later — we still render the row
  // with a generic chip rather than dropping the entry.
  | (string & {});

export interface TimelineEntry {
  id: string;
  /** Coarse classifier — `job_state`, `session_transition`, `verification`,
   *  `child_job`, `derivative_job`, `event_bus`, `session_snapshot`. */
  type: string;
  /** ISO timestamp; may be undefined for entries the backend can't
   *  date-stamp yet. Renders as "—" in that case. */
  at?: string;
  correlationId?: string;
  phase?: string;
  source: TimelineSource;
  topic?: string;
  severity: TimelineSeverity;
  jobId?: string;
  sessionId?: string;
  wallet?: string;
  /** Free-form structured data shaped by the entry type. The panel
   *  surfaces the most useful keys per entry kind without locking the
   *  shape down — new fields land additively. */
  data: Record<string, unknown>;
}

export interface TimelineLineage {
  templateId: string | null;
  recurringTemplate: boolean;
  derivativeJobIds: string[];
  parentSessionId: string | null;
  parentSession: {
    sessionId: string;
    jobId: string;
    wallet: string;
    status: string;
    updatedAt?: string;
  } | null;
  sessionIds: string[];
  childJobIds: string[];
  childSessionIds: string[];
}

export interface TimelineSummary {
  sessionCount: number;
  activeSessionIds: string[];
  terminalSessionIds: string[];
  childJobCount: number;
  derivativeJobCount: number;
  eventCount: number;
  eventBusGap: boolean;
  latestSessionStatus: string | null;
}

export interface JobTimeline {
  timelineVersion: string;
  /** Snapshot of the job document at fetch time (publicDetails,
   *  lifecycle, claim state). Useful for context the panel may show
   *  alongside the entry list. */
  job: Record<string, unknown> | null;
  lineage: TimelineLineage;
  summary: TimelineSummary;
  timeline: TimelineEntry[];
}

export const EMPTY_JOB_TIMELINE: JobTimeline = {
  timelineVersion: "0",
  job: null,
  lineage: {
    templateId: null,
    recurringTemplate: false,
    derivativeJobIds: [],
    parentSessionId: null,
    parentSession: null,
    sessionIds: [],
    childJobIds: [],
    childSessionIds: [],
  },
  summary: {
    sessionCount: 0,
    activeSessionIds: [],
    terminalSessionIds: [],
    childJobCount: 0,
    derivativeJobCount: 0,
    eventCount: 0,
    eventBusGap: false,
    latestSessionStatus: null,
  },
  timeline: [],
};

export function buildJobTimeline(payload: unknown): JobTimeline {
  const root = asRecord(payload);
  if (!root) return EMPTY_JOB_TIMELINE;

  const lineage = asRecord(root.lineage) ?? {};
  const summary = asRecord(root.summary) ?? {};
  const timelineRaw = Array.isArray(root.timeline) ? root.timeline : [];

  return {
    timelineVersion: text(root.timelineVersion, "0"),
    job: asRecord(root.job),
    lineage: {
      templateId: text(lineage.templateId) || null,
      recurringTemplate: Boolean(lineage.recurringTemplate),
      derivativeJobIds: stringArray(lineage.derivativeJobIds),
      parentSessionId: text(lineage.parentSessionId) || null,
      parentSession: parentSessionFor(lineage.parentSession),
      sessionIds: stringArray(lineage.sessionIds),
      childJobIds: stringArray(lineage.childJobIds),
      childSessionIds: stringArray(lineage.childSessionIds),
    },
    summary: {
      sessionCount: nonNegInt(summary.sessionCount),
      activeSessionIds: stringArray(summary.activeSessionIds),
      terminalSessionIds: stringArray(summary.terminalSessionIds),
      childJobCount: nonNegInt(summary.childJobCount),
      derivativeJobCount: nonNegInt(summary.derivativeJobCount),
      eventCount: nonNegInt(summary.eventCount),
      eventBusGap: Boolean(summary.eventBusGap),
      latestSessionStatus: text(summary.latestSessionStatus) || null,
    },
    timeline: timelineRaw
      .map(buildTimelineEntry)
      .filter((entry): entry is TimelineEntry => entry !== null),
  };
}

function buildTimelineEntry(raw: unknown): TimelineEntry | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = text(record.id);
  if (!id) return null;
  return {
    id,
    type: text(record.type, "event"),
    ...(text(record.at) ? { at: text(record.at) } : {}),
    ...(text(record.correlationId)
      ? { correlationId: text(record.correlationId) }
      : {}),
    ...(text(record.phase) ? { phase: text(record.phase) } : {}),
    source: parseSource(record.source),
    ...(text(record.topic) ? { topic: text(record.topic) } : {}),
    severity: parseSeverity(record.severity),
    ...(text(record.jobId) ? { jobId: text(record.jobId) } : {}),
    ...(text(record.sessionId) ? { sessionId: text(record.sessionId) } : {}),
    ...(text(record.wallet) ? { wallet: text(record.wallet) } : {}),
    data: asRecord(record.data) ?? {},
  };
}

function parseSeverity(value: unknown): TimelineSeverity {
  if (value === "warn" || value === "error") return value;
  return "info";
}

function parseSource(value: unknown): TimelineSource {
  if (typeof value !== "string" || !value.trim()) return "state";
  return value.trim();
}

function parentSessionFor(value: unknown): TimelineLineage["parentSession"] {
  const record = asRecord(value);
  if (!record) return null;
  const sessionId = text(record.sessionId);
  const jobId = text(record.jobId);
  const wallet = text(record.wallet);
  const status = text(record.status);
  if (!sessionId || !jobId) return null;
  return {
    sessionId,
    jobId,
    wallet,
    status,
    ...(text(record.updatedAt) ? { updatedAt: text(record.updatedAt) } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry): entry is string => entry.length > 0);
}

function nonNegInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Human label for a timeline entry. The backend keeps `type` /
 * `topic` in machine form; the panel renders this label as the row's
 * primary text. Falls through to `type` when we don't recognise the
 * combination so a new event type lands additively.
 */
export function describeTimelineEntry(entry: TimelineEntry): string {
  switch (entry.type) {
    case "job_state":
      return "Job state";
    case "session_snapshot":
      return entry.data.status
        ? `Session ${entry.data.status}`
        : "Session snapshot";
    case "session_transition":
      return entry.data.to
        ? `Session → ${entry.data.to}`
        : entry.data.status
          ? `Session ${entry.data.status}`
          : "Session transition";
    case "verification":
      return entry.data.outcome
        ? `Verifier ${entry.data.outcome}`
        : "Verifier resolved";
    case "child_job":
      return "Child job created";
    case "derivative_job":
      return "Recurring derivative";
    case "event_bus":
      return entry.topic ?? "Event";
    default:
      return entry.topic ?? entry.type;
  }
}

/**
 * Compact "secondary" string for the row — typically the most useful
 * detail beyond the headline label (e.g. handler version, reason
 * code, child job id). Returns empty string when nothing to add.
 */
export function describeTimelineDetail(entry: TimelineEntry): string {
  const parts: string[] = [];
  const data = entry.data;
  switch (entry.type) {
    case "verification":
      if (typeof data.handler === "string") parts.push(data.handler);
      if (typeof data.reasonCode === "string") parts.push(data.reasonCode);
      break;
    case "session_transition":
      if (typeof data.from === "string" && typeof data.to === "string") {
        parts.push(`${data.from} → ${data.to}`);
      }
      break;
    case "child_job":
      if (typeof data.childJobId === "string") parts.push(data.childJobId);
      break;
    case "derivative_job":
      if (typeof data.derivativeJobId === "string")
        parts.push(data.derivativeJobId);
      break;
    case "event_bus":
      if (typeof data.txHash === "string") parts.push(data.txHash);
      else if (typeof data.blockNumber === "number")
        parts.push(`block ${data.blockNumber}`);
      break;
    case "job_state":
      if (typeof data.effectiveState === "string")
        parts.push(`state: ${data.effectiveState}`);
      else if (typeof data.claimState === "string")
        parts.push(`state: ${data.claimState}`);
      break;
  }
  if (entry.sessionId && entry.type !== "job_state") {
    parts.push(shortId(entry.sessionId));
  }
  return parts.join(" · ");
}

function shortId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
