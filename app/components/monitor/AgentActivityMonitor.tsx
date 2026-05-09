"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Radio,
  ShieldCheck,
} from "lucide-react";
import { SectionHead } from "@/components/overview/SectionHead";
import { SourceBadge } from "@/components/runs/StatePill";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth/use-auth";
import { useAdminJobs, useAdminSessions } from "@/lib/api/hooks";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";
import { startEventStream, type EventTopic } from "@/lib/events/stream";
import { cn } from "@/lib/utils/cn";

type RawRecord = Record<string, unknown>;

type MonitorState =
  | "claimed"
  | "submitted"
  | "disputed"
  | "settled"
  | "failed";

interface MonitorRow {
  id: string;
  jobId: string;
  title: string;
  state: MonitorState;
  stateLabel: string;
  worker: string;
  lastEvent: string;
  lastEventAt?: string;
  startedAt?: string;
  stale: boolean;
  source?: "github" | "wikipedia" | "osv" | "data_gov" | "openapi" | "standards" | "oss";
}

interface PulseEvent {
  id: string;
  topic: EventTopic;
  message: string;
  at: string;
}

const LIVE_TOPICS: EventTopic[] = [
  "session.claimed",
  "session.submitted",
  "verification.resolved",
  "escrow.job_claimed",
  "escrow.work_submitted",
  "escrow.job_rejected",
  "escrow.job_closed",
  "system.provider_error",
  "system.listener_error",
  "gap",
];

const TERMINAL_STATES = new Set([
  "approved",
  "closed",
  "failed",
  "rejected",
  "resolved",
  "settled",
  "slashed",
  "timed_out",
  "expired",
]);

