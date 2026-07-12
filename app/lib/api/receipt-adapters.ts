import type { ReceiptKind } from "@/components/receipts/KindChip";
import type {
  LinkedArtifact,
  SignatureEntry,
} from "@/components/receipts/ReceiptDrawerBody";
import type { ReceiptRow } from "@/components/receipts/ReceiptsTable";
import type { Signer } from "@/components/receipts/SignerAvatars";
import type { SourceKind } from "@/components/runs/StatePill";
import { extractReceiptSigners } from "./receipt-signers";
import {
  receiptHasSignature,
  selectCanonicalReceiptDocument,
} from "@/lib/ui/receipt-signature-verification";

export type ReceiptRowWithMeta = ReceiptRow & {
  sessionId: string;
  issuedAtIso: string;
  evidenceHash?: string;
  /** Escrow `chainJobId` — the on-chain bytes32 EscrowCore key for this job.
   *  Shape-identical to a tx hash but NOT a transaction and not block-explorer
   *  resolvable, so it is surfaced as "Escrow job", never as a block/tx. */
  chainJobId?: string;
  badge?: unknown;
  listRow?: unknown;
};

export interface ReceiptDrawerModel {
  signatures: SignatureEntry[];
  canonicalDocument: Record<string, unknown> | null;
  evidenceJson: string;
  evidenceMeta: string;
  evidenceRawHref: string;
  links: LinkedArtifact[];
  /**
   * Provenance + attribution for the underlying run, when known. Used to
   * render a SourceBadge + a short attribution line in the drawer so an
   * auditor opening a receipt sees the same source context the table row
   * shows. Optional because non-run receipts (badge, settle on a loan,
   * policy revision) don't carry a platform source.
   */
  source?: {
    kind: SourceKind;
    /** Optional secondary chip — e.g. "NVD" on OSV advisories with CVEs. */
    secondary?: string;
    /** Short single-line attribution. */
    attribution: string;
    /** Optional inline identity, e.g. "owner/repo #123" or dataset title. */
    identity?: string;
    /** Optional URL the identity links out to. */
    href?: string;
  };
}

const SOURCE_ATTRIBUTION: Record<SourceKind, string> = {
  github: "Averray-attributed PR review",
  wikipedia: "Averray proposal — agent never edits Wikipedia",
  osv: "Averray dependency remediation",
  data_gov: "Averray open-data quality audit",
  openapi: "Averray OpenAPI quality audit",
  standards: "Averray standards-freshness audit",
  oss: "Open-source contribution",
};

export function extractReceiptRows(data: unknown): ReceiptRowWithMeta[] {
  const rows = Array.isArray(data)
    ? data
    : arrayField(data, "badges") ?? arrayField(data, "receipts") ?? arrayField(data, "items") ?? arrayField(data, "data") ?? [];
  return rows.map(extractReceiptRow).filter((row): row is ReceiptRowWithMeta => Boolean(row));
}

export function extractReceiptRow(data: unknown): ReceiptRowWithMeta | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (isUiReceiptRow(record)) return normalizeUiRow(record as unknown as ReceiptRowWithMeta);

  const badge = objectField(record, "badge");
  const runReceipt = objectField(record, "runReceipt");
  const receiptDocument = badge ?? runReceipt;
  const averray = objectField(badge, "averray") ?? objectField(record, "averray");
  const sessionId = text(record.sessionId, text(averray?.sessionId, ""));
  if (!sessionId) return null;

  const issuedAtIso = text(record.issuedAt, text(averray?.completedAt, ""));
  const kind = receiptKind(record.kind, badge ? "badge" : "run");
  const jobId = text(record.jobId, text(averray?.jobId, sessionId));
  const category = text(averray?.category, "");
  const level = text(averray?.level, "");
  const subject = kind === "badge" && category ? `${category}-tier-${level || "1"}` : jobId;
  const signers = extractSigners(record.signers, averray);
  const evidenceHash = text(record.evidenceHash, text(averray?.evidenceHash, ""));
  const chainJobId = text(record.chainJobId, text(averray?.chainJobId, ""));

  return {
    id: receiptId(record.id, sessionId, evidenceHash),
    sessionId,
    kind,
    subject,
    subjectSub: subjectSub(record, averray),
    signers,
    policy: policyRef(record, averray),
    size: sizeOf(receiptDocument ?? record),
    signedAt: displayTime(issuedAtIso),
    issuedAtIso,
    evidenceHash: evidenceHash || undefined,
    chainJobId: chainJobId || undefined,
    badge: receiptDocument ?? undefined,
    listRow: record,
  };
}

