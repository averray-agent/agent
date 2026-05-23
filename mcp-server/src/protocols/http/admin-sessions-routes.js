export function createAdminSessionsRoutes({
  authMiddleware,
  parseLimit,
  respond,
  service,
}) {
  return async function handleAdminSessionsRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/admin/sessions") {
      await authMiddleware(request, url, { requireRole: "admin" });
      const limit = parseLimit(url, 50, 250);
      const jobId = url.searchParams.get("jobId") ?? undefined;
      const sessions = jobId
        ? await service.listSessionHistory({ jobId, limit })
        : await service.listRecentSessions(limit);
      respond(response, 200, {
        sessions,
        count: sessions.length,
        limit,
        ...(jobId ? { jobId } : {}),
        scope: "operator"
      });
      return true;
    }

    return false;
  };
}
