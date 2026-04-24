"use client";

import { useState } from "react";
import { cn } from "@/lib/utils/cn";

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterGroup {
  id: string;
  label: string;
  options: FilterOption[];
  initial: string;
}

export interface ReceiptsFiltersProps {
  groups: FilterGroup[];
}

export function ReceiptsFilters({ groups }: ReceiptsFiltersProps) {
  const [active, setActive] = useState<Record<string, string>>(() =>
    Object.fromEntries(groups.map((g) => [g.id, g.initial]))
  );
  const [query, setQuery] = useState("");

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-3 shadow-[var(--shadow-card)] backdrop-blur-[10px]">
      <div className="flex flex-wrap items-center gap-3">
        {groups.map((group) => (
          <div key={group.id} className="flex items-center gap-2">
            <span
              className="min-w-[3.2rem] font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
              style={{ letterSpacing: "0.14em" }}
            >
              {group.label}
            </span>
            <div className="inline-flex gap-0.5 rounded-[8px] bg-[color:rgba(17,19,21,0.04)] p-[3px]">
              {group.options.map((opt) => {
                const on = active[group.id] === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      setActive((s) => ({ ...s, [group.id]: opt.value }))
                    }
                    className={cn(
                      "rounded-[6px] border-0 bg-transparent px-2.5 py-1.5 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase transition-colors",
                      on
                        ? "bg-[var(--avy-paper-solid)] text-[var(--avy-accent)] shadow-[0_1px_0_rgba(17,19,21,0.04),0_1px_4px_rgba(17,19,21,0.08)]"
                        : "text-[var(--avy-muted)] hover:text-[var(--avy-ink)]"
                    )}
                    style={{ letterSpacing: "0.06em" }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="relative flex-1">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-[family-name:var(--font-mono)] text-xs text-[var(--avy-muted)]"
        >
          ⌕
        </span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by hash, receipt id, signer, policy…"
          className="h-9 w-full rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] pl-8 pr-10 font-[family-name:var(--font-body)] text-[13px] text-[var(--avy-ink)] placeholder:text-[var(--avy-muted)] focus:border-[color:rgba(30,102,66,0.3)] focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-[color:rgba(30,102,66,0.26)]"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-[5px] border border-[var(--avy-line)] bg-[color:rgba(17,19,21,0.06)] px-1.5 py-px font-[family-name:var(--font-mono)] text-[11px] leading-none text-[var(--avy-muted)]"
        >
          /
        </span>
      </div>
    </div>
  );
}
