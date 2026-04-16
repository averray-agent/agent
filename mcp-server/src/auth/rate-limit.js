import { RateLimitError } from "../core/errors.js";

/**
 * Build a rate-limit enforcer bound to a state store.
 *
 * Usage:
 *   const enforce = createRateLimiter({ stateStore });
 *   await enforce("auth_nonce", clientKey, { limit: 10, windowSeconds: 60 });
 *
 * Throws `RateLimitError` (HTTP 429) when the window count exceeds `limit`.
 * Non-throw mode is available via `{ throwOnLimit: false }` for callers that
 * want to surface soft-limit warnings instead.
 */
export function createRateLimiter({ stateStore, logger = console } = {}) {
  if (!stateStore || typeof stateStore.consumeRateLimit !== "function") {
    throw new Error("createRateLimiter requires a state store with consumeRateLimit(bucket, key, opts).");
  }

  return async function enforce(bucket, key, { limit, windowSeconds, throwOnLimit = true } = {}) {
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(`Rate limit must be a positive number; got ${limit}.`);
    }
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      throw new Error(`Rate limit window must be positive seconds; got ${windowSeconds}.`);
    }
    const safeKey = String(key || "anonymous").slice(0, 128);
    const result = await stateStore.consumeRateLimit(bucket, safeKey, { limit, windowSeconds });
    if (!result.allowed && throwOnLimit) {
      logger.warn?.(
        { bucket, clientKey: safeKey, count: result.count, limit, windowSeconds },
        "rate-limit.exceeded"
      );
      throw new RateLimitError("Rate limit exceeded. Retry after the window resets.", {
        bucket,
        limit,
        remaining: 0,
        resetAt: new Date(result.resetAt).toISOString(),
        retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))
      });
    }
    return result;
  };
}

/**
 * Extract a stable client identifier from a Node http request. Prefers a
 * trusted X-Forwarded-For value when TRUST_PROXY is set, otherwise falls back
 * to the raw socket remote address.
 */
export function extractClientKey(request, { trustProxy = false } = {}) {
  if (trustProxy) {
    const header = request.headers?.["x-forwarded-for"];
    if (typeof header === "string" && header.length > 0) {
      const first = header.split(",")[0]?.trim();
      if (first) {
        return first;
      }
    }
  }
  return request.socket?.remoteAddress ?? "unknown";
}
