"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RunsTopbar } from "@/components/runs/RunsTopbar";
import {
  QueueBar,
  type QueueFilter,
} from "@/components/runs/QueueBar";
import { RunQueueTable } from "@/components/runs/RunQueueTable";
import { RecommendationRail } from "@/components/runs/RecommendationRail";
import { LoadedRunView } from "@/components/runs/LoadedRunView";
import { LifecycleRail } from "@/components/runs/LifecycleRail";
import {
  FIXTURE_FILTERS,
  FIXTURE_LIFECYCLE,
  FIXTURE_LIFECYCLE_OPEN_DATA,
  FIXTURE_LIFECYCLE_OSV,
  FIXTURE_LIFECYCLE_WIKIPEDIA,
  FIXTURE_RECOMMENDATIONS,
  FIXTURE_RUN_ROWS,
} from "@/components/runs/fixtures";
import { useAdminJobs, useJobs, useRecommendations } from "@/lib/api/hooks";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";
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
 * the hooks, fixture fallback, and submit/drawer state for that run.
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

function RunsPageInner() {
  const searchParams = useSearchParams();
  const runParam = searchParams?.get("run") ?? null;
  const [activeFilter, setActiveFilter] = useState<QueueFilter>("all");
  const [showClosed, setShowClosed] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(runParam ?? "run-2742");

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
  const rows = liveRows.length ? liveRows : FIXTURE_RUN_ROWS;
  const filters = useMemo(() => buildRunFilters(rows), [rows]);
  const recommendationCards = useMemo(() => {
    const liveCards = buildRecommendationCards(recommendations.data, jobs.data);
    return liveCards.length ? liveCards : FIXTURE_RECOMMENDATIONS;
  }, [jobs.data, recommendations.data]);

  // Honour ?run=<id> deep links on first hydration so a linked run is
  // pre-selected.
  useEffect(() => {
    if (runParam) setSelectedId(runParam);
  }, [runParam]);

  // Keep selectedId valid when the rows list changes (e.g. live data
  // arrives and the previously-selected fixture id isn't in it).
  useEffect(() => {
    if (rows.length && !rows.some((row) => row.id === selectedId)) {
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
    return next;
  }, [activeFilter, rows, showClosed]);

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
  // One source-of-truth narrow on `selectedRow.source`. The lifecycle
  // copy below switches on `selectedSource?.type` and TS narrows to the
  // right per-source field set inside each branch — no per-source
  // intermediate variables needed.
  const selectedSource = selectedRow?.source;
  const lifecycleContextNote =
    selectedSource?.type === "wikipedia_article" ? (
      <>
        Window closes in{" "}
        <b className="font-semibold text-[var(--avy-ink)]">21m 46s</b>
        {" · "}verification{" "}
        <b className="font-semibold text-[var(--avy-ink)]">
          wikipedia_proposal_review
        </b>
        {" · "}proposal{" "}
        <b className="font-semibold text-[var(--avy-ink)]">submitted</b> ·
        pending Averray review
      </>
    ) : selectedSource?.type === "osv_advisory" ? (
      <>
        Window closes in{" "}
        <b className="font-semibold text-[var(--avy-ink)]">21m 46s</b>
        {" · "}verification{" "}
        <b className="font-semibold text-[var(--avy-ink)]">osv_dependency_pr</b>
        {" · "}advisory{" "}
        <b className="font-semibold text-[var(--avy-ink)]">
          {selectedSource.advisoryId}
        </b>{" "}
        · PR pending merge
      </>
    ) : selectedSource?.type === "open_data_dataset" ? (
      <>
        Window closes in{" "}
        <b className="font-semibold text-[var(--avy-ink)]">21m 46s</b>
        {" · "}verification{" "}
        <b className="font-semibold text-[var(--avy-ink)]">
          open_data_quality_audit
        </b>
        {" · "}audit{" "}
        <b className="font-semibold text-[var(--avy-ink)]">submitted</b>
      </>
    ) : (
      <>
        Window closes in{" "}
        <b className="font-semibold text-[var(--avy-ink)]">21m 46s</b>
        {" · "}verification{" "}
        <b className="font-semibold text-[var(--avy-ink)]">github_pr</b>
        {" · "}PR{" "}
        <b className="font-semibold text-[var(--avy-ink)]">#4931</b> opened
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
    ? "fixture fallback"
    : jobs.isLoading
      ? "loading live jobs"
      : "live API";
  const freshness = freshnessFromRequests(jobs, adminJobs, recommendations);

  return (
    <div className="flex w-full max-w-[1440px] flex-col gap-3.5">
      <RunsTopbar freshness={freshness} />
      <QueueBar
        filters={filters.length ? filters : FIXTURE_FILTERS}
        active={activeFilter}
        onChange={setActiveFilter}
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
          <LoadedRunView
            runId={selectedId}
            standaloneUrl={`/runs/detail/?id=${encodeURIComponent(selectedId)}`}
            // The queue page renders the lifecycle rail below the split
            // pane (full width) so it doesn't steal vertical room from
            // the sticky panel column. The standalone detail page will
            // render it inline instead.
            showLifecycle={false}
          />
        </div>
      </div>

      <LifecycleRail
        runId={selectedId}
        contextNote={lifecycleContextNote}
        stages={
          selectedSource?.type === "wikipedia_article"
            ? FIXTURE_LIFECYCLE_WIKIPEDIA
            : selectedSource?.type === "osv_advisory"
              ? FIXTURE_LIFECYCLE_OSV
              : selectedSource?.type === "open_data_dataset"
                ? FIXTURE_LIFECYCLE_OPEN_DATA
                : FIXTURE_LIFECYCLE
        }
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
