export type AgentTier = "T1" | "T2" | "T3";
/**
 * Agent operational state, ordered by when it can occur in the work loop:
 *   - `idle`: no current claim, no verified run yet, OR caught up
 *   - `claimed`: holds a claim, hasn't started work
 *   - `working`: claim is open and the agent is producing the artefact
 *   - `submitted`: artefact submitted, verifier hasn't ruled yet
 *   - `disputed`: a claim went into dispute
 *   - `slashed`: a slash event landed against this wallet
 *
 * `active` is a legacy umbrella for "has at least one verified run" — kept
 * so older fixture data still works, but new code should use the granular
 * states above. `stateFromAgent` collapses the live signal into one of
 * these per-render.
 */
export type AgentState =
  | "idle"
  | "claimed"
  | "working"
  | "submitted"
  | "disputed"
  | "active"
  | "slashed";
export type AgentSpecialty = "coding" | "writer-gov" | "ops" | "gov-review";
export type BadgeSpecialtyColor = "code" | "write" | "ops" | "gov";

export interface BadgeDef {
  glyph: string;
  name: string;
  specialty: AgentSpecialty;
}

export interface AgentRecentRun {
  id: string;
  title: string;
  receipt: string;
  state: "Verified" | "Disputed" | "Pending";
}

/**
 * Active claim/session info for the agent, when known. Populated from the
 * backend's session payload (or from the agent payload if it ships an
 * `activeSession` block); undefined when the agent isn't currently working.
 *
 * The drawer renders an "Active session" block above the historical
 * sections when this is set, and the directory pill flips to the matching
 * lifecycle state (claimed / working / submitted / disputed).
 */
export interface AgentActiveSession {
  /** Run identifier for the session-level audit trail. */
  runId: string;
  /** The job the run was claimed against. */
  jobId: string;
  /** Session id (matches `/session?sessionId=<id>` on the API). */
  sessionId: string;
  /** Lifecycle status surfaced from the backend. */
  status: "claimed" | "working" | "submitted" | "disputed";
  /** Human title (so the drawer doesn't have to refetch the job). */
  title?: string;
  /** ISO timestamp. Used to compute the relative "claim deadline" copy. */
  deadlineAt?: string;
  /** ISO timestamp of the last event the operator should care about. */
  lastEventAt?: string;
  /** Optional human label for the last event ("PR submitted", …). */
  lastEvent?: string;
}

export interface AgentSlash {
  when: string;
  amount: string;
  reason: string;
  ref: string;
}

export interface AgentStake {
  deposited: number;
  locked: number;
  available: number;
  slashed30: number;
}

export interface AgentRecord {
  handle: string;
  wallet: string;
  walletFull: string;
  tier: AgentTier;
  score: number;
  sparkline: number[];
  badges: string[];
  badgeDates: Record<string, string>;
  specialty: AgentSpecialty;
  stake: AgentStake;
  /**
   * Last meaningful action by this agent. The `ref` here is heterogeneous
   * — it can be a run id, a receipt id, or a policy tag — so we don't
   * carry a SourceBadge here; an inconsistently-rendering badge would
   * confuse more than it clarifies. Sessions are 1:1 with runs and do
   * carry a source badge.
   */
  activity: { msg: string; ref: string; when: string };
  state: AgentState;
  /**
   * Set when the agent currently holds a claim/session. The directory pill
   * promotes the row out of "idle" and the drawer renders the dedicated
   * Active session block above Recent runs.
   */
  activeSession?: AgentActiveSession;
  /**
   * True when this agent has not yet earned any verified-receipt badges —
   * i.e. the badges list (when populated) holds **capability markers**
   * granted on registration, not "earned" outputs of completed work. The
   * drawer relabels its badge section accordingly so the operator doesn't
   * confuse a starter capability with a verified receipt.
   */
  hasVerifiedBadges?: boolean;
  recentRuns: AgentRecentRun[];
  slashes: AgentSlash[];
}

export const BADGES: Record<string, BadgeDef> = {
  code: { glyph: "C1", name: "Coding L1", specialty: "coding" },
  code2: { glyph: "C2", name: "Coding L2", specialty: "coding" },
  code3: { glyph: "C3", name: "Coding L3", specialty: "coding" },
  write: { glyph: "W1", name: "Writer L1", specialty: "writer-gov" },
  write2: { glyph: "W2", name: "Writer L2", specialty: "writer-gov" },
  gov: { glyph: "G1", name: "Gov review L1", specialty: "gov-review" },
  gov2: { glyph: "G2", name: "Gov review L2", specialty: "gov-review" },
  ops: { glyph: "O1", name: "Ops L1", specialty: "ops" },
  ops2: { glyph: "O2", name: "Ops L2", specialty: "ops" },
  audit: { glyph: "A1", name: "Audit L1", specialty: "gov-review" },
  sec: { glyph: "S1", name: "Sec-only L1", specialty: "coding" },
};

export function specialtyColor(s: AgentSpecialty): BadgeSpecialtyColor {
  if (s === "coding") return "code";
  if (s === "writer-gov") return "write";
  if (s === "ops") return "ops";
  return "gov";
}

export function tierFor(score: number): AgentTier {
  if (score < 300) return "T1";
  if (score < 800) return "T2";
  return "T3";
}

export function nextThreshold(score: number): number | null {
  if (score < 300) return 300;
  if (score < 800) return 800;
  return null;
}
