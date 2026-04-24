import { cn } from "@/lib/utils/cn";
import { Sparkline } from "@/components/overview/Sparkline";
import type { AuditEvent } from "./types";

export function AuditAggregateStrip({ events }: { events: AuditEvent[] }) {
  const today = events.filter((e) => e.day === "today").length;
  const operator = events.filter((e) => e.source === "operator").length;
  const system = events.filter((e) => e.source === "system").length;
  const contract = events.filter((e) => e.source === "contract").length;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Card
        label="Events today"
        value={`${today}`}
        meta="signed & exportable"
        right={<Sparkline points={[3, 5, 4, 8, 6, 10, 9, 14]} width={72} height={20} />}
      />
      <Card
        label="Operator actions"
        value={`${operator}`}
        meta="signed by a wallet"
        tone="sage"
      />
      <Card
        label="System events"
        value={`${system}`}
        meta="platform lifecycle"
        tone="muted"
      />
      <Card
        label="Contract events"
        value={`${contract}`}
        meta="on-chain receipts"
        tone="blue"
      />
    </div>
  );
}

interface CardProps {
  label: string;
  value: string;
  meta: string;
  tone?: "sage" | "blue" | "muted";
  right?: React.ReactNode;
}

function Card({ label, value, meta, tone = "muted", right }: CardProps) {
  return (
    <article className="flex min-h-[96px] flex-col gap-1.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)] backdrop-blur-[8px]">
      <div className="flex items-baseline justify-between">
        <span
          className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.12em" }}
        >
          {label}
        </span>
        {right}
      </div>
      <span
        className="font-[family-name:var(--font-display)] text-[2rem] font-bold leading-none tabular-nums text-[var(--avy-ink)]"
        style={{ letterSpacing: "-0.01em" }}
      >
        {value}
      </span>
      <span
        className={cn(
          "flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11.5px]",
          tone === "sage" && "text-[var(--avy-accent)]",
          tone === "blue" && "text-[var(--avy-blue)]",
          tone === "muted" && "text-[var(--avy-muted)]"
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
        {meta}
      </span>
    </article>
  );
}
