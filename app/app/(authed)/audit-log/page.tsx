"use client";

import { useMemo, useState } from "react";
import { AuditTopbar } from "@/components/audit/AuditTopbar";
import { AuditAggregateStrip } from "@/components/audit/AuditAggregateStrip";
import {
  AuditFilterRail,
  type AuditFilter,
} from "@/components/audit/AuditFilterRail";
import { AuditTimeline } from "@/components/audit/AuditTimeline";
import type { AuditActor, AuditCategory, AuditEvent, AuditSource } from "@/components/audit/types";
import { useAudit } from "@/lib/api/hooks";
import { ApiError } from "@/lib/api/client";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";

const DAY_BUCKETS: Record<AuditFilter["day"], (d: string, now?: Date) => boolean> = {
  all: () => true,
  today: (d) => d === "today",
  yesterday: (d) => d === "yesterday",
  "7d": (d, now = new Date()) => isWithinLastDays(d, now, 7),
};

export default function AuditLogPage() {
  const auditRequest = useAudit();
  const [filter, setFilter] = useState<AuditFilter>({
    source: "all",
    category: "all",
    day: "all",
    q: "",
  });
  const liveEvents = useMemo(() => extractAuditEvents(auditRequest.data), [auditRequest.data]);
  const events = liveEvents;

  const filtered = useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    const dayMatch = DAY_BUCKETS[filter.day];
    return events.filter((e) => {
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
  }, [events, filter]);

  const freshness = freshnessFromRequests(auditRequest);
  // The /audit endpoint requires SIWE auth. When the viewer is signed
  // out the request 401s and we render zero events — but the generic
  // "no events match" copy reads as if the platform itself is quiet.
  // Distinguish the two so the empty state can prompt sign-in.
  const unauthenticated =
    auditRequest.error instanceof ApiError &&
    (auditRequest.error.status === 401 || auditRequest.error.status === 403);
  const filtersApplied =
    filter.source !== "all" ||
    filter.category !== "all" ||
    filter.day !== "all" ||
    filter.q.trim().length > 0;

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <AuditTopbar freshness={freshness} />

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

      <AuditAggregateStrip events={events} />
      <AuditFilterRail filter={filter} onChange={setFilter} />
      <AuditTimeline
        events={filtered}
        unauthenticated={unauthenticated}
        filtersApplied={filtersApplied}
      />

      <p
        className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        Showing <b className="font-semibold text-[var(--avy-ink)]">{filtered.length}</b> of{" "}
        <b className="font-semibold text-[var(--avy-ink)]">{events.length}</b> events.
        The full history lives at <span className="text-[var(--avy-accent)]">/audit/export</span>{" "}
        — signed manifest includes hashes, actor wallets, and block references for
        every row.
      </p>
    </div>
  );
}

function extractAuditEvents(data: unknown): AuditEvent[] {
  if (!Array.isArray(data)) return [];
  return data.reduce<AuditEvent[]>((events, item) => {
    if (!item || typeof item !== "object") return events;
    const record = item as Record<string, unknown>;
    const id = text(record.id, "");
    const action = text(record.action, "");
    if (!id || !action) return events;
    const event: AuditEvent = {
      id,
      at: text(record.at, "00:00:00"),
      day: text(record.day, "today"),
      source: source(record.source),
      category: category(record.category),
      action,
      actor: actor(record.actor),
      summary: text(record.summary, action),
    };
    const target = text(record.target, "");
    const hash = text(record.hash, "");
    const tone = auditTone(record.tone);
    const link = linkTarget(record.link);
    if (target) event.target = target;
    if (hash) event.hash = hash;
    if (tone) event.tone = tone;
    if (link) event.link = link;
    events.push(event);
    return events;
  }, []);
}

function source(value: unknown): AuditSource {
  if (value === "operator" || value === "system" || value === "contract") return value;
  if (value === "on-chain") return "contract";
  return "system";
}

/**
 * Normalise the category emitted by the audit event stream into the
 * fixed `AuditCategory` set the timeline filter rail knows how to
 * render. The backend uses a finer-grained taxonomy than the UI
 * (e.g. `session`, `escrow`, `reputation`, `admin`) so we collapse
 * those into the closest UI bucket here:
 *
 *   - `session`                            → `runs`     (sessions are run lifecycle events)
 *   - `escrow` / `reputation` / `admin`    → `treasury` (capital + control-plane)
 *
 * If you add a new audit category in the backend, add a passthrough
 * here OR map it to one of the existing UI buckets — DO NOT silently
 * drop it; the catch-all returns `"runs"` so unknown events still
 * surface somewhere instead of disappearing.
 */
function category(value: unknown): AuditCategory {
  if (
    value === "policy" ||
    value === "runs" ||
    value === "treasury" ||
    value === "xcm" ||
    value === "badge" ||
    value === "dispute" ||
    value === "auth" ||
    value === "verifier"
  ) {
    return value;
  }
  if (value === "session") return "runs";
  if (value === "escrow" || value === "reputation" || value === "admin") return "treasury";
  return "runs";
}

function actor(value: unknown): AuditActor {
  if (!value || typeof value !== "object") {
    return { handle: "system", address: "averray.platform", initials: "--", tone: "muted" };
  }
  const record = value as Record<string, unknown>;
  const handle = text(record.handle, "system");
  return {
    handle,
    address: text(record.address, "averray.platform"),
    initials: text(record.initials, handle.slice(0, 2).toUpperCase()),
    tone: actorTone(record.tone),
  };
}

function actorTone(value: unknown): AuditActor["tone"] {
  if (value === "sage" || value === "ink" || value === "clay" || value === "blue" || value === "muted") {
    return value;
  }
  return "muted";
}

function auditTone(value: unknown): AuditEvent["tone"] | undefined {
  if (value === "neutral" || value === "accent" || value === "warn" || value === "bad") {
    return value;
  }
  return undefined;
}

function linkTarget(value: unknown): AuditEvent["link"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const label = text(record.label, "");
  const href = text(record.href, "");
  return label && href ? { label, href } : undefined;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function isWithinLastDays(day: string, now: Date, days: number): boolean {
  if (day === "today" || day === "yesterday") return true;
  const parsed = Date.parse(day);
  if (!Number.isFinite(parsed)) return false;
  const start = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - (days - 1)
  );
  const eventDay = Date.UTC(
    new Date(parsed).getUTCFullYear(),
    new Date(parsed).getUTCMonth(),
    new Date(parsed).getUTCDate()
  );
  return eventDay >= start && eventDay <= now.getTime();
}
