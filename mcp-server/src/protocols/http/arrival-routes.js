/**
 * GET /monitor/arrivals — what has reached the MCP front door.
 *
 * Public, following /monitor/bank-feed. That is the reason the observatory
 * hashes IP addresses rather than storing them: everything here is
 * world-readable, so it holds only self-declared client identity and counts.
 *
 * The ops monitor polls this to render the arrival funnel.
 */
export function createArrivalRoutes({ respond, arrivalObservatory }) {
  return async function handleArrivalRoute({ request, response, pathname }) {
    if (request.method !== "GET" || pathname !== "/monitor/arrivals") return false;

    respond(response, 200, await arrivalObservatory.getSnapshot(), {
      "cache-control": "public, max-age=10"
    });
    return true;
  };
}
