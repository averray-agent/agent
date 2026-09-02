"use client";

import { cn } from "@/lib/utils/cn";
import type { OutcomeRationale } from "@/lib/ui/outcome-rationale-types";

export function OutcomeRationaleInline({
  rationale,
  compact = false,
}: {
  rationale: OutcomeRationale;
  compact?: boolean;
}) {
  const toneClass =
    rationale.tone === "bad"
      ? "border-[color:rgba(140,42,23,0.24)] bg-[color:rgba(140,42,23,0.055)] text-[#8c2a17]"
      : "border-[color:rgba(167,97,34,0.26)] bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]";

  return (
    <div
      className={cn(
        "min-w-0 rounded-[8px] border px-2.5 py-2",
        compact ? "mt-2 max-w-[320px]" : "mt-3 w-full",
        toneClass
      )}
    >
      <div
        className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 font-[family-name:var(--font-mono)] text-[11.5px]"
        style={{ letterSpacing: 0 }}
      >
        <span className="font-semibold">{rationale.statusLabel}</span>
        <span className="text-[var(--avy-muted)]">·</span>
        <span className="break-words text-[var(--avy-ink)]">{rationale.reason}</span>
      </div>

      <div
        className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-[family-name:var(--font-mono)] text-[10.8px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        <span>
          Policy ·{" "}
          <CitationLink href={rationale.policyHref} tone={rationale.tone}>
            {rationale.policyLabel}
          </CitationLink>
        </span>
        <span className="opacity-45">|</span>
        <span>
          Receipt ·{" "}
          <CitationLink href={rationale.receiptHref} tone={rationale.tone}>
            {rationale.receiptLabel}
          </CitationLink>
        </span>
      </div>

      {!compact && (rationale.detail || rationale.reasonCode) ? (
        <p
          className="m-0 mt-1.5 break-words text-[12px] leading-snug text-[var(--avy-ink)]"
          style={{ letterSpacing: 0 }}
        >
          {rationale.detail ?? rationale.reasonCode}
        </p>
      ) : null}
    </div>
  );
}

function CitationLink({
  href,
  tone,
  children,
}: {
  href?: string;
  tone: OutcomeRationale["tone"];
  children: React.ReactNode;
}) {
  if (!href) {
    return <b className="font-semibold text-[var(--avy-ink)]">{children}</b>;
  }

  return (
    <a
      href={href}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "break-words border-b border-dashed font-semibold",
        tone === "bad"
          ? "border-[color:rgba(140,42,23,0.36)] text-[#8c2a17] hover:text-[#6a2010]"
          : "border-[color:rgba(167,97,34,0.42)] text-[var(--avy-warn)] hover:text-[#7a481a]"
      )}
    >
      {children}
    </a>
  );
}
