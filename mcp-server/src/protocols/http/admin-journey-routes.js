export function createAdminJourneyRoutes({
  adminJourneyReadService,
  authMiddleware,
  parseLimit,
  respond
}) {
  return async function handleAdminJourneyRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/admin/arrivals/timeline") {
      await authMiddleware(request, url, { requireCapability: "ops:view" });
      const window = url.searchParams.get("window")?.trim() || "48h";
      respond(response, 200, await adminJourneyReadService.getArrivalTimeline(window), {
        "cache-control": "no-store"
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/admin/worker-journeys") {
      await authMiddleware(request, url, { requireCapability: "ops:view" });
      const wallet = url.searchParams.get("wallet")?.trim() || undefined;
      const limit = parseLimit(url, 25, 100);
      respond(response, 200, await adminJourneyReadService.getWorkerJourneys({ wallet, limit }), {
        "cache-control": "no-store"
      });
      return true;
    }

    return false;
  };
}
