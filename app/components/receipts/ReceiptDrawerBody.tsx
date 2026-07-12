"use client";

import { useState } from "react";
import { DrawerSection } from "@/components/shell/DetailDrawer";
import { SourceBadge, type SourceKind } from "@/components/runs/StatePill";
import { cn } from "@/lib/utils/cn";
import { verifyReceiptSignature } from "@/lib/ui/receipt-signature-verification";

export interface SignatureEntry {
  role: string;
  address: string;
  time?: string;
  pending?: boolean;
  identified?: boolean;
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
  receiptId: string;
  signatures: SignatureEntry[];
  canonicalDocument: Record<string, unknown> | null;
  verificationPresence: "live" | "loading" | "locked" | "down";
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
  receiptId,
  signatures,
  canonicalDocument,
  verificationPresence,
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
        <VerifyPanel
          key={`${receiptId}:${verificationPresence}:${canonicalDocument ? "document" : "missing"}`}
          canonicalDocument={canonicalDocument}
          presence={verificationPresence}
        />
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
          sig.pending || sig.identified === false
            ? "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]"
            : "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]"
        )}
      >
        {sig.pending || sig.identified === false ? "…" : "✓"}
      </span>
      <span
        className="font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.1em" }}
      >
        {sig.role}
      </span>
      <span className="text-[12px] text-[var(--avy-ink)]">
        {sig.identified === false
          ? "identity not yet emitted by /badges"
          : sig.address}
      </span>
      <span className="text-[11px] text-[var(--avy-muted)]">
        {sig.pending
          ? "awaiting"
          : sig.identified === false
            ? ""
            : sig.time ?? ""}
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

type VerifyStatus =
  | { tone: "idle"; title: string; detail: string }
  | { tone: "pending"; title: string; detail: string }
  | { tone: "ok"; title: string; detail: string }
  | { tone: "bad"; title: string; detail: string }
  | { tone: "unsigned"; title: string; detail: string }
  | { tone: "unavailable"; title: string; detail: string };

function VerifyPanel({
  canonicalDocument,
  presence,
}: {
  canonicalDocument: Record<string, unknown> | null;
  presence: "live" | "loading" | "locked" | "down";
}) {
  const [status, setStatus] = useState<VerifyStatus>(() => initialVerifyStatus(canonicalDocument, presence));

  const verifyDocument = async () => {
    if (presence !== "live" || !canonicalDocument) return;

    setStatus({
      tone: "pending",
      title: "Verifying in browser",
      detail: "Canonicalizing the receipt and checking its detached ES256 JWS against the public JWKS.",
    });
    const result = await verifyReceiptSignature({ document: canonicalDocument });
    if (result.state === "verified") {
      setStatus({
        tone: "ok",
        title: "✓ Verified",
        detail: `${result.kid} · signed ${formatSignedAt(result.signedAt)}`,
      });
      return;
    }
    if (result.state === "unsigned") {
      setStatus({
        tone: "unsigned",
        title: "Unsigned (legacy)",
        detail: "This receipt has no signature field; it is not treated as failed or verified.",
      });
      return;
    }
    if (result.state === "unavailable") {
      setStatus({
        tone: "unavailable",
        title: "Verification unavailable",
        detail: result.error,
      });
      return;
    }
    setStatus({
      tone: "bad",
      title: "✗ Failed",
      detail: result.error,
    });
  };

  const disabledReason = presenceReason(presence, canonicalDocument);

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-[color:rgba(30,102,66,0.24)] bg-[color:rgba(30,102,66,0.05)] px-3.5 py-3.5">
      <span
        className="font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.12em" }}
      >
        Receipt signature
      </span>
      <p className="m-0 font-[family-name:var(--font-mono)] text-[11px] leading-[1.5] text-[var(--avy-muted)]" style={{ letterSpacing: 0 }}>
        Browser-only RFC 8785 + ES256 check. The receipt stays local; only the public key set is fetched.
      </p>
      <button
        type="button"
        disabled={Boolean(disabledReason)}
        title={disabledReason ?? "Verify this receipt against the public badge-1 key"}
        onClick={verifyDocument}
        className="inline-flex h-8 w-fit items-center gap-1.5 rounded-[8px] bg-[var(--avy-accent)] px-3 font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase text-[var(--fg-invert)] transition-transform hover:-translate-y-px hover:bg-[var(--avy-accent-2)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:bg-[var(--avy-accent)]"
        style={{ letterSpacing: "0.04em" }}
      >
        Verify signature
      </button>
      {disabledReason ? (
        <span className="font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]" style={{ letterSpacing: 0 }}>
          {disabledReason}
        </span>
      ) : null}
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "rounded-[8px] border px-3 py-2 font-[family-name:var(--font-mono)] text-[11px] leading-[1.5]",
          status.tone === "ok" &&
            "border-[color:rgba(30,102,66,0.24)] bg-[color:rgba(30,102,66,0.08)] text-[var(--avy-accent)]",
          status.tone === "bad" &&
            "border-[color:rgba(176,72,55,0.28)] bg-[color:rgba(176,72,55,0.08)] text-[#b04837]",
          status.tone === "unsigned" &&
            "border-[var(--avy-line)] bg-[var(--avy-paper-solid)] text-[var(--avy-ink)]",
          status.tone === "unavailable" &&
            "border-[color:rgba(211,145,27,0.26)] bg-[color:rgba(211,145,27,0.08)] text-[var(--avy-warn)]",
          status.tone === "pending" &&
            "border-[color:rgba(211,145,27,0.26)] bg-[color:rgba(211,145,27,0.08)] text-[var(--avy-warn)]",
          status.tone === "idle" &&
            "border-[var(--avy-line)] bg-[var(--avy-paper-solid)] text-[var(--avy-muted)]"
        )}
        style={{ letterSpacing: 0 }}
      >
        <b className="font-semibold">{status.title}:</b> {status.detail}
      </div>
    </div>
  );
}

function initialVerifyStatus(
  document: Record<string, unknown> | null,
  presence: "live" | "loading" | "locked" | "down"
): VerifyStatus {
  if (presence === "loading") {
    return { tone: "unavailable", title: "Loading", detail: "Waiting for the canonical receipt document." };
  }
  if (presence === "locked") {
    return { tone: "unavailable", title: "Locked", detail: "Receipt feed locked for this session; verification was not attempted." };
  }
  if (presence === "down") {
    return { tone: "unavailable", title: "Unavailable", detail: "Receipt feed is unavailable; verification was not attempted." };
  }
  if (!document) {
    return { tone: "unavailable", title: "Unavailable", detail: "Canonical receipt document was not emitted." };
  }
  if (!("signature" in document)) {
    return {
      tone: "unsigned",
      title: "Unsigned (legacy)",
      detail: "This receipt has no signature field; it is not treated as failed or verified.",
    };
  }
  return { tone: "idle", title: "Ready", detail: "Signature present; click to verify it locally against badge-1." };
}

function presenceReason(
  presence: "live" | "loading" | "locked" | "down",
  document: Record<string, unknown> | null
): string | null {
  if (presence === "loading") return "Disabled while the canonical receipt is loading.";
  if (presence === "locked") return "Disabled: receipt feed locked for this session.";
  if (presence === "down") return "Disabled: receipt feed unavailable.";
  if (!document) return "Disabled: canonical receipt document unavailable.";
  return null;
}

function formatSignedAt(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}
