import { cn } from "@/lib/utils/cn";
import type { PayoutEntry } from "./types";

const ROLE_LABEL: Record<PayoutEntry["role"], string> = {
  worker: "Worker",
  verifier: "Verifier",
  "co-signer": "Co-signer",
  treasury: "Treasury",
};

export function PayoutTrail({ payouts }: { payouts: PayoutEntry[] }) {
  if (payouts.length === 0) {
    return (
      <p
        className="m-0 rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] px-3 py-2.5 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        No payouts recorded. Stake stays frozen while the session is open or disputed.
      </p>
    );
  }
  return (
    <ul className="m-0 flex flex-col gap-1.5 p-0">
      {payouts.map((p, i) => (
        <li
          key={i}
          className="grid items-center gap-3 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-2.5"
          style={{ gridTemplateColumns: "90px 1fr auto auto" }}
        >
          <span
            className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
            style={{ letterSpacing: "0.12em" }}
          >
            {ROLE_LABEL[p.role]}
          </span>
          <span
            className="font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--avy-ink)]"
            style={{ letterSpacing: 0 }}
          >
            {p.party}
          </span>
          <span
            className={cn(
              "font-[family-name:var(--font-mono)] text-[12.5px] tabular-nums",
              p.at === "pending" ? "text-[var(--avy-muted)]" : "text-[var(--avy-ink)]"
            )}
            style={{ letterSpacing: 0 }}
          >
            {p.amount}
          </span>
          <span
            className={cn(
              "font-[family-name:var(--font-mono)] text-[11.5px]",
              p.at === "pending" ? "text-[var(--avy-warn)]" : "text-[var(--avy-muted)]"
            )}
            style={{ letterSpacing: 0 }}
          >
            {p.at}
            {p.tx !== "—" ? (
              <span className="ml-1.5 text-[var(--avy-accent)]">· {p.tx}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
