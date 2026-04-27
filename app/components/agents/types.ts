export type AgentTier = "T1" | "T2" | "T3";
export type AgentState = "active" | "idle" | "slashed";
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
