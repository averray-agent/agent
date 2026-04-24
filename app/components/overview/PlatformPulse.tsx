"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { SectionHead } from "./SectionHead";
import { cn } from "@/lib/utils/cn";

export type EventTone = "accent" | "warn" | "neutral" | "blue";
export type EventKind = "all" | "runs" | "stake" | "identity";

export interface PulseEvent {
  id: string;
  kind: Exclude<EventKind, "all">;
  tone: EventTone;
  topicNamespace: string;
  topicAction: string;
  address: string;
  message: ReactNode;
  time: string;
}

export interface PlatformPulseProps {
  events: PulseEvent[];
  endpoint: string;
  meta?: string;
}

const FILTERS: { id: EventKind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "runs", label: "Runs" },
  { id: "stake", label: "Stake" },
  { id: "identity", label: "Identity" },
];

export function PlatformPulse({ events, endpoint, meta }: PlatformPulseProps) {
  const [active, setActive] = useState<EventKind>("all");

  const visible = active === "all" ? events : events.filter((e) => e.kind === active);

  return (
    <section>
      <SectionHead
        title="Platform pulse"
        meta={meta ?? `last 30 min · ${events.length} events`}
      />
      <div className="overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] shadow-[var(--shadow-card)]">
        <div className="flex items-center justify-between border-b border-[var(--avy-line-soft)] p-[1rem_1.15rem]">
          <div className="flex items-center gap-2.5">
            <h3 className="m-0 font-[family-name:var(--font-display)] text-[15px] font-bold text-[var(--avy-ink)]">
              Live event feed
            </h3>
            <span
              className="inline-flex items-center gap-1.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-accent)]"
              style={{ letterSpacing: "0.12em" }}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)] [animation:pulse_2.2s_ease-in-out_infinite]" />
              Streaming
            </span>
          </div>
          <div
            className="flex gap-1 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase text-[var(--avy-muted)]"
            style={{ letterSpacing: "0.08em" }}
          >
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setActive(f.id)}
                className={cn(
                  "rounded-full px-2.5 py-1 transition-all",
                  active === f.id
                    ? "bg-[var(--avy-accent-wash)] text-[var(--avy-accent)]"
                    : "hover:bg-[color:rgba(17,19,21,0.04)] hover:text-[var(--avy-ink)]"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          {visible.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--avy-line-soft)] bg-[rgba(250,248,241,0.6)] p-[0.85rem_1.15rem] font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
          <span>
            Stream endpoint ·{" "}
            <span className="text-[var(--avy-ink)]">{endpoint}</span>
          </span>
          <a
            className="cursor-pointer font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]"
            style={{ letterSpacing: "0.08em" }}
          >
            Open full log →
          </a>
        </div>
      </div>
    </section>
  );
}

function EventRow({ event }: { event: PulseEvent }) {
  return (
    <div className="grid grid-cols-[180px_120px_1fr_auto] items-center gap-[1.1rem] border-b border-[var(--avy-line-soft)] p-[0.75rem_1.15rem] transition-colors last:border-b-0 hover:bg-white/55 max-md:grid-cols-[1fr_auto]">
      <span className="inline-flex min-w-0 items-center gap-2 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-ink)] max-md:col-span-full">
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            event.tone === "accent" && "bg-[var(--avy-accent)]",
            event.tone === "warn" && "bg-[var(--avy-warn)]",
            event.tone === "neutral" && "bg-[#a8a294]",
            event.tone === "blue" && "bg-[var(--avy-blue)]"
          )}
        />
        <span className="text-[var(--avy-muted)]">{event.topicNamespace}/</span>
        {event.topicAction}
      </span>
      <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--avy-ink)] max-md:col-span-full">
        {event.address}
      </span>
      <span className="font-[family-name:var(--font-body)] text-[13.5px] leading-[1.45] text-[var(--avy-ink)]">
        {event.message}
      </span>
      <span className="whitespace-nowrap text-right font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
        {event.time}
      </span>
    </div>
  );
}
