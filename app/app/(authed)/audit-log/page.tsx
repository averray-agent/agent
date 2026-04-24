"use client";

import { useMemo, useState } from "react";
import { AuditTopbar } from "@/components/audit/AuditTopbar";
import { AuditAggregateStrip } from "@/components/audit/AuditAggregateStrip";
import {
  AuditFilterRail,
  type AuditFilter,
} from "@/components/audit/AuditFilterRail";
import { AuditTimeline } from "@/components/audit/AuditTimeline";
import { AUDIT_EVENTS } from "@/components/audit/data";

// TODO(data): wire to useApi("/audit") once backend emits an event
// stream. The SSE channel in lib/events/stream.ts already carries most
// of these topic names — the audit log is just the persisted version.

const DAY_BUCKETS: Record<AuditFilter["day"], (d: string) => boolean> = {
  all: () => true,
  today: (d) => d === "today",
  yesterday: (d) => d === "yesterday",
  "7d": (d) => d === "today" || d === "yesterday" || d.startsWith("2026-04"),
};

export default function AuditLogPage() {
  const [filter, setFilter] = useState<AuditFilter>({
    source: "all",
    category: "all",
    day: "all",
    q: "",
  });

  const filtered = useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    const dayMatch = DAY_BUCKETS[filter.day];
    return AUDIT_EVENTS.filter((e) => {
      if (filter.source !== "all" && e.source !== filter.source) return false;
      if (filter.category !== "all" && e.category !== filter.category) return false;
      if (!dayMatch(e.day)) return false;
      if (q) {
        const hay = [
          e.action,
          e.actor.handle,
          e.actor.address,
          e.target ?? "",
          e.hash ?? "",
          e.category,
          e.source,
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [filter]);

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <AuditTopbar />

      <header className="flex flex-col gap-1.5">
        <span
          className="font-[family-name:var(--font-display)] text-[11.5px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.12em" }}
        >
          Operator memory
        </span>
        <h1 className="m-0 font-[family-name:var(--font-display)] text-[2.4rem] font-bold leading-none text-[var(--avy-ink)]">
          Audit log
        </h1>
        <p className="m-0 mt-0.5 max-w-[62ch] font-[family-name:var(--font-body)] text-[16px] leading-[1.55] text-[var(--avy-muted)]">
          Append-only. Every operator action, platform event, and contract
          event, signed at write-time and exportable as a notarized manifest.
          Nothing on this page can be edited or deleted.
        </p>
      </header>

      <AuditAggregateStrip events={AUDIT_EVENTS} />
      <AuditFilterRail filter={filter} onChange={setFilter} />
      <AuditTimeline events={filtered} />

      <p
        className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        Showing <b className="font-semibold text-[var(--avy-ink)]">{filtered.length}</b> of{" "}
        <b className="font-semibold text-[var(--avy-ink)]">{AUDIT_EVENTS.length}</b> events.
        The full history lives at <span className="text-[var(--avy-accent)]">/audit/export</span>{" "}
        — signed manifest includes hashes, actor wallets, and block references for
        every row.
      </p>
    </div>
  );
}
