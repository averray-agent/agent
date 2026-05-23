export function createActivityRoutes({
  authMiddleware,
  listAlerts,
  listAuditEvents,
  parseLimit,
  respond,
}) {
  return async function handleActivityRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/alerts") {
      await authMiddleware(request, url);
      respond(response, 200, await listAlerts(parseLimit(url, 20, 100)));
      return true;
    }

    if (request.method === "GET" && pathname === "/audit") {
      await authMiddleware(request, url);
      respond(response, 200, await listAuditEvents(parseLimit(url, 100, 500)));
      return true;
    }

    return false;
  };
}
