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
    if (pathname === "/admin/quality-reviews" && ["GET", "POST"].includes(request.method)) {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      if (request.method === "GET") {
        respond(response, 200, await service.verificationIngestionService.qualityReviewService.listPending(), { "cache-control": "no-store" });
        return true;
      }
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const idempotency = buildIdempotentMutationContext({
        route: "/admin/quality-reviews", auth, payload, bucket: "quality_review"
      });
      const replay = await getIdempotentMutationReplay(idempotency);
      if (replay) { respond(response, replay.statusCode, replay.body); return true; }
      const session = await service.verificationIngestionService.recordQualityReview({
        sessionId: payload.sessionId, qualityScore: payload.qualityScore, note: payload.note, reviewer: auth.wallet
      });
      await respondWithMutationReceipt(response, idempotency, 200, {
        sessionId: session.sessionId, qualityScore: session.qualityScore, review: session.qualityReview
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/admin/status") {
      const auth = await authMiddleware(request, url, {
        requireCapabilities: ["admin:status", "ops:view"]
      });
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
