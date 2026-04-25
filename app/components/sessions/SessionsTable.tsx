"use client";

import { cn } from "@/lib/utils/cn";
import { SessionStatePill, VerifierModeChip } from "./pills";
import { WorkerChip } from "./WorkerChip";
import type { SessionDetail } from "./types";

export interface SessionsTableProps {
  rows: SessionDetail[];
  totalCount: number;
  selectedId: string | null;
  onSelect: (s: SessionDetail) => void;
}

export function SessionsTable({
  rows,
  totalCount,
  selectedId,
  onSelect,
}: SessionsTableProps) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] shadow-[var(--shadow-card)] backdrop-blur-[10px]">
      <header className="flex items-baseline justify-between gap-3 border-b border-[var(--avy-line-soft)] px-4 py-3.5">
        <h3 className="m-0 font-[family-name:var(--font-display)] text-[15px] font-bold">
          Session ledger
        </h3>
        <span
          className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {rows.length} of {totalCount.toLocaleString()} · newest first
        </span>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-[family-name:var(--font-body)] text-[13px]">
          <thead>
            <tr>
              <Th width={140}>Session id · run</Th>
              <Th>Job</Th>
              <Th>Worker</Th>
              <Th align="right" width={110}>Escrow</Th>
              <Th width={110}>State</Th>
              <Th width={110}>Verifier</Th>
              <Th width={90}>Age</Th>
              <Th>Last event</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="p-8 text-center font-[family-name:var(--font-mono)] text-[13px] text-[var(--avy-muted)]"
                  style={{ letterSpacing: 0 }}
                >
                  No sessions match these filters.
                </td>
              </tr>
            ) : (
              rows.map((s) => {
                const selected = s.id === selectedId;
                return (
                  <tr
                    key={s.id}
                    onClick={() => onSelect(s)}
                    className={cn(
                      "cursor-pointer transition-colors hover:bg-white/55",
                      selected && "bg-[color:rgba(30,102,66,0.06)]"
                    )}
                  >
                    <Td>
                      <div
                        className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-accent)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {s.id}
                      </div>
                      <div
                        className="mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {s.runRef}
                      </div>
                    </Td>
                    <Td>
                      <div className="text-[13px] leading-tight text-[var(--avy-ink)]">
                        {s.job.title}
                      </div>
                      <div
                        className="mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {s.job.meta}
                      </div>
                    </Td>
                    <Td>
                      <WorkerChip
                        tone={s.worker.tone}
                        initials={s.worker.initials}
                        handle={s.worker.handle}
                        address={s.worker.address}
                      />
                    </Td>
                    <Td align="right">
                      <span
                        className="font-[family-name:var(--font-mono)] text-[13px] tabular-nums text-[var(--avy-ink)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {s.escrow.amount}
                        <span className="ml-1 text-[11px] text-[var(--avy-muted)]">
                          {s.escrow.asset}
                        </span>
                      </span>
                    </Td>
                    <Td>
                      <SessionStatePill state={s.state} />
                    </Td>
                    <Td>
                      <VerifierModeChip mode={s.verifierMode} />
                    </Td>
                    <Td>
                      <span
                        className={cn(
                          "font-[family-name:var(--font-mono)] text-[11.5px] whitespace-nowrap",
                          s.ageStale ? "text-[var(--avy-warn)]" : "text-[var(--avy-muted)]"
                        )}
                        style={{ letterSpacing: 0 }}
                      >
                        {s.age}
                      </span>
                    </Td>
                    <Td>
                      <div
                        className={cn(
                          "text-[13px] leading-tight",
                          s.lastEvent.tone === "accent" && "text-[var(--avy-accent-hover)]",
                          s.lastEvent.tone === "warn" && "text-[var(--avy-warn)]",
                          s.lastEvent.tone === "bad" && "text-[#8c2a17]",
                          (!s.lastEvent.tone || s.lastEvent.tone === "neutral") &&
                            "text-[var(--avy-ink)]"
                        )}
                        style={{ letterSpacing: 0 }}
                      >
                        {s.lastEvent.text}
                      </div>
                      <div
                        className="mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {s.lastEvent.meta}
                      </div>
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <footer
        className="flex items-center justify-between gap-3 border-t border-[var(--avy-line-soft)] bg-[rgba(250,248,241,0.5)] px-4 py-3 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        <span>
          Showing <b className="font-semibold text-[var(--avy-ink)]">{rows.length}</b> of{" "}
          <b className="font-semibold text-[var(--avy-ink)]">1,284</b>
        </span>
        <button
          type="button"
          className="cursor-pointer border-b border-dashed border-[color:rgba(30,102,66,0.4)] pb-px text-[var(--avy-accent)] hover:text-[var(--avy-accent-2)]"
        >
          load more
        </button>
      </footer>
    </div>
  );
}

function Th({
  children,
  width,
  align,
}: {
  children: React.ReactNode;
  width?: number;
  align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        "border-b border-[var(--avy-line-soft)] bg-[rgba(250,248,241,0.6)] px-4 py-2.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)] whitespace-nowrap",
        align === "right" ? "text-right" : "text-left"
      )}
      style={{ letterSpacing: "0.12em", width }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      className={cn(
        "border-b border-[var(--avy-line-soft)] px-4 py-3 align-middle last:border-b-0",
        align === "right" && "text-right"
      )}
    >
      {children}
    </td>
  );
}
