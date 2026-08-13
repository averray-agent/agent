export function createAdminTreasuryRoutes({ authMiddleware, respond, treasurySummary }) {
  return async function handleAdminTreasuryRoute({ request, response, url, pathname }) {
    if (request.method !== "GET" || pathname !== "/admin/treasury/summary") return false;
    const auth = await authMiddleware(request, url, { requireRole: "admin" });
    respond(response, 200, await treasurySummary.getSummary(auth.wallet));
    return true;
  };
}