export function buildReceiptDrawer(
  row: ReceiptRowWithMeta,
  detailData: unknown
): ReceiptDrawerModel {
  const detailDocument = objectValue(detailData);
  const embeddedDocument = objectValue(row.badge);
  const canonicalDocument = selectCanonicalReceiptDocument({
    kind: row.kind,
    listRow: row.listRow,
    detailDocument,
  });
  const previewDocument = canonicalDocument ?? embeddedDocument ?? detailDocument;
  const averray = objectField(previewDocument, "averray");
  const signers = previewDocument ? extractSigners(previewDocument.signers, averray) : row.signers;
  const raw = previewDocument ?? {
    sessionId: row.sessionId,
    jobId: row.subject,
    evidenceHash: row.evidenceHash,
    chainJobId: row.chainJobId,
    signers: row.signers,
  };
  const evidencePath = row.kind === "run"
    ? `/badges/${encodeURIComponent(row.sessionId)}/run`
    : `/badges/${encodeURIComponent(row.sessionId)}`;
  const evidenceJson = `// ${row.kind} receipt JSON — served by ${evidencePath}\n${JSON.stringify(raw, null, 2)}`;

  return {
    canonicalDocument,
    signatures: signers.map((signer) => ({
      role: signer.role,
      address: signer.address,
      ...(signer.signedAt ? { time: signer.signedAt.replace(" UTC", "") } : {}),
      pending: signer.address === "pending...",
      identified: signer.identified,
    })),
    evidenceJson,
    evidenceMeta: `${sizeOf(raw)} · ${receiptHasSignature(raw) ? "application/jose+json" : "application/json"}`,
    evidenceRawHref: evidencePath,
    links: [
      { role: "Origin run", ref: text(averray?.jobId, row.subject) },
      { role: "Evidence", ref: text(averray?.evidenceHash, row.evidenceHash ?? "not indexed") },
      { role: "Policy ref", ref: row.policy },
      { role: "Session", ref: row.sessionId },
      // Escrow job key (chainJobId) — an on-chain EscrowCore id, not a block or
      // transaction. Labelled honestly and never linked to a block explorer.
      { role: "Escrow job", ref: text(averray?.chainJobId, row.chainJobId ?? "pending") },
    ],
    ...(row.source ? { source: receiptSource(row.source) } : {}),
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Build the optional source-attribution block surfaced in the receipt
 * drawer. Today we only know the source `kind` from the row itself —
 * the rich source object (repo + issue, dataset + agency) lives on the
 * underlying run, not on the receipt payload. So we render a badge +
 * a short attribution line, and let the existing "Linked artifacts"
 * section continue to carry the run id / evidence hash. Once receipts
 * carry a richer source field this can hydrate identity/href too.
 */
function receiptSource(
  kind: SourceKind
): NonNullable<ReceiptDrawerModel["source"]> {
  return {
    kind,
    attribution: SOURCE_ATTRIBUTION[kind] ?? "Averray-attributed run",
  };
}

function normalizeUiRow(row: ReceiptRowWithMeta): ReceiptRowWithMeta {
  return {
    ...row,
    sessionId: row.sessionId ?? row.subject,
    issuedAtIso: row.issuedAtIso ?? "",
    listRow: row.listRow ?? (row.kind === "run" && objectValue(row.badge)
      ? { runReceipt: row.badge }
      : undefined),
  };
}

function isUiReceiptRow(record: Record<string, unknown>): boolean {
  return Boolean(record.id && record.subject && record.subjectSub && Array.isArray(record.signers));
}

function extractSigners(value: unknown, averray: Record<string, unknown> | null): Signer[] {
  return extractReceiptSigners(value, averray) as Signer[];
}

function receiptKind(value: unknown, fallback: ReceiptKind): ReceiptKind {
  if (value === "run" || value === "settle" || value === "policy" || value === "badge") return value;
  return fallback;
}

function subjectSub(record: Record<string, unknown>, averray: Record<string, unknown> | null): string {
  const worker = shortAddress(text(record.worker, text(averray?.worker, "")));
  const category = text(averray?.category, "");
  if (category && worker) return `${category} · ${worker}`;
  return worker || text(record.subjectSub, "agent award");
}

function policyRef(record: Record<string, unknown>, averray: Record<string, unknown> | null): string {
  const explicit = text(record.policy, "");
  if (explicit) return explicit;
  const category = text(averray?.category, "reputation");
  const level = text(averray?.level, "1");
  return `${category}/tier-${level}`;
}

function receiptId(value: unknown, sessionId: string, evidenceHash: string): string {
  const explicit = text(value, "");
  if (explicit) return explicit;
  if (evidenceHash) return `r_${evidenceHash.slice(2, 8)}`;
  return `r_${sessionId.replace(/[^a-z0-9]/giu, "").slice(-6) || "badge"}`;
}

function displayTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value || "pending";
  const date = new Date(parsed);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} UTC`;
}

function sizeOf(value: unknown): string {
  const bytes = JSON.stringify(value ?? {}).length;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.max(bytes, 1)} B`;
}

function text(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value : fallback;
}

function objectField(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === "object" && !Array.isArray(field) ? (field as Record<string, unknown>) : null;
}

function arrayField(value: unknown, key: string): unknown[] | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : null;
}

function shortAddress(value: string): string {
  if (!value.startsWith("0x") || value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function isIdentifiedSignerAddress(value: string): boolean {
  const raw = value.trim();
  return /^0x[0-9a-fA-F]{40}$/u.test(raw) && !/^0x0{40}$/iu.test(raw);
}

function initials(value: string): string {
  return (value.match(/[a-z0-9]/giu)?.join("") ?? "--").slice(0, 1).toUpperCase();
}
