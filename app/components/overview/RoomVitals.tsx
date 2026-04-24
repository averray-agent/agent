import type { ReactNode } from "react";
import { Sparkline } from "./Sparkline";
import { SectionHead } from "./SectionHead";
import { cn } from "@/lib/utils/cn";

export type DeltaTone = "good" | "warn" | "neutral";

export interface KpiData {
  label: string;
  value: ReactNode;
  unit?: string;
  spark: number[];
  sparkColor?: string;
  delta: ReactNode;
  deltaTone?: DeltaTone;
  valueAccent?: boolean;
}

export interface RoomVitalsProps {
  vitals: KpiData[];
  comparedTo: string;
}

export function RoomVitals({ vitals, comparedTo }: RoomVitalsProps) {
  return (
    <section>
      <SectionHead title="Room vitals" meta={`vs. ${comparedTo}`} />
      <div className="grid grid-cols-1 gap-[0.9rem] md:grid-cols-2 xl:grid-cols-4">
        {vitals.map((kpi) => (
          <KpiCard key={kpi.label} {...kpi} />
        ))}
      </div>
    </section>
  );
}

function KpiCard({
  label,
  value,
  unit,
  spark,
  sparkColor,
  delta,
  deltaTone = "good",
  valueAccent,
}: KpiData) {
  return (
    <article className="grid gap-2.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-[1.1rem] shadow-[var(--shadow-card)] backdrop-blur-[10px] transition-all hover:-translate-y-0.5 hover:border-[color:rgba(30,102,66,0.24)]">
      <span
        className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.14em" }}
      >
        {label}
      </span>
      <div className="flex items-end justify-between gap-2.5">
        <span
          className="font-[family-name:var(--font-display)] font-bold text-[2.2rem] leading-none"
          style={{
            color: valueAccent ? "var(--avy-accent)" : "var(--avy-ink)",
            letterSpacing: "-0.01em",
          }}
        >
          {value}
          {unit ? (
            <span className="ml-[3px] text-[0.9rem] font-semibold text-[var(--avy-muted)]">
              {unit}
            </span>
          ) : null}
        </span>
        <Sparkline points={spark} color={sparkColor ?? "var(--avy-accent)"} />
      </div>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11.5px]",
          deltaTone === "good" && "text-[var(--avy-accent)]",
          deltaTone === "warn" && "text-[var(--avy-warn)]",
          deltaTone === "neutral" && "text-[var(--avy-muted)]"
        )}
      >
        {delta}
      </span>
    </article>
  );
}
