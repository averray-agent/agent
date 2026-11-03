export function createAdminReserveRoutes({ authMiddleware, reserveBreakdown, respond }) {
  return async function handleAdminReserveRoute({ request, response, url, pathname }) {
    if (request.method !== "GET" || pathname !== "/admin/ops/reserve-breakdown") return false;
    await authMiddleware(request, url, { requireCapability: "ops:view" });
    const body = await reserveBreakdown.getBreakdown();
    respond(response, body.status === "ok" ? 200 : 503, body, { "cache-control": "no-store" });
    return true;
  };
}
