"use client";

import { cn } from "@/lib/utils/cn";
import { DisputeStatePill, OriginPill } from "./pills";
import { PartyChip } from "./PartyChip";
import { WindowCountdown } from "./WindowCountdown";
import type { Dispute } from "./types";

export interface DisputesTableProps {
  rows: Dispute[];
  totalCount: number;
  selectedId: string | null;
  onSelect: (d: Dispute) => void;
}

export function DisputesTable({
  rows,
  totalCount,
  selectedId,
  onSelect,
}: DisputesTableProps) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] shadow-[var(--shadow-card)] backdrop-blur-[10px]">
      <header className="flex items-baseline justify-between gap-3 border-b border-[var(--avy-line-soft)] px-4 py-3.5">
        <h3 className="m-0 font-[family-name:var(--font-display)] text-[15px] font-bold">
          Contested runs
        </h3>
        <span
          className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {rows.length} of {totalCount} · oldest first
        </span>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-[family-name:var(--font-body)] text-[13px]">
          <thead>
            <tr>
              <Th width={100}>Dispute</Th>
              <Th width={100}>Run</Th>
              <Th>Opener</Th>
              <Th>Respondent</Th>
              <Th width={90} align="right">Stake</Th>
              <Th width={110}>Window</Th>
              <Th width={130}>Origin</Th>
              <Th width={130}>State</Th>
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
                  No disputes match these filters. Queue is clear.
                </td>
              </tr>
            ) : (
              rows.map((d) => {
                const selected = d.id === selectedId;
                return (
                  <tr
                    key={d.id}
                    onClick={() => onSelect(d)}
                    className={cn(
                      "cursor-pointer transition-colors hover:bg-white/55",
                      selected && "bg-[color:rgba(30,102,66,0.06)]"
                    )}
                  >
                    <Td>
                      <span
                        className="font-[family-name:var(--font-mono)] text-[12.5px] font-semibold text-[var(--avy-accent)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {d.id}
                      </span>
                    </Td>
                    <Td>
                      <span
                        className="font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--avy-ink)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {d.runRef}
                      </span>
                    </Td>
                    <Td>
                      <PartyChip party={d.opener} />
                    </Td>
                    <Td>
                      <PartyChip party={d.respondent} />
                    </Td>
                    <Td align="right">
                      <span
                        className="font-[family-name:var(--font-mono)] text-[13px] tabular-nums text-[var(--avy-ink)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {d.stakeFrozen} DOT
                      </span>
                    </Td>
                    <Td>
                      <WindowCountdown
                        total={d.windowSeconds}
                        elapsed={d.windowElapsed}
                        size="sm"
                        frozen={d.state === "resolved"}
                      />
                    </Td>
                    <Td>
                      <OriginPill origin={d.origin} />
                    </Td>
                    <Td>
                      <DisputeStatePill state={d.state} />
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
          <b className="font-semibold text-[var(--avy-ink)]">{totalCount}</b> · queue empty
          when resolved
        </span>
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
