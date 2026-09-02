import { ValidationError } from "../../core/errors.js";

function resolveRequestId(payload, url) {
  return typeof payload?.requestId === "string" && payload.requestId.trim()
    ? payload.requestId.trim()
    : (url.searchParams.get("requestId") ?? "");
}

function createMutationContext({ auth, buildMutationRequestHash, payload, requestId, route }) {
  const idempotencyKey = typeof payload?.idempotencyKey === "string" && payload.idempotencyKey.trim()
    ? payload.idempotencyKey.trim()
    : undefined;
  return {
    key: idempotencyKey ? `${auth.wallet}:${requestId}:${idempotencyKey}` : undefined,
    requestHash: buildMutationRequestHash({
      route,
      wallet: auth.wallet,
      payload: {
        ...payload,
        requestId
      }
    })
  };
}

export function createAdminXcmRoutes({
  authMiddleware,
  buildMutationRequestHash,
  enforceLimit,
  getIdempotentMutationReplay,
  rateLimitConfig,
  readJsonBody,
  respond,
  service,
  storeIdempotentMutationReceipt,
}) {
  async function authenticateAndLimit(request, url) {
    const auth = await authMiddleware(request, url, { requireRole: "admin" });
    await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
    return auth;
  }

  return async function handleAdminXcmRoute({ request, response, url, pathname }) {
    if (request.method === "POST" && pathname === "/admin/xcm/observe") {
      const auth = await authenticateAndLimit(request, url);
      const payload = await readJsonBody(request);
      const requestId = resolveRequestId(payload, url);
      if (!requestId) {
        throw new ValidationError("requestId is required.");
      }
      const mutation = createMutationContext({
        auth,
        buildMutationRequestHash,
        payload,
        requestId,
        route: "/admin/xcm/observe"
      });
      const replay = await getIdempotentMutationReplay({
        bucket: "admin_xcm_observe",
        key: mutation.key,
        requestHash: mutation.requestHash
      });
      if (replay) {
        respond(response, replay.statusCode, replay.body);
        return true;
      }
      const observed = await service.observeXcmOutcome(requestId, {
        status: payload?.status,
        settledAssets: payload?.settledAssets ?? 0,
        settledShares: payload?.settledShares ?? 0,
        remoteRef: payload?.remoteRef,
        failureCode: payload?.failureCode,
        source: payload?.source ?? "admin_observer",
        observedAt: payload?.observedAt
      });
      await storeIdempotentMutationReceipt({
        bucket: "admin_xcm_observe",
        key: mutation.key,
        requestHash: mutation.requestHash,
        response: observed,
        statusCode: 200
      });
      respond(response, 200, observed);
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/xcm/finalize") {
      const auth = await authenticateAndLimit(request, url);
      const payload = await readJsonBody(request);
      const requestId = resolveRequestId(payload, url);
      if (!requestId) {
        throw new ValidationError("requestId is required.");
      }
      const mutation = createMutationContext({
        auth,
        buildMutationRequestHash,
        payload,
        requestId,
        route: "/admin/xcm/finalize"
      });
      const replay = await getIdempotentMutationReplay({
        bucket: "admin_xcm_finalize",
        key: mutation.key,
        requestHash: mutation.requestHash
      });
      if (replay) {
        respond(response, replay.statusCode, replay.body);
        return true;
      }
      const finalized = await service.finalizeXcmRequest(requestId, {
        status: payload?.status,
        settledAssets: payload?.settledAssets ?? 0,
        settledShares: payload?.settledShares ?? 0,
        remoteRef: payload?.remoteRef,
        failureCode: payload?.failureCode
      });
      await storeIdempotentMutationReceipt({
        bucket: "admin_xcm_finalize",
        key: mutation.key,
        requestHash: mutation.requestHash,
        response: finalized,
        statusCode: 200
      });
      respond(response, 200, finalized);
      return true;
    }

    return false;
  };
}
