"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { StatePill, SourceBadge, type RunState } from "./StatePill";
import { WorkerChip, type WorkerVariant } from "./WorkerChip";
import type { JobSource } from "./types";
import {
  formatLifecycleLabel,
  type JobLifecycle,
  type JobLifecycleState,
} from "@/lib/api/job-lifecycle";
import {
  CLAIM_STATE_LABEL,
  type ClaimEffectiveState,
  type ClaimSummary,
} from "@/lib/api/claim-status";

export interface RunRow {
  id: string;
  sessionId?: string;
  jobMeta: string;
  title: string;
  /**
   * Optional provenance. Present on GitHub-ingested jobs so the row can
   * show the source badge + `owner/repo #123` inline instead of just the
   * internal job id.
   */
  source?: JobSource;
  /**
   * Lifecycle metadata from PR #64. Present when the row was loaded
   * from `/admin/jobs` (operator). Drives the lifecycle pill and the
   * action bar in the loaded-run panel.
   */
  lifecycle?: JobLifecycle;
  /**
   * Claim-state block from `/jobs[]` and `/admin/jobs[]`. Present on
   * every row the backend has rolled out the new claim contract for;
   * absent on older fixtures. When present the row pill renders the
   * claim `effectiveState` (which reflects retry-budget exhaustion)
   * instead of the legacy `state` field, and recommendation / claim
   * buttons gate on `claim.claimable`.
   */
  claim?: ClaimSummary;
  worker: {
    variant: WorkerVariant;
    initials: string;
    label: string;
    isSelf?: boolean;
  };
  state: RunState;
  stake: string;
  age: string;
  ageStale?: boolean;
  lastEvent: ReactNode;
  lastEventMeta: string;
}

export interface RunQueueTableProps {
  rows: RunRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  shownCount: number;
  totalCount: number;
  unclaimedStake: string;
  assignedToMe: number;
  liveStatus?: string;
}

export function RunQueueTable({
  rows,
  selectedId,
  onSelect,
  shownCount,
  totalCount,
  unclaimedStake,
  assignedToMe,
  liveStatus = "ws://verifier.averray",
}: RunQueueTableProps) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)]">
      <header className="flex items-baseline justify-between gap-2.5 border-b border-[var(--avy-line-soft)] p-3 px-4">
        <h3 className="m-0 font-[family-name:var(--font-display)] text-[14px] font-bold">
          Run queue
        </h3>
        <span className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
          {totalCount} open · {assignedToMe} assigned to you · live
        </span>
      </header>

      {/*
       * Card-row list instead of a 6-column table. A <table> forces every
       * column to share a single horizontal lane, which either overflows
       * or drops columns when the queue lives in a narrow split-pane.
       * Structuring each row as a small 2-D card lets us surface all six
       * pieces of info (title, source, state, stake, age, worker, last
       * event) on every row at ~90px of height, without horizontal scroll.
       */}
      {rows.length === 0 ? (
        <div
          className="px-4 py-10 text-center font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          No runs match this filter.{" "}
          <span className="text-[var(--avy-accent)]">Try a different state.</span>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--avy-line-soft)]" role="list">
          {rows.map((row) => (
            <RunRowCard
              key={row.id}
              row={row}
              selected={row.id === selectedId}
              onSelect={() => onSelect(row.id)}
            />
          ))}
        </ul>
      )}

      <footer className="flex items-center justify-between border-t border-[var(--avy-line-soft)] bg-[#faf8f1] px-4 py-2.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
        <span>
          Showing{" "}
          <b className="font-semibold text-[var(--avy-ink)]">
            {shownCount} of {totalCount}
          </b>{" "}
          · unclaimed stake{" "}
          <b className="font-semibold text-[var(--avy-ink)]">{unclaimedStake}</b> ·
          assigned to you{" "}
          <b className="font-semibold text-[var(--avy-ink)]">{assignedToMe}</b>
        </span>
        <span>
          Updated <b className="font-semibold text-[var(--avy-ink)]">2s ago</b> ·{" "}
          {liveStatus} —{" "}
          <span className="text-[var(--avy-accent)]">●</span> live
        </span>
      </footer>
    </div>
  );
}

