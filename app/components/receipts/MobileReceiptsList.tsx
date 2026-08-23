"use client";

import { useMemo, useState } from "react";
import { KindChip } from "@/components/receipts/KindChip";
import type { ReceiptRow } from "@/components/receipts/ReceiptsTable";
import { DataFreshnessPill, type FreshnessState } from "@/components/shell/DataFreshnessPill";
import { receiptMatchesMobileQuery } from "@/lib/ui/mobile-operator.js";
import { cn } from "@/lib/utils/cn";

export function MobileReceiptsList({
  rows,
  selectedId,
  onSelect,
  freshness,
}: {
  rows: ReceiptRow[];
  selectedId: string | null;
  onSelect: (row: ReceiptRow) => void;
  freshness: FreshnessState;
}) {
  const [query, setQuery] = useState("");
  const visibleRows = useMemo(
    () => rows.filter((row) => receiptMatchesMobileQuery(row, query)),
    [query, rows],
  );

  return (
    <section className="flex flex-col gap-4 min-[1080px]:hidden" data-mobile-layout="receipts">
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--avy-accent)]">
            Evidence library
          </p>
          <h1 className="mt-1 text-[1.75rem] font-bold text-[var(--avy-ink)]">Receipts</h1>
        </div>
        <DataFreshnessPill state={freshness} />
      </header>

      <div className="sticky top-0 z-10 -mx-1 bg-[color:rgba(246,244,237,0.94)] px-1 py-2 backdrop-blur-xl">
        <label className="sr-only" htmlFor="mobile-receipt-search">Search receipts</label>
        <div className="relative">
          <span aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--avy-muted)]">⌕</span>
          <input
            id="mobile-receipt-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search receipt, subject, policy…"
            className="h-11 w-full rounded-[12px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] pl-9 pr-3 text-sm text-[var(--avy-ink)] placeholder:text-[var(--avy-muted)]"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-[14px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] shadow-[var(--shadow-card)]">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--avy-line-soft)] px-4 py-3">
          <h2 className="text-sm font-bold text-[var(--avy-ink)]">Signed receipts</h2>
          <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--avy-muted)]">
            {visibleRows.length} of {rows.length}
          </span>
        </div>
        <ul role="list">
          {visibleRows.map((row) => (
            <li key={row.id} className="border-b border-[var(--avy-line-soft)] last:border-b-0">
              <button
                type="button"
                onClick={() => onSelect(row)}
                className={cn(
                  "grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-left",
                  selectedId === row.id && "bg-[color:rgba(30,102,66,0.06)]",
                )}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-[family-name:var(--font-mono)] text-xs font-semibold text-[var(--avy-accent)]">{row.id}</span>
                    <KindChip kind={row.kind} />
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--avy-muted)]">{row.subject} · {row.subjectSub}</span>
                </span>
                <span className="hidden text-right font-[family-name:var(--font-mono)] text-[10px] text-[var(--avy-muted)] md:block">
                  <span className="block text-[var(--avy-ink)]">{row.policy}</span>
                  {row.signedAt}
                </span>
                <span aria-hidden className="text-[var(--avy-accent)] md:hidden">→</span>
              </button>
            </li>
          ))}
          {visibleRows.length === 0 ? (
            <li className="px-4 py-8 text-center text-sm text-[var(--avy-muted)]">
              {rows.length === 0 ? "No receipt rows are available." : "No receipts match this search."}
            </li>
          ) : null}
        </ul>
      </div>
    </section>
  );
}
