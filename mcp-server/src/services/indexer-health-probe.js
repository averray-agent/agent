const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_LAG_BUDGET_SECONDS = 600;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveIndexerHealthProbeConfig(env = process.env) {
  const statusUrl = env.INDEXER_STATUS_URL?.trim() || undefined;
  return {
    statusUrl,
    detailsUrl: env.INDEXER_DETAILS_URL?.trim() || rootUrlFor(statusUrl),
    timeoutMs: positiveNumber(env.INDEXER_HEALTH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    lagBudgetSeconds: positiveNumber(
      env.INDEXER_LAG_BUDGET_SECONDS,
      DEFAULT_LAG_BUDGET_SECONDS
    )
  };
}

export function createIndexerHealthProbe({
  statusUrl,
  detailsUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  lagBudgetSeconds = DEFAULT_LAG_BUDGET_SECONDS,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!statusUrl) {
    return async () => ({ ok: false, reason: "indexer_status_url_unconfigured" });
  }

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
      const recovery = await readRecoveryDetails(detailsUrl, fetchImpl, timeoutMs);
      return {
        ok: true,
        ...latest,
        lagBudgetSeconds,
        ...(recovery ? { recovery } : {})
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

function rootUrlFor(statusUrl) {
  if (!statusUrl) return undefined;
  try {
    return new URL("/", statusUrl).toString();
  } catch {
    return undefined;
  }
}

async function readRecoveryDetails(detailsUrl, fetchImpl, timeoutMs) {
  if (!detailsUrl) return undefined;
  try {
    const response = await fetchImpl(detailsUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return undefined;
    const payload = await response.json();
    return payload?.recovery && typeof payload.recovery === "object"
      ? payload.recovery
      : undefined;
  } catch {
    return undefined;
  }
}

export function createConfiguredIndexerHealthProbe(env = process.env, options = {}) {
  return createIndexerHealthProbe({
    ...resolveIndexerHealthProbeConfig(env),
    ...options
  });
}
