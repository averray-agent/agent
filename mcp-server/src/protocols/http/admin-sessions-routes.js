import { OperatorOverturnService } from "../../services/operator-overturn-service.js";

export function createAdminSessionsRoutes({
  authMiddleware,
  parseLimit,
  respond,
  service,
  stateStore, gateway, eventBus, readJsonBody,
}) {
  const overturnService = new OperatorOverturnService({ stateStore, gateway, eventBus });
  return async function handleAdminSessionsRoute({ request, response, url, pathname }) {
    if (request.method === "POST" && pathname === "/admin/sessions/overturn") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      const payload = await readJsonBody(request);
      const session = await overturnService.overturn({ sessionId: payload?.sessionId, rationale: payload?.rationale, operator: auth.wallet });
      respond(response, 200, session);
      return true;
    }
    if (request.method === "GET" && pathname === "/admin/sessions") {
      await authMiddleware(request, url, { requireCapability: "ops:view" });
      const limit = parseLimit(url, 50, 250);
      const jobId = url.searchParams.get("jobId") ?? undefined;
      const sessions = jobId
        ? await service.listSessionHistory({ jobId, limit, progression: false })
        : await service.listRecentSessions(limit, { progression: false });
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
