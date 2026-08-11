import { ValidationError } from "../../core/errors.js";
import { TIER_REQUIREMENTS } from "../../core/job-catalog-service.js";
import { buildPublicJobsResponse } from "./jobs-response.js";

export function createJobRoutes({
  arrivalObservatory,
  authMiddleware,
  clientIp,
  enforceLimit,
  ensureSessionOwnership,
  externalPostingService,
  posterOnboardingService,
  protocol = "http",
  rateLimitConfig,
  readJsonBody,
  respond,
  service,
}) {
  async function recordHttp(request, pathname, wallet) {
    try {
      await arrivalObservatory?.recordHttp?.({
        method: request.method,
        pathname,
        wallet,
        ip: clientIp?.(request)
      });
    } catch {
      // Arrival telemetry must never refuse a job request.
    }
  }

  return async function handleJobRoute({ request, response, url, pathname }) {
    if (request.method === "GET" && pathname === "/jobs") {
      await recordHttp(request, pathname);
      const jobs = await service.listJobsWithSessions({
        wallet: url.searchParams.get("wallet") ?? undefined
      });
      const projected = externalPostingService?.filterExternalCatalogProjection
        ? await externalPostingService.filterExternalCatalogProjection(jobs)
        : jobs;
      const enriched = posterOnboardingService?.enrichExternalCatalogRows
        ? await posterOnboardingService.enrichExternalCatalogRows(projected)
        : projected;
      respond(response, 200, buildPublicJobsResponse(enriched, url.searchParams));
      return true;
    }

    if (request.method === "GET" && pathname === "/jobs/tiers") {
      await recordHttp(request, pathname);
      respond(
        response,
        200,
        {
          tiers: Object.entries(TIER_REQUIREMENTS).map(([tier, requires]) => ({ tier, requires }))
        },
        { "cache-control": "public, max-age=300" }
      );
      return true;
    }

    if (request.method === "GET" && pathname === "/jobs/definition") {
      const includeArchived = isTruthyFlag(url.searchParams.get("includeArchived"));
      const auth = includeArchived
        ? await authMiddleware(request, url, { requireRole: "admin" })
        : undefined;
      await recordHttp(request, pathname, auth?.wallet);
      respond(response, 200, await service.getPublicJobDefinition(url.searchParams.get("jobId") ?? "", {
        wallet: url.searchParams.get("wallet") ?? undefined,
        ...(includeArchived ? { includeArchived: true, currentWallet: auth.wallet } : {})
      }));
      return true;
    }

    if (request.method === "GET" && pathname === "/jobs/recommendations") {
      const auth = await authMiddleware(request, url);
      await recordHttp(request, pathname, auth.wallet);
      respond(response, 200, await service.recommendJobs(auth.wallet));
      return true;
    }

    if (request.method !== "GET" && pathname === "/jobs/preflight") {
      await recordHttp(request, pathname);
      respond(
        response,
        405,
        {
          error: "method_not_allowed",
          message: "Use GET /jobs/preflight?jobId=X."
        },
        { allow: "GET" }
      );
      return true;
    }

    if (request.method === "GET" && pathname === "/jobs/preflight") {
      const auth = await authMiddleware(request, url);
      await recordHttp(request, pathname, auth.wallet);
      respond(
        response,
        200,
        await service.preflightJob(auth.wallet, url.searchParams.get("jobId") ?? "")
      );
      return true;
    }

    if (request.method === "GET" && pathname === "/jobs/explain-eligibility") {
      const auth = await authMiddleware(request, url);
      await recordHttp(request, pathname, auth.wallet);
      const jobId = url.searchParams.get("jobId") ?? "";
      if (!jobId) {
        throw new ValidationError("jobId query parameter is required.");
      }
      respond(
        response,
        200,
        await service.explainEligibility(auth.wallet, jobId)
      );
      return true;
    }

    if (request.method === "GET" && pathname === "/jobs/estimate-reward") {
      const auth = await authMiddleware(request, url);
      await recordHttp(request, pathname, auth.wallet);
      const jobId = url.searchParams.get("jobId") ?? "";
      if (!jobId) {
        throw new ValidationError("jobId query parameter is required.");
      }
      respond(
        response,
        200,
        await service.estimateNetReward(auth.wallet, jobId)
      );
      return true;
    }

    if (request.method === "GET" && pathname === "/jobs/sub") {
      const auth = await authMiddleware(request, url);
      await recordHttp(request, pathname, auth.wallet);
      const parentSessionId = url.searchParams.get("parentSessionId") ?? "";
      await ensureSessionOwnership(parentSessionId, auth.wallet);
      respond(response, 200, await service.listSubJobs(parentSessionId));
      return true;
    }

    if (request.method === "POST" && pathname === "/jobs/sub") {
      const auth = await authMiddleware(request, url);
      await recordHttp(request, pathname, auth.wallet);
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      const parentSessionId = typeof payload?.parentSessionId === "string" && payload.parentSessionId.trim()
        ? payload.parentSessionId.trim()
        : (url.searchParams.get("parentSessionId") ?? "");
      if (!parentSessionId) {
        throw new ValidationError("parentSessionId is required.");
      }
      const created = await service.createSubJob(parentSessionId, auth.wallet, payload);
      respond(response, 201, created);
      return true;
    }

    if (request.method === "POST" && pathname === "/jobs/claim") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const jobId = typeof payload?.jobId === "string" && payload.jobId.trim()
        ? payload.jobId.trim()
        : (url.searchParams.get("jobId") ?? "");
      const idempotencyKey = typeof payload?.idempotencyKey === "string" && payload.idempotencyKey.trim()
        ? payload.idempotencyKey.trim()
        : (url.searchParams.get("idempotencyKey") ?? `${auth.wallet}:${jobId}`);
      await recordHttp(request, pathname, auth.wallet);
      respond(response, 200, await service.claimJob(auth.wallet, jobId, protocol, idempotencyKey));
      return true;
    }

    if (request.method === "POST" && pathname === "/jobs/validate-submission") {
      const payload = await readJsonBody(request);
      const jobId = typeof payload?.jobId === "string" && payload.jobId.trim()
        ? payload.jobId.trim()
        : (url.searchParams.get("jobId") ?? "");
      if (!jobId) {
        throw new ValidationError("jobId is required.");
      }
      const submission = payload && typeof payload === "object" && "submission" in payload
        ? payload.submission
        : (payload && typeof payload === "object" && "output" in payload
            ? payload.output
            : (typeof payload?.evidence === "string"
                ? payload.evidence
                : undefined));
      if (submission === undefined) {
        throw new ValidationError("submission is required.");
      }
      await recordHttp(request, pathname);
      respond(response, 200, await service.validateJobSubmission(jobId, submission));
      return true;
    }

    if (request.method === "POST" && pathname === "/jobs/submit") {
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const sessionId = typeof payload?.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : (url.searchParams.get("sessionId") ?? "");
      const submission = payload && typeof payload === "object" && "submission" in payload
        ? payload.submission
        : (typeof payload?.evidence === "string"
            ? payload.evidence
            : (url.searchParams.get("evidence") ?? "submitted-via-http"));
      if (!sessionId) {
        throw new ValidationError("sessionId is required.");
      }
      if (typeof submission === "string" && submission.length > 16 * 1024) {
        throw new ValidationError("evidence exceeds 16 KiB. Submit long payloads via evidenceURI once supported.");
      }
      await ensureSessionOwnership(sessionId, auth.wallet);
      await recordHttp(request, pathname, auth.wallet);
      respond(response, 200, await service.submitWork(sessionId, protocol, submission));
      return true;
    }

    return false;
  };
}

function isTruthyFlag(value) {
  return ["1", "true", "yes"].includes(String(value ?? "").trim().toLowerCase());
}
