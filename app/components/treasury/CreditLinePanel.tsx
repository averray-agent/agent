import type { ReactNode } from "react";
import { TreasuryPanel } from "./TreasuryPanel";

export interface ActiveLoan {
  id: string;
  name: string;
  sub: string;
  amount: string;
  amountUnit: string;
}

export interface CreditLinePanelProps {
  capacityUsed: string;
  capacityTotal: string;
  usedPct: number;
  headerPct: number;
  headroom: ReactNode;
  nextMark: string;
  loans: ActiveLoan[];
  policyCap: string;
}

export function CreditLinePanel({
  capacityUsed,
  capacityTotal,
  usedPct,
  headerPct,
  headroom,
  nextMark,
  loans,
  policyCap,
}: CreditLinePanelProps) {
  return (
    <TreasuryPanel
      eyebrow="Credit line"
      title="Borrowing against collateral"
      sub={`policy cap · ${policyCap}`}
    >
      <div className="grid gap-3.5 p-4">
        <div className="grid gap-2">
          <div className="flex items-baseline justify-between">
            <span
              className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
              style={{ letterSpacing: "0.12em" }}
            >
              Capacity used
            </span>
            <span className="font-[family-name:var(--font-mono)] text-[20px] tabular-nums text-[var(--avy-ink)]">
              {capacityUsed}{" "}
              <span className="text-sm text-[var(--avy-muted)]">/ {capacityTotal}</span>
            </span>
          </div>
          <div className="flex h-2 overflow-hidden rounded-[4px] bg-[color:rgba(17,19,21,0.08)]">
            <span
              className="block h-full bg-[var(--avy-accent)]"
              style={{ width: `${usedPct}%` }}
            />
            <span
              className="block h-full bg-[var(--avy-accent-soft)]"
              style={{ width: `${headerPct}%` }}
            />
          </div>
          <div className="flex justify-between font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]">
            <span>
              Headroom{" "}
              <b className="font-semibold text-[var(--avy-ink)]">{headroom}</b>
            </span>
            <span>Next mark-to-market · {nextMark}</span>
          </div>
        </div>

        <div className="grid gap-2.5 border-t border-[var(--avy-line-soft)] pt-3">
          {loans.length === 0 ? (
            <p
              className="m-0 rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] px-3 py-3 text-center font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              No active loans against this credit line.
            </p>
          ) : (
            loans.map((loan) => <LoanRow key={loan.id} loan={loan} />)
          )}
        </div>
      </div>
    </TreasuryPanel>
  );
}

function LoanRow({ loan }: { loan: ActiveLoan }) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-2.5">
      <div>
        <div className="font-[family-name:var(--font-display)] text-[13px] font-semibold text-[var(--avy-ink)]">
          {loan.name}
        </div>
        <div
          className="mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {loan.sub}
        </div>
      </div>
      <div className="text-right">
        <div className="font-[family-name:var(--font-mono)] text-[13px] tabular-nums text-[var(--avy-ink)]">
          {loan.amount}
        </div>
        <div
          className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {loan.amountUnit}
        </div>
      </div>
      <button
        type="button"
        disabled
        title="Loan repayment is not yet wired to a live backend."
        className="cursor-not-allowed rounded-[6px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2.5 py-1 font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase text-[var(--avy-muted)] opacity-60"
        style={{ letterSpacing: "0.08em" }}
      >
        Repay
      </button>
    </div>
  );
}
