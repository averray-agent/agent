const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_LAG_BUDGET_SECONDS = 600;
// How long the newest indexed block may stay the SAME before a lagging index
// is reported as stalled. A schema replay is old but advances every probe; the
// 2026-09-10 wedge sat on one block for ~10h with /health 200 throughout.
const DEFAULT_STALL_BUDGET_SECONDS = 900;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveIndexerHealthProbeConfig(env = process.env) {
  return {
    statusUrl: env.INDEXER_STATUS_URL?.trim() || undefined,
    timeoutMs: positiveNumber(env.INDEXER_HEALTH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    lagBudgetSeconds: positiveNumber(
      env.INDEXER_LAG_BUDGET_SECONDS,
      DEFAULT_LAG_BUDGET_SECONDS
    ),
    stallBudgetSeconds: positiveNumber(
      env.INDEXER_STALL_BUDGET_SECONDS,
      DEFAULT_STALL_BUDGET_SECONDS
    )
  };
}

export function createIndexerHealthProbe({
  statusUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  lagBudgetSeconds = DEFAULT_LAG_BUDGET_SECONDS,
  stallBudgetSeconds = DEFAULT_STALL_BUDGET_SECONDS,
  fetchImpl = globalThis.fetch,
  now = Date.now
} = {}) {
  if (!statusUrl) {
    return async () => ({ ok: false, reason: "indexer_status_url_unconfigured" });
  }

  // Ponder's /status exposes only the newest indexed block, so "stalled"
  // needs two samples: remember when the head last changed. Wall clock, not
  // block timestamps — a replay's head timestamps race forward while a
  // wedged sync's stand still. Any change (forward, or backward after a
  // schema rotation) counts as progress and resets the clock.
  let headProgress = null;

  return async function probeIndexerHealth() {
    try {
      const response = await fetchImpl(statusUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        return { ok: false, reason: "indexer_status_http_error", statusCode: response.status };
      }

      const payload = await response.json();
      const heads = Object.entries(payload ?? {}).flatMap(([network, value]) => {
        const blockNumber = value?.block?.number;
        const blockTimestamp = value?.block?.timestamp;
        if (
          !Number.isSafeInteger(blockNumber)
          || blockNumber < 0
          || !Number.isFinite(blockTimestamp)
          || blockTimestamp <= 0
        ) {
          return [];
        }
        return [{ network, blockNumber, blockTimestamp }];
      });
      if (heads.length === 0) {
        return { ok: false, reason: "indexer_status_missing_checkpoint" };
      }

      const latest = heads.reduce((current, candidate) => (
        candidate.blockTimestamp > current.blockTimestamp ? candidate : current
      ));
      const observedAtMs = now();
      if (!headProgress || headProgress.blockNumber !== latest.blockNumber) {
        headProgress = { blockNumber: latest.blockNumber, observedAtMs };
      }
      return {
        ok: true,
        ...latest,
        lagBudgetSeconds,
        stallBudgetSeconds,
        headUnchangedSeconds: Math.max(0, Math.floor((observedAtMs - headProgress.observedAtMs) / 1000))
      };
    } catch (error) {
      return {
        ok: false,
        reason: error?.name === "TimeoutError"
          ? "indexer_status_timeout"
          : "indexer_status_unavailable"
      };
    }
  };
}

export function createConfiguredIndexerHealthProbe(env = process.env, options = {}) {
  return createIndexerHealthProbe({
    ...resolveIndexerHealthProbeConfig(env),
    ...options
  });
}
