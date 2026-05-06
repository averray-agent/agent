"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils/cn";
import {
  buildJobTimeline,
  describeTimelineDetail,
  describeTimelineEntry,
  EMPTY_JOB_TIMELINE,
  type TimelineEntry,
  type TimelineSeverity,
  type TimelineSource,
} from "@/lib/api/job-timeline";
import { useJobTimeline } from "@/lib/api/hooks";
import { ApiError } from "@/lib/api/client";

/**
 * "Everything that happened to this job" panel for /runs/detail.
 *
 * The 5-stage `LifecycleRail` above this panel gives the at-a-glance
 * answer (Ready → Claimed → Submitted → Verified → Paid). This panel
 * is the full chronological log driven by `GET /admin/jobs/timeline`
 * (PR #149) so an auditor can see child runs, recurring derivatives,
 * verifier reason codes, raw event-bus rows, and severity-tagged
 * transitions in one read.
 */
export function JobTimelinePanel({ jobId }: { jobId: string }) {
  const request = useJobTimeline(jobId);
  const data = useMemo(() => buildJobTimeline(request.data), [request.data]);
  const unauthenticated =
    request.error instanceof ApiError &&
    (request.error.status === 401 || request.error.status === 403);

  return (
    <section
      aria-labelledby="job-timeline-heading"
      className="flex flex-col gap-3 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)]"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span
            className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
            style={{ letterSpacing: "0.12em" }}
          >
            Job timeline
          </span>
          <h2
            id="job-timeline-heading"
            className="m-0 font-[family-name:var(--font-display)] text-[16px] font-bold text-[var(--avy-ink)]"
          >
            Every event recorded for this job
          </h2>
        </div>
        <TimelineSummary
          data={data}
          loading={Boolean(request.isLoading)}
          unauthenticated={unauthenticated}
        />
      </header>

      <ul className="flex flex-col">
        {data.timeline.length === 0 ? (
          <EmptyRow
            unauthenticated={unauthenticated}
            loading={Boolean(request.isLoading)}
          />
        ) : (
          data.timeline.map((entry, idx) => (
            <TimelineRow
              key={entry.id}
              entry={entry}
              isLast={idx === data.timeline.length - 1}
            />
          ))
        )}
      </ul>

      {data.summary.eventBusGap ? (
        <p
          className="m-0 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-warn)]"
          style={{ letterSpacing: 0 }}
        >
          ⚠ event-bus replay reported a gap — older events may be missing.
        </p>
      ) : null}
    </section>
  );
}

function TimelineSummary({
  data,
  loading,
  unauthenticated,
}: {
  data: ReturnType<typeof buildJobTimeline>;
  loading: boolean;
  unauthenticated: boolean;
}) {
  if (unauthenticated) {
    return (
      <span
        className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        sign in to load
      </span>
    );
  }
  if (loading && data.summary.eventCount === 0) {
    return (
      <span
        className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        loading…
      </span>
    );
  }
  const { summary, lineage } = data;
  const segments: string[] = [];
  if (summary.sessionCount > 0) {
    segments.push(
      `${summary.sessionCount} session${summary.sessionCount === 1 ? "" : "s"}`
    );
  }
  if (summary.childJobCount > 0) {
    segments.push(`${summary.childJobCount} child`);
  }
  if (lineage.recurringTemplate) {
    segments.push(
      `${summary.derivativeJobCount} derivative${summary.derivativeJobCount === 1 ? "" : "s"}`
    );
  }
  if (segments.length === 0 && summary.eventCount > 0) {
    segments.push(`${summary.eventCount} event${summary.eventCount === 1 ? "" : "s"}`);
  }
  return (
    <span
      className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
      style={{ letterSpacing: 0 }}
    >
      {segments.length > 0 ? segments.join(" · ") : "/admin/jobs/timeline"}
    </span>
  );
}

function EmptyRow({
  unauthenticated,
  loading,
}: {
  unauthenticated: boolean;
  loading: boolean;
}) {
  return (
    <li className="rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] p-4 text-center">
      <p
        className="m-0 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        {unauthenticated
          ? "Sign in with your operator wallet to load the timeline. /admin/jobs/timeline is admin-gated."
          : loading
            ? "Loading timeline…"
            : "No events recorded for this job yet."}
      </p>
    </li>
  );
}

function TimelineRow({
  entry,
  isLast,
}: {
  entry: TimelineEntry;
  isLast: boolean;
}) {
  return (
    <li className="relative flex gap-3 pb-3">
      {/* Vertical gutter line tying entries together. */}
      {!isLast ? (
        <span
          aria-hidden="true"
          className="absolute left-[6.5px] top-3 bottom-0 w-px bg-[var(--avy-line)]"
        />
      ) : null}
      <SeverityDot severity={entry.severity} />
      <div className="min-w-0 flex-1 -mt-0.5 flex flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="font-[family-name:var(--font-body)] text-[13px] font-semibold text-[var(--avy-ink)]">
            {describeTimelineEntry(entry)}
          </span>
          <span
            className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)] whitespace-nowrap"
            style={{ letterSpacing: 0 }}
            title={entry.at}
          >
            {formatTimestamp(entry.at)}
          </span>
        </div>
        <div
          className="flex flex-wrap items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          <SourceChip source={entry.source} />
          {entry.topic ? <span>{entry.topic}</span> : null}
          {describeTimelineDetail(entry) ? (
            <>
              <span className="opacity-40">·</span>
              <span className="text-[var(--avy-ink)]/80">
                {describeTimelineDetail(entry)}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function SeverityDot({ severity }: { severity: TimelineSeverity }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-1 h-3 w-3 shrink-0 rounded-full ring-2",
        severity === "error" &&
          "bg-[var(--avy-warn)] ring-[var(--avy-warn-soft,rgba(167,97,34,0.18))]",
        severity === "warn" &&
          "bg-[var(--avy-warn)] ring-[var(--avy-warn-soft,rgba(167,97,34,0.18))] opacity-75",
        severity === "info" &&
          "bg-[var(--avy-accent)] ring-[color:rgba(30,102,66,0.18)]"
      )}
    />
  );
}

function SourceChip({ source }: { source: TimelineSource }) {
  // Source chip carries the entry's origin (state machine, verifier,
  // event bus, …). Keeps the row scannable without re-printing the
  // full topic string.
  return (
    <span
      className={cn(
        "rounded-[4px] px-1.5 py-px font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase",
        source === "event_bus" && "bg-[#1f2a3a] text-white",
        source === "verification" && "bg-[var(--avy-accent-wash)] text-[var(--avy-accent)]",
        source === "state" && "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-ink)]",
        source === "lineage" && "bg-[#2a1f3a] text-white",
        source === "schedule" && "bg-[#3a2a1f] text-white",
        // Unknown source kinds — neutral fill so the row still
        // renders and the operator can read the topic.
        ![
          "event_bus",
          "verification",
          "state",
          "lineage",
          "schedule",
        ].includes(source as string) && "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-ink)]"
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      {String(source).replace(/_/g, " ")}
    </span>
  );
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(t);
}

// Re-export the empty constant for callers that want to render a
// stable shape during SSR / first paint.
export { EMPTY_JOB_TIMELINE };
