// Chain ticker — pure derivation for the operator rail's live block-height chip.
//
// Honesty contract (truth boundary): the HEIGHT is always the last value the
// backend's /health reported — it never counts up on its own in the browser.
// Only the AGE ticks, anchored to the backend's `asOf` (when it last read the
// chain). A stale read (asOf older than the freshness window) or a failing
// poll shows the chip as degraded and dulled — it never presents old data as a
// confidently-live chain, and never fabricates a height when none is reported.
//
// Kept pure (no Date.now, no DOM): callers pass `nowMs`, so every state is
// deterministic. `/health` shape consumed: components.blockchain.{ok,blockNumber,asOf}
// + auth.chainId + top-level status.

export type ChainTickerTone = "ok" | "degraded" | "awaiting";

// Mainnet chainId → short label. Anything else renders the raw id (honest: we
// don't pretend an unknown chain is something it isn't).
const CHAIN_LABELS: Record<number, string> = {
  420420419: "Polkadot Hub",
  420420417: "Paseo Hub",
};

// The backend refreshes /health frequently; a chain read older than this means
// the backend isn't advancing its view, so we stop showing a confident "ok".
export const CHAIN_TICKER_STALE_SECONDS = 120;

export interface ChainTickerView {
  kind: "ready" | "awaiting";
  /** e.g. "#18,863,947" — last reported height, never client-incremented. */
  heightLabel: string;
  /** e.g. "22s" / "4m" — age of the backend's chain read, ticking client-side. */
  ageLabel: string;
  ageSeconds: number;
  tone: ChainTickerTone;
  /** Chain name or raw id, e.g. "Polkadot Hub". */
  chainLabel: string;
  stale: boolean;
  /** Tooltip / aria text spelling out exactly what is shown. */
  title: string;
}

const NUM = new Intl.NumberFormat("en-US");

function formatAge(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function pickNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** Shape we read out of the /health payload — intentionally loose (the hook types it `unknown`). */
interface HealthLike {
  status?: unknown;
  auth?: { chainId?: unknown } | null;
  components?: { blockchain?: { ok?: unknown; blockNumber?: unknown; asOf?: unknown } | null } | null;
}

export function deriveChainTicker(input: {
  health: HealthLike | undefined;
  /** True when the /health poll itself is currently failing. */
  pollError?: boolean;
  nowMs: number;
}): ChainTickerView {
  const { health, pollError = false, nowMs } = input;
  const awaiting: ChainTickerView = {
    kind: "awaiting",
    heightLabel: "—",
    ageLabel: "",
    ageSeconds: 0,
    tone: "awaiting",
    chainLabel: "chain",
    stale: false,
    title: "Chain height not reported yet — awaiting the product's next health check.",
  };

  const bc = health?.components?.blockchain ?? undefined;
  const height = pickNumber(bc?.blockNumber);
  if (!health || height === undefined || height <= 0) return awaiting;

  const chainId = pickNumber(health.auth?.chainId);
  const chainLabel = chainId !== undefined ? CHAIN_LABELS[chainId] ?? `chain ${chainId}` : "chain";

  // Age is measured from the backend's own `asOf` (when it read the chain), so
  // the ticking number means "how old is the backend's view", not "since we
  // rendered". If asOf is missing/unparseable we can't claim freshness — treat
  // as stale rather than invent an age of 0.
  const asOfMs = typeof bc?.asOf === "string" ? Date.parse(bc.asOf) : NaN;
  const haveAsOf = Number.isFinite(asOfMs);
  const ageSeconds = haveAsOf ? Math.max(0, (nowMs - asOfMs) / 1000) : Number.POSITIVE_INFINITY;

  const blockchainOk = bc?.ok !== false;
  const statusOk = health.status === "ok";
  const stale = pollError || !haveAsOf || ageSeconds > CHAIN_TICKER_STALE_SECONDS;

  let tone: ChainTickerTone;
  if (!blockchainOk) tone = "degraded"; // backend itself says its chain component is unhealthy
  else if (stale) tone = "degraded"; // read too old / poll failing → not confidently live
  else if (!statusOk) tone = "degraded"; // overall product degraded
  else tone = "ok";

  const heightLabel = `#${NUM.format(Math.floor(height))}`;
  const ageLabel = haveAsOf ? formatAge(ageSeconds) : "stale";
  const title =
    `Block ${heightLabel} on ${chainLabel} — last height the product reported` +
    (haveAsOf ? ` · read ${ageLabel} ago` : " · read time unknown") +
    (stale ? " · READING STALE (chain view is not advancing or the poll is failing)" : "") +
    " · the height only changes when a new health check lands; it never counts up on its own.";

  return { kind: "ready", heightLabel, ageLabel, ageSeconds, tone, chainLabel, stale, title };
}
