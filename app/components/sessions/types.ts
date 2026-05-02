/**
 * Sessions domain types.
 *
 * A session is one capital-movement lifecycle keyed to a single run:
 *   funded → claimed → submitted → verified → settled (or slashed / disputed).
 * This page is the auditor's read-only log of every session across all runs.
 */

import type { SourceKind } from "@/components/runs/StatePill";

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
  /**
   * Provenance of the run this session is keyed to. Optional because
   * legacy/native runs predate ingested sources. When set, the row renders
   * a small SourceBadge so an auditor can scan GitHub-PR vs. Wikipedia-
   * proposal-review sessions without opening the drawer.
   */
  source?: SourceKind;
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
  /**
   * Raw ISO timestamps from the backend session record. The `openedAt`
   * field above is a display string (e.g. "14:48 UTC"); these are the
   * unformatted source-of-truth values aggregate views need to compute
   * real durations like avg / p50 / p95 settle time.
   * Optional because older sessions may not have all four fields.
   */
  timestamps?: {
    claimedAt?: string;
    submittedAt?: string;
    /** When the session reached its terminal state (verified, settled,
     *  rejected, slashed). Maps to `resolvedAt` on the backend, falling
     *  back to `closedAt`. */
    settledAt?: string;
    /** Most-recent backend mutation; useful for "age" recomputation. */
    updatedAt?: string;
  };
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
