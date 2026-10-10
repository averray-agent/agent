export function createAdminArrivalAlertRoutes({ authMiddleware, respond, arrivalAlerts }) {
  return async function handleAdminArrivalAlertRoute({ request, response, url, pathname }) {
    if (request.method !== "GET" || pathname !== "/admin/arrivals/alerts") return false;
    await authMiddleware(request, url, {
      requireCapabilities: ["admin:status", "ops:view"]
    });
    const body = await arrivalAlerts.list();
    respond(response, body.unavailable ? 503 : 200, body, { "cache-control": "no-store" });
    return true;
  };
}
