import Link from "next/link";
import { cn } from "@/lib/utils/cn";
import { SourcePill, CategoryChip } from "./pills";
import { ActorChip } from "./ActorChip";
import type { AuditEvent } from "./types";

const DAY_LABEL: Record<string, string> = {
  today: "Today",
  yesterday: "Yesterday",
};

/**
 * Vertical append-only timeline grouped by day. Each day gets a sticky
 * section header with a date chip and the count of events in that
 * bucket. Events stack under the header with a subtle gutter line
 * on the left tying them together.
 *
 * Entries are link-through only — clicking an event opens the relevant
 * surface (receipts, runs, policies, disputes) in the same tab.
 */
export function AuditTimeline({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-[10px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] p-8 text-center">
        <p
          className="m-0 font-[family-name:var(--font-mono)] text-[13px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          No events match these filters. The log is append-only, so a quiet
          window means the platform is quiet — not stalled.
        </p>
      </div>
    );
  }

  // Preserve insertion order; events are already newest-first in the fixture.
  const groups = new Map<string, AuditEvent[]>();
  for (const e of events) {
    const bucket = groups.get(e.day) ?? [];
    bucket.push(e);
    groups.set(e.day, bucket);
  }

  return (
    <div className="flex flex-col gap-5">
      {[...groups.entries()].map(([day, list]) => (
        <section key={day} className="flex flex-col gap-2.5">
          <header className="flex items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <span
                className="font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]"
                style={{ letterSpacing: "0.14em" }}
              >
                {DAY_LABEL[day] ?? day}
              </span>
              <span
                className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                style={{ letterSpacing: 0 }}
              >
                {list.length} event{list.length === 1 ? "" : "s"}
              </span>
            </div>
            <span className="h-px flex-1 bg-[var(--avy-line-soft)]" />
          </header>

          <ul className="m-0 flex flex-col gap-1.5 p-0">
            {list.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function EventCard({ event }: { event: AuditEvent }) {
  return (
    <li
      className={cn(
        "grid items-start gap-3 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] px-4 py-3 shadow-[var(--shadow-card)] backdrop-blur-[8px] transition-colors hover:border-[color:rgba(30,102,66,0.28)]",
        event.tone === "warn" &&
          "border-l-[3px] border-l-[var(--avy-warn)]",
        event.tone === "bad" &&
          "border-l-[3px] border-l-[#8c2a17]",
        event.tone === "accent" &&
          "border-l-[3px] border-l-[var(--avy-accent)]"
      )}
      style={{ gridTemplateColumns: "76px 110px 1fr 200px auto" }}
    >
      <div className="flex flex-col">
        <span
          className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]"
          style={{ letterSpacing: 0 }}
        >
          {event.at}
        </span>
      </div>

      <div className="flex flex-col items-start gap-1">
        <SourcePill source={event.source} />
        <CategoryChip category={event.category} />
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <span
          className={cn(
            "font-[family-name:var(--font-mono)] text-[12px] font-semibold",
            event.tone === "accent" && "text-[var(--avy-accent)]",
            event.tone === "warn" && "text-[var(--avy-warn)]",
            event.tone === "bad" && "text-[#8c2a17]",
            (!event.tone || event.tone === "neutral") && "text-[var(--avy-ink)]"
          )}
          style={{ letterSpacing: 0 }}
        >
          {event.action}
        </span>
        <p
          className="m-0 text-[13px] leading-snug text-[var(--avy-ink)]"
          style={{ letterSpacing: 0 }}
        >
          {event.summary}
        </p>
        <div
          className="flex flex-wrap items-center gap-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {event.target ? (
            <>
              <span>
                target ·{" "}
                <span className="text-[var(--avy-ink)]">{event.target}</span>
              </span>
              {event.hash ? <span className="opacity-40">·</span> : null}
            </>
          ) : null}
          {event.hash ? (
            <span>
              hash ·{" "}
              <span className="text-[var(--avy-accent)]">{event.hash}</span>
            </span>
          ) : null}
        </div>
      </div>

      <div>
        <ActorChip actor={event.actor} />
      </div>

      <div className="pl-2">
        {event.link ? (
          <Link
            href={event.link.href}
            className="inline-flex h-8 items-center rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase text-[var(--avy-ink)] transition-all hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.28)] hover:text-[var(--avy-accent)]"
            style={{ letterSpacing: "0.06em" }}
          >
            {event.link.label}
          </Link>
        ) : null}
      </div>
    </li>
  );
}