export function AgentActivityMonitor() {
  const sessionsQuery = useAdminSessions();
  const jobsQuery = useAdminJobs();
  const auth = useAuth();
  const [events, setEvents] = useState<PulseEvent[]>([]);
  const [streamState, setStreamState] = useState<
    "connecting" | "streaming" | "stalled" | "auth" | "idle"
  >("idle");

  useEffect(() => {
    if (!auth.authenticated) {
      setStreamState("auth");
      return undefined;
    }
    setStreamState("connecting");
    return startEventStream({
      wallet: auth.wallet,
      topics: LIVE_TOPICS,
      onEvent: ({ topic, data, id }) => {
        setStreamState("streaming");
        setEvents((current) =>
          [
            {
              id: id ?? `${topic}-${Date.now()}`,
              topic,
              message: eventMessage(topic, data),
              at: new Date().toISOString(),
            },
            ...current,
          ].slice(0, 18)
        );
      },
      onGap: ({ lastEventId }) => {
        setEvents((current) =>
          [
            {
              id: lastEventId ? `gap-${lastEventId}` : `gap-${Date.now()}`,
              topic: "gap" as EventTopic,
              message: "Stream gap detected; refreshing indexed views.",
              at: new Date().toISOString(),
            },
            ...current,
          ].slice(0, 18)
        );
      },
      onStalled: () => setStreamState("stalled"),
      onReauthNeeded: () => setStreamState("auth"),
    });
  }, [auth.authenticated, auth.wallet]);

  const rows = useMemo(
    () => buildMonitorRows(sessionsQuery.data, jobsQuery.data),
    [jobsQuery.data, sessionsQuery.data]
  );
  const activeRows = rows.filter((row) => isInMotion(row.state));
  const staleRows = activeRows.filter((row) => row.stale);
  const recentRows = rows.filter((row) => !isInMotion(row.state)).slice(0, 6);
  const latestSignal =
    events[0]?.at ??
    activeRows[0]?.lastEventAt ??
    recentRows[0]?.lastEventAt ??
    undefined;
  const freshness = freshnessFromRequests(sessionsQuery, jobsQuery);

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-6">
      <header className="flex flex-col gap-2">
        <span
          className="font-[family-name:var(--font-display)] text-[11.5px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.12em" }}
        >
          Agent flight recorder
        </span>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="m-0 font-[family-name:var(--font-display)] text-[2.4rem] font-bold leading-none text-[var(--avy-ink)]">
              Live monitor
            </h1>
            <p className="m-0 mt-2 max-w-[68ch] font-[family-name:var(--font-body)] text-[14.5px] leading-[1.5] text-[var(--avy-muted)]">
              Watch what Hermes and other worker agents are doing right now:
              active claims, pending submissions, stale sessions, and the event
              stream tail that updates while this page is open.
            </p>
          </div>
          <span
            className="inline-flex items-center gap-2 rounded-full border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)]" />
            {freshnessLabel(freshness)}
          </span>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MonitorStat
          icon={Radio}
          label="In motion"
          value={activeRows.length}
          meta="claimed or submitted"
          tone={activeRows.length ? "accent" : "neutral"}
        />
        <MonitorStat
          icon={AlertTriangle}
          label="Needs eyes"
          value={staleRows.length}
          meta={staleRows.length ? "stale runtime" : "nothing stale"}
          tone={staleRows.length ? "warn" : "good"}
        />
        <MonitorStat
          icon={Activity}
          label="Live events"
          value={events.length}
          meta={streamLabel(streamState)}
          tone={streamState === "stalled" ? "warn" : streamState === "streaming" ? "good" : "neutral"}
        />
        <MonitorStat
          icon={Clock3}
          label="Last signal"
          value={latestSignal ? relativeAge(latestSignal) : "-"}
          meta={latestSignal ? absoluteTime(latestSignal) : "waiting"}
          tone="neutral"
        />
      </section>

      <section>
        <SectionHead title="Current work" meta={`${activeRows.length} in motion`} />
        <div className="overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] shadow-[var(--shadow-card)]">
          {activeRows.length ? (
            <div className="divide-y divide-[var(--avy-line-soft)]">
              {activeRows.map((row) => (
                <WorkRow key={row.id} row={row} />
              ))}
            </div>
          ) : (
            <EmptyPanel
              title="No agent work is currently in motion"
              body="When another agent hands Hermes a PR review, deploy verification, or workflow test, the session shows up here as soon as Averray sees a claim or submission event."
            />
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <section>
          <SectionHead title="Event stream tail" meta={streamLabel(streamState)} />
          <div className="overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] shadow-[var(--shadow-card)]">
            {events.length ? (
              <div className="divide-y divide-[var(--avy-line-soft)]">
                {events.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </div>
            ) : (
              <EmptyPanel
                title="Waiting for the next live event"
                body="The backend pushes session, escrow, verifier, and system events into this page. Keep it open during a handoff to watch the lifecycle move."
              />
            )}
          </div>
        </section>

        <section>
          <SectionHead title="Recently finished" meta={`${recentRows.length} latest`} />
          <div className="overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] shadow-[var(--shadow-card)]">
            {recentRows.length ? (
              <div className="divide-y divide-[var(--avy-line-soft)]">
                {recentRows.map((row) => (
                  <WorkRow key={row.id} row={row} compact />
                ))}
              </div>
            ) : (
              <EmptyPanel
                title="No completed agent sessions yet"
                body="Finished submissions, approvals, and failed sessions will settle here after the first completed run."
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function MonitorStat({
  icon: Icon,
  label,
  value,
  meta,
  tone,
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  meta: string;
  tone: "accent" | "good" | "warn" | "neutral";
}) {
  return (
    <article className="rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-[1.05rem] shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between">
        <span
          className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
          style={{ letterSpacing: "0.14em" }}
        >
          {label}
        </span>
        <span
          className={cn(
            "grid h-8 w-8 place-items-center rounded-[8px]",
            tone === "warn" && "bg-[var(--warn-soft)] text-[var(--warn)]",
            tone === "good" && "bg-[var(--accent-soft)] text-[var(--accent-hover)]",
            tone === "accent" && "bg-[var(--avy-accent-wash)] text-[var(--avy-accent)]",
            tone === "neutral" && "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-muted)]"
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <strong className="font-[family-name:var(--font-display)] text-[2rem] leading-none text-[var(--avy-ink)]">
          {value}
        </strong>
        <span
          className="pb-0.5 text-right font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {meta}
        </span>
      </div>
    </article>
  );
}

function WorkRow({ row, compact = false }: { row: MonitorRow; compact?: boolean }) {
  return (
    <article className={cn("grid gap-3 px-4 py-3", compact ? "grid-cols-1" : "md:grid-cols-[1fr_auto]")}>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {row.source ? <SourceBadge kind={row.source} className="shrink-0" /> : null}
          <h3 className="m-0 min-w-0 truncate font-[family-name:var(--font-body)] text-[14px] font-semibold text-[var(--avy-ink)]">
            {row.title}
          </h3>
          <StateBadge row={row} />
        </div>
        <div
          className="mt-1 flex min-w-0 flex-wrap items-center gap-2 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          <span className="truncate">{row.jobId}</span>
          <span className="opacity-40">·</span>
          <span>{row.worker}</span>
          {row.startedAt ? (
            <>
              <span className="opacity-40">·</span>
              <span>started {relativeAge(row.startedAt)} ago</span>
            </>
          ) : null}
        </div>
        <p className="m-0 mt-2 text-[13px] leading-[1.45] text-[var(--avy-muted)]">
          {row.lastEvent}
          {row.lastEventAt ? (
            <span className="font-[family-name:var(--font-mono)] text-[11.5px]">
              {" "}
              · {absoluteTime(row.lastEventAt)}
            </span>
          ) : null}
        </p>
      </div>
      {!compact ? (
        <div className="flex shrink-0 items-center gap-2 md:justify-end">
          <Link
            href={`/runs/detail/?id=${encodeURIComponent(row.jobId)}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--avy-line)] px-2.5 py-1 font-[family-name:var(--font-display)] text-[11px] font-bold text-[var(--avy-ink)] transition-colors hover:bg-[var(--avy-paper)]"
          >
            Run <ExternalLink className="h-3 w-3" />
          </Link>
          <Link
            href="/sessions"
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--avy-line)] px-2.5 py-1 font-[family-name:var(--font-display)] text-[11px] font-bold text-[var(--avy-ink)] transition-colors hover:bg-[var(--avy-paper)]"
          >
            Session <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      ) : null}
    </article>
  );
}

function StateBadge({ row }: { row: MonitorRow }) {
  if (row.stale) {
    return (
      <Badge tone="warn" className="font-[family-name:var(--font-display)] text-[10.5px] uppercase">
        stale
      </Badge>
    );
  }
  if (row.state === "settled") {
    return (
      <Badge tone="success" className="font-[family-name:var(--font-display)] text-[10.5px] uppercase">
        <CheckCircle2 className="h-3 w-3" />
        done
      </Badge>
    );
  }
  if (row.state === "failed" || row.state === "disputed") {
    return (
      <Badge tone="warn" className="font-[family-name:var(--font-display)] text-[10.5px] uppercase">
        {row.stateLabel}
      </Badge>
    );
  }
  return (
    <Badge tone="accent" className="font-[family-name:var(--font-display)] text-[10.5px] uppercase">
      <ShieldCheck className="h-3 w-3" />
      {row.stateLabel}
    </Badge>
  );
}

function EventRow({ event }: { event: PulseEvent }) {
  const [namespace, action] = event.topic.split(".");
  return (
    <div className="grid grid-cols-[minmax(130px,180px)_1fr_auto] items-center gap-3 px-4 py-3 max-md:grid-cols-1">
      <span
        className="inline-flex min-w-0 items-center gap-2 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-ink)]"
        style={{ letterSpacing: 0 }}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", eventToneClass(event.topic))} />
        <span className="truncate">
          <span className="text-[var(--avy-muted)]">{namespace}/</span>
          {action}
        </span>
      </span>
      <span className="text-[13px] text-[var(--avy-ink)]">{event.message}</span>
      <span
        className="whitespace-nowrap text-right font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)] max-md:text-left"
        style={{ letterSpacing: 0 }}
      >
        {relativeAge(event.at)} ago
      </span>
    </div>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="m-0 font-[family-name:var(--font-display)] text-[15px] font-bold text-[var(--avy-ink)]">
        {title}
      </p>
      <p className="mx-auto mt-1 max-w-[58ch] text-[13.5px] leading-[1.45] text-[var(--avy-muted)]">
        {body}
      </p>
    </div>
  );
}

function buildMonitorRows(sessionsPayload: unknown, jobsPayload: unknown): MonitorRow[] {
  const jobs = recordsFrom(jobsPayload, ["jobs", "items", "data"]);
  const sessions = recordsFrom(sessionsPayload, ["sessions", "items", "data"]);
  const seen = new Set<string>();
  const rows: MonitorRow[] = [];

  for (const session of sessions) {
    const jobId = text(session.jobId, "unknown-job");
    const job = jobs.find((candidate) => text(candidate.id) === jobId) ?? {};
    const id = text(session.sessionId, text(session.id, `${jobId}:${text(session.wallet, "unknown")}`));
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push(rowFromSession(session, job, id, jobId));
  }

  for (const job of jobs) {
    if (!isActiveClaim(job)) continue;
    const worker = text(job.claimedBy, text(job.worker, text(job.claimedByWallet, "")));
    const id = text(job.sessionId, `${text(job.id)}:${worker}`);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push(rowFromSession(
      {
        sessionId: id,
        jobId: text(job.id),
        wallet: worker,
        status: "claimed",
        claimedAt: text(job.claimedAt),
        updatedAt: text(job.claimedAt),
      },
      job,
      id,
      text(job.id)
    ));
  }

  return rows.sort((a, b) => timestamp(b.lastEventAt ?? b.startedAt) - timestamp(a.lastEventAt ?? a.startedAt));
}

function rowFromSession(session: RawRecord, job: RawRecord, id: string, jobId: string): MonitorRow {
  const rawStatus = text(session.status, "claimed").toLowerCase();
  const currentState = stateFromStatus(rawStatus);
  const startedAt = iso(session.claimedAt) ?? iso(session.createdAt);
  const lastEventAt =
    iso(session.updatedAt) ??
    iso(session.resolvedAt) ??
    iso(session.submittedAt) ??
    iso(session.claimedAt);
  const stale = isStale(currentState, startedAt, lastEventAt);

  return {
    id,
    jobId,
    title: text(job.title, text(job.description, titleFromId(jobId))),
    state: currentState,
    stateLabel: stateLabel(currentState, rawStatus),
    worker: shortAddress(session.wallet),
    startedAt,
    lastEventAt,
    lastEvent: lastEventText(session, rawStatus),
    stale,
    source: sourceFromJob(job),
  };
}

function recordsFrom(value: unknown, keys: string[]): RawRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested.filter(isRecord);
  }
  return [];
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : undefined;
}

function timestamp(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function titleFromId(id: string): string {
  return id
    .split(/[-_:]/u)
    .filter(Boolean)
    .slice(0, 4)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function stateFromStatus(status: string): MonitorState {
  if (status === "submitted") return "submitted";
  if (status === "disputed") return "disputed";
  if (["rejected", "slashed", "expired", "timed_out", "failed"].includes(status)) return "failed";
  if (TERMINAL_STATES.has(status)) return "settled";
  return "claimed";
}

function stateLabel(state: MonitorState, rawStatus: string): string {
  if (state === "settled") return "done";
  if (state === "failed") return rawStatus.replace(/_/gu, " ");
  return state;
}

function isInMotion(state: MonitorState): boolean {
  return state === "claimed" || state === "submitted" || state === "disputed";
}

function isStale(state: MonitorState, startedAt?: string, lastEventAt?: string): boolean {
  if (!isInMotion(state)) return false;
  const basis = timestamp(lastEventAt ?? startedAt);
  if (!basis) return false;
  const ageMs = Date.now() - basis;
  const limit = state === "submitted" ? 30 * 60_000 : 15 * 60_000;
  return ageMs > limit;
}

function lastEventText(session: RawRecord, status: string): string {
  const history = recordsFrom(session.statusHistory, ["items", "data"]);
  const last = history.at(-1);
  if (last) {
    const from = text(last.from);
    const to = text(last.to, status);
    const reason = text(last.reason);
    return reason ? `${from ? `${from} -> ` : ""}${to}: ${reason}` : `${from ? `${from} -> ` : ""}${to}`;
  }
  return `Session ${status || "claimed"}`;
}

function isActiveClaim(job: RawRecord): boolean {
  const state = text(job.effectiveState, text(job.claimState, text(job.state))).toLowerCase();
  if (state !== "claimed") return false;
  const worker = text(job.claimedBy, text(job.worker, text(job.claimedByWallet)));
  if (!worker) return false;
  const expiresAt = text(job.claimExpiresAt);
  return !expiresAt || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) > Date.now();
}

function sourceFromJob(job: RawRecord): MonitorRow["source"] {
  const source = isRecord(job.source) ? job.source : {};
  const sourceType = text(source.type, text(job.sourceType));
  switch (sourceType) {
    case "github_issue":
      return "github";
    case "wikipedia_article":
      return "wikipedia";
    case "osv_advisory":
      return "osv";
    case "open_data_dataset":
      return "data_gov";
    case "openapi_spec":
      return "openapi";
    case "standards_spec":
      return "standards";
    default:
      return undefined;
  }
}

function shortAddress(value: unknown): string {
  const raw = text(value, "unknown");
  return raw.length > 16 ? `${raw.slice(0, 6)}...${raw.slice(-4)}` : raw;
}

function relativeAge(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (seconds < 90) return `${Math.max(1, seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function absoluteTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function streamLabel(state: "connecting" | "streaming" | "stalled" | "auth" | "idle"): string {
  switch (state) {
    case "streaming":
      return "streaming now";
    case "connecting":
      return "connecting";
    case "stalled":
      return "stream stalled";
    case "auth":
      return "sign in required";
    default:
      return "idle";
  }
}

function freshnessLabel(state: "live" | "loading" | "fallback"): string {
  switch (state) {
    case "live":
      return "Live API";
    case "loading":
      return "Loading";
    default:
      return "Unavailable";
  }
}

function eventMessage(topic: EventTopic, data: unknown): string {
  const record = isRecord(data) ? data : {};
  const jobId = text(record.jobId, text(record.id));
  const sessionId = text(record.sessionId);
  const status = text(record.status, text(record.state));
  const parts = [jobId, sessionId, status].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return topic === "gap" ? "Stream gap detected." : "Event received.";
}

function eventToneClass(topic: EventTopic): string {
  if (topic.includes("error") || topic === "gap" || topic.includes("rejected")) return "bg-[var(--avy-warn)]";
  if (topic.includes("resolved") || topic.includes("closed")) return "bg-[var(--avy-accent)]";
  if (topic.includes("submitted")) return "bg-[#a76122]";
  return "bg-[var(--avy-blue)]";
}
