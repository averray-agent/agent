import { cn } from "@/lib/utils/cn";
import { Sparkline } from "@/components/overview/Sparkline";
import { TierChip } from "./TierChip";
import { tierFor, type AgentRecord } from "./types";

export interface AgentsAggregateStripProps {
  agents: AgentRecord[];
}

export function AgentsAggregateStrip({ agents }: AgentsAggregateStripProps) {
  const active = agents.filter((a) => a.state === "active").length;
  const claimed24h = 23;
  const claim24Spark = [1, 2, 0, 3, 2, 4, 3, 2, 5, 1, 0, 0];
  const avgRep = Math.round(
    agents.reduce((s, a) => s + a.score, 0) / agents.length
  );
  const slashed30 = agents.filter((a) => a.state === "slashed").length;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <AggCard
        label="Active agents"
        value={`${active}`}
        unit={`/ ${agents.length}`}
        meta={active < 3 ? "below healthy floor" : "healthy roster"}
        metaTone={active < 3 ? "warn" : "ok"}
      />
      <AggCard
        label="Claimed 24h"
        value={`${claimed24h}`}
        unit="runs"
        meta="+4 vs prior 24h"
        metaTone="ok"
        rightSlot={<Sparkline points={claim24Spark} width={72} height={20} />}
      />
      <AggCard
        label="Avg reputation"
        value={`${avgRep}`}
        mono
        meta="across 8 agents · 14d trend up"
        metaTone="ok"
        rightSlot={<TierChip tier={tierFor(avgRep)} />}
      />
      <AggCard
        label="Slashed 30d"
        value={`${slashed30}`}
        valueAccent={slashed30 > 0 ? "bad" : undefined}
        meta={slashed30 > 0 ? `${slashed30} event · 45 DOT total` : "clean record"}
        metaTone={slashed30 > 0 ? "bad" : "ok"}
      />
    </div>
  );
}

interface AggCardProps {
  label: string;
  value: string;
  unit?: string;
  mono?: boolean;
  meta: string;
  metaTone?: "muted" | "ok" | "warn" | "bad";
  rightSlot?: React.ReactNode;
  valueAccent?: "bad";
}

function AggCard({
  label,
  value,
  unit,
  mono,
  meta,
  metaTone = "muted",
  rightSlot,
  valueAccent,
}: AggCardProps) {
  return (
    <article className="flex min-h-[96px] flex-col gap-1.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)] backdrop-blur-[8px]">
      <div className="flex items-baseline justify-between">
        <span
          className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
          style={{ letterSpacing: "0.12em" }}
        >
          {label}
        </span>
        {rightSlot}
      </div>
      <span
        className={cn(
          "font-[family-name:var(--font-display)] font-bold text-[2rem] leading-none tabular-nums flex items-baseline gap-1.5",
          mono && "!font-[family-name:var(--font-mono)]",
          valueAccent === "bad" && "text-[#8a2a2a]",
          !valueAccent && "text-[var(--avy-ink)]"
        )}
      >
        {value}
        {unit ? (
          <span className="text-[13px] font-semibold text-[var(--avy-muted)]">{unit}</span>
        ) : null}
      </span>
      <span
        className={cn(
          "flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11.5px]",
          metaTone === "ok" && "text-[var(--avy-accent)]",
          metaTone === "warn" && "text-[var(--avy-warn)]",
          metaTone === "bad" && "text-[#8a2a2a]",
          (!metaTone || metaTone === "muted") && "text-[var(--avy-muted)]"
        )}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-70" />
        {meta}
      </span>
    </article>
  );
}
