import { cn } from "@/lib/utils/cn";
import type { Dispute } from "./types";

export function DisputesAggregateStrip({ disputes }: { disputes: Dispute[] }) {
  const openCount = disputes.filter((d) => d.state !== "resolved").length;
  const frozen = disputes
    .filter((d) => d.state !== "resolved")
    .reduce((acc, d) => acc + d.stakeFrozen, 0);

  const oldestMinutes = Math.max(
    ...disputes
      .filter((d) => d.state !== "resolved")
      .map((d) => Math.floor(d.windowElapsed / 60)),
    0
  );

  // Simple upheld-rate calculation from resolved disputes.
  const resolved = disputes.filter((d) => d.state === "resolved");
  const upheld = resolved.filter((d) => d.resolution?.decision === "uphold").length;
  const upheldPct = resolved.length === 0 ? 0 : Math.round((upheld / resolved.length) * 100);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Card
        label="Open disputes"
        value={openCount}
        meta={
          openCount === 0
            ? "queue clear"
            : openCount > 5
              ? "backlog — triage now"
              : "within SLA"
        }
        tone={openCount === 0 ? "ok" : openCount > 5 ? "bad" : "warn"}
      />
      <Card
        label="Stake frozen"
        value={`${frozen}`}
        unit="DOT"
        meta={`across ${openCount} open · refundable on reject`}
        tone="muted"
      />
      <Card
        label="Oldest open"
        value={oldestMinutes === 0 ? "—" : `${oldestMinutes}m`}
        meta={
          oldestMinutes === 0
            ? "queue clear"
            : oldestMinutes > 30
              ? "past auto-escalate window"
              : "inside review window"
        }
        tone={oldestMinutes === 0 ? "ok" : oldestMinutes > 30 ? "warn" : "muted"}
      />
      <Card
        label="Upheld rate 30d"
        value={`${upheldPct}`}
        unit="%"
        meta={`${upheld} of ${resolved.length} resolved · mostly policy-violation`}
        tone="ok"
      />
    </div>
  );
}

interface CardProps {
  label: string;
  value: React.ReactNode;
  unit?: string;
  meta: string;
  tone?: "ok" | "warn" | "bad" | "muted";
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
        className={cn(
          "flex items-baseline gap-1.5 font-[family-name:var(--font-display)] text-[2rem] font-bold leading-none tabular-nums",
          tone === "bad" && "text-[#8c2a17]",
          tone === "warn" && "text-[var(--avy-warn)]",
          tone === "ok" && "text-[var(--avy-ink)]",
          tone === "muted" && "text-[var(--avy-ink)]"
        )}
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
          tone === "bad" && "text-[#8c2a17]",
          tone === "muted" && "text-[var(--avy-muted)]"
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
        {meta}
      </span>
    </article>
  );
}
