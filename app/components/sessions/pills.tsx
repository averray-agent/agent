import { cn } from "@/lib/utils/cn";
import type { SessionState, VerifierMode } from "./types";

const STATE: Record<SessionState, { cls: string; label: string; dot: boolean }> = {
  claimed: { cls: "bg-[#e6ecf7] text-[var(--avy-blue)]", label: "Claimed", dot: true },
  submitted: { cls: "bg-[#fff0d8] text-[var(--avy-warn)]", label: "Submitted", dot: true },
  disputed: { cls: "bg-[#f3d2c9] text-[#8c2a17]", label: "Disputed", dot: true },
  resolved: { cls: "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]", label: "Resolved", dot: false },
  rejected: { cls: "bg-[#f4ddd5] text-[#a03a1a]", label: "Rejected", dot: false },
  closed: { cls: "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-ink)]", label: "Closed", dot: false },
  expired: { cls: "bg-[#f4ddd5] text-[#a03a1a]", label: "Expired", dot: false },
  timed_out: { cls: "bg-[#f4ddd5] text-[#a03a1a]", label: "Timed out", dot: false },
  unknown: { cls: "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-muted)]", label: "Unknown", dot: false },
};

export function SessionStatePill({
  state,
  className,
}: {
  state: SessionState;
  className?: string;
}) {
  const s = STATE[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase whitespace-nowrap",
        s.cls,
        className
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      {s.dot ? <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" /> : null}
      {s.label}
    </span>
  );
}

export function VerifierModeChip({
  mode,
  className,
}: {
  mode: VerifierMode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[4px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-ink)]",
        className
      )}
      style={{ letterSpacing: 0 }}
    >
      {humanizeToken(mode)}
    </span>
  );
}

function humanizeToken(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "Not emitted";
  return normalized
    .replace(/[_-]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
