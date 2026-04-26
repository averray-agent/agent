"use client";

import { cn } from "@/lib/utils/cn";
import { Sparkline } from "@/components/overview/Sparkline";
import { BadgeStrip } from "./BadgeStrip";
import { TierChip } from "./TierChip";
import { SourceBadge } from "@/components/runs/StatePill";
import type { AgentRecord } from "./types";

export interface AgentDirectoryTableProps {
  rows: AgentRecord[];
  total: number;
  selectedHandle: string | null;
  onSelect: (agent: AgentRecord) => void;
}

const STATE_PILL: Record<AgentRecord["state"], { cls: string; label: string }> = {
  active: { cls: "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]", label: "Active" },
  idle: { cls: "bg-[#ebe7da] text-[#756d58]", label: "Idle" },
  slashed: { cls: "bg-[#f3d9d9] text-[#8a2a2a]", label: "Slashed" },
};

export function AgentDirectoryTable({
  rows,
  total,
  selectedHandle,
  onSelect,
}: AgentDirectoryTableProps) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] shadow-[var(--shadow-card)] backdrop-blur-[10px]">
      <header className="flex items-baseline justify-between gap-3 border-b border-[var(--avy-line-soft)] px-4 py-3.5">
        <h3 className="m-0 font-[family-name:var(--font-display)] text-[15px] font-bold">
          Agent directory
        </h3>
        <span className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
          default sort · last active
        </span>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-[family-name:var(--font-body)] text-[13px]">
          <thead>
            <tr>
              <Th>Handle / wallet</Th>
              <Th>Tier</Th>
              <Th>Reputation</Th>
              <Th>Badges</Th>
              <Th align="right">Stake</Th>
              <Th>Recent activity</Th>
              <Th>State</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="p-8 text-center font-[family-name:var(--font-mono)] text-[13px] text-[var(--avy-muted)]"
                  style={{ letterSpacing: 0 }}
                >
                  No agents match these filters.
                </td>
              </tr>
            ) : (
              rows.map((a) => {
                const lockPct = a.stake.deposited > 0 ? a.stake.locked / a.stake.deposited : 0;
                const hot = lockPct > 0.8;
                const pill = STATE_PILL[a.state];
                const selected = a.handle === selectedHandle;
                const activityParts = a.activity.msg.split(a.activity.ref);
                return (
                  <tr
                    key={a.handle}
                    onClick={() => onSelect(a)}
                    className={cn(
                      "cursor-pointer transition-colors hover:bg-white/55",
                      selected && "bg-[color:rgba(30,102,66,0.06)]"
                    )}
                  >
                    <Td>
                      <div className="text-[14px] font-semibold leading-tight text-[var(--avy-ink)]">
                        {a.handle}
                      </div>
                      <div
                        className="mt-0.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {a.wallet}
                      </div>
                    </Td>
                    <Td>
                      <TierChip tier={a.tier} />
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <span
                          className="min-w-[2.6rem] font-[family-name:var(--font-mono)] text-[13.5px] font-semibold tabular-nums text-[var(--avy-ink)]"
                          style={{ letterSpacing: 0 }}
                        >
                          {a.score}
                        </span>
                        <Sparkline points={a.sparkline} width={72} height={20} />
                      </div>
                    </Td>
                    <Td>
                      <BadgeStrip badges={a.badges} />
                    </Td>
                    <Td align="right">
                      <div>
                        <span
                          className="font-[family-name:var(--font-mono)] text-[13px] tabular-nums text-[var(--avy-ink)]"
                          style={{ letterSpacing: 0 }}
                        >
                          {a.stake.deposited.toFixed(0)} DOT
                        </span>
                        <div
                          className={cn(
                            "mt-0.5 font-[family-name:var(--font-mono)] text-[11px]",
                            hot ? "text-[var(--avy-warn)]" : "text-[var(--avy-muted)]"
                          )}
                          style={{ letterSpacing: 0 }}
                        >
                          {a.stake.locked} locked · {Math.round(lockPct * 100)}%
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        {a.activity.source ? (
                          <SourceBadge kind={a.activity.source} />
                        ) : null}
                        <span
                          className="text-[13px] leading-[1.3] text-[var(--avy-ink)]"
                          style={{ letterSpacing: 0 }}
                        >
                          {activityParts.map((chunk, i, arr) => (
                            <span key={i}>
                              {chunk}
                              {i < arr.length - 1 ? (
                                <span className="font-[family-name:var(--font-mono)] text-[var(--avy-accent)]">
                                  {a.activity.ref}
                                </span>
                              ) : null}
                            </span>
                          ))}
                        </span>
                      </div>
                      <div
                        className="mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                        style={{ letterSpacing: 0 }}
                      >
                        {a.activity.when}
                      </div>
                    </Td>
                    <Td>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase",
                          pill.cls
                        )}
                        style={{ letterSpacing: "0.08em" }}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
                        {pill.label}
                      </span>
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-[var(--avy-line-soft)] bg-[rgba(250,248,241,0.5)] px-4 py-2.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
        <span>
          Showing <b className="font-semibold text-[var(--avy-ink)]">{rows.length}</b> of{" "}
          <b className="font-semibold text-[var(--avy-ink)]">{total}</b> · all agents visible
        </span>
        <button
          type="button"
          disabled
          title="Agent invites are not yet wired to a live backend."
          className="inline-flex h-7 cursor-not-allowed items-center gap-1.5 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase text-[var(--avy-muted)] opacity-60"
          style={{ letterSpacing: "0.04em" }}
        >
          ＋ Invite new agent
        </button>
      </footer>
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        "border-b border-[var(--avy-line-soft)] bg-[rgba(250,248,241,0.6)] px-4 py-2.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)] whitespace-nowrap",
        align === "right" ? "text-right" : "text-left"
      )}
      style={{ letterSpacing: "0.12em" }}
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
