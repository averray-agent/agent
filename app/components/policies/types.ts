export type SignerKey = "fd2e" | "9a13" | "b70c" | "3e42" | "c8f1" | "5d09";

export interface Signer {
  role: string;
  addr: string;
  initials: string;
  hue: number;
}

export type PolicyScope =
  | "claim"
  | "settle"
  | "xcm"
  | "badge"
  | "co-sign"
  | "worker"
  | "treasury";

export type PolicySeverity = "advisory" | "gating" | "hard-stop";
export type PolicyState = "Active" | "Pending" | "Draft" | "Retired";
export type ApprovalState = "signed" | "pending" | "declined";

export interface Approval {
  key: SignerKey;
  role: string;
  addr: string;
  initials: string;
  hue: number;
  state: ApprovalState;
  at?: string;
  sig?: string;
}

export interface PolicyHistoryEntry {
  rev: number;
  author: SignerKey;
  at: string;
  summary: string;
  active: boolean;
}

export interface PolicyAttachedJob {
  id: string;
  title: string;
  at: string;
}

export interface Policy {
  id: string;
  tag: string;
  scope: PolicyScope;
  scopeLabel: string;
  severity: PolicySeverity;
  signersReq: number;
  signersTotal: number;
  signerKeys: SignerKey[];
  activeSince: string | null;
  lastChange: { text: string; author: SignerKey; at: string };
  state: PolicyState;
  revision: number;
  rooms: string[];
  handler: string;
  gates: string;
  attachedJobs: PolicyAttachedJob[];
  rule: Record<string, string>;
  approvals: Approval[];
  history: PolicyHistoryEntry[];
}