/**
 * Compact card row for the run queue. Layout is a 3-line stack with the
 * high-signal info on the left (title + source) and the terminal-style
 * numbers on the right (state, stake, age) — plus a low-emphasis footer
 * row with the worker and the last event so an operator can scan a run's
 * status without ever leaving the queue.
 */
function RunRowCard({
  row,
  selected,
  onSelect,
}: {
  row: RunRow;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          // Default: soft background-tint hover + a 2px left accent hint
          // on hover so the row reads as "clickable, will select". The
          // selected state promotes that hint to a solid accent bar and
          // a matching tint.
          "group relative block w-full cursor-pointer px-4 py-3 text-left transition-all",
          "hover:bg-[color:rgba(17,19,21,0.025)] hover:shadow-[inset_2px_0_0_rgba(30,102,66,0.35)]",
          selected &&
            "bg-[color:rgba(30,102,66,0.06)] shadow-[inset_2px_0_0_var(--avy-accent)] hover:bg-[color:rgba(30,102,66,0.08)] hover:shadow-[inset_2px_0_0_var(--avy-accent)]"
        )}
      >
        {/* Row 1: title (left) + state/stake/age stack (right). */}
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div
              className="line-clamp-2 font-[family-name:var(--font-body)] text-[13px] font-semibold leading-[1.3] text-[var(--avy-ink)]"
              title={row.title}
            >
              {row.title}
            </div>
            <div
              className="mt-0.5 flex min-w-0 items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11px] font-normal text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              {row.source?.type === "github_issue" ? (
                <>
                  <SourceBadge kind="github" className="shrink-0" />
                  <span className="truncate">
                    {row.source.repo}
                    <span className="text-[var(--avy-accent)]">
                      {" "}#{row.source.issueNumber}
                    </span>
                  </span>
                  <span className="shrink-0 opacity-40">·</span>
                  <span className="shrink-0 whitespace-nowrap">
                    {row.jobMeta}
                  </span>
                </>
              ) : row.source?.type === "wikipedia_article" ? (
                <>
                  <SourceBadge kind="wikipedia" className="shrink-0" />
                  <span className="truncate">
                    <span>{row.source.language}.wikipedia</span>
                    <span className="text-[var(--avy-accent)]">
                      {" "}/ &ldquo;{row.source.pageTitle}&rdquo;
                    </span>
                  </span>
                  <span className="shrink-0 opacity-40">·</span>
                  <span className="shrink-0 whitespace-nowrap">
                    {row.jobMeta}
                  </span>
                </>
              ) : row.source?.type === "osv_advisory" ? (
                <>
                  <SourceBadge
                    kind="osv"
                    secondary={
                      (row.source.cves?.length ?? 0) > 0 ? "NVD" : undefined
                    }
                    className="shrink-0"
                  />
                  <span className="truncate">
                    {row.source.ecosystem} / {row.source.packageName}
                    <span className="text-[var(--avy-accent)]">
                      {" "}· {row.source.advisoryId}
                    </span>
                  </span>
                  <span className="shrink-0 opacity-40">·</span>
                  <span className="shrink-0 whitespace-nowrap">
                    {row.jobMeta}
                  </span>
                </>
              ) : row.source?.type === "open_data_dataset" ? (
                <>
                  <SourceBadge kind="data_gov" className="shrink-0" />
                  <span className="truncate text-[var(--avy-ink)]">
                    {row.source.datasetTitle}
                  </span>
                  <span className="shrink-0 opacity-40">·</span>
                  <span className="shrink-0 truncate whitespace-nowrap">
                    {row.jobMeta}
                  </span>
                </>
              ) : row.source?.type === "openapi_spec" ? (
                <>
                  <SourceBadge kind="openapi" className="shrink-0" />
                  <span className="truncate">
                    <span>{row.source.provider}</span>
                    <span className="text-[var(--avy-accent)]">
                      {" "}/ {row.source.apiTitle}
                    </span>
                  </span>
                  <span className="shrink-0 opacity-40">·</span>
                  <span className="shrink-0 truncate whitespace-nowrap">
                    {row.jobMeta}
                  </span>
                </>
              ) : row.source?.type === "standards_spec" ? (
                <>
                  <SourceBadge kind="standards" className="shrink-0" />
                  <span className="truncate">
                    <span>{row.source.provider.toUpperCase()}</span>
                    <span className="text-[var(--avy-accent)]">
                      {" "}/ {row.source.specTitle}
                    </span>
                  </span>
                  <span className="shrink-0 opacity-40">·</span>
                  <span className="shrink-0 truncate whitespace-nowrap">
                    {row.jobMeta}
                  </span>
                </>
              ) : (
                <span className="truncate">{row.jobMeta}</span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <div className="flex items-center gap-1.5">
              {row.lifecycle && row.lifecycle.state !== "open" ? (
                <LifecyclePill state={row.lifecycle.state} />
              ) : null}
              {/*
               * Prefer the claim `effectiveState` pill when the row
               * carries the new claim contract — it tells the operator
               * whether the job can actually be claimed (an "open" row
               * can still be `exhausted` after every retry was used).
               * Fall back to the legacy run-state pill for older
               * fixtures and any backend that hasn't rolled out yet.
               */}
              {row.claim ? (
                <EffectiveStatePill state={row.claim.state} />
              ) : (
                <StatePill state={row.state} />
              )}
            </div>
            <span className="font-[family-name:var(--font-mono)] text-[12.5px] leading-tight text-[var(--avy-ink)]">
              {row.stake}
              <small className="font-normal text-[var(--avy-muted)]"> DOT</small>
            </span>
            <span
              className={cn(
                "whitespace-nowrap font-[family-name:var(--font-mono)] text-[11.5px] leading-tight",
                row.ageStale ? "text-[var(--avy-warn)]" : "text-[var(--avy-muted)]"
              )}
            >
              {row.age}
            </span>
          </div>
        </div>

        {/* Row 2: worker (if any) + last event. Kept quiet so it doesn't
            compete with the primary title/state row above. */}
        <div className="mt-1.5 flex items-center gap-2 overflow-hidden font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]" style={{ letterSpacing: 0 }}>
          <span className="shrink-0">
            <WorkerChip {...row.worker} />
          </span>
          <span className="shrink-0 opacity-40">·</span>
          <span className="min-w-0 flex-1 truncate text-[var(--avy-ink)]/80">
            {row.lastEvent}
          </span>
          <span className="shrink-0 truncate text-[var(--avy-muted)]">
            {row.lastEventMeta}
          </span>
        </div>
      </button>
    </li>
  );
}

