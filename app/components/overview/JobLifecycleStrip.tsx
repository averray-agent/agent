import { SectionHead } from "./SectionHead";
import type { JobLifecycleSummary } from "@/lib/api/job-lifecycle";

export interface JobLifecycleStripProps {
  summary: JobLifecycleSummary;
  meta?: string;
}

interface Slot {
  label: string;
  /** `null` renders as "—": the source did not report this bucket. */
  value: number | null;
  tone: "ink" | "accent" | "warn" | "muted";
  /** Renders under the number, so a bucket can state its own relationship. */
  hint?: string;
}

/** `reward_funding_pending` → `reward funding pending`. */
function humaniseReason(reason?: string): string | undefined {
  return reason ? reason.replace(/_/g, " ") : undefined;
}

function countHint(value: number | null, whenKnown?: string): string | undefined {
  return value === null ? "not reported" : whenKnown;
}

export function JobLifecycleStrip({ summary, meta }: JobLifecycleStripProps) {
  // Ordered so the arithmetic is readable left to right: the catalog total,
  // then how much of it is open, then how that open work splits into
  // claimable vs blocked, then the buckets that are not open at all.
  //
  // Previously this read total / claimable / open / stale / paused / archived,
  // which invited two wrong conclusions: that claimable and open were
  // siblings summing to total (claimable is a subset of open), and that
  // nothing was stuck (exhausted jobs appeared in no bucket, and blocked work
  // was not counted at all).
  const slots: Slot[] = [
    { label: "total", value: summary.total, tone: "ink" },
    { label: "open", value: summary.open, tone: "ink" },
    { label: "claimable", value: summary.claimable, tone: "accent", hint: "of open" },
    {
      label: "blocked",
      value: summary.blocked,
      tone: summary.blocked ? "warn" : "muted",
      hint: countHint(
        summary.blocked,
        summary.blocked ? humaniseReason(summary.blockedReason) ?? "not claimable" : "of open"
      ),
    },
    {
      label: "exhausted",
      value: summary.exhausted,
      tone: summary.exhausted ? "warn" : "muted",
      hint: countHint(summary.exhausted, "reserve spent"),
    },
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
      <div className="grid grid-cols-2 gap-2 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] p-[0.85rem_1.05rem] shadow-[var(--shadow-card)] sm:grid-cols-4 lg:grid-cols-8">
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
              {slot.value === null ? "—" : slot.value}
            </span>
            {slot.hint && (
              <span className="text-[10px] leading-tight text-[var(--avy-muted)]">
                {slot.hint}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
