import { ValidationError, normalizeError } from "../../core/errors.js";

export function createBadgeRoutes({
  buildBadgeFromSession,
  deriveBadgeLineage,
  listBadgeReceipts,
  parseLimit,
  publicBaseUrl,
  posterAddress,
  respond,
  service,
  verifierAddress,
  verifierService,
}) {
  return async function handleBadgeRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/badges") {
      respond(response, 200, await listBadgeReceipts(parseLimit(url, 100, 500)), {
        "cache-control": "public, max-age=30"
      });
      return true;
    }

    if (request.method === "GET" && pathname.startsWith("/badges/")) {
      const sessionId = decodeURIComponent(pathname.slice("/badges/".length));
      if (!sessionId) {
        throw new ValidationError("sessionId path segment is required.");
      }

      let session;
      try {
        session = await service.resumeSession(sessionId);
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "session_not_found") {
          respond(response, 404, { status: "not_found", sessionId });
          return true;
        }
        throw normalized;
      }

      const verification = await verifierService.getResult(sessionId);
      const job = service.getJobDefinition(session.jobId);
      try {
        const badge = buildBadgeFromSession({
          session,
          job,
          verification,
          context: {
            publicBaseUrl,
            posterAddress,
            verifierAddress,
            lineage: deriveBadgeLineage(session, job)
          }
        });
        // Badge JSON is deterministic once a session is resolved.
        respond(response, 200, badge, { "cache-control": "public, max-age=60" });
        return true;
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "badge_not_ready") {
          respond(response, 404, { status: "not_ready", sessionId, reason: normalized.message });
          return true;
        }
        throw normalized;
      }
    }

    return false;
  };
}