function LifecyclePill({ state }: { state: JobLifecycleState }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase",
        state === "stale" &&
          "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]",
        state === "paused" &&
          "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-muted)]",
        state === "archived" &&
          "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-muted)]",
        state === "open" && "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]"
      )}
      style={{ letterSpacing: "0.1em" }}
      title={`Lifecycle: ${state}`}
    >
      {formatLifecycleLabel(state)}
    </span>
  );
}

/**
 * Pill for `claim.effectiveState`. Five buckets, one tone each:
 *   - claimable → green (matches the existing "ready" affordance)
 *   - claimed → blue-tinted (a worker holds it; not red)
 *   - submitted → amber (awaiting verification)
 *   - expired → amber (a prior claim TTL'd; reopen is implicit)
 *   - exhausted → muted (retry budget gone)
 *
 * Brief explicitly calls out `lifecycle.status: "open"` +
 * `claim.exhausted` rendering as Exhausted, not Open. This pill is the
 * single place that decides that.
 */
function EffectiveStatePill({ state }: { state: ClaimEffectiveState }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase",
        state === "claimable" &&
          "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
        state === "claimed" &&
          "bg-[color:rgba(37,78,154,0.14)] text-[#254e9a]",
        state === "submitted" &&
          "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]",
        state === "expired" &&
          "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]",
        state === "exhausted" &&
          "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-muted)]"
      )}
      style={{ letterSpacing: "0.08em" }}
      title={`Claim state: ${state}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {CLAIM_STATE_LABEL[state]}
    </span>
  );
}
