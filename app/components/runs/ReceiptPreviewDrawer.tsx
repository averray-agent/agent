"use client";

import { DetailDrawer, DrawerSection } from "@/components/shell/DetailDrawer";
import { SourceBadge, StatePill, type RunState } from "./StatePill";
import type { GitHubJobContext, WikipediaJobContext } from "./types";
import { cn } from "@/lib/utils/cn";

/**
 * Draft ledger entry that the operator is about to sign when they hit
 * "Mark verified & pay". Everything in this payload is assembled from
 * data already visible in the Loaded-run panel — this drawer is a
 * "print preview" before on-chain settlement, not a new data fetch.
 *
 * The explicit purpose: let the operator inspect the split, the
 * verifier verdict, the PR reference, and the receipt ref BEFORE any
 * DOT moves, so a wrong category / wrong split / wrong PR gets caught
 * at the preview step instead of committed to the audit log.
 */
export interface ReceiptPreviewDraft {
  receiptRef: string; // "r_4e133"
  runId: string;
  jobMeta: string;
  state: RunState;
  stake: {
    amount: string;
    currency: string;
    breakdown: { label: string; value: string }[];
  };
  verdict: {
    status: string;
    score: string;
    confidence: string;
  };
  evidenceHash?: string;
  github?: GitHubJobContext;
  /**
   * Set when the loaded run is a Wikipedia maintenance proposal. The
   * drawer shows page metadata + the proposal-only attribution line.
   * Mutually exclusive with `github` at runtime.
   */
  wikipedia?: WikipediaJobContext;
  prUrl?: string;
  signers: { label: string; status: "pending" | "signed" }[];
}

export interface ReceiptPreviewDrawerProps {
  open: boolean;
  onClose: () => void;
  draft: ReceiptPreviewDraft;
}

