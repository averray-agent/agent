/**
 * GET /monitor/arrivals — what has reached the MCP front door.
 *
 * Public, following /monitor/bank-feed. That is the reason the observatory
 * keeps anonymous activity in aggregate counts only, alongside declared
 * client identity and measured wallet rows.
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
  readJsonBody,
  now = () => Date.now()
}) {
  let cachedSnapshot;
  let cachedUntilMs = 0;
  let snapshotPromise;
  const getPublicSnapshot = async () => {
    if (cachedSnapshot && now() < cachedUntilMs) return cachedSnapshot;
    snapshotPromise ??= Promise.resolve().then(async () => {
      const snapshot = await arrivalObservatory.getSnapshot();
      cachedSnapshot = snapshot;
      cachedUntilMs = now() + 10_000;
      return snapshot;
    }).finally(() => { snapshotPromise = undefined; });
    return snapshotPromise;
  };
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

    respond(response, 200, await getPublicSnapshot(), {
      "cache-control": "public, max-age=10"
    }, { compact: true });
    return true;
  };
}
