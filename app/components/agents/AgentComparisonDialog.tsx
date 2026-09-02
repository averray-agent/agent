"use client";

import { Download } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BADGES, type AgentRecord } from "./types";
import {
  buildComparisonRows,
  comparisonToCsv,
  comparisonCsvFilename,
} from "@/lib/ui/agent-comparison";

function shortWallet(wallet: string): string {
  return wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;
}

/** Flatten an AgentRecord into the comparison shape, resolving badge ids
 *  to human labels (the BADGES map lives in this .ts module). */
function toComparisonAgent(agent: AgentRecord) {
  return {
    handle: agent.handle,
    walletFull: agent.walletFull,
    tier: agent.tier,
    score: agent.score,
    specialty: agent.specialty,
    badges: agent.badges.map((id) => BADGES[id]?.name ?? id),
    recentActivity: agent.activity?.msg
      ? `${agent.activity.msg}${agent.activity.when ? ` · ${agent.activity.when}` : ""}`
      : "",
    stakeDeposited: agent.stake.deposited,
    stakeLocked: agent.stake.locked,
    slashed30: agent.stake.slashed30,
    delegated: agent.lineageStats?.delegated ?? 0,
    subcontracted: agent.lineageStats?.subcontracted ?? 0,
  };
}

export function AgentComparisonDialog({
  open,
  onClose,
  agents,
}: {
  open: boolean;
  onClose: () => void;
  agents: AgentRecord[];
}) {
  const comparison = agents.map(toComparisonAgent);
  const rows = buildComparisonRows(comparison);

  function exportCsv() {
    const csv = comparisonToCsv(comparison);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = comparisonCsvFilename(new Date().toISOString().slice(0, 10));
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[88vh] max-w-[min(980px,94vw)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Compare agents</DialogTitle>
          <p className="text-sm text-[var(--avy-muted)]">
            Side-by-side reputation, badges, and recent activity for the selected
            agents.
          </p>
        </DialogHeader>

        {comparison.length < 2 ? (
          <p className="py-6 text-center text-sm text-[var(--avy-muted)]">
            Select at least two agents to compare.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className="w-[190px] border-b border-[var(--avy-line-soft)] px-3 py-2.5" />
                    {comparison.map((agent) => (
                      <th
                        key={agent.walletFull}
                        scope="col"
                        className="border-b border-[var(--avy-line-soft)] px-3 py-2.5 text-left align-bottom"
                      >
                        <div className="font-[family-name:var(--font-display)] text-[14px] font-semibold leading-tight text-[var(--avy-ink)]">
                          {agent.handle}
                        </div>
                        <div
                          className="mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                          style={{ letterSpacing: 0 }}
                        >
                          {shortWallet(agent.walletFull)}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key} className="border-t border-[var(--avy-line-soft)]">
                      <th
                        scope="row"
                        className="px-3 py-2 text-left align-top font-[family-name:var(--font-display)] text-[11.5px] font-semibold uppercase text-[var(--avy-muted)]"
                        style={{ letterSpacing: "0.04em" }}
                      >
                        {row.label}
                      </th>
                      {row.values.map((value, index) => (
                        <td
                          key={comparison[index].walletFull}
                          className="px-3 py-2 align-top text-[var(--avy-ink)]"
                          style={
                            row.key === "walletFull" || row.key === "recentActivity"
                              ? { letterSpacing: 0 }
                              : undefined
                          }
                        >
                          <span
                            className={
                              row.key === "walletFull"
                                ? "break-all font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-accent)]"
                                : undefined
                            }
                          >
                            {value}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={exportCsv}
                className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-1.5 font-[family-name:var(--font-display)] text-[12px] font-bold uppercase text-[var(--avy-ink)] transition-colors hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)]"
                style={{ letterSpacing: "0.04em" }}
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                Export CSV
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
