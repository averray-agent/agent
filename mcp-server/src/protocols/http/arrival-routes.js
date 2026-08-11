/**
 * GET /monitor/arrivals — what has reached the MCP front door.
 *
 * Public, following /monitor/bank-feed. That is the reason the observatory
 * hashes IP addresses rather than storing them: everything here is
 * world-readable, so it holds only self-declared client identity and counts.
 *
 * The ops monitor polls this to render the arrival funnel.
 */
export function createArrivalRoutes({
  respond,
  arrivalObservatory,
  arrivalCanaryMarkers,
  authMiddleware,
  enforceLimit,
  rateLimitConfig,
  readJsonBody
}) {
  return async function handleArrivalRoute({ request, response, url, pathname }) {
    if (request.method === "POST" && pathname === "/admin/arrivals/canary-marker") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const marker = await arrivalCanaryMarkers.issue(payload?.wallet);
      respond(response, 201, marker, { "cache-control": "no-store" });
      return true;
    }

    if (request.method !== "GET" || pathname !== "/monitor/arrivals") return false;

    respond(response, 200, await arrivalObservatory.getSnapshot(), {
      "cache-control": "public, max-age=10"
    });
    return true;
  };
}
