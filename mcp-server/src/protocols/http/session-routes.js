import { normalizeError } from "../../core/errors.js";

export function createSessionRoutes({
  authMiddleware,
  ensureSessionOwnership,
  respond,
  service,
}) {
  return async function handleSessionRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/session/state-machine") {
      respond(
        response,
        200,
        service.getSessionStateMachine(),
        { "cache-control": "public, max-age=300" }
      );
      return true;
    }

    if (request.method === "GET" && pathname === "/session") {
      const auth = await authMiddleware(request, url);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      try {
        const session = await ensureSessionOwnership(sessionId, auth.wallet);
        respond(response, 200, session);
        return true;
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "session_not_found") {
          respond(response, 404, { status: "not_found", sessionId });
          return true;
        }
        throw normalized;
      }
    }

    if (request.method === "GET" && pathname === "/session/timeline") {
      const auth = await authMiddleware(request, url);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      await ensureSessionOwnership(sessionId, auth.wallet);
      respond(response, 200, await service.getSessionTimeline(sessionId));
      return true;
    }

    if (request.method === "GET" && pathname === "/sessions") {
      const auth = await authMiddleware(request, url);
      const limit = Number(url.searchParams.get("limit") ?? 8);
      const jobId = url.searchParams.get("jobId") ?? undefined;
      respond(
        response,
        200,
        await service.listSessionHistory({
          wallet: auth.wallet,
          limit: Number.isFinite(limit) ? limit : 8,
          jobId
        })
      );
      return true;
    }

    return false;
  };
}
