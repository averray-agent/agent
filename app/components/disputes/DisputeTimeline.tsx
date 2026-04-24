import { cn } from "@/lib/utils/cn";
import type { DisputeTimelineEvent } from "./types";

export function DisputeTimeline({ events }: { events: DisputeTimelineEvent[] }) {
  return (
    <ol className="m-0 flex flex-col gap-2 p-0">
      {events.map((e, i) => (
        <li
          key={i}
          className="grid items-start gap-3 rounded-[8px] border border-[var(--avy-line-soft)] bg-[var(--avy-paper-solid)] px-3 py-2.5"
          style={{ gridTemplateColumns: "110px 10px 1fr auto" }}
        >
          <span
            className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            {e.at}
          </span>
          <span
            className={cn(
              "mt-1 h-2 w-2 rounded-full",
              e.tone === "accent" && "bg-[var(--avy-accent)]",
              e.tone === "warn" && "bg-[var(--avy-warn)]",
              e.tone === "bad" && "bg-[#8c2a17]",
              (!e.tone || e.tone === "neutral") && "bg-[var(--avy-line-strong)]"
            )}
          />
          <div>
            <div
              className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-accent)]"
              style={{ letterSpacing: 0 }}
            >
              {e.label}
            </div>
            <div
              className="mt-0.5 text-[13px] leading-snug text-[var(--avy-ink)]"
              style={{ letterSpacing: 0 }}
            >
              {e.body}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
