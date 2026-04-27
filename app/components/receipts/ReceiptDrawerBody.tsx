"use client";

import { DrawerSection } from "@/components/shell/DetailDrawer";
import { SourceBadge, type SourceKind } from "@/components/runs/StatePill";
import { cn } from "@/lib/utils/cn";

export interface SignatureEntry {
  role: string;
  address: string;
  time: string;
  pending?: boolean;
}

export interface LinkedArtifact {
  role: string;
  ref: string;
  href?: string;
}

export interface ReceiptDrawerSource {
  kind: SourceKind;
  /** Optional secondary tag inside the badge — e.g. "NVD" on OSV with CVEs. */
  secondary?: string;
  /** One-line attribution. */
  attribution: string;
  /** Optional inline identity, e.g. "owner/repo #123" or dataset title. */
  identity?: string;
  href?: string;
}

export interface ReceiptDrawerBodyProps {
  signatures: SignatureEntry[];
  evidenceJson: string;
  evidenceMeta: string;
  evidenceRawHref: string;
  links: LinkedArtifact[];
  /**
   * Source provenance + attribution for run-kind receipts. Unset for
   * non-run receipts (badge, settle on a loan, policy revision) where
   * the platform-source concept doesn't apply.
   */
  source?: ReceiptDrawerSource;
}

export function ReceiptDrawerBody({
  signatures,
  evidenceJson,
  evidenceMeta,
  evidenceRawHref,
  links,
  source,
}: ReceiptDrawerBodyProps) {
  return (
    <>
      {source ? (
        <DrawerSection title="Source">
          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[8px] border border-[var(--avy-line)] bg-[color:rgba(17,19,21,0.02)] px-3 py-2"
            style={{ letterSpacing: 0 }}
          >
            <SourceBadge kind={source.kind} secondary={source.secondary} />
            {source.identity ? (
              source.href ? (
                <a
                  href={source.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="truncate whitespace-nowrap font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)] hover:text-[var(--avy-accent)]"
                  title={source.identity}
                >
                  {source.identity}
                </a>
              ) : (
                <span
                  className="truncate whitespace-nowrap font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]"
                  title={source.identity}
                >
                  {source.identity}
                </span>
              )
            ) : null}
          </div>
          <p
            className="mt-2 m-0 rounded-[6px] border border-[var(--avy-warn)] bg-[color:rgba(211,145,27,0.08)] px-2.5 py-2 font-[family-name:var(--font-mono)] text-[11px] leading-[1.5] text-[var(--avy-ink)]"
            style={{ letterSpacing: 0 }}
          >
            <b className="font-semibold">Attribution:</b> {source.attribution}.
          </p>
        </DrawerSection>
      ) : null}

      <DrawerSection title="Signature chain">
        <div className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3.5 py-3">
          {signatures.map((sig, i) => (
            <SignatureRow key={i} sig={sig} />
          ))}
        </div>
      </DrawerSection>

      <DrawerSection title="Evidence preview">
        <EvidenceCodeBlock raw={evidenceJson} />
        <div
          className="flex items-center justify-between font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          <span>{evidenceMeta}</span>
          <a
            href={evidenceRawHref}
            target="_blank"
            rel="noreferrer"
            className="border-b border-dashed border-[color:rgba(30,102,66,0.4)] pb-px text-[var(--avy-accent)]"
          >
            Open raw → {evidenceRawHref}
          </a>
        </div>
      </DrawerSection>

      <DrawerSection title="Linked artifacts">
        <div className="flex flex-col gap-1">
          {links.map((link) => (
            <LinkedArtifactRow key={link.role} link={link} />
          ))}
        </div>
      </DrawerSection>

      <DrawerSection title="Verify">
        <VerifyPanel />
      </DrawerSection>
    </>
  );
}

function SignatureRow({ sig }: { sig: SignatureEntry }) {
  return (
    <div
      className="grid items-center gap-2.5 font-[family-name:var(--font-mono)] text-[12px]"
      style={{
        gridTemplateColumns: "22px auto 1fr auto",
        letterSpacing: 0,
      }}
    >
      <span
        className={cn(
          "grid h-[22px] w-[22px] place-items-center rounded-full",
          sig.pending
            ? "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]"
            : "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]"
        )}
      >
        {sig.pending ? "…" : "✓"}
      </span>
      <span
        className="font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.1em" }}
      >
        {sig.role}
      </span>
      <span className="text-[12px] text-[var(--avy-ink)]">{sig.address}</span>
      <span className="text-[11px] text-[var(--avy-muted)]">
        {sig.pending ? "awaiting" : sig.time}
      </span>
    </div>
  );
}

function LinkedArtifactRow({ link }: { link: LinkedArtifact }) {
  const content = (
    <div
      className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-2"
      style={{ letterSpacing: 0 }}
    >
      <span
        className="min-w-[90px] font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.1em" }}
      >
        {link.role}
      </span>
      <span className="flex-1 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]">
        {link.ref}
      </span>
      <span className="font-[family-name:var(--font-mono)] text-[13px] text-[var(--avy-accent)]">
        →
      </span>
    </div>
  );

  return link.href ? (
    <a href={link.href} target="_blank" rel="noreferrer" className="block">
      {content}
    </a>
  ) : (
    <div>{content}</div>
  );
}

function EvidenceCodeBlock({ raw }: { raw: string }) {
  return (
    <pre
      className="m-0 overflow-x-auto rounded-[8px] bg-[#131715] px-4 py-3.5 font-[family-name:var(--font-mono)] text-[11.5px] leading-[1.65] text-[#e8e5dc]"
      style={{ letterSpacing: 0 }}
    >
      <code>{raw}</code>
    </pre>
  );
}

function VerifyPanel() {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-[color:rgba(30,102,66,0.24)] bg-[color:rgba(30,102,66,0.05)] px-3.5 py-3.5">
      <span
        className="font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.12em" }}
      >
        Re-verify evidence
      </span>
      <textarea
        placeholder="Paste detached signature to re-verify — base64 or hex…"
        className="min-h-[68px] resize-y rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] p-2.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-ink)] placeholder:text-[var(--avy-muted)] focus:outline focus:outline-2 focus:outline-[color:rgba(30,102,66,0.26)]"
        style={{ letterSpacing: 0 }}
      />
      <div className="flex gap-2">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-[8px] bg-[var(--avy-accent)] px-3 font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase text-[var(--fg-invert)] transition-transform hover:-translate-y-px hover:bg-[var(--avy-accent-2)]"
          style={{ letterSpacing: "0.04em" }}
        >
          ✓ Verify paste
        </button>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase text-[var(--avy-ink)] transition-transform hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.24)]"
          style={{ letterSpacing: "0.04em" }}
        >
          ⟳ Re-hash content
        </button>
      </div>
    </div>
  );
}
