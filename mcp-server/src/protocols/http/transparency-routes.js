const FALLBACK_CACHE_TTL_MS = 15_000;

/**
 * GET /transparency is deliberately public.
 *
 * Every field in this payload is derived from state anyone can already read
 * directly from the chain — balances, the escrow contract, the armed wrapper,
 * settlement counts. Gating it would not keep anything secret; it would only
 * hide it from the people it is published for. The public record page at
 * averray.com/transparency is the primary consumer and holds no session.
 *
 * The service coalesces reads behind its own short-lived cache, so the
 * response carries a matching cache-control derived from that same TTL —
 * the two cannot drift apart.
 */
export function createTransparencyRoutes({ respond, transparencyService }) {
  return async function handleTransparencyRoute({ request, response, pathname }) {
    if (request.method !== "GET" || pathname !== "/transparency") return false;

    const snapshot = await transparencyService.getSnapshot();
    respond(response, 200, snapshot, {
      "cache-control": `public, max-age=${resolveMaxAgeSeconds(transparencyService)}`
    });
    return true;
  };
}

function resolveMaxAgeSeconds(transparencyService) {
  const ttlMs = Number(transparencyService?.cacheTtlMs);
  const resolved = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : FALLBACK_CACHE_TTL_MS;
  return Math.max(1, Math.round(resolved / 1000));
}
