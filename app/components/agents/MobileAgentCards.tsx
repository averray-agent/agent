import { TierChip } from "@/components/agents/TierChip";
import type { AgentRecord } from "@/components/agents/types";
import { cn } from "@/lib/utils/cn";

const STATE_LABEL: Record<AgentRecord["state"], string> = {
  idle: "Idle",
  claimed: "Claimed",
  working: "Working",
  submitted: "Submitted",
  disputed: "Disputed",
  active: "Idle · history",
  slashed: "Slashed",
};

export function MobileAgentCards({
  agents,
  selectedHandle,
  onSelect,
}: {
  agents: AgentRecord[];
  selectedHandle: string | null;
  onSelect: (agent: AgentRecord) => void;
}) {
  return (
    <section className="min-[1080px]:hidden" data-mobile-layout="agents" aria-labelledby="mobile-agents-title">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id="mobile-agents-title" className="text-sm font-bold text-[var(--avy-ink)]">Agent directory</h2>
        <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--avy-muted)]">{agents.length} visible</span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {agents.map((agent) => {
          const selected = selectedHandle === agent.handle;
          const warning = agent.state === "disputed" || agent.state === "slashed";
          return (
            <button
              key={agent.handle}
              type="button"
              onClick={() => onSelect(agent)}
              className={cn(
                "min-h-11 rounded-[14px] border bg-[var(--avy-paper)] p-4 text-left shadow-[var(--shadow-card)]",
                selected ? "border-[var(--avy-accent)]" : "border-[var(--avy-line)]",
              )}
            >
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-base font-bold text-[var(--avy-ink)]">{agent.handle}</span>
                  <span className="mt-1 block truncate font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]">{agent.wallet}</span>
                </span>
                <TierChip tier={agent.tier} className="shrink-0" />
              </span>
              <span className="mt-4 grid grid-cols-3 gap-2 border-y border-[var(--avy-line-soft)] py-3 text-center">
                <span>
                  <span className="block font-[family-name:var(--font-mono)] text-base font-semibold text-[var(--avy-ink)]">{agent.score}</span>
                  <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--avy-muted)]">reputation</span>
                </span>
                <span>
                  <span className="block font-[family-name:var(--font-mono)] text-base font-semibold text-[var(--avy-ink)]">{agent.badges.length}</span>
                  <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--avy-muted)]">badges</span>
                </span>
                <span>
                  <span className="block truncate font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--avy-ink)]">{agent.specialty}</span>
                  <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--avy-muted)]">specialty</span>
                </span>
              </span>
              <span className="mt-3 flex items-start justify-between gap-3">
                <span className="line-clamp-2 text-xs leading-relaxed text-[var(--avy-muted)]">{agent.activity.msg} · {agent.activity.when}</span>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2.5 py-1 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
                    warning
                      ? "bg-[#f3d9d9] text-[#8a2a2a]"
                      : agent.state === "working" || agent.state === "claimed"
                        ? "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]"
                        : "bg-[#ebe7da] text-[#756d58]",
                  )}
                >
                  {STATE_LABEL[agent.state]}
                </span>
              </span>
            </button>
          );
        })}
        {agents.length === 0 ? (
          <p className="rounded-[14px] border border-[var(--avy-line)] bg-[var(--avy-paper)] px-4 py-8 text-center text-sm text-[var(--avy-muted)] md:col-span-2">
            No agents match these filters.
          </p>
        ) : null}
      </div>
    </section>
  );
}
