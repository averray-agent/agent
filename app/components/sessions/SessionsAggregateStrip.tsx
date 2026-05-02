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
      <SettleTimeCard sessions={settled} />
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

/**
 * "Avg settle time" card — derived from real claimedAt → settledAt
 * deltas across the settled rows in scope. Falls back to an honest
 * `—` when:
 *   - no rows are in the `settled` state, or
 *   - settled rows exist but the row adapter didn't surface the raw
 *     claimedAt / settledAt pair (older sessions before the
 *     timestamps field was plumbed; renders as "n timestamp(s) missing"
 *     so the gap is visible to the operator).
 *
 * Median is the headline value (resilient to one outlier dominating
 * the average). p50 / p95 are also surfaced when ≥ 2 / ≥ 5 settled
 * rows are available, so an auditor can see tail latency at a glance.
 */
function SettleTimeCard({ sessions }: { sessions: SessionDetail[] }) {
  if (sessions.length === 0) {
    return (
      <Card
        label="Median settle time"
        value="—"
        meta="no settlements in scope"
        tone="muted"
      />
    );
  }

  const durations: number[] = [];
  let missing = 0;
  for (const session of sessions) {
    const claimed = session.timestamps?.claimedAt;
    const settled = session.timestamps?.settledAt;
    if (!claimed || !settled) {
      missing += 1;
      continue;
    }
    const claimedTs = Date.parse(claimed);
    const settledTs = Date.parse(settled);
    if (!Number.isFinite(claimedTs) || !Number.isFinite(settledTs) || settledTs < claimedTs) {
      missing += 1;
      continue;
    }
    durations.push(settledTs - claimedTs);
  }

  if (durations.length === 0) {
    return (
      <Card
        label="Median settle time"
        value="—"
        meta={
          missing > 0
            ? `${missing} timestamp${missing === 1 ? "" : "s"} missing`
            : "no settlements in scope"
        }
        tone="muted"
      />
    );
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const p95 = sorted.length >= 5 ? percentile(sorted, 0.95) : undefined;
  const headline = formatDurationCompact(median);
  // Compose meta: "p50 14m · p95 18m" when we have enough rows,
  // "n=1" when there's only one, plus a "k missing timestamps" tail
  // when the adapter dropped some rows.
  const metaParts: string[] = [];
  if (sorted.length >= 2) metaParts.push(`p50 ${formatDurationLong(median)}`);
  else metaParts.push(`n=${sorted.length}`);
  if (p95 !== undefined) metaParts.push(`p95 ${formatDurationLong(p95)}`);
  if (missing > 0) {
    metaParts.push(
      `${missing} missing timestamp${missing === 1 ? "" : "s"}`
    );
  }
  return (
    <Card
      label="Median settle time"
      value={headline.value}
      unit={headline.unit}
      meta={metaParts.join(" · ")}
      tone="muted"
    />
  );
}

/**
 * Linear-interpolated percentile over a sorted ascending array of
 * durations (ms). Stable for small samples — a typical operator view
 * has fewer than a dozen settled rows visible.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (sortedAsc.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

interface FormattedDuration {
  value: string;
  unit: string;
}

/**
 * Compact display ("3m 12s", "14m", "2h 4m"). Drops the smaller unit
 * once the duration crosses an hour so the headline number stays
 * readable at the card's 2rem display weight.
 */
function formatDurationCompact(ms: number): FormattedDuration {
  if (!Number.isFinite(ms) || ms < 0) return { value: "—", unit: "" };
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return { value: `${totalSeconds}`, unit: "s" };
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0
      ? { value: `${minutes}`, unit: "m" }
      : { value: `${minutes}m`, unit: `${seconds}s` };
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0
    ? { value: `${hours}`, unit: "h" }
    : { value: `${hours}h`, unit: `${remMinutes}m` };
}

/** Single-string variant for meta text — same buckets as the
 *  compact formatter but as one string ("3m 12s", "14m", "2h 4m"). */
function formatDurationLong(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
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
