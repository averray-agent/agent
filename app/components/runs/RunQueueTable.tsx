"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { StatePill, SourceBadge, type RunState } from "./StatePill";
import { WorkerChip, type WorkerVariant } from "./WorkerChip";
import type { JobSource } from "./types";

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
              ) : (
                <span className="truncate">{row.jobMeta}</span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <StatePill state={row.state} />
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
