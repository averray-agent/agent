"use client";

import { useState } from "react";
import { cn } from "@/lib/utils/cn";

export type QueueFilter =
  | "all"
  | "ready"
  | "claimed"
  | "submitted"
  | "disputed"
  | "settled";

export interface QueueFilterCount {
  id: QueueFilter;
  label: string;
  count: number;
}

export interface QueueBarProps {
  filters: QueueFilterCount[];
  active: QueueFilter;
  onChange: (id: QueueFilter) => void;
}

export function QueueBar({ filters, active, onChange }: QueueBarProps) {
  const [query, setQuery] = useState("");

  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3.5 py-2.5">
      <div
        className="inline-flex items-center gap-0.5 rounded-[8px] bg-[color:rgba(17,19,21,0.04)] p-0.5"
        role="tablist"
      >
        {filters.map((f) => {
          const isActive = active === f.id;
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

      <div className="flex-1" />

      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--avy-muted)]">
          ⌕
        </span>
        <input
          type="text"
          placeholder="Filter by id, job, worker, hash…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-[30px] w-[260px] rounded-[8px] border border-[var(--avy-line)] bg-white px-3 pl-7 font-[family-name:var(--font-body)] text-[12.5px] text-[var(--avy-ink)] placeholder:text-[var(--avy-muted)] focus:border-[var(--avy-accent)] focus:outline-none focus:ring-2 focus:ring-[color:rgba(30,102,66,0.18)]"
        />
        <span
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[3px] bg-[color:rgba(17,19,21,0.05)] px-1.5 py-px font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
          aria-hidden="true"
        >
          /
        </span>
      </div>

      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-[6px] border border-[var(--avy-line)] bg-white px-2.5 py-1 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase text-[var(--avy-ink)]"
        style={{ letterSpacing: "0.06em" }}
      >
        <span className="font-medium text-[var(--avy-muted)]">Sort</span> Age ↓
      </button>
    </div>
  );
}
