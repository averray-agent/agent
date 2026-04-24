import { cn } from "@/lib/utils/cn";
import type { SessionState, VerifierMode } from "./types";

const STATE: Record<SessionState, { cls: string; label: string; dot: boolean }> = {
  active: { cls: "bg-[#e6ecf7] text-[var(--avy-blue)]", label: "Active", dot: true },
  submitted: { cls: "bg-[#fff0d8] text-[var(--avy-warn)]", label: "Submitted", dot: true },
  approved: { cls: "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]", label: "Approved", dot: true },
  rejected: { cls: "bg-[#f4ddd5] text-[#a03a1a]", label: "Rejected", dot: true },
  disputed: { cls: "bg-[#f3d2c9] text-[#8c2a17]", label: "Disputed", dot: true },
  slashed: { cls: "bg-[#1e0f0d] text-[#f3d2c9]", label: "Slashed", dot: true },
  settled: { cls: "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-ink)]", label: "Settled", dot: false },
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

const VERIFIER_LABEL: Record<VerifierMode, string> = {
  deterministic: "Deterministic",
  semantic: "Semantic",
  "paired-hash": "Paired-hash",
  "human-llm": "Human+LLM",
};

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
      {VERIFIER_LABEL[mode]}
    </span>
  );
}
