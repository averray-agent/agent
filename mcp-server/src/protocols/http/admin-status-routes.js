export function createAdminStatusRoutes({
  authMiddleware,
  buildIdempotentMutationContext,
  enforceLimit,
  getIdempotentMutationReplay,
  rateLimitConfig,
  readJsonBody,
  respond,
  respondWithMutationReceipt,
  service,
}) {
  return async function handleAdminStatusRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/admin/status") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      respond(response, 200, await service.getAdminStatus({ auth }));
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/bootstrap-self-report/send") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const idempotency = buildIdempotentMutationContext({
        route: "/admin/bootstrap-self-report/send",
        auth,
        payload,
        bucket: "bootstrap_self_report_send"
      });
      const replay = await getIdempotentMutationReplay(idempotency);
      if (replay) {
        respond(response, replay.statusCode, replay.body);
        return true;
      }
      const result = await service.runBootstrapSelfReport();
      await respondWithMutationReceipt(response, idempotency, 200, result);
      return true;
    }

    return false;
  };
}
