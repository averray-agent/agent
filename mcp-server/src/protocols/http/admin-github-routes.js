export function createAdminGithubRoutes({
  authMiddleware,
  parseLimit,
  respond,
  service,
}) {
  return async function handleAdminGithubRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/admin/github/status") {
      await authMiddleware(request, url, { requireRole: "admin" });
      respond(response, 200, await service.getGithubOperatorStatus({
        repos: url.searchParams.has("repos") ? url.searchParams.get("repos") : undefined,
        limit: parseLimit(url, 5, 20),
        view: url.searchParams.get("view") ?? undefined
      }));
      return true;
    }

    return false;
  };
}
