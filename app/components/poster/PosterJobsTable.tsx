"use client";

import { ExplorerLink } from "@/components/common/ExplorerLink";
import { shortAddress } from "@/lib/format";
import type { PosterJobRow, StateTone } from "@/lib/api/poster-adapters";
import { cn } from "@/lib/utils/cn";

const TONE_CLASS: Record<StateTone, string> = {
  ok: "border-[rgba(30,102,66,0.35)] bg-[rgba(30,102,66,0.08)] text-[#1e6642]",
  neutral: "border-[var(--avy-line)] bg-[#faf8f1] text-[var(--avy-ink)]",
  warn: "border-[var(--avy-warn)] bg-[var(--avy-warn-soft)] text-[var(--avy-ink)]",
  muted: "border-[var(--avy-line-soft)] bg-transparent text-[var(--avy-muted)]",
  bad: "border-[rgba(178,34,34,0.4)] bg-[rgba(178,34,34,0.08)] text-[#b22222]",
};

function StateChip({ label, tone }: { label: string; tone: StateTone }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2.5 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
        TONE_CLASS[tone]
      )}
      style={{ letterSpacing: "0.1em" }}
    >
      {label}
    </span>
  );
}

const TH_CLASS =
  "border-b border-[var(--avy-line-soft)] bg-[#faf8f1] px-4 py-2.5 text-left font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)] whitespace-nowrap";
const TD_CLASS = "border-b border-[var(--avy-line-soft)] px-4 py-3 align-middle";

export function PosterJobsTable({
  rows,
  externalTotal,
  wallet,
  loading,
}: {
  rows: PosterJobRow[];
  externalTotal: number;
  wallet: string | null;
  loading: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] shadow-[var(--shadow-card)] backdrop-blur-[10px]">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-[family-name:var(--font-body)] text-[13px]">
          <thead>
            <tr>
              {["Job", "Status", "Reward", "Claim bond*", "Funded", "Claimed by"].map(
                (label) => (
                  <th key={label} className={TH_CLASS} style={{ letterSpacing: "0.12em" }}>
                    {label}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="transition-colors hover:bg-[rgba(255,252,240,0.75)]">
                <td className={TD_CLASS}>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-[var(--avy-ink)]">{row.title}</span>
                    <span className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]">
                      {row.id.slice(0, 10)}…{row.id.slice(-6)}
                    </span>
                  </div>
                </td>
                <td className={TD_CLASS}>
                  <StateChip label={row.stateLabel} tone={row.stateTone} />
                </td>
                <td className={cn(TD_CLASS, "font-[family-name:var(--font-mono)] text-[12px]")}>
                  {row.rewardLabel ?? "—"}
                </td>
                <td className={cn(TD_CLASS, "font-[family-name:var(--font-mono)] text-[12px]")}>
                  {row.bondLabel ?? "—"}
                </td>
                <td className={cn(TD_CLASS, "font-[family-name:var(--font-mono)] text-[12px]")}>
                  {row.fundedTxHash ? (
                    <div className="flex flex-col gap-0.5">
                      <ExplorerLink kind="tx" value={row.fundedTxHash} />
                      {row.fundedAt ? (
                        <span className="text-[11px] text-[var(--avy-muted)]">
                          {row.fundedAt.slice(0, 10)}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    "—"
                  )}
                </td>
                <td className={cn(TD_CLASS, "font-[family-name:var(--font-mono)] text-[12px]")}>
                  {row.claimedBy ? shortAddress(row.claimedBy) : "unclaimed"}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="p-8 text-center font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
                >
                  {loading
                    ? "Loading external jobs…"
                    : !wallet
                      ? "Sign in to see jobs posted by your wallet."
                      : externalTotal > 0
                        ? `No external jobs posted by ${shortAddress(wallet)}. ${externalTotal} external job${externalTotal === 1 ? "" : "s"} from other posters ${externalTotal === 1 ? "is" : "are"} in the catalog.`
                        : "No external jobs in the catalog yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="border-t border-[var(--avy-line-soft)] px-4 py-2 font-[family-name:var(--font-body)] text-[11px] text-[var(--avy-muted)]">
        *Claim bond is the live policy estimate the catalog publishes; the
        per-wallet truth for any worker is <span className="font-[family-name:var(--font-mono)]">GET /jobs/preflight?jobId=…</span>.
        Settlement figures (worker payout, protocol fee, resolution tx) are not
        part of the catalog projection — receipts and the chain remain their
        source of truth.
      </p>
    </div>
  );
}
