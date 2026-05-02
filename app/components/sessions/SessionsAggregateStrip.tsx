import { cn } from "@/lib/utils/cn";
import type { SessionDetail } from "./types";

/**
 * Top-of-page aggregate cards for the Sessions surface.
 *
 * Every value is derived from the live SessionDetail[]. When something
 * isn't computable from what we have today (e.g. median settle time
 * needs raw claim/settle timestamps that the row adapter doesn't carry
 * yet), the card shows an honest `—` placeholder with a meta line
 * that explains the gap, instead of the previous fixture string. Same
 * principle as the rest of the operator dashboard: zero stays zero,
 * unknown stays unknown.
 */
export function SessionsAggregateStrip({ sessions }: { sessions: SessionDetail[] }) {
  // Sessions still in flight — claimed or submitted but not yet
  // settled or anomalous. Aliased to "in flight" instead of the old
  // "24h funded" framing, which implied a 24h window we never
  // filtered to.
  const inFlight = sessions.filter(
    (s) => s.state === "active" || s.state === "submitted"
  );
  const settled = sessions.filter((s) => s.state === "settled");
  const anomalies = sessions.filter(
    (s) => s.state === "disputed" || s.state === "slashed" || s.state === "rejected"
  );

  // Total escrow currently locked across in-flight rows, grouped by
  // asset. Multi-asset stacks render as `4.00 DOT · 12.00 USDC`.
  const inFlightEscrow = sumEscrowByAsset(inFlight);
  const settledEscrow = sumEscrowByAsset(settled);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Card
        label="In flight"
        value={`${inFlight.length}`}
        unit={inFlight.length === 1 ? "session" : "sessions"}
        meta={
          inFlightEscrow.length
            ? `${formatEscrowList(inFlightEscrow)} locked`
            : sessions.length === 0
              ? "no sessions observed yet"
              : "no escrow currently locked"
        }
        tone={inFlight.length > 0 ? "ok" : "muted"}
      />
      <Card
        label="Settled"
        value={`${settled.length}`}
        unit={settled.length === 1 ? "session" : "sessions"}
        meta={
          settledEscrow.length
            ? `${formatEscrowList(settledEscrow)} paid out`
            : "no settlements in scope"
        }
        tone={settled.length > 0 ? "ok" : "muted"}
      />
      <Card
        label="Avg settle time"
        // Median/avg requires raw claimedAt → settledAt timestamps,
        // which the SessionRow adapter doesn't surface yet. Show an
        // honest placeholder rather than the previous fixture
        // "3m 12s · p50 2m40s · p95 8m02s".
        value="—"
        meta="raw timestamps not exposed yet"
        tone="muted"
      />
      <Card
        label="Open anomalies"
        value={`${anomalies.length}`}
        meta={anomalies.length > 0 ? "triage in /disputes" : "clean"}
        tone={anomalies.length > 0 ? "warn" : "ok"}
      />
    </div>
  );
}

interface CardProps {
  label: string;
  value: string;
  unit?: string;
  meta: string;
  tone?: "ok" | "warn" | "muted";
}

function Card({ label, value, unit, meta, tone = "muted" }: CardProps) {
  return (
    <article className="flex min-h-[96px] flex-col gap-1.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)] backdrop-blur-[8px]">
      <span
        className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.12em" }}
      >
        {label}
      </span>
      <span
        className={cn(
          "flex items-baseline gap-1.5 font-[family-name:var(--font-display)] text-[2rem] font-bold leading-none tabular-nums",
          value === "—" ? "text-[var(--avy-muted)]" : "text-[var(--avy-ink)]"
        )}
        style={{ letterSpacing: "-0.01em" }}
      >
        {value}
        {unit ? <span className="text-[13px] text-[var(--avy-muted)]">{unit}</span> : null}
      </span>
      <span
        className={cn(
          "flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11.5px]",
          tone === "ok" && "text-[var(--avy-accent)]",
          tone === "warn" && "text-[var(--avy-warn)]",
          tone === "muted" && "text-[var(--avy-muted)]"
        )}
        style={{ letterSpacing: 0 }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
        {meta}
      </span>
    </article>
  );
}

interface EscrowTotal {
  asset: string;
  amount: number;
}

/**
 * Sum escrow amounts grouped by asset. Returns an array sorted by
 * descending amount so the largest asset shows first when there are
 * mixed-asset sessions.
 */
function sumEscrowByAsset(sessions: SessionDetail[]): EscrowTotal[] {
  const totals = new Map<string, number>();
  for (const session of sessions) {
    const amount = Number(session.escrow.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    totals.set(session.escrow.asset, (totals.get(session.escrow.asset) ?? 0) + amount);
  }
  return Array.from(totals.entries())
    .map(([asset, amount]) => ({ asset, amount }))
    .sort((a, b) => b.amount - a.amount);
}

function formatEscrowList(totals: EscrowTotal[]): string {
  return totals
    .map((entry) => `${formatAmount(entry.amount)} ${entry.asset}`)
    .join(" · ");
}

function formatAmount(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  if (value < 1) return value.toFixed(2);
  return value.toFixed(value < 100 ? 2 : 0);
}
