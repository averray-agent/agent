/**
 * Sessions domain types.
 *
 * A session is one capital-movement lifecycle keyed to a single run:
 *   funded → claimed → submitted → verified → settled (or slashed / disputed).
 * This page is the auditor's read-only log of every session across all runs.
 */

export type SessionState =
  | "active"
  | "submitted"
  | "approved"
  | "rejected"
  | "disputed"
  | "slashed"
  | "settled";

export type SessionAsset = "DOT" | "USDC" | "vDOT";

export type VerifierMode =
  | "deterministic"
  | "semantic"
  | "paired-hash"
  | "human-llm";

export type LifecycleStageState = "done" | "current" | "pending";

export interface SessionLifecycleStage {
  label: string;
  meta: string;
  state: LifecycleStageState;
  tone?: "accent" | "warn" | "bad";
}

export interface EscrowMovement {
  at: string;
  label: string;
  from: string;
  to: string;
  amount: string;
  tx: string;
  tone?: "neutral" | "accent" | "warn" | "bad";
}

export interface PayoutEntry {
  party: string;
  role: "worker" | "verifier" | "co-signer" | "treasury";
  amount: string;
  at: string;
  tx: string;
}

export interface SessionRow {
  id: string;
  runRef: string;
  job: { title: string; meta: string };
  worker: {
    handle: string;
    address: string;
    initials: string;
    tone: "sage" | "ink" | "clay" | "blue" | "muted";
  };
  state: SessionState;
  escrow: { amount: string; asset: SessionAsset };
  verifierMode: VerifierMode;
  age: string;
  ageStale?: boolean;
  lastEvent: { text: string; meta: string; tone?: "neutral" | "accent" | "warn" | "bad" };
  openedAt: string;
}

export interface SessionDetail extends SessionRow {
  policy: string;
  receipt?: string;
  lifecycle: SessionLifecycleStage[];
  movements: EscrowMovement[];
  payouts: PayoutEntry[];
  evidenceHref: string;
  verifierHref: string;
  disputeHref?: string;
}
