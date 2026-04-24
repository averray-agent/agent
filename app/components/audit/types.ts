/**
 * Audit log domain types.
 *
 * Append-only timeline of every operator action, platform event, and
 * contract event. Each event is link-through to its receipt / run /
 * policy / dispute — nothing editable, nothing deletable.
 */

export type AuditSource = "operator" | "system" | "contract";
export type AuditCategory =
  | "policy"
  | "runs"
  | "treasury"
  | "xcm"
  | "badge"
  | "dispute"
  | "auth"
  | "verifier";

export interface AuditActor {
  handle: string;
  address: string;
  initials: string;
  tone: "sage" | "ink" | "clay" | "blue" | "muted";
}

export interface AuditLink {
  label: string;
  href: string;
}

export interface AuditEvent {
  id: string;
  at: string; // UTC time, e.g. "14:08:42"
  day: string; // Grouping bucket — "today", "yesterday", or "2026-04-22"
  source: AuditSource;
  category: AuditCategory;
  action: string; // e.g. "policy.revision.signed"
  actor: AuditActor;
  summary: React.ReactNode;
  target?: string; // e.g. "run-2742", "r_4e12a", "policy claim/deps-sec-only@v4"
  hash?: string; // "0x7a0c…b11e"
  tone?: "neutral" | "accent" | "warn" | "bad";
  link?: AuditLink;
}
