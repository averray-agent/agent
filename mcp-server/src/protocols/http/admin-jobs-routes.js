import { ValidationError, normalizeError } from "../../core/errors.js";
import { ingestGithubIssues } from "../../jobs/ingest-github-issues.js";
import { ingestOpenDataDatasets, parseDatasets as parseOpenDataDatasets } from "../../jobs/ingest-open-data-datasets.js";
import { ingestOpenApiSpecs, parseOpenApiSpecs } from "../../jobs/ingest-openapi-specs.js";
import {
  ingestOsvAdvisories,
  parseManifests as parseOsvManifests,
  parsePackages as parseOsvPackages
} from "../../jobs/ingest-osv-advisories.js";
import { ingestStandardsSpecs, parseSpecs as parseStandardsSpecs } from "../../jobs/ingest-standards-specs.js";
import { ingestWikipediaMaintenance, parseCategories } from "../../jobs/ingest-wikipedia-maintenance.js";

function createJobImportSummary(result, { dryRun, created, skipped = [], errors = [], extra = {} }) {
  return {
    ...extra,
    minScore: result.minScore,
    dryRun,
    candidateCount: result.count,
    created,
    skipped,
    errors
  };
}

function normalizeSkippedWithNumericCount(result, skipped = []) {
  return [
    ...skipped,
    ...(Number.isFinite(result.skipped) ? [{ reason: "below_min_score_or_over_limit", count: result.skipped }] : [])
  ];
}

