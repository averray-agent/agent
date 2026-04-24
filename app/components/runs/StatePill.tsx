import { cn } from "@/lib/utils/cn";

export type RunState = "ready" | "claimed" | "submitted" | "disputed" | "settled";
export type Tier = "T1" | "T2" | "T3";

const STATE_CLASSES: Record<RunState, string> = {
  ready: "bg-[#e6ecf7] text-[#254e9a]",
  claimed: "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
  submitted: "bg-[#fff0d8] text-[#a76122]",
  disputed: "bg-[#f4ddd5] text-[#a03a1a]",
  settled: "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-ink)]",
};

const TIER_CLASSES: Record<Tier, string> = {
  T1: "bg-[#e9f2e0] text-[#425d1a]",
  T2: "bg-[#e8efea] text-[#326244]",
  T3: "bg-[#e6ecf7] text-[#254e9a]",
};

const STATE_LABEL: Record<RunState, string> = {
  ready: "Ready",
  claimed: "Claimed",
  submitted: "Submitted",
  disputed: "Disputed",
  settled: "Settled",
};

const PILL_BASE =
  "inline-flex items-center gap-1.5 min-h-[22px] px-2.5 py-0.5 rounded-full font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase whitespace-nowrap";

export function StatePill({
  state,
  className,
}: {
  state: RunState;
  className?: string;
}) {
  return (
    <span
      className={cn(PILL_BASE, STATE_CLASSES[state], className)}
      style={{ letterSpacing: "0.1em" }}
    >
      <span className="h-[5px] w-[5px] rounded-full bg-current opacity-80" />
      {STATE_LABEL[state]}
    </span>
  );
}

export function TierPill({ tier, className }: { tier: Tier; className?: string }) {
  return (
    <span
      className={cn(PILL_BASE, TIER_CLASSES[tier], className)}
      style={{ letterSpacing: "0.1em" }}
    >
      <span className="h-[5px] w-[5px] rounded-full bg-current opacity-80" />
      Tier {tier.slice(1)}
    </span>
  );
}

export function VerifierModePill({
  label,
  tone = "claimed",
  className,
}: {
  label: string;
  tone?: RunState;
  className?: string;
}) {
  return (
    <span
      className={cn(PILL_BASE, STATE_CLASSES[tone], className)}
      style={{ letterSpacing: "0.1em" }}
    >
      <span className="h-[5px] w-[5px] rounded-full bg-current opacity-80" />
      {label}
    </span>
  );
}
