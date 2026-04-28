"use client";

import { cn } from "@/lib/utils/cn";
import type { RunRow } from "./RunQueueTable";

/**
 * Source-kind filter for the runs queue. Sister to QueueBar's
 * state-filter row, but operates on `row.source.type`.
 *
 * Browser agents want to narrow the marketplace to a single upstream
 * (e.g. "show me only Wikipedia citation-repair jobs"); the public job
 * feed already carries the source kind on every row, so this is a
 * pure-frontend filter — no extra fetch.
 */

export type SourceFilter =
  | "all"
  | "github"
  | "wikipedia"
  | "osv"
  | "openData"
  | "openApi"
  | "standards"
  | "other";

export interface SourceFilterCount {
  id: SourceFilter;
  label: string;
  count: number;
}

export interface SourceFilterBarProps {
  filters: SourceFilterCount[];
  active: SourceFilter;
  onChange: (id: SourceFilter) => void;
}

const ALL_KINDS: SourceFilter[] = [
  "all",
  "github",
  "wikipedia",
  "osv",
  "openData",
  "openApi",
  "standards",
  "other",
];

const LABEL: Record<SourceFilter, string> = {
  all: "All sources",
  github: "GitHub",
  wikipedia: "Wikipedia",
  osv: "OSV",
  openData: "Data.gov",
  openApi: "OpenAPI",
  standards: "Standards",
  other: "Other",
};

export function rowSourceKind(row: RunRow): SourceFilter {
  switch (row.source?.type) {
    case "github_issue":
      return "github";
    case "wikipedia_article":
      return "wikipedia";
    case "osv_advisory":
      return "osv";
    case "open_data_dataset":
      return "openData";
    case "openapi_spec":
      return "openApi";
    case "standards_spec":
      return "standards";
    default:
      return "other";
  }
}

/** Build the filter chip set with live row counts. */
export function buildSourceFilters(rows: RunRow[]): SourceFilterCount[] {
  const counts = new Map<SourceFilter, number>();
  for (const row of rows) {
    const kind = rowSourceKind(row);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return ALL_KINDS.map((id) => ({
    id,
    label: LABEL[id],
    count: id === "all" ? rows.length : counts.get(id) ?? 0,
  }));
}

/** Type guard for parsing `?source=` URL params. */
export function parseSourceFilter(value: string | null | undefined): SourceFilter {
  if (!value) return "all";
  return ALL_KINDS.includes(value as SourceFilter)
    ? (value as SourceFilter)
    : "all";
}

export function SourceFilterBar({
  filters,
  active,
  onChange,
}: SourceFilterBarProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3.5 py-2"
      role="tablist"
      aria-label="Filter runs by source"
    >
      <span
        className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.14em" }}
      >
        Source
      </span>
      <div className="inline-flex flex-wrap items-center gap-0.5 rounded-[8px] bg-[color:rgba(17,19,21,0.04)] p-0.5">
        {filters.map((f) => {
          const isActive = active === f.id;
          // Hide kinds that have zero rows in the current data set,
          // except "All" which is always shown so the operator can
          // reset the filter.
          if (f.id !== "all" && f.count === 0) return null;
          return (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(f.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[6px] border border-transparent px-2.5 py-1 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase text-[var(--avy-muted)] transition-colors hover:text-[var(--avy-ink)]",
                isActive &&
                  "border-[var(--avy-line)] bg-[var(--avy-paper-solid)] text-[var(--avy-ink)] shadow-[0_1px_0_rgba(17,19,21,0.04)]"
              )}
              style={{ letterSpacing: "0.06em" }}
            >
              {f.label}
              <span
                className={cn(
                  "rounded-[4px] px-1.5 py-px font-[family-name:var(--font-mono)] text-[10.5px] font-medium",
                  isActive
                    ? "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]"
                    : "bg-[color:rgba(17,19,21,0.05)] text-[var(--avy-muted)]"
                )}
                style={{ letterSpacing: 0 }}
              >
                {f.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