function createJobsFromImportResult(service, jobs) {
  const created = [];
  const skipped = [];
  const errors = [];

  for (const job of jobs) {
    try {
      created.push(service.createJob(job));
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code === "job_exists") {
        skipped.push({ id: job.id, reason: "already_exists" });
        continue;
      }
      errors.push({
        id: job.id,
        code: normalized.code,
        message: normalized.message
      });
    }
  }

  return { created, skipped, errors };
}

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

    if (request.method === "POST" && pathname === "/admin/jobs/ingest/github") {
      await handleImportRoute({
        request,
        response,
        url,
        route: "/admin/jobs/ingest/github",
        bucket: "admin_jobs_ingest_github",
        normalize: (payload) => {
          const query = typeof payload?.query === "string" && payload.query.trim()
            ? payload.query.trim()
            : undefined;
          const limit = parsePositiveInteger(payload?.limit, 10, 50);
          const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
          const dryRun = payload?.dryRun !== false;
          return {
            query,
            limit,
            minScore,
            dryRun,
            idempotencyPayload: { query, limit, minScore, dryRun }
          };
        },
        ingest: ({ query, limit, minScore }) => ingestGithubIssues({
          query,
          limit,
          minScore,
          githubToken: process.env.GITHUB_TOKEN?.trim() || undefined
        }),
        dryRunBody: (result) => ({
          ...result,
          dryRun: true,
          created: [],
          skipped: [
            ...(Array.isArray(result.skipped) ? result.skipped : []),
            ...normalizeSkippedWithNumericCount(result)
          ]
        }),
        resultBody: (result, { created, skipped, errors }) => createJobImportSummary(result, {
          dryRun: false,
          created,
          skipped: [
            ...skipped,
            ...normalizeSkippedWithNumericCount(result)
          ],
          errors,
          extra: {
            query: result.query
          }
        })
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/jobs/ingest/wikipedia") {
      await handleImportRoute({
        request,
        response,
        url,
        route: "/admin/jobs/ingest/wikipedia",
        bucket: "admin_jobs_ingest_wikipedia",
        normalize: (payload) => {
          const language = typeof payload?.language === "string" && payload.language.trim()
            ? payload.language.trim()
            : undefined;
          const categories = Array.isArray(payload?.categories) || typeof payload?.categories === "string"
            ? parseCategories(payload.categories)
            : undefined;
          const limit = parsePositiveInteger(payload?.limit, 10, 50);
          const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
          const dryRun = payload?.dryRun !== false;
          return {
            language,
            categories,
            limit,
            minScore,
            dryRun,
            idempotencyPayload: { language, categories, limit, minScore, dryRun }
          };
        },
        ingest: ({ language, categories, limit, minScore }) => ingestWikipediaMaintenance({
          language,
          categories,
          limit,
          minScore
        }),
        dryRunBody: (result) => ({
          ...result,
          dryRun: true,
          created: [],
          skipped: [
            ...(Array.isArray(result.skipped) ? result.skipped : []),
            ...normalizeSkippedWithNumericCount(result)
          ]
        }),
        resultBody: (result, { created, skipped, errors }) => createJobImportSummary(result, {
          dryRun: false,
          created,
          skipped: [
            ...skipped,
            ...normalizeSkippedWithNumericCount(result)
          ],
          errors,
          extra: {
            language: result.language,
            categories: result.categories
          }
        })
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/jobs/ingest/osv") {
      await handleImportRoute({
        request,
        response,
        url,
        route: "/admin/jobs/ingest/osv",
        bucket: "admin_jobs_ingest_osv",
        normalize: (payload) => {
          const packages = Array.isArray(payload?.packages) || typeof payload?.packages === "string"
            ? parseOsvPackages(payload.packages)
            : parseOsvPackages(process.env.OSV_INGEST_PACKAGES_JSON ?? process.env.OSV_INGEST_PACKAGES);
          const manifests = Array.isArray(payload?.manifests) || typeof payload?.manifests === "string"
            ? parseOsvManifests(payload.manifests)
            : parseOsvManifests(process.env.OSV_INGEST_MANIFESTS_JSON ?? process.env.OSV_INGEST_MANIFESTS);
          const limit = parsePositiveInteger(payload?.limit, 10, 50);
          const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
          const maxPackageTargets = parsePositiveInteger(payload?.maxPackageTargets, 100, 500);
          const dryRun = payload?.dryRun !== false;
          return {
            packages,
            manifests,
            limit,
            minScore,
            maxPackageTargets,
            dryRun,
            idempotencyPayload: { packages, manifests, limit, minScore, maxPackageTargets, dryRun }
          };
        },
        ingest: ({ packages, manifests, limit, minScore, maxPackageTargets }) =>
          ingestOsvAdvisories({ packages, manifests, limit, minScore, maxPackageTargets }),
        dryRunBody: (result) => ({
          ...result,
          dryRun: true,
          created: []
        }),
        resultBody: (result, { created, skipped, errors }) => createJobImportSummary(result, {
          dryRun: false,
          created,
          skipped: [...skipped, ...(Array.isArray(result.skipped) ? result.skipped : [])],
          errors,
          extra: {
            ecosystem: result.ecosystem
          }
        })
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/jobs/ingest/open-data") {
      await handleImportRoute({
        request,
        response,
        url,
        route: "/admin/jobs/ingest/open-data",
        bucket: "admin_jobs_ingest_open_data",
        normalize: (payload) => {
          const datasets = Array.isArray(payload?.datasets) || typeof payload?.datasets === "string"
            ? parseOpenDataDatasets(payload.datasets)
            : parseOpenDataDatasets(process.env.OPEN_DATA_INGEST_DATASETS_JSON ?? process.env.OPEN_DATA_INGEST_DATASETS);
          const query = typeof payload?.query === "string" && payload.query.trim()
            ? payload.query.trim()
            : process.env.OPEN_DATA_INGEST_QUERY;
          const limit = parsePositiveInteger(payload?.limit, 10, 50);
          const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
          const dryRun = payload?.dryRun !== false;
          return {
            datasets,
            query,
            limit,
            minScore,
            dryRun,
            idempotencyPayload: { datasets, query, limit, minScore, dryRun }
          };
        },
        ingest: ({ datasets, query, limit, minScore }) => ingestOpenDataDatasets({ datasets, query, limit, minScore }),
        dryRunBody: (result) => ({
          ...result,
          dryRun: true,
          created: []
        }),
        resultBody: (result, { created, skipped, errors }) => createJobImportSummary(result, {
          dryRun: false,
          created,
          skipped: [...skipped, ...(Array.isArray(result.skipped) ? result.skipped : [])],
          errors,
          extra: {
            provider: result.provider,
            query: result.query
          }
        })
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/jobs/ingest/openapi") {
      await handleImportRoute({
        request,
        response,
        url,
        route: "/admin/jobs/ingest/openapi",
        bucket: "admin_jobs_ingest_openapi",
        normalize: (payload) => {
          const specs = Array.isArray(payload?.specs) || typeof payload?.specs === "string"
            ? parseOpenApiSpecs(payload.specs)
            : parseOpenApiSpecs(process.env.OPENAPI_INGEST_SPECS_JSON ?? process.env.OPENAPI_INGEST_SPECS);
          const limit = parsePositiveInteger(payload?.limit, 10, 50);
          const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
          const dryRun = payload?.dryRun !== false;
          return {
            specs,
            limit,
            minScore,
            dryRun,
            idempotencyPayload: { specs, limit, minScore, dryRun }
          };
        },
        ingest: ({ specs, limit, minScore }) => ingestOpenApiSpecs({ specs, limit, minScore }),
        dryRunBody: (result) => ({
          ...result,
          dryRun: true,
          created: []
        }),
        resultBody: (result, { created, skipped, errors }) => createJobImportSummary(result, {
          dryRun: false,
          created,
          skipped: [...skipped, ...(Array.isArray(result.skipped) ? result.skipped : [])],
          errors,
          extra: {
            provider: result.provider,
            specCount: result.specCount
          }
        })
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/admin/jobs/ingest/standards") {
      await handleImportRoute({
        request,
        response,
        url,
        route: "/admin/jobs/ingest/standards",
        bucket: "admin_jobs_ingest_standards",
        normalize: (payload) => {
          const specs = Array.isArray(payload?.specs) || typeof payload?.specs === "string"
            ? parseStandardsSpecs(payload.specs)
            : parseStandardsSpecs(process.env.STANDARDS_INGEST_SPECS_JSON ?? process.env.STANDARDS_INGEST_SPECS);
          const limit = parsePositiveInteger(payload?.limit, 10, 50);
          const minScore = parsePositiveInteger(payload?.minScore, 55, 100);
          const dryRun = payload?.dryRun !== false;
          return {
            specs,
            limit,
            minScore,
            dryRun,
            idempotencyPayload: { specs, limit, minScore, dryRun }
          };
        },
        ingest: ({ specs, limit, minScore }) => ingestStandardsSpecs({ specs, limit, minScore }),
        dryRunBody: (result) => ({
          ...result,
          dryRun: true,
          created: []
        }),
        resultBody: (result, { created, skipped, errors }) => createJobImportSummary(result, {
          dryRun: false,
          created,
          skipped: [...skipped, ...(Array.isArray(result.skipped) ? result.skipped : [])],
          errors,
          extra: {
            provider: result.provider,
            specCount: result.specCount
          }
        })
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
