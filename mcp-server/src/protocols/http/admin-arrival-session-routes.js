export function createAdminArrivalSessionRoutes({
  authMiddleware,
  respond,
  sessionTrail,
  parseLimit
}) {
  return async function handleAdminArrivalSessionRoute({ request, response, url, pathname }) {
    if (request.method !== "GET" || pathname !== "/admin/arrivals/sessions") return false;
    await authMiddleware(request, url, {
      requireCapabilities: ["admin:status", "ops:view"]
    });
    const id = url.searchParams.get("id")?.trim();
    if (id) {
      const body = await sessionTrail.get(id);
      if (body?.unavailable) {
        respond(response, 503, body, { "cache-control": "no-store" });
        return true;
      }
      if (!body) {
        respond(response, 404, { error: "not_found" }, { "cache-control": "no-store" });
        return true;
      }
      respond(response, 200, body, { "cache-control": "no-store" });
      return true;
    }
    const limit = parseLimit(url, 50, 100);
    const body = await sessionTrail.list({ limit });
    respond(response, body.unavailable ? 503 : 200, body, { "cache-control": "no-store" });
    return true;
  };
}
