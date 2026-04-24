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

      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-[family-name:var(--font-body)] text-[13px]">
          <thead>
            <tr>
              <Th width="34%">Run · Job</Th>
              <Th>Worker</Th>
              <Th>State</Th>
              <Th align="right">Stake</Th>
              <Th align="right" sortable>
                Age <span className="ml-0.5 text-[9px] text-[var(--avy-accent)]">▼</span>
              </Th>
              <Th>Last event</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isSelected = row.id === selectedId;
              return (
                <tr
                  key={row.id}
                  onClick={() => onSelect(row.id)}
                  className={cn(
                    "cursor-pointer transition-colors hover:bg-[color:rgba(17,19,21,0.025)]",
                    isSelected &&
                      "bg-[color:rgba(30,102,66,0.06)] [&>td:first-child]:[box-shadow:inset_2px_0_0_var(--avy-accent)]"
                  )}
                >
                  <Td>
                    <div className="min-w-0 max-w-[360px]">
                      <div
                        className="line-clamp-2 text-[13px] font-semibold leading-[1.3] text-[var(--avy-ink)]"
                        title={row.title}
                      >
                        {row.title}
                      </div>
                      <div
                        className="mt-0.5 flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11px] font-normal text-[var(--avy-muted)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {row.source?.type === "github_issue" ? (
                          <>
                            <SourceBadge kind="github" />
                            <span className="truncate">
                              {row.source.repo}
                              <span className="text-[var(--avy-accent)]"> #{row.source.issueNumber}</span>
                            </span>
                            <span className="opacity-40">·</span>
                            <span className="truncate">{row.jobMeta}</span>
                          </>
                        ) : (
                          <span className="truncate">{row.jobMeta}</span>
                        )}
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <WorkerChip {...row.worker} />
                  </Td>
                  <Td>
                    <StatePill state={row.state} />
                  </Td>
                  <Td align="right">
                    <span className="font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--avy-ink)]">
                      {row.stake}
                      <small className="font-normal text-[var(--avy-muted)]"> DOT</small>
                    </span>
                  </Td>
                  <Td align="right">
                    <span
                      className={cn(
                        "whitespace-nowrap font-[family-name:var(--font-mono)] text-xs",
                        row.ageStale ? "text-[var(--avy-warn)]" : "text-[var(--avy-ink)]"
                      )}
                    >
                      {row.age}
                    </span>
                  </Td>
                  <Td>
                    <div className="text-xs leading-[1.35] text-[var(--avy-ink)]">
                      {row.lastEvent}
                      <small
                        className="mt-px block font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {row.lastEventMeta}
                      </small>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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

function Th({
  children,
  width,
  align,
  sortable,
}: {
  children: ReactNode;
  width?: string;
  align?: "left" | "right";
  sortable?: boolean;
}) {
  return (
    <th
      className={cn(
        "sticky top-0 z-[1] border-b border-[var(--avy-line-soft)] bg-[#faf8f1] px-3.5 py-2.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)] whitespace-nowrap",
        align === "right" ? "text-right" : "text-left",
        sortable && "cursor-pointer"
      )}
      style={{ letterSpacing: "0.14em", width }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
}: {
  children: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      className={cn(
        "border-b border-[var(--avy-line-soft)] px-3.5 py-2.5 align-middle last:border-b-0",
        align === "right" && "text-right"
      )}
    >
      {children}
    </td>
  );
}
