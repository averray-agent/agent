import type { ReactNode } from "react";
import { Sparkline } from "@/components/overview/Sparkline";
import { cn } from "@/lib/utils/cn";

export interface ReceiptsKpi {
  label: string;
  value: ReactNode;
  unit?: ReactNode;
  spark?: number[];
  sparkPulse?: boolean;
  pillRight?: ReactNode;
  meta: ReactNode;
  metaTone?: "muted" | "ok" | "warn";
}

export function ReceiptsKpiStrip({ kpis }: { kpis: ReceiptsKpi[] }) {
  return (
    <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-4">
      {kpis.map((k) => (
        <KpiCard key={k.label} kpi={k} />
      ))}
    </div>
  );
}

function KpiCard({ kpi }: { kpi: ReceiptsKpi }) {
  return (
    <article className="grid gap-1.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)] backdrop-blur-[10px]">
      <span
        className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.12em" }}
      >
        {kpi.label}
      </span>
      <div className="flex items-baseline justify-between gap-2">
        <span
          className="font-[family-name:var(--font-mono)] text-[28px] font-semibold leading-none text-[var(--avy-ink)]"
          style={{ letterSpacing: "-0.01em" }}
        >
          {kpi.value}
          {kpi.unit ? (
            <span className="ml-1 text-[18px] text-[var(--avy-muted)]">{kpi.unit}</span>
          ) : null}
        </span>
        {kpi.pillRight ? (
          kpi.pillRight
        ) : kpi.spark ? (
          <Sparkline
            points={kpi.spark}
            color="var(--avy-accent)"
            width={66}
            height={22}
            className={cn("block", kpi.sparkPulse && "[&_path:first-of-type]:animate-pulse")}
          />
        ) : null}
      </div>
      <span
        className={cn(
          "font-[family-name:var(--font-mono)] text-[11px]",
          kpi.metaTone === "ok" && "text-[var(--avy-accent)]",
          kpi.metaTone === "warn" && "text-[var(--avy-warn)]",
          (!kpi.metaTone || kpi.metaTone === "muted") && "text-[var(--avy-muted)]"
        )}
      >
        {kpi.meta}
      </span>
    </article>
  );
}
