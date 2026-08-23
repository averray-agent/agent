import Link from "next/link";
import type { FreshnessState } from "@/components/shell/DataFreshnessPill";
import { DataFreshnessPill } from "@/components/shell/DataFreshnessPill";
import { RoomVitals, type KpiData } from "@/components/overview/RoomVitals";
import type { LaneCardData } from "@/components/overview/LaneStatusGrid";
import { cn } from "@/lib/utils/cn";
import { deriveOperatorRoomVerdict } from "@/lib/ui/operator-room-verdict.js";

export function MobileOverview({
  vitals,
  lanes,
  freshness,
  visibleAlertCount,
  alertFeedPresence,
}: {
  vitals: KpiData[];
  lanes: LaneCardData[];
  freshness: FreshnessState;
  visibleAlertCount: number;
  alertFeedPresence: "live" | "loading" | "locked" | "down";
}) {
  const verdict = deriveOperatorRoomVerdict({ alertFeedPresence, visibleAlertCount });

  return (
    <div className="flex flex-col gap-5 min-[1080px]:hidden" data-mobile-layout="overview">
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--accent)]">
            Room
          </p>
          <h1 className="mt-1 text-[1.75rem] font-bold text-[var(--ink)]">Overview</h1>
        </div>
        <DataFreshnessPill state={freshness} />
      </header>

      <section
        className={cn(
          "rounded-[16px] border p-5 shadow-[var(--shadow-card)]",
          verdict.tone === "clear" && "border-[color:rgba(30,102,66,0.24)] bg-[var(--accent-soft)]",
          verdict.tone === "attention" && "border-[color:rgba(167,97,34,0.28)] bg-[var(--warn-soft)]",
          verdict.tone === "unknown" && "border-[var(--line)] bg-[var(--paper-solid)]",
        )}
        aria-label="Operator verdict"
      >
        <p className="font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase tracking-[0.12em] text-[var(--muted)]">
          Current verdict
        </p>
        <h2 className="mt-2 text-xl font-bold text-[var(--ink)]">{verdict.eyebrow}</h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{verdict.detail}</p>
      </section>

      <RoomVitals vitals={vitals} comparedTo="live API" layout="mobile" />

      <section aria-labelledby="mobile-capabilities-title">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 id="mobile-capabilities-title" className="text-sm font-bold text-[var(--ink)]">
            Capabilities
          </h2>
          <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--muted)]">
            live lane state
          </span>
        </div>
        <div className="overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--paper-solid)]">
          {lanes.map((lane) => (
            <Link
              key={lane.name}
              href={lane.href}
              className="flex min-h-14 items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3 last:border-b-0"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-[var(--ink)]">{lane.name}</span>
                <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">{lane.recentEvent}</span>
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2.5 py-1 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
                  lane.pillTone === "ok" && "bg-[var(--accent-soft)] text-[var(--accent)]",
                  lane.pillTone === "warn" && "bg-[var(--warn-soft)] text-[var(--warn)]",
                  lane.pillTone === "neutral" && "bg-[#ebe7da] text-[#756d58]",
                )}
              >
                {lane.pillLabel}
              </span>
            </Link>
          ))}
          {lanes.length === 0 ? (
            <p className="px-4 py-5 text-sm text-[var(--muted)]">Capability state is not available yet.</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
