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
  FIXTURE_RECOMMENDATIONS,
  FIXTURE_RUN_ROWS,
} from "@/components/runs/fixtures";
import { useJobs, useRecommendations } from "@/lib/api/hooks";
import {
  buildRecommendationCards,
  buildRunFilters,
  buildRunRows,
  sumReadyStake,
} from "@/lib/api/run-adapters";

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
  const [selectedId, setSelectedId] = useState<string>(runParam ?? "run-2742");

  const jobs = useJobs();
  const recommendations = useRecommendations();

  const liveRows = useMemo(() => buildRunRows(jobs.data), [jobs.data]);
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
    if (activeFilter === "all") return rows;
    return rows.filter((r) => r.state === activeFilter);
  }, [activeFilter, rows]);

  // Lifecycle rail at the page level mirrors the loaded run, so its
  // copy has to follow the selected row's source — otherwise selecting
  // a Wikipedia maintenance run still shows "verification github_pr ·
  // PR #4931 opened" and "Maintainer review → Pay", which is the wrong
  // verification path and implies a direct GitHub flow that doesn't
  // exist for that run.
  const selectedRow = rows.find((row) => row.id === selectedId) ?? rows[0];
  const selectedSourceType = selectedRow?.source?.type;
  const lifecycleContextNote =
    selectedSourceType === "wikipedia_article" ? (
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
    selectedSourceType === "wikipedia_article"
      ? {
          label: "Next",
          value: "Averray review → Pay",
          sub: "auto-pays on Averray-approved review",
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

  return (
    <div className="flex w-full max-w-[1440px] flex-col gap-3.5">
      <RunsTopbar />
      <QueueBar
        filters={filters.length ? filters : FIXTURE_FILTERS}
        active={activeFilter}
        onChange={setActiveFilter}
      />

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
        stages={FIXTURE_LIFECYCLE}
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
