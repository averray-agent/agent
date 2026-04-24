import type { AgentTier } from "./types";

export function TierChip({ tier, className }: { tier: AgentTier; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-[4px] bg-[var(--avy-accent-soft)] px-1.5 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-accent)] ${className ?? ""}`}
      style={{ letterSpacing: "0.08em" }}
    >
      {tier}
    </span>
  );
}
