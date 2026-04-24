import { cn } from "@/lib/utils/cn";
import type { EscrowMovement } from "./types";

/**
 * Tightly-typed ledger of escrow movements for one session.
 * Presented as a small mono table; each row cites its tx hash and
 * tone-codes the movement (sage for lock/funded, warn for freeze,
 * deep-red for slash, neutral for settle).
 */
export function EscrowLedger({ movements }: { movements: EscrowMovement[] }) {
  if (movements.length === 0) {
    return (
      <p
        className="m-0 rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] px-3 py-2.5 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        No movements on this session yet.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)]">
      <header
        className="grid items-baseline gap-2 border-b border-[var(--avy-line-soft)] bg-[#faf8f1] px-3.5 py-2 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{
          gridTemplateColumns: "72px 140px 1fr 1fr 86px 80px",
          letterSpacing: "0.12em",
        }}
      >
        <span>When</span>
        <span>Event</span>
        <span>From</span>
        <span>To</span>
        <span className="text-right">Amount</span>
        <span>Tx</span>
      </header>
      <ul className="m-0 flex flex-col p-0">
        {movements.map((m, i) => (
          <li
            key={i}
            className="grid items-center gap-2 border-b border-[var(--avy-line-soft)] px-3.5 py-2.5 last:border-b-0"
            style={{
              gridTemplateColumns: "72px 140px 1fr 1fr 86px 80px",
            }}
          >
            <span
              className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              {m.at}
            </span>
            <span
              className={cn(
                "font-[family-name:var(--font-mono)] text-[11.5px] font-semibold",
                m.tone === "accent" && "text-[var(--avy-accent)]",
                m.tone === "warn" && "text-[var(--avy-warn)]",
                m.tone === "bad" && "text-[#8c2a17]",
                (!m.tone || m.tone === "neutral") && "text-[var(--avy-ink)]"
              )}
              style={{ letterSpacing: 0 }}
            >
              {m.label}
            </span>
            <span
              className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-ink)]"
              style={{ letterSpacing: 0 }}
            >
              {m.from}
            </span>
            <span
              className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-ink)]"
              style={{ letterSpacing: 0 }}
            >
              {m.to}
            </span>
            <span
              className="text-right font-[family-name:var(--font-mono)] text-[11.5px] tabular-nums text-[var(--avy-ink)]"
              style={{ letterSpacing: 0 }}
            >
              {m.amount}
            </span>
            <span
              className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-accent)]"
              style={{ letterSpacing: 0 }}
            >
              {m.tx}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
