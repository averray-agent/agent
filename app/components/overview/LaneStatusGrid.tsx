import Link from "next/link";
import type { ReactNode } from "react";
import { SectionHead } from "./SectionHead";
import { cn } from "@/lib/utils/cn";

export type LaneTone = "ok" | "warn" | "neutral";

export interface LaneMetric {
  label: string;
  value: string;
}

export interface LaneCardData {
  name: string;
  href: string;
  pillLabel: string;
  pillTone: LaneTone;
  metrics: LaneMetric[];
  recentEvent: ReactNode;
}

export interface LaneStatusGridProps {
  lanes: LaneCardData[];
  meta?: string;
}

export function LaneStatusGrid({ lanes, meta }: LaneStatusGridProps) {
  return (
    <section>
      <SectionHead title="Lanes" meta={meta ?? "rolling 15 min window"} />
      <div className="grid grid-cols-1 gap-[0.9rem] md:grid-cols-3">
        {lanes.map((lane) => (
          <LaneCard key={lane.name} lane={lane} />
        ))}
      </div>
    </section>
  );
}

function LaneCard({ lane }: { lane: LaneCardData }) {
  return (
    <Link
      href={lane.href}
      className="group grid cursor-pointer gap-2.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-[1.05rem_1.15rem] shadow-[var(--shadow-card)] backdrop-blur-[10px] transition-all hover:-translate-y-0.5 hover:border-[color:rgba(30,102,66,0.24)]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="whitespace-nowrap font-[family-name:var(--font-display)] text-[15px] font-bold text-[var(--avy-ink)]">
          {lane.name}
        </span>
        <LanePill tone={lane.pillTone} label={lane.pillLabel} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--avy-ink)]">
        {lane.metrics.map((metric, i) => (
          <span key={metric.label} className="flex items-center gap-3.5">
            <span>
              <span className="text-[var(--avy-muted)]">{metric.label}</span>{" "}
              {metric.value}
            </span>
            {i < lane.metrics.length - 1 ? (
              <span className="text-[var(--avy-line)]">|</span>
            ) : null}
          </span>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2.5 border-t border-[var(--avy-line-soft)] pt-2 font-[family-name:var(--font-body)] text-[12.5px] text-[var(--avy-muted)]">
        <span>{lane.recentEvent}</span>
        <span
          className="inline-flex items-center gap-1 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.08em" }}
        >
          Open lane{" "}
          <span className="transition-transform group-hover:translate-x-[3px]">
            →
          </span>
        </span>
      </div>
    </Link>
  );
}

function LanePill({ tone, label }: { tone: LaneTone; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
        tone === "ok" && "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
        tone === "warn" && "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]",
        tone === "neutral" && "bg-[#ebe7da] text-[#756d58]"
      )}
      style={{ letterSpacing: "0.1em" }}
    >
      <span className="h-[5px] w-[5px] rounded-full bg-current" />
      {label}
    </span>
  );
}
