"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RunsTopbar } from "@/components/runs/RunsTopbar";
import {
  QueueBar,
  type QueueFilter,
} from "@/components/runs/QueueBar";
import {
  buildSourceFilters,
  parseSourceFilter,
  rowSourceKind,
  SourceFilterBar,
  type SourceFilter,
} from "@/components/runs/SourceFilter";
import { RunQueueTable } from "@/components/runs/RunQueueTable";
import { RecommendationRail } from "@/components/runs/RecommendationRail";
import { LoadedRunView } from "@/components/runs/LoadedRunView";
import { LifecycleRail } from "@/components/runs/LifecycleRail";
import {
  buildLifecycleStages,
  describeClaimer,
  formatDeadline,
} from "@/components/runs/buildLifecycleStages";
import { useAdminJobs, useJobs, useJobTimeline, useRecommendations } from "@/lib/api/hooks";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";
import { buildJobTimeline } from "@/lib/api/job-timeline";
import {
  buildRecommendationCards,
  buildRunFilters,
  buildRunRows,
  sumReadyStake,
} from "@/lib/api/run-adapters";
import { extractAdminJobs } from "@/lib/api/job-lifecycle";

/**
 * Runs — the operator's primary work surface.
 *
 * Layout: email-client split pane. Queue on the left (card-row list of
 * all open runs), sticky detail pane on the right driven by LoadedRunView.
 * Clicking a queue row just updates `selectedId`; LoadedRunView owns all
 * the hooks plus submit/drawer state for that run.
 *
 * Lifecycle rail + recommendation rail sit below the split pane so they
 * don't steal horizontal room from the two primary panes.
 */
export default function RunsPage() {
  return (
    <Suspense fallback={null}>
      <RunsPageInner />
    </Suspense>
  );
}

// State filters that are valid as `?state=` URL params. Anything else
// falls back to "all" so a malformed link doesn't surface a broken
// filter chip.
const STATE_VALUES: QueueFilter[] = [
  "all",
  "ready",
  "claimed",
  "submitted",
  "disputed",
  "settled",
];

function parseStateFilter(value: string | null | undefined): QueueFilter {
  if (!value) return "all";
  return STATE_VALUES.includes(value as QueueFilter)
    ? (value as QueueFilter)
    : "all";
}

function RunsPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const runParam = searchParams?.get("run") ?? null;
  const initialState = parseStateFilter(searchParams?.get("state"));
  const initialSource = parseSourceFilter(searchParams?.get("source"));
  const [activeFilter, setActiveFilter] = useState<QueueFilter>(initialState);
  const [activeSource, setActiveSource] = useState<SourceFilter>(initialSource);
  const [showClosed, setShowClosed] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(runParam ?? "");

  // Sync filter state into the URL query string so links are
  // shareable and a browser agent can deep-link to a narrowed
  // marketplace view (e.g. `/runs?source=wikipedia&state=ready`).
  // We use `replace` rather than `push` so toggling filters doesn't
  // pollute the back stack.
  const syncQuery = useCallback(
    (next: { state?: QueueFilter; source?: SourceFilter }) => {
      if (!pathname) return;
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      const stateValue = next.state ?? activeFilter;
      const sourceValue = next.source ?? activeSource;
      if (stateValue === "all") params.delete("state");
      else params.set("state", stateValue);
      if (sourceValue === "all") params.delete("source");
      else params.set("source", sourceValue);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [activeFilter, activeSource, pathname, router, searchParams]
  );

  const onStateChange = useCallback(
    (next: QueueFilter) => {
      setActiveFilter(next);
      syncQuery({ state: next });
    },
    [syncQuery]
  );

  const onSourceChange = useCallback(
    (next: SourceFilter) => {
      setActiveSource(next);
      syncQuery({ source: next });
    },
    [syncQuery]
  );

  const jobs = useJobs();
  const adminJobs = useAdminJobs();
  const recommendations = useRecommendations();

  // Operator app uses /admin/jobs (which carries lifecycle metadata and
  // includes paused/archived/stale rows). Falls back to public /jobs
  // until the admin payload arrives so the queue isn't empty on first
  // hydration.
  const adminPayload = adminJobs.data ? extractAdminJobs(adminJobs.data) : [];
  const sourceForRows = adminPayload.length ? adminPayload : jobs.data;
  const liveRows = useMemo(() => buildRunRows(sourceForRows), [sourceForRows]);
  const rows = liveRows;
  const filters = useMemo(() => buildRunFilters(rows), [rows]);
  const sourceFilters = useMemo(() => buildSourceFilters(rows), [rows]);
  const recommendationCards = useMemo(() => {
    const liveCards = buildRecommendationCards(recommendations.data, jobs.data);
    return liveCards;
  }, [jobs.data, recommendations.data]);

  // Honour ?run=<id> deep links on first hydration so a linked run is
  // pre-selected.
  useEffect(() => {
    if (runParam) setSelectedId(runParam);
  }, [runParam]);

  // Keep selectedId valid when the rows list changes (e.g. live data
  // arrives and the previously-selected fixture id isn't in it).
  useEffect(() => {
    if (rows.length && (!selectedId || !rows.some((row) => row.id === selectedId))) {
      setSelectedId(rows[0].id);
    }
  }, [rows, selectedId]);

  const visibleRows = useMemo(() => {
    let next = rows;
    // Default-hide stale, paused, and archived rows so the queue stays
    // focused on actionable runs. Operators can flip the toggle to see
    // the full lifecycle picture (or to reopen something they paused).
    if (!showClosed) {
      next = next.filter(
        (r) => !r.lifecycle || r.lifecycle.state === "open"
      );
    }
    if (activeFilter !== "all") {
      next = next.filter((r) => r.state === activeFilter);
    }
    if (activeSource !== "all") {
      next = next.filter((r) => rowSourceKind(r) === activeSource);
    }
    return next;
  }, [activeFilter, activeSource, rows, showClosed]);

  const closedRowCount = rows.filter(
    (r) => r.lifecycle && r.lifecycle.state !== "open"
  ).length;

  // Lifecycle rail at the page level mirrors the loaded run, so its
  // copy has to follow the selected row's source — otherwise selecting
  // a Wikipedia maintenance run still shows "verification github_pr ·
  // PR #4931 opened" and "Maintainer review → Pay", which is the wrong
  // verification path and implies a direct GitHub flow that doesn't
  // exist for that run.
  const selectedRow = rows.find((row) => row.id === selectedId) ?? rows[0];
  // Pull the v2 timeline for the selected row so the rail below can
  // tint stages with severity overlays. SWR shares the fetch with the
  // sticky LoadedRunView pane (same key) so this is free.
  const timelineRequest = useJobTimeline(selectedRow?.id ?? null);
  const selectedTimeline = useMemo(
    () => buildJobTimeline(timelineRequest.data),
    [timelineRequest.data]
  );
  // One source-of-truth narrow on `selectedRow.source`. The lifecycle
  // copy below switches on `selectedSource?.type` and TS narrows to the
  // right per-source field set inside each branch — no per-source
  // intermediate variables needed.
  const selectedSource = selectedRow?.source;
  const verificationLabel =
    selectedSource?.type === "wikipedia_article"
      ? "wikipedia_proposal_review"
      : selectedSource?.type === "osv_advisory"
        ? "osv_dependency_pr"
        : selectedSource?.type === "open_data_dataset"
          ? "open_data_quality_audit"
          : "github_pr";
  const claim = selectedRow?.claim;
  const deadlineLabel = claim?.claimExpiresAt
    ? formatDeadline(claim.claimExpiresAt)
    : "";
  const stateLabel = claim
    ? claim.state === "claimed"
      ? `claimed${claim.claimedBy ? ` ${describeClaimer(claim.claimedBy, undefined)}` : ""}`
      : claim.state === "submitted"
        ? "submitted, awaiting verifier"
        : claim.state === "expired"
          ? "claim expired — reopenable"
          : claim.state === "exhausted"
            ? "no retries left"
            : "ready to claim"
    : "no claim state";
  const lifecycleContextNote = (
    <>
      {deadlineLabel ? (
        <>
          Window <b className="font-semibold text-[var(--avy-ink)]">{deadlineLabel}</b>
          {" · "}
        </>
      ) : null}
      verification{" "}
      <b className="font-semibold text-[var(--avy-ink)]">{verificationLabel}</b>
      {" · "}
      <b className="font-semibold text-[var(--avy-ink)]">{stateLabel}</b>
    </>
  );
  const lifecycleNext =
    selectedSource?.type === "wikipedia_article"
      ? {
          label: "Next",
          value: "Averray review → Pay",
          sub: "auto-pays on Averray-approved review",
        }
      : selectedSource?.type === "osv_advisory"
        ? {
            label: "Next",
            value: "Maintainer merge → Pay",
            sub: "auto-pays on PR merge + CI green + lockfile resolves",
          }
        : selectedSource?.type === "open_data_dataset"
          ? {
              label: "Next",
              value: "Verifier check → Pay",
              sub: "auto-pays on audit verifier signals green",
            }
          : {
              label: "Next",
              value: "Maintainer review → Pay",
              sub: "auto-pays on PR merge + CI green",
            };

  const assignedToMe = rows.filter((row) => row.worker.isSelf).length;
  const liveStatus = jobs.error
    ? "live API unavailable"
    : jobs.isLoading
      ? "loading live jobs"
      : "live API";
  const freshness = freshnessFromRequests(jobs, adminJobs, recommendations);

  return (
    <div className="flex w-full max-w-[1440px] flex-col gap-3.5">
      <RunsTopbar freshness={freshness} />
      <QueueBar
        filters={filters}
        active={activeFilter}
        onChange={onStateChange}
      />
      <SourceFilterBar
        filters={sourceFilters}
        active={activeSource}
        onChange={onSourceChange}
      />
      {closedRowCount > 0 || showClosed ? (
        <div className="flex items-center justify-between rounded-[10px] border border-[var(--avy-line-soft)] bg-[var(--avy-paper)] px-3.5 py-2 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
          <span>
            {showClosed
              ? `Showing all jobs including ${closedRowCount} paused/archived/stale.`
              : `${closedRowCount} paused/archived/stale ${closedRowCount === 1 ? "job is" : "jobs are"} hidden.`}
          </span>
          <button
            type="button"
            onClick={() => setShowClosed((v) => !v)}
            className="rounded-full border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2.5 py-1 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-ink)] transition-colors hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)]"
            style={{ letterSpacing: "0.08em" }}
          >
            {showClosed ? "Hide closed" : "Show closed"}
          </button>
        </div>
      ) : null}

      {/*
       * Email-client layout: queue left, loaded-run detail right. The
       * right pane is sticky so clicking a row instantly swaps detail
       * without scrolling. Rails sit below so they don't compete with
       * the two primary panes for horizontal real estate.
       */}
      <div className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-[minmax(480px,0.85fr)_minmax(0,1.15fr)]">
        <RunQueueTable
          rows={visibleRows}
          selectedId={selectedId}
          onSelect={setSelectedId}
          shownCount={visibleRows.length}
          totalCount={rows.length}
          unclaimedStake={sumReadyStake(rows)}
          assignedToMe={assignedToMe}
          liveStatus={liveStatus}
        />
        <div className="xl:sticky xl:top-6 xl:max-h-[calc(100vh-3rem)] xl:overflow-y-auto">
          {selectedRow ? (
            <LoadedRunView
              runId={selectedId}
              standaloneUrl={`/runs/detail/?id=${encodeURIComponent(selectedId)}`}
              // The queue page renders the lifecycle rail below the split
              // pane (full width) so it doesn't steal vertical room from
              // the sticky panel column. The standalone detail page will
              // render it inline instead.
              showLifecycle={false}
            />
          ) : (
            <div className="rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] p-5 font-[family-name:var(--font-body)] text-sm text-[var(--avy-muted)] shadow-[var(--shadow-card)]">
              No live run selected.
            </div>
          )}
        </div>
      </div>

      <LifecycleRail
        runId={selectedId}
        contextNote={lifecycleContextNote}
        stages={buildLifecycleStages({
          claim: selectedRow?.claim,
          source: selectedSource,
          timeline: selectedTimeline.timeline,
        })}
        next={lifecycleNext}
      />

      <RecommendationRail
        layout="horizontal"
        workerTier="live"
        workerScore={recommendations.error ? 0 : recommendationCards.length}
        jobs={recommendationCards}
        totalMatches={recommendationCards.length}
      />
    </div>
  );
}
