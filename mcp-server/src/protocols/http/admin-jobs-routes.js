import { ValidationError } from "../../core/errors.js";

import {
  createAdminJobImportRouteDefinitions,
  createJobsFromImportResult
} from "./admin-job-import-routes.js";

export function createAdminJobsRoutes({
  authMiddleware,
  buildIdempotentMutationContext,
  buildMutationRequestHash,
  enforceLimit,
  getIdempotentMutationReplay,
  parseEventFilters,
  parseIdempotencyKey,
  parseLimit,
  parsePositiveInteger,
  rateLimitConfig,
  readJsonBody,
  respond,
  respondWithMutationReceipt,
  service,
  storeIdempotentMutationReceipt,
}) {
  const importRouteDefinitions = createAdminJobImportRouteDefinitions({ parsePositiveInteger });

  async function authenticateAndLimit(request, url) {
    const auth = await authMiddleware(request, url, { requireRole: "admin" });
    await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
    return auth;
  }

  async function handleImportRoute({
    request,
    response,
    url,
    route,
    bucket,
    normalize,
    ingest,
    dryRunBody,
    resultBody,
  }) {
    const auth = await authenticateAndLimit(request, url);
    const payload = await readJsonBody(request);
    const normalized = normalize(payload);
    const idempotency = buildIdempotentMutationContext({
      route,
      auth,
      payload,
      normalizedPayload: normalized.idempotencyPayload,
      bucket
    });
    const replay = await getIdempotentMutationReplay(idempotency);
    if (replay) {
      return respond(response, replay.statusCode, replay.body);
    }

    const result = await ingest(normalized);
    if (normalized.dryRun) {
      return respondWithMutationReceipt(response, idempotency, 200, dryRunBody(result));
    }

    const { created, skipped, errors } = createJobsFromImportResult(service, result.jobs);
    const status = errors.length ? 207 : 201;
    return respondWithMutationReceipt(
      response,
      idempotency,
      status,
      resultBody(result, { created, skipped, errors })
    );
  }

  return async function handleAdminJobsRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/admin/jobs") {
      const auth = await authenticateAndLimit(request, url);
      // Operator-side full job listing including paused, archived, and
      // stale rows so the operator app can show lifecycle controls.
      // The public `/jobs` route filters those out by default.
      respond(response, 200, {
        jobs: await service.listJobsWithSessions({
          wallet: auth.wallet,
          includePaused: true,
          includeArchived: true,
          includeStale: true
        }),
        jobLifecycle: service.getJobLifecycleSummary()
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/admin/jobs/timeline") {
      const auth = await authenticateAndLimit(request, url);
      const jobId = url.searchParams.get("jobId") ?? "";
      if (!jobId.trim()) {
        throw new ValidationError("jobId is required.");
      }
      respond(
        response,
        200,
        await service.getJobTimeline(jobId.trim(), {
          wallet: auth.wallet,
          limit: parseLimit(url, 100, 250),
          ...parseEventFilters(url, { includeWallet: true })
        })
      );
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/jobs") {
      const auth = await authenticateAndLimit(request, url);
      const payload = await readJsonBody(request);
      const idempotencyKey = parseIdempotencyKey(payload);
      const mutationKey = idempotencyKey ? `${auth.wallet}:${idempotencyKey}` : undefined;
      const requestHash = buildMutationRequestHash({ route: "/admin/jobs", wallet: auth.wallet, payload });
      const replay = await getIdempotentMutationReplay({
        bucket: "admin_jobs",
        key: mutationKey,
        requestHash
      });
      if (replay) {
        respond(response, replay.statusCode, replay.body);
        return true;
      }
      const created = await service.createAdminJob(payload, { posterWallet: auth.wallet });
      await storeIdempotentMutationReceipt({
        bucket: "admin_jobs",
        key: mutationKey,
        requestHash,
        response: created,
        statusCode: 201
      });
      respond(response, 201, created);
      return true;
    }

    const importRouteDefinition = request.method === "POST"
      ? importRouteDefinitions.find((definition) => definition.pathname === pathname)
      : undefined;
    if (importRouteDefinition) {
      await handleImportRoute({
        request,
        response,
        url,
        ...importRouteDefinition
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/jobs/fire") {
      // Manually fire one instance off a recurring template. The scheduler
      // uses the same service helper; this route remains the admin override.
      const auth = await authenticateAndLimit(request, url);
      const payload = await readJsonBody(request);
      const templateId = typeof payload?.templateId === "string" ? payload.templateId.trim() : "";
      if (!templateId) {
        throw new ValidationError("templateId is required.");
      }
      const idempotencyKey = parseIdempotencyKey(payload);
      const mutationKey = idempotencyKey ? `${auth.wallet}:${idempotencyKey}` : undefined;
      const firedAt = payload?.firedAt ? new Date(payload.firedAt) : new Date();
      if (Number.isNaN(firedAt.getTime())) {
        throw new ValidationError("firedAt must be ISO-8601 if provided.");
      }
      const normalizedPayload = {
        ...payload,
        templateId,
        firedAt: payload?.firedAt ? firedAt.toISOString() : "__server_now__"
      };
      const requestHash = buildMutationRequestHash({ route: "/admin/jobs/fire", wallet: auth.wallet, payload: normalizedPayload });
      const replay = await getIdempotentMutationReplay({
        bucket: "admin_jobs_fire",
        key: mutationKey,
        requestHash
      });
      if (replay) {
        respond(response, replay.statusCode, replay.body);
        return true;
      }
      const derivative = service.fireRecurringJob(templateId, { firedAt });
      await storeIdempotentMutationReceipt({
        bucket: "admin_jobs_fire",
        key: mutationKey,
        requestHash,
        response: derivative,
        statusCode: 201
      });
      respond(response, 201, derivative);
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/jobs/lifecycle") {
      const auth = await authenticateAndLimit(request, url);
      const payload = await readJsonBody(request);
      const jobId = typeof payload?.jobId === "string" ? payload.jobId.trim() : "";
      if (!jobId) {
        throw new ValidationError("jobId is required.");
      }
      const updated = service.updateJobLifecycle(jobId, {
        action: payload?.action,
        status: payload?.status,
        staleAt: payload?.staleAt,
        reason: payload?.reason
      });
      respond(response, 200, {
        job: updated,
        jobLifecycle: service.getJobLifecycleSummary()
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/jobs/pause") {
      const auth = await authenticateAndLimit(request, url);
      const payload = await readJsonBody(request);
      const templateId = typeof payload?.templateId === "string" ? payload.templateId.trim() : "";
      if (!templateId) {
        throw new ValidationError("templateId is required.");
      }
      const idempotencyKey = parseIdempotencyKey(payload);
      const mutationKey = idempotencyKey ? `${auth.wallet}:${templateId}:${idempotencyKey}` : undefined;
      const requestHash = buildMutationRequestHash({
        route: "/admin/jobs/pause",
        wallet: auth.wallet,
        payload: { ...payload, templateId }
      });
      const replay = await getIdempotentMutationReplay({
        bucket: "admin_jobs_pause",
        key: mutationKey,
        requestHash
      });
      if (replay) {
        respond(response, replay.statusCode, replay.body);
        return true;
      }
      await service.pauseRecurringTemplate(templateId);
      const status = await service.getAdminStatus({ auth });
      await storeIdempotentMutationReceipt({
        bucket: "admin_jobs_pause",
        key: mutationKey,
        requestHash,
        response: status,
        statusCode: 200
      });
      respond(response, 200, status);
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/jobs/resume") {
      const auth = await authenticateAndLimit(request, url);
      const payload = await readJsonBody(request);
      const templateId = typeof payload?.templateId === "string" ? payload.templateId.trim() : "";
      if (!templateId) {
        throw new ValidationError("templateId is required.");
      }
      const idempotencyKey = parseIdempotencyKey(payload);
      const mutationKey = idempotencyKey ? `${auth.wallet}:${templateId}:${idempotencyKey}` : undefined;
      const requestHash = buildMutationRequestHash({
        route: "/admin/jobs/resume",
        wallet: auth.wallet,
        payload: { ...payload, templateId }
      });
      const replay = await getIdempotentMutationReplay({
        bucket: "admin_jobs_resume",
        key: mutationKey,
        requestHash
      });
      if (replay) {
        respond(response, replay.statusCode, replay.body);
        return true;
      }
      await service.resumeRecurringTemplate(templateId);
      const status = await service.getAdminStatus({ auth });
      await storeIdempotentMutationReceipt({
        bucket: "admin_jobs_resume",
        key: mutationKey,
        requestHash,
        response: status,
        statusCode: 200
      });
      respond(response, 200, status);
      return true;
    }

    return false;
  };
}
