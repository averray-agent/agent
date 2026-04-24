"use client";

import { cn } from "@/lib/utils/cn";
import type { DecisionKind, ReleaseDestination } from "./types";

export interface DecisionPanelProps {
  decision: DecisionKind | null;
  onDecision: (d: DecisionKind) => void;
  rationale: string;
  onRationaleChange: (s: string) => void;
  roleConfirmed: boolean;
  onRoleToggle: () => void;
  destination: ReleaseDestination | null;
  onCommit: () => void;
  disabled?: boolean;
}

const DECISIONS: {
  id: DecisionKind;
  label: string;
  subtitle: string;
  blurb: string;
  tone: "accent" | "neutral" | "warn";
}[] = [
  {
    id: "uphold",
    label: "Uphold dispute",
    subtitle: "confirm the contestation",
    blurb: "Stake slashed per policy. Receipt signed. Badge auto-suspended.",
    tone: "accent",
  },
  {
    id: "reject",
    label: "Reject dispute",
    subtitle: "dismiss the contestation",
    blurb: "Stake released to worker. Run resumes. Receipt carries dismissal reason.",
    tone: "neutral",
  },
  {
    id: "request-more",
    label: "Request more evidence",
    subtitle: "pause and ping opener",
    blurb: "Window paused. Opener notified to add payload or cite policy clause.",
    tone: "warn",
  },
];

export function DecisionPanel({
  decision,
  onDecision,
  rationale,
  onRationaleChange,
  roleConfirmed,
  onRoleToggle,
  destination,
  onCommit,
  disabled,
}: DecisionPanelProps) {
  const rationaleOk = rationale.trim().length >= 20;
  const destinationOk =
    decision === "request-more" || destination !== null;
  const committable =
    !disabled && decision !== null && rationaleOk && roleConfirmed && destinationOk;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {DECISIONS.map((d) => (
          <DecisionButton
            key={d.id}
            id={d.id}
            label={d.label}
            subtitle={d.subtitle}
            blurb={d.blurb}
            tone={d.tone}
            active={decision === d.id}
            disabled={disabled}
            onClick={() => onDecision(d.id)}
          />
        ))}
      </div>

      <label className="flex flex-col gap-1.5">
        <span
          className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
          style={{ letterSpacing: "0.14em" }}
        >
          Rationale · signed on commit · min 20 chars
        </span>
        <textarea
          disabled={!decision || disabled}
          value={rationale}
          onChange={(e) => onRationaleChange(e.target.value)}
          placeholder={
            decision
              ? "Explain the decision in one or two sentences. This text is signed into the receipt."
              : "Pick a verdict to enable."
          }
          className={cn(
            "min-h-[84px] resize-y rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] p-3 font-[family-name:var(--font-body)] text-[13px] leading-[1.5] text-[var(--avy-ink)] placeholder:text-[var(--avy-muted)]",
            "focus:border-[color:rgba(30,102,66,0.45)] focus:outline focus:outline-2 focus:outline-offset-0 focus:outline-[color:rgba(30,102,66,0.22)]",
            (!decision || disabled) && "opacity-60"
          )}
        />
        <div
          className="flex items-center justify-between font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          <span>{rationale.trim().length} / 20 min</span>
          <span>sha-256 hash of this text joins the signed receipt</span>
        </div>
      </label>

      <label
        className={cn(
          "flex cursor-pointer items-start gap-2.5 rounded-[8px] border px-3 py-2.5",
          roleConfirmed
            ? "border-[color:rgba(30,102,66,0.32)] bg-[color:rgba(30,102,66,0.05)]"
            : "border-[var(--avy-line)] bg-[var(--avy-paper-solid)]"
        )}
      >
        <input
          type="checkbox"
          checked={roleConfirmed}
          onChange={onRoleToggle}
          disabled={disabled}
          className="mt-0.5 h-4 w-4 accent-[var(--avy-accent)]"
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-[family-name:var(--font-display)] text-[12.5px] font-bold text-[var(--avy-ink)]">
            I hold the dispute-resolver role for this scope
          </span>
          <span
            className="font-[family-name:var(--font-body)] text-[11.5px] leading-snug text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            Required per <Mono>co-sign/policy-change-quorum@v2</Mono>. This
            claim is signed into the receipt alongside your wallet.
          </span>
        </span>
      </label>

      <button
        type="button"
        disabled={!committable}
        onClick={committable ? onCommit : undefined}
        className={cn(
          "inline-flex h-11 items-center justify-center gap-2 rounded-[8px] px-4 font-[family-name:var(--font-display)] text-[13px] font-bold uppercase transition-all",
          committable
            ? "bg-[var(--avy-accent)] text-[var(--fg-invert)] hover:-translate-y-px hover:bg-[var(--avy-accent-2)]"
            : "cursor-not-allowed bg-[color:rgba(17,19,21,0.08)] text-[var(--avy-muted)]"
        )}
        style={{ letterSpacing: "0.05em" }}
        title={
          committable
            ? "Sign & commit this verdict to the dispute"
            : !decision
              ? "Pick a verdict above"
              : !destinationOk
                ? "Pick a release destination"
                : !rationaleOk
                  ? "Write at least 20 chars of rationale"
                  : "Confirm you hold the dispute-resolver role"
        }
      >
        Sign &amp; commit verdict
      </button>
    </div>
  );
}

function DecisionButton({
  id,
  label,
  subtitle,
  blurb,
  tone,
  active,
  disabled,
  onClick,
}: {
  id: DecisionKind;
  label: string;
  subtitle: string;
  blurb: string;
  tone: "accent" | "neutral" | "warn";
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const inactive =
    "border-[var(--avy-line)] bg-[var(--avy-paper-solid)] hover:border-[color:rgba(30,102,66,0.24)]";
  const activeCls = {
    accent:
      "border-[color:rgba(30,102,66,0.45)] bg-[var(--avy-accent-soft)] shadow-[inset_0_0_0_1px_rgba(30,102,66,0.18)]",
    neutral:
      "border-[color:rgba(17,19,21,0.24)] bg-[color:rgba(17,19,21,0.04)] shadow-[inset_0_0_0_1px_rgba(17,19,21,0.08)]",
    warn:
      "border-[color:rgba(167,97,34,0.35)] bg-[var(--avy-warn-soft)] shadow-[inset_0_0_0_1px_rgba(167,97,34,0.18)]",
  }[tone];

  const labelTone = {
    accent: "text-[var(--avy-accent)]",
    neutral: "text-[var(--avy-ink)]",
    warn: "text-[var(--avy-warn)]",
  }[tone];

  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      data-decision={id}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex min-h-[104px] flex-col items-start gap-1 rounded-[10px] border px-3.5 py-3 text-left transition-all hover:-translate-y-px",
        active ? activeCls : inactive,
        disabled && "cursor-not-allowed opacity-45 hover:translate-y-0"
      )}
    >
      <span
        className={cn(
          "font-[family-name:var(--font-display)] text-[13.5px] font-bold uppercase",
          active ? labelTone : "text-[var(--avy-ink)]"
        )}
        style={{ letterSpacing: "0.04em" }}
      >
        {label}
      </span>
      <span
        className="font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        {subtitle}
      </span>
      <span
        className="mt-1 font-[family-name:var(--font-body)] text-[12px] leading-snug text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        {blurb}
      </span>
    </button>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code
      className="rounded-[4px] bg-[color:rgba(17,19,21,0.06)] px-1 py-px font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-ink)]"
      style={{ letterSpacing: 0 }}
    >
      {children}
    </code>
  );
}
