import { SectionHead } from "./SectionHead";
import type { JobLifecycleSummary } from "@/lib/api/job-lifecycle";

export interface JobLifecycleStripProps {
  summary: JobLifecycleSummary;
  meta?: string;
}

interface Slot {
  label: string;
  value: number;
  tone: "ink" | "accent" | "warn" | "muted";
}

export function JobLifecycleStrip({ summary, meta }: JobLifecycleStripProps) {
  const slots: Slot[] = [
    { label: "total", value: summary.total, tone: "ink" },
    { label: "claimable", value: summary.claimable, tone: "accent" },
    { label: "open", value: summary.open, tone: "ink" },
    { label: "stale", value: summary.stale, tone: "warn" },
    { label: "paused", value: summary.paused, tone: "muted" },
    { label: "archived", value: summary.archived, tone: "muted" },
  ];
  return (
    <section>
      <SectionHead
        title="Job lifecycle"
        meta={meta ?? "/admin/jobs/lifecycle"}
      />
      <div className="grid grid-cols-2 gap-2 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] p-[0.85rem_1.05rem] shadow-[var(--shadow-card)] sm:grid-cols-3 md:grid-cols-6">
        {slots.map((slot) => (
          <div
            key={slot.label}
            className="flex flex-col gap-0.5 font-[family-name:var(--font-mono)]"
          >
            <span
              className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
              style={{ letterSpacing: "0.14em" }}
            >
              {slot.label}
            </span>
            <span
              className="font-[family-name:var(--font-display)] text-[1.7rem] font-bold leading-none"
              style={{
                color:
                  slot.tone === "accent"
                    ? "var(--avy-accent)"
                    : slot.tone === "warn"
                      ? "var(--avy-warn)"
                      : slot.tone === "muted"
                        ? "var(--avy-muted)"
                        : "var(--avy-ink)",
              }}
            >
              {slot.value}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
