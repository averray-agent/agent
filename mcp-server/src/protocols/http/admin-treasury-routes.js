export function createAdminTreasuryRoutes({ authMiddleware, respond, treasurySummary }) {
  return async function handleAdminTreasuryRoute({ request, response, url, pathname }) {
    if (request.method !== "GET" || pathname !== "/admin/treasury/summary") return false;
    const auth = await authMiddleware(request, url, {
      requireCapabilities: ["admin:status", "ops:view"]
    });
    respond(response, 200, await treasurySummary.getSummary(auth.wallet));
    return true;
  };
}
