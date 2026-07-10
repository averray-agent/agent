import type { ReactNode } from "react";
import { FEED_STATE_LABEL } from "@/lib/api/feed-presence";
import { TreasuryPanel } from "./TreasuryPanel";

type CreditFeedPresence = "live" | "loading" | "locked" | "down";

export interface ActiveLoan {
  id: string;
  name: string;
  sub: string;
  amount: string;
  amountUnit: string;
}

export interface CreditLinePanelProps {
  presence: CreditFeedPresence;
  capacityAvailable: boolean;
  capacityUsed: string;
  capacityTotal: string;
  usedPct: number;
  headerPct: number;
  headroom: ReactNode;
  loans: ActiveLoan[];
}

export function CreditLinePanel({
  presence,
  capacityAvailable,
  capacityUsed,
  capacityTotal,
  usedPct,
  headerPct,
  headroom,
  loans,
}: CreditLinePanelProps) {
  return (
    <TreasuryPanel
      eyebrow="Credit line"
      title="Borrowing against collateral"
      sub="cap not emitted by API yet"
    >
      {presence !== "live" ? (
        <CreditFeedNotice presence={presence} />
      ) : !capacityAvailable ? (
        <div className="p-4">
          <p className="m-0 rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] px-3 py-4 text-center font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]">
            Borrow capacity not emitted by API yet.
          </p>
        </div>
      ) : (
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
      )}
    </TreasuryPanel>
  );
}

function CreditFeedNotice({ presence }: { presence: Exclude<CreditFeedPresence, "live"> }) {
  const detail =
    presence === "loading"
      ? "Waiting for the first borrow-capacity response."
      : "Capacity figures are hidden until the borrow-capacity feed recovers.";
  return (
    <div className="p-4">
      <p className="m-0 rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] px-3 py-4 text-center font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]">
        Borrow-capacity feed · {FEED_STATE_LABEL[presence]}. {detail}
      </p>
    </div>
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
