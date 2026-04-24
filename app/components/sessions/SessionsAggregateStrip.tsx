import { cn } from "@/lib/utils/cn";
import { Sparkline } from "@/components/overview/Sparkline";
import type { SessionDetail } from "./types";

export function SessionsAggregateStrip({ sessions }: { sessions: SessionDetail[] }) {
  const funded24h = sessions.length;
  const settled24h = sessions.filter((s) => s.state === "settled").length;
  const anomalies = sessions.filter(
    (s) => s.state === "disputed" || s.state === "slashed" || s.state === "rejected"
  ).length;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Card
        label="24h funded"
        value={`${funded24h}`}
        unit="sessions"
        meta="~ 166 DOT routed · +4 vs prior 24h"
        tone="ok"
      />
      <Card
        label="24h settled"
        value={`${settled24h}`}
        unit="sessions"
        meta="~ 18 DOT paid out · median 3m12s"
        tone="ok"
        right={<Sparkline points={[1, 2, 2, 3, 2, 4, 3, 5]} width={72} height={20} />}
      />
      <Card
        label="Avg settle time"
        value="3m"
        unit="12s"
        meta="p50 2m40s · p95 8m02s"
        tone="muted"
        right={<Sparkline points={[4, 5, 3, 4, 3, 3, 4, 3]} width={72} height={20} />}
      />
      <Card
        label="Open anomalies"
        value={`${anomalies}`}
        meta={anomalies > 0 ? "triage in /disputes" : "clean"}
        tone={anomalies > 0 ? "warn" : "ok"}
      />
    </div>
  );
}

interface CardProps {
  label: string;
  value: string;
  unit?: string;
  meta: string;
  tone?: "ok" | "warn" | "muted";
  right?: React.ReactNode;
}

function Card({ label, value, unit, meta, tone = "muted", right }: CardProps) {
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
        className="flex items-baseline gap-1.5 font-[family-name:var(--font-display)] text-[2rem] font-bold leading-none tabular-nums text-[var(--avy-ink)]"
        style={{ letterSpacing: "-0.01em" }}
      >
        {value}
        {unit ? <span className="text-[13px] text-[var(--avy-muted)]">{unit}</span> : null}
      </span>
      <span
        className={cn(
          "flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11.5px]",
          tone === "ok" && "text-[var(--avy-accent)]",
          tone === "warn" && "text-[var(--avy-warn)]",
          tone === "muted" && "text-[var(--avy-muted)]"
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
        {meta}
      </span>
    </article>
  );
}
