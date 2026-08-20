export function createAdminPlatformFaultRemediationRoutes({
  authMiddleware,
  parseLimit,
  respond,
  stateStore,
}) {
  return async function handleAdminPlatformFaultRemediationRoute({ request, response, url, pathname }) {
    if (request.method !== "GET" || pathname !== "/admin/platform-fault-remediations") {
      return false;
    }
    await authMiddleware(request, url, { requireRole: "admin" });
    const limit = parseLimit(url, 50, 250);
    const requestedStatus = url.searchParams.get("status")?.trim();
    const status = !requestedStatus
      ? "awaiting_hardware_arbitrator"
      : requestedStatus.toLowerCase() === "all"
        ? undefined
        : requestedStatus;
    const items = await stateStore.listPlatformFaultRemediations({ status, limit });
    respond(response, 200, {
      items,
      count: items.length,
      limit,
      status: status ?? "all",
      scope: "internal",
      execution: "out_of_band_hardware",
      workerInitiated: false
    });
    return true;
  };
}
