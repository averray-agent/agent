"use client";

import { cn } from "@/lib/utils/cn";

export interface GovernanceChangeEntry {
  id: string;
  title: string;
  subjectId?: string;
  subjectLabel?: string;
  summary?: string;
  at?: string;
  badge?: string;
  fromRevision?: number;
  toRevision?: number;
  before?: string;
  after?: string;
  beforeLabel?: string;
  afterLabel?: string;
}

type GovernanceFeedPresence = "live" | "loading" | "locked" | "down";

export function WhatChangedPanel({
  title,
  eyebrow,
  changes,
  emptyHint,
  presence = "live",
  blockedHint,
  activeId,
  onSelect,
}: {
  title: string;
  eyebrow: string;
  changes: GovernanceChangeEntry[];
  emptyHint: string;
  presence?: GovernanceFeedPresence;
  blockedHint?: string;
  activeId?: string | null;
  onSelect: (change: GovernanceChangeEntry) => void;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-4 shadow-[var(--shadow-sm)]">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span
            className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
            style={{ letterSpacing: 0 }}
          >
            {eyebrow}
          </span>
          <h2 className="m-0 font-[family-name:var(--font-display)] text-[18px] font-bold text-[var(--ink)]">
            {title}
          </h2>
        </div>
        <span
          className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--muted)]"
          style={{ letterSpacing: 0 }}
        >
          {presence === "live" ? changes.length : "—"} tracked
        </span>
      </header>

      {presence !== "live" ? (
        <p className="m-0 text-[13px] leading-[1.5] text-[var(--muted)]">
          {presence === "locked"
            ? blockedHint ?? "Governance feed locked for this session."
            : presence === "down"
              ? "Governance change feed unavailable."
              : "Loading governance changes."}
        </p>
      ) : changes.length === 0 ? (
        <p className="m-0 text-[13px] leading-[1.5] text-[var(--muted)]">
          {emptyHint}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {changes.map((change) => {
            const active = activeId === change.id;
            return (
              <button
                key={change.id}
                type="button"
                onClick={() => onSelect(change)}
                className={cn(
                  "grid min-h-[104px] grid-rows-[auto_1fr_auto] gap-1.5 rounded-[8px] border p-3 text-left transition-colors",
                  active
                    ? "border-[color:rgba(30,102,66,0.42)] bg-[color:rgba(30,102,66,0.08)]"
                    : "border-[var(--line)] bg-[var(--paper)] hover:border-[color:rgba(30,102,66,0.28)]"
                )}
              >
                <span className="flex flex-wrap items-center gap-2">
                  {change.badge ? (
                    <span
                      className="rounded-full border border-[color:rgba(30,102,66,0.22)] bg-[var(--accent-soft)] px-2 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-accent)]"
                      style={{ letterSpacing: 0 }}
                    >
                      {change.badge}
                    </span>
                  ) : null}
                  {change.subjectLabel ? (
                    <span
                      className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--muted)]"
                      style={{ letterSpacing: 0 }}
                    >
                      {change.subjectLabel}
                    </span>
                  ) : null}
                </span>
                <span className="flex flex-col gap-1">
                  <strong className="font-[family-name:var(--font-display)] text-[13.5px] leading-snug text-[var(--ink)]">
                    {change.title}
                  </strong>
                  {change.summary ? (
                    <span className="text-[12.5px] leading-snug text-[var(--muted)]">
                      {change.summary}
                    </span>
                  ) : null}
                </span>
                <span className="flex items-center justify-between gap-3">
                  <span
                    className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--muted)]"
                    style={{ letterSpacing: 0 }}
                  >
                    {formatDate(change.at)}
                  </span>
                  <span
                    className="font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase text-[var(--avy-accent)]"
                    style={{ letterSpacing: 0 }}
                  >
                    view diff
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatDate(value: string | undefined): string {
  if (!value) return "unknown";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleDateString("en-CH", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
