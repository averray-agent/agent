/**
 * Dispute domain types.
 *
 * A dispute freezes stake, pauses a run, and demands an operator
 * verdict before a policy-defined window expires. Origins map 1:1 to
 * the reasons a verifier or co-signer would contest a claim.
 */

export type DisputeState =
  | "open"
  | "awaiting-evidence"
  | "under-review"
  | "escalated"
  | "resolved";

export type DisputeSeverity = "advisory" | "gating" | "hard-stop";

export type DisputeOrigin =
  | "signature"
  | "schema"
  | "co-sign-missing"
  | "policy-violation"
  | "timeout";

export type StakePortion = "worker" | "verifier" | "treasury";

export type ReleaseDestination =
  | "return-to-depositor"
  | "pay-verifier"
  | "slash-to-treasury";

export type DecisionKind = "uphold" | "reject" | "request-more";

export interface DisputeParty {
  handle: string;
  address: string;
  initials: string;
  tone: "sage" | "ink" | "clay" | "blue" | "muted";
}

export interface EvidenceRow {
  label: string;
  worker: string;
  expected: string;
  match: "ok" | "warn" | "fail";
  /** Optional short note explaining why it diverges. */
  note?: string;
}

export interface StakeBreakdown {
  worker: number;
  verifier: number;
  treasury: number;
}

export interface DisputeTimelineEvent {
  at: string;
  label: string;
  body: string;
  tone?: "neutral" | "accent" | "warn" | "bad";
}

export interface Dispute {
  id: string;
  runRef: string;
  openingReceipt: string;
  summary: string;
  origin: DisputeOrigin;
  severity: DisputeSeverity;
  state: DisputeState;
  opener: DisputeParty;
  respondent: DisputeParty;
  reviewer: DisputeParty;
  /** DOT. Sum of worker + verifier + treasury portions. */
  stakeFrozen: number;
  stakeBreakdown: StakeBreakdown;
  /** ISO-ish string opened-at used only for the window countdown seed. */
  openedAt: string;
  /** Seconds allocated for the operator to decide before auto-escalate. */
  windowSeconds: number;
  /** Seconds already elapsed when the fixture was seeded. */
  windowElapsed: number;
  evidence: EvidenceRow[];
  /** Monospace payload shown in the dark terminal column — worker-submitted. */
  workerPayload: string;
  /** Monospace payload shown in the dark terminal column — verifier-expected. */
  expectedPayload: string;
  escalatedBy?: DisputeParty;
  escalatedAt?: string;
  timeline: DisputeTimelineEvent[];
  /** Final verdict — only set when state === 'resolved'. */
  resolution?: {
    decision: DecisionKind;
    destination: ReleaseDestination;
    rationale: string;
    at: string;
    signer: DisputeParty;
  };
}