export function ReceiptPreviewDrawer({
  open,
  onClose,
  draft,
}: ReceiptPreviewDrawerProps) {
  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      width={560}
      title={
        <div>
          <div
            className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-accent)]"
            style={{ letterSpacing: "0.14em" }}
          >
            Receipt preview · draft
          </div>
          <h2 className="m-0 mt-0.5 font-[family-name:var(--font-display)] text-[18px] font-bold leading-[1.2] text-[var(--avy-ink)]">
            {draft.receiptRef}
          </h2>
        </div>
      }
      meta={
        <div className="flex flex-wrap items-center gap-2 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]" style={{ letterSpacing: 0 }}>
          <StatePill state={draft.state} />
          <span>{draft.runId}</span>
          <span className="opacity-40">·</span>
          <span>{draft.jobMeta}</span>
        </div>
      }
    >
      <DraftBanner />

      {draft.github ? (
        <DrawerSection title="Source">
          <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-[var(--avy-line)] bg-[color:rgba(17,19,21,0.02)] px-3 py-2">
            <SourceBadge kind="github" />
            <a
              href={draft.github.issueUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)] hover:text-[var(--avy-accent)]"
              style={{ letterSpacing: 0 }}
            >
              {draft.github.repo}
              <span className="ml-0.5 text-[var(--avy-accent)]">
                #{draft.github.issueNumber}
              </span>
            </a>
            <span className="opacity-40">·</span>
            <span
              className="font-[family-name:var(--font-mono)] text-[11.5px] uppercase text-[var(--avy-muted)]"
              style={{ letterSpacing: "0.08em" }}
            >
              {draft.github.category}
            </span>
          </div>
          {draft.prUrl ? (
            <a
              href={draft.prUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase text-[var(--avy-ink)] transition-transform hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.24)] hover:text-[var(--avy-accent)]"
              style={{ letterSpacing: "0.04em" }}
            >
              View PR ↗
            </a>
          ) : null}
        </DrawerSection>
      ) : null}

      {draft.wikipedia ? (
        <DrawerSection title="Source">
          <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-[var(--avy-line)] bg-[color:rgba(17,19,21,0.02)] px-3 py-2">
            <SourceBadge kind="wikipedia" />
            <a
              href={draft.wikipedia.pageUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)] hover:text-[var(--avy-accent)]"
              style={{ letterSpacing: 0 }}
            >
              <span className="text-[var(--avy-muted)]">
                {draft.wikipedia.language}.wikipedia
              </span>
              <span className="ml-0.5 text-[var(--avy-accent)]">
                / {draft.wikipedia.pageTitle}
              </span>
            </a>
            <span className="opacity-40">·</span>
            <span
              className="font-[family-name:var(--font-mono)] text-[11.5px] uppercase text-[var(--avy-muted)]"
              style={{ letterSpacing: "0.08em" }}
            >
              {draft.wikipedia.taskType.replace(/_/g, " ")}
            </span>
          </div>

          <dl
            className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-[family-name:var(--font-mono)] text-[11.5px]"
            style={{ letterSpacing: 0 }}
          >
            <dt className="text-[var(--avy-muted)]">Page title</dt>
            <dd className="m-0 truncate font-medium text-[var(--avy-ink)]">
              {draft.wikipedia.pageTitle}
            </dd>
            <dt className="text-[var(--avy-muted)]">Revision</dt>
            <dd className="m-0 font-medium text-[var(--avy-ink)]">
              {draft.wikipedia.revisionId}
            </dd>
            <dt className="text-[var(--avy-muted)]">Task type</dt>
            <dd className="m-0 font-medium text-[var(--avy-ink)]">
              {draft.wikipedia.taskType.replace(/_/g, " ")}
            </dd>
          </dl>

          {/* Attribution + non-edit policy. The receipt is the only
              place in the audit trail where this proposal-only stance is
              spelled out for downstream consumers, so we show it here
              even though the panel already shows it. */}
          <p
            className="mt-2 rounded-[6px] border border-[var(--avy-warn)] bg-[color:rgba(211,145,27,0.08)] px-2.5 py-2 font-[family-name:var(--font-mono)] text-[11px] leading-[1.5] text-[var(--avy-ink)]"
            style={{ letterSpacing: 0 }}
          >
            <b className="font-semibold">Attribution:</b> Averray (proposal
            only). Public Wikipedia edits, if any, are performed downstream
            by an approved Averray editor or bot — never directly by the
            agent.
          </p>

          <a
            href={draft.wikipedia.pageUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase text-[var(--avy-ink)] transition-transform hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.24)] hover:text-[var(--avy-accent)]"
            style={{ letterSpacing: "0.04em" }}
          >
            Open Wikipedia article ↗
          </a>
        </DrawerSection>
      ) : null}

      <DrawerSection title="Payout split">
        <div className="overflow-hidden rounded-[8px] border border-[color:rgba(30,102,66,0.22)] bg-[color:rgba(30,102,66,0.04)]">
          <div className="flex items-baseline justify-between gap-3 border-b border-[color:rgba(30,102,66,0.14)] px-3.5 py-3">
            <div>
              <span className="font-[family-name:var(--font-display)] text-[24px] font-bold leading-none text-[var(--avy-ink)]">
                {draft.stake.amount}
              </span>
              <span
                className="ml-1 font-[family-name:var(--font-mono)] text-[11px] font-medium text-[var(--avy-muted)]"
                style={{ letterSpacing: 0 }}
              >
                {draft.stake.currency}
              </span>
              <p
                className="mt-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                style={{ letterSpacing: 0 }}
              >
                total posted to pay at settlement
              </p>
            </div>
          </div>
          <ul className="divide-y divide-[color:rgba(30,102,66,0.12)]">
            {draft.stake.breakdown.map((row) => (
              <li
                key={row.label}
                className="flex items-center justify-between gap-3 px-3.5 py-2 font-[family-name:var(--font-mono)] text-[12px]"
                style={{ letterSpacing: 0 }}
              >
                <span className="text-[var(--avy-muted)]">{row.label}</span>
                <span className="font-semibold text-[var(--avy-ink)]">
                  {row.value}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </DrawerSection>

      <DrawerSection title="Verifier verdict">
        <div className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--avy-line)] bg-white px-3.5 py-2.5">
          <div>
            <div className="font-[family-name:var(--font-display)] text-[12.5px] font-bold text-[var(--avy-ink)]">
              {draft.verdict.status}
            </div>
            <div
              className="mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              {draft.verdict.score} · {draft.verdict.confidence}
            </div>
          </div>
          {draft.evidenceHash ? (
            <div className="text-right">
              <div
                className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
                style={{ letterSpacing: "0.1em" }}
              >
                Evidence
              </div>
              <div
                className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-ink)]"
                style={{ letterSpacing: 0 }}
              >
                {draft.evidenceHash}
              </div>
            </div>
          ) : null}
        </div>
      </DrawerSection>

      <DrawerSection title="Signers">
        <ul className="flex flex-col gap-1.5">
          {draft.signers.map((signer) => (
            <li
              key={signer.label}
              className="flex items-center justify-between gap-2 rounded-[6px] border border-[var(--avy-line)] bg-white px-3 py-2 font-[family-name:var(--font-mono)] text-[11.5px]"
              style={{ letterSpacing: 0 }}
            >
              <span className="truncate text-[var(--avy-ink)]">
                {signer.label}
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase whitespace-nowrap",
                  signer.status === "signed"
                    ? "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]"
                    : "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-muted)]"
                )}
                style={{ letterSpacing: "0.1em" }}
              >
                {signer.status === "signed" ? "✓ Signed" : "· Pending"}
              </span>
            </li>
          ))}
        </ul>
      </DrawerSection>

      <DrawerSection title="On settlement">
        <p
          className="m-0 rounded-[6px] border border-[var(--avy-line)] bg-[color:rgba(17,19,21,0.02)] px-3 py-2 font-[family-name:var(--font-mono)] text-[11.5px] leading-[1.55] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          This draft becomes an append-only receipt at the moment{" "}
          <b className="font-semibold text-[var(--avy-ink)]">Mark verified & pay</b>{" "}
          is pressed. The payload — receipt ref, run id, stake split, verdict,
          evidence hash, and signer addresses — is then hashed with sha256 and
          co-signed into the audit log. Nothing on this page is written yet.
        </p>
      </DrawerSection>
    </DetailDrawer>
  );
}

function DraftBanner() {
  return (
    <div
      className="flex items-center gap-2 rounded-[8px] border border-[var(--avy-warn)] bg-[color:rgba(211,145,27,0.08)] px-3 py-2 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-ink)]"
      style={{ letterSpacing: 0 }}
    >
      <span
        className="inline-flex items-center rounded-full bg-[var(--avy-warn)] px-1.5 py-0.5 font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-white"
        style={{ letterSpacing: "0.1em" }}
      >
        Draft
      </span>
      <span>
        Unsigned preview. No DOT moves, no audit-log entry, no notifications
        fire.
      </span>
    </div>
  );
}
