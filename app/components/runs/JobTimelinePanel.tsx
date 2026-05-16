"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import { useJobTimeline, type JobTimelineFilters } from "@/lib/api/hooks";
import { ApiError } from "@/lib/api/client";
import {
  applyTimelineEventFiltersToParams,
  EMPTY_TIMELINE_EVENT_FILTERS,
  isTimelineEventFilterActive,
  parseTimelineEventFilters,
  TimelineEventFilters,
  type TimelineEventFilterValue,
} from "./TimelineEventFilters";

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
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const filters = useMemo(
    () => parseTimelineEventFilters(searchParams ?? null),
    [searchParams]
  );
  const filtersActive = isTimelineEventFilterActive(filters);
  const apiFilters = useMemo<JobTimelineFilters>(
    () => ({
      sources: filters.source ? [filters.source] : undefined,
      topics: filters.topic ? [filters.topic] : undefined,
      phases: filters.phase ? [filters.phase] : undefined,
      severities: filters.severity ? [filters.severity] : undefined,
      wallet: filters.wallet || undefined,
      correlationId: filters.correlationId || undefined,
    }),
    [filters]
  );
  const request = useJobTimeline(jobId, apiFilters);
  const data = useMemo(() => buildJobTimeline(request.data), [request.data]);
  const visibleTimeline = useMemo(
    () => filterTimelineEntries(data.timeline, filters),
    [data.timeline, filters]
  );
  const hiddenCount = data.timeline.length - visibleTimeline.length;
  const unauthenticated =
    request.error instanceof ApiError &&
    (request.error.status === 401 || request.error.status === 403);

  // URL is the source of truth for filter state so a refresh / shared
  // link reproduces the filtered view. `replace` rather than `push` so
  // toggling filters doesn't pollute the back stack.
  const handleFilterChange = useCallback(
    (next: TimelineEventFilterValue) => {
      if (!pathname) return;
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      applyTimelineEventFiltersToParams(params, next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

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
          visibleCount={visibleTimeline.length}
          filtersActive={filtersActive}
          loading={Boolean(request.isLoading)}
          unauthenticated={unauthenticated}
        />
      </header>

      <TimelineEventFilters
        value={filters}
        onChange={handleFilterChange}
        idPrefix="job-timeline-filter"
      />

      <ul className="flex flex-col">
        {visibleTimeline.length === 0 ? (
          <EmptyRow
            unauthenticated={unauthenticated}
            loading={Boolean(request.isLoading)}
            filtersActive={filtersActive}
            onClearFilters={() =>
              handleFilterChange(EMPTY_TIMELINE_EVENT_FILTERS)
            }
          />
        ) : (
          visibleTimeline.map((entry, idx) => (
            <TimelineRow
              key={entry.id}
              entry={entry}
              isLast={idx === visibleTimeline.length - 1}
            />
          ))
        )}
      </ul>

      {filtersActive && hiddenCount > 0 ? (
        <p
          className="m-0 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {hiddenCount} hidden by filter — clear filters to see the full timeline.
        </p>
      ) : null}

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
  visibleCount,
  filtersActive,
  loading,
  unauthenticated,
}: {
  data: ReturnType<typeof buildJobTimeline>;
  visibleCount: number;
  filtersActive: boolean;
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
  if (filtersActive) {
    segments.push(`${visibleCount} shown`);
  }
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
  filtersActive,
  onClearFilters,
}: {
  unauthenticated: boolean;
  loading: boolean;
  filtersActive: boolean;
  onClearFilters: () => void;
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
            : filtersActive
              ? "No events match these filters."
              : "No events recorded for this job yet."}
      </p>
      {!unauthenticated && !loading && filtersActive ? (
        <button
          type="button"
          onClick={onClearFilters}
          className="mt-2 rounded-[6px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2.5 py-1 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-ink)] transition-colors hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.08em" }}
        >
          Clear filters
        </button>
      ) : null}
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
        source === "chain" && "bg-[#173247] text-white",
        source === "settlement" && "bg-[#17473b] text-white",
        source === "ingestion" && "bg-[#46381a] text-white",
        source === "system" && "bg-[#5b2a2a] text-white",
        // Unknown source kinds — neutral fill so the row still
        // renders and the operator can read the topic.
        ![
          "event_bus",
          "verification",
          "state",
          "lineage",
          "schedule",
          "chain",
          "settlement",
          "ingestion",
          "system",
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

function filterTimelineEntries(
  entries: TimelineEntry[],
  filters: TimelineEventFilterValue
): TimelineEntry[] {
  const source = normalizeFilterText(filters.source);
  const topic = normalizeFilterText(filters.topic);
  const phase = normalizeFilterText(filters.phase);
  const severity = normalizeFilterText(filters.severity);
  const wallet = normalizeFilterText(filters.wallet);
  const correlationId = normalizeFilterText(filters.correlationId);
  if (!source && !topic && !phase && !severity && !wallet && !correlationId) {
    return entries;
  }
  return entries.filter((entry) => {
    if (source && normalizeFilterText(entry.source) !== source) return false;
    if (topic && normalizeFilterText(entry.topic) !== topic) return false;
    if (phase && normalizeFilterText(entry.phase) !== phase) return false;
    if (severity && normalizeFilterText(entry.severity) !== severity) return false;
    if (wallet && normalizeFilterText(entry.wallet).indexOf(wallet) === -1) {
      return false;
    }
    if (
      correlationId &&
      normalizeFilterText(entry.correlationId) !== correlationId
    ) {
      return false;
    }
    return true;
  });
}

function normalizeFilterText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

// Re-export the empty constant for callers that want to render a
// stable shape during SSR / first paint.
export { EMPTY_JOB_TIMELINE };
