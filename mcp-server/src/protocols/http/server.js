import { createServer } from "node:http";
import { createPlatformRuntime } from "../../services/bootstrap.js";
import { assertMutationBackendAvailable } from "../../core/mutation-backend.js";
import {
  AuthorizationError,
  normalizeError,
} from "../../core/errors.js";
import { extractClientKey } from "../../auth/rate-limit.js";
import { hasRole } from "../../auth/config.js";
import { resolveRequestId } from "../../core/logger.js";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import { buildAgentProfile } from "../../core/agent-profile.js";
import { buildBadgeFromSession } from "../../core/badge-metadata.js";
import { buildDiscoveryManifest } from "../../core/discovery-manifest.js";
import {
  getPublicBuiltinJobSchemaByName,
  listBuiltinJobSchemas,
  schemaRefToJobSchemaPath
} from "../../core/job-schema-registry.js";
import { createAdminCapabilityRoutes } from "./admin-capability-routes.js";
import { createAdminGithubRoutes } from "./admin-github-routes.js";
import { createAdminJobsRoutes } from "./admin-jobs-routes.js";
import { createAdminSessionsRoutes } from "./admin-sessions-routes.js";
import { createAdminStatusRoutes } from "./admin-status-routes.js";
import { createAdminXcmRoutes } from "./admin-xcm-routes.js";
import { createActivityRoutes } from "./activity-routes.js";
import { createAccountRoutes } from "./account-routes.js";
import { createAuthRoutes } from "./auth-routes.js";
import { createBadgeRoutes, createListBadgeReceipts } from "./badge-routes.js";
import { createContentRoutes } from "./content-routes.js";
import { createDisputeRoutes } from "./dispute-routes.js";
import { createEventRoutes } from "./event-routes.js";
import { createGasRoutes } from "./gas-routes.js";
import {
  createCorsHeaderResolver,
  createJsonBodyReader,
  metricPathLabel,
  parseEventFilters,
  parseLimit,
  parsePositiveInteger,
  respond
} from "./http-helpers.js";
import { createIdempotentMutationHelpers } from "./idempotent-mutations.js";
import { createJobRoutes } from "./job-routes.js";
import { createOperationalRoutes, resolveMetricsAuthConfig } from "./operational-routes.js";
import { createOperatorActivityFeed } from "./operator-activity-feed.js";
import { createPaymentRoutes, resolvePaymentRouteConfig } from "./payment-routes.js";
import { createPolicyRoutes } from "./policy-routes.js";
import { createProfileRoutes } from "./profile-routes.js";
import { createPublicMetadataRoutes } from "./public-metadata-routes.js";
import { createSchemaRoutes } from "./schema-routes.js";
import { createSessionRoutes } from "./session-routes.js";
import { createShareRoutes } from "./share-routes.js";
import { createUsdcLiquidityRoutes } from "./usdc-liquidity-routes.js";
import { createVerifierRoutes } from "./verifier-routes.js";
import { createXcmRequestRoutes } from "./xcm-request-routes.js";
import { makePolicy } from "../../core/builtin-policies.js";
import { createUsdcLiquidityStatusService } from "../../services/usdc-liquidity-status.js";

const {
  platformService: service,
  policyService,
  verifierService,
  stateStore,
  contentRecoveryLog,
  gateway,
  mutationBackendConfig,
  pimlicoClient,
  eventBus,
  authConfig,
  authMiddleware,
  authCapabilities,
  rateLimiter,
  rateLimitConfig,
  httpConfig,
  strategies,
  trustProxy,
  logger,
  metrics,
  observability
} = await createPlatformRuntime();

// Label the state-store gauge once at boot for Prometheus discovery.
metrics.gauge("state_store_backend", "1 when state store backend matches the label.", ["backend"]).set(
  { backend: stateStore.constructor.name },
  1
);

const { metricsBearerToken, metricsAuthRequired } = resolveMetricsAuthConfig(process.env);
const { paymentsSendEnabled } = resolvePaymentRouteConfig(process.env);
const port = Number(process.env.PORT ?? 8787);
const readJsonBody = createJsonBodyReader({ maxBytes: httpConfig.maxBodyBytes });
const resolveCorsHeaders = createCorsHeaderResolver(httpConfig);

function walletsMatch(a, b) {
  if (!a || !b) {
    return false;
  }
  return a.toLowerCase() === b.toLowerCase();
}

async function ensureSessionOwnership(sessionId, wallet) {
  const session = await service.resumeSession(sessionId);
  if (!walletsMatch(session.wallet, wallet)) {
    throw new AuthorizationError(
      `Session ${sessionId} does not belong to authenticated wallet.`,
      "session_not_owned"
    );
  }
  return session;
}

function safeChecksum(raw) {
  try {
    return getAddress(raw);
  } catch {
    return raw;
  }
}

async function buildShareAgentProfile(wallet) {
  const checksummed = safeChecksum(wallet);
  const [reputation, sessions] = await Promise.all([
    service.getReputation(checksummed),
    service.collectSessionHistory(checksummed, { logger })
  ]);
  return buildAgentProfile({
    wallet: String(wallet).toLowerCase(),
    reputation,
    sessions,
    getJobDefinition: (jobId) => {
      try {
        return service.getJobDefinition(jobId);
      } catch {
        return undefined;
      }
    },
    publicBaseUrl: process.env.PUBLIC_BASE_URL
  });
}

async function resolveShareResource({ surface, id }) {
  if (surface === "agent") {
    return {
      kind: "agent_profile",
      profile: await buildShareAgentProfile(id)
    };
  }

  if (surface === "session") {
    const session = await service.resumeSession(id);
    return {
      kind: "session_audit_trail",
      session,
      timeline: await service.getSessionTimeline(id)
    };
  }

  if (surface === "dispute") {
    const disputes = await listDisputes(250);
    const dispute = disputes.find((candidate) => candidate.id === id);
    return dispute ? { kind: "dispute_snapshot", dispute } : null;
  }

  if (surface === "policy") {
    const policy = findPolicy(id);
    return policy ? { kind: "policy_snapshot", policy } : null;
  }

  return null;
}

async function authorizeShareTarget({ surface, id, auth }) {
  if (surface === "session" && !hasRole(auth.claims, "admin")) {
    await ensureSessionOwnership(id, auth.wallet);
    return;
  }
  const resource = await resolveShareResource({ surface, id });
  if (!resource) {
    throw new ValidationError("Cannot create a share URL for an unknown resource.");
  }
}

function ensureXcmRequestOwnership(record, auth) {
  if (hasRole(auth.claims, "admin")) {
    return;
  }
  if (!walletsMatch(record.account, auth.wallet)) {
    throw new AuthorizationError(
      `XCM request ${record.requestId} does not belong to authenticated wallet.`,
      "xcm_request_not_owned"
    );
  }
}

function ensureAsyncXcmTreasuryAdmin(auth) {
  if (hasRole(auth.claims, "admin")) {
    return;
  }
  throw new AuthorizationError(
    "Async XCM treasury actions require an admin role until the server-side XCM assembler is enabled.",
    "async_xcm_admin_required"
  );
}

async function requireChainBackedMutation(route) {
  return assertMutationBackendAvailable({
    gateway,
    config: mutationBackendConfig,
    route
  });
}

function clientIp(request) {
  return extractClientKey(request, { trustProxy });
}

function deriveBadgeLineage(session, job) {
  if (!session || !job) return undefined;
  const lineage = {};
  if (job.parentSessionId) {
    const parent = {
      sessionId: String(job.parentSessionId),
      ...(job.lineage?.parentJobId ? { jobId: String(job.lineage.parentJobId) } : {}),
      ...(typeof job.lineage?.parentWallet === "string" ? { wallet: job.lineage.parentWallet } : {})
    };
    if (Object.keys(parent).length > 0) lineage.parent = parent;
  }
  let childJobs = [];
  try {
    childJobs = service.listChildJobsByParentSession?.(session.sessionId) ?? [];
  } catch {
    childJobs = [];
  }
  if (childJobs.length > 0) {
    lineage.children = {
      count: childJobs.length,
      jobIds: childJobs.map((childJob) => String(childJob.id ?? "")).filter(Boolean)
    };
  }
  return Object.keys(lineage).length > 0 ? lineage : undefined;
}

const listBadgeReceipts = createListBadgeReceipts({
  buildBadgeFromSession,
  deriveBadgeLineage,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  posterAddress: process.env.DEFAULT_POSTER_ADDRESS,
  service,
  stateStore,
  verifierAddress: process.env.DEFAULT_VERIFIER_ADDRESS,
  verifierService
});

// Package G (P2.5b) — policy state is now owned by `policyService`.
// `OPERATOR_SIGNERS`, `signerApproval`, `makePolicy`, and the
// `BUILTIN_POLICIES` seed array moved to
// `mcp-server/src/core/builtin-policies.js`; operator proposals live
// in the durable `PolicyService` store. Two thin wrappers below
// preserve the legacy `listPolicies()` / `findPolicy()` call sites in
// the rest of this file without each call having to know about the
// service object.

function listPolicies() {
  return policyService.listAll();
}

function findPolicy(tag) {
  return policyService.findByTagOrId(tag);
}

function buildPolicyProposal(payload, auth) {
  const tag = String(payload?.tag ?? payload?.id ?? "").trim();
  if (!tag) {
    throw new ValidationError("policy tag is required.");
  }
  const title = String(payload?.title ?? tag).trim();
  const body = typeof payload?.currentBody === "string"
    ? payload.currentBody
    : JSON.stringify(payload?.rule ?? { title }, null, 2);
  const now = new Date().toISOString();
  const id = `p-proposed-${keccak256(toUtf8Bytes(tag)).slice(2, 10)}`;
  return makePolicy({
    id,
    tag,
    scope: payload?.scope ?? "claim",
    scopeLabel: payload?.scopeLabel ?? "Claim",
    severity: payload?.severity ?? "gating",
    state: "Pending",
    revision: Number(payload?.revision ?? 1),
    activeSince: null,
    handler: payload?.handler ?? "operator/proposed_policy.ts",
    gates: payload?.gates ?? title,
    rooms: Array.isArray(payload?.rooms) ? payload.rooms : ["policies/proposed/*"],
    signerKeys: ["fd2e", "9a13", "3e42"],
    signersReq: 2,
    lastChange: {
      text: `Proposed by ${auth.wallet}`,
      author: "fd2e",
      at: now.replace("T", " ").slice(0, 19) + " UTC"
    },
    rule: {
      v1: body
    }
  });
}

async function persistContentRecord(record) {
  await contentRecoveryLog?.append?.(record);
  await stateStore.upsertContent?.(record);
  return record;
}

async function enforceLimit(bucket, key, limits) {
  if (!rateLimiter) {
    return;
  }
  try {
    await rateLimiter(bucket, key, limits);
  } catch (error) {
    if (error?.code === "rate_limited") {
      metrics.counter("rate_limit_rejections_total").inc({ bucket });
    }
    throw error;
  }
}

const {
  buildIdempotentMutationContext,
  buildMutationRequestHash,
  buildScopedIdempotentMutationContext,
  getIdempotentMutationReplay,
  parseIdempotencyKey,
  respondWithMutationReceipt,
  runIdempotentMutation,
  storeIdempotentMutationReceipt,
  stripIdempotencyKey,
} = createIdempotentMutationHelpers({ stateStore, respond });

const handleAdminStatusRoute = createAdminStatusRoutes({
  authMiddleware,
  buildIdempotentMutationContext,
  enforceLimit,
  getIdempotentMutationReplay,
  rateLimitConfig,
  readJsonBody,
  respond,
  respondWithMutationReceipt,
  service,
});

const usdcLiquidityStatusService = createUsdcLiquidityStatusService({ gateway });
const handleUsdcLiquidityRoute = createUsdcLiquidityRoutes({
  authMiddleware,
  respond,
  usdcLiquidityStatusService,
});

const handleAdminJobsRoute = createAdminJobsRoutes({
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
});

const handleAdminCapabilityRoute = createAdminCapabilityRoutes({
  authConfig,
  authMiddleware,
  buildMutationRequestHash,
  enforceLimit,
  eventBus,
  getIdempotentMutationReplay,
  parseIdempotencyKey,
  parseLimit,
  rateLimitConfig,
  readJsonBody,
  respond,
  stateStore,
  storeIdempotentMutationReceipt,
});

const handleAdminGithubRoute = createAdminGithubRoutes({
  authMiddleware,
  parseLimit,
  respond,
  service,
});

const handleAdminSessionsRoute = createAdminSessionsRoutes({
  authMiddleware,
  parseLimit,
  respond,
  service,
});

const handleAdminXcmRoute = createAdminXcmRoutes({
  authMiddleware,
  buildMutationRequestHash,
  enforceLimit,
  getIdempotentMutationReplay,
  rateLimitConfig,
  readJsonBody,
  respond,
  service,
  storeIdempotentMutationReceipt,
});

const handleXcmRequestRoute = createXcmRequestRoutes({
  authMiddleware,
  ensureXcmRequestOwnership,
  respond,
  service,
});

const handleGasRoute = createGasRoutes({
  authMiddleware,
  pimlicoClient,
  readJsonBody,
  respond,
});

const handleVerifierRoute = createVerifierRoutes({
  authMiddleware,
  enforceLimit,
  rateLimitConfig,
  readJsonBody,
  respond,
  verifierService,
});

const handleProfileRoute = createProfileRoutes({
  authMiddleware,
  logger,
  parseLimit,
  respond,
  service,
  stateStore,
});

const handleSessionRoute = createSessionRoutes({
  authMiddleware,
  ensureSessionOwnership,
  respond,
  service,
});

const handleJobRoute = createJobRoutes({
  authMiddleware,
  enforceLimit,
  ensureSessionOwnership,
  rateLimitConfig,
  readJsonBody,
  respond,
  service,
});

const handleSchemaRoute = createSchemaRoutes({
  getPublicBuiltinJobSchemaByName,
  listBuiltinJobSchemas,
  respond,
  schemaRefToJobSchemaPath,
});

const handlePolicyRoute = createPolicyRoutes({
  authMiddleware,
  buildPolicyProposal,
  eventBus,
  findPolicy,
  listPolicies,
  policyService,
  readJsonBody,
  respond,
});

const handleBadgeRoute = createBadgeRoutes({
  buildBadgeFromSession,
  deriveBadgeLineage,
  listBadgeReceipts,
  parseLimit,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  posterAddress: process.env.DEFAULT_POSTER_ADDRESS,
  respond,
  service,
  stateStore,
  verifierAddress: process.env.DEFAULT_VERIFIER_ADDRESS,
  verifierService,
});

const {
  handleDisputeRoute,
  listDisputes,
} = createDisputeRoutes({
  authMiddleware,
  buildScopedIdempotentMutationContext,
  eventBus,
  gateway,
  getIdempotentMutationReplay,
  hasRole,
  parseLimit,
  persistContentRecord,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  defaultVerifierAddress: process.env.DEFAULT_VERIFIER_ADDRESS,
  readJsonBody,
  respond,
  respondWithMutationReceipt,
  service,
  stateStore,
});

const { listAlerts, listAuditEvents } = createOperatorActivityFeed({
  defaultVerifierAddress: process.env.DEFAULT_VERIFIER_ADDRESS,
  listDisputes,
  listPolicies,
  service,
  stateStore,
});

const handleActivityRoute = createActivityRoutes({
  authMiddleware,
  listAlerts,
  listAuditEvents,
  parseLimit,
  respond,
});

const handleShareRoute = createShareRoutes({
  authConfig,
  authMiddleware,
  authorizeShareTarget,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  readJsonBody,
  resolveShareResource,
  respond,
});

const handleEventRoute = createEventRoutes({
  authMiddleware,
  enforceLimit,
  eventBus,
  metrics,
  parseEventFilters,
  parseLimit,
  rateLimitConfig,
});

const handlePublicMetadataRoute = createPublicMetadataRoutes({
  authConfig,
  buildDiscoveryManifest,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  respond,
  service,
  strategies,
});

const handleContentRoute = createContentRoutes({
  authMiddleware,
  gateway,
  hasRole,
  logger,
  persistContentRecord,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  readJsonBody,
  respond,
  stateStore,
  walletsMatch,
});

const handleAuthRoute = createAuthRoutes({
  authCapabilities,
  authConfig,
  authMiddleware,
  clientIp,
  enforceLimit,
  logger,
  rateLimitConfig,
  readJsonBody,
  respond,
  stateStore,
});

const handleAccountRoute = createAccountRoutes({
  authMiddleware,
  buildIdempotentMutationContext,
  buildMutationRequestHash,
  ensureAsyncXcmTreasuryAdmin,
  gateway,
  getIdempotentMutationReplay,
  readJsonBody,
  requireChainBackedMutation,
  respond,
  runIdempotentMutation,
  service,
  storeIdempotentMutationReceipt,
  strategies,
  stripIdempotencyKey,
});

const handlePaymentRoute = createPaymentRoutes({
  authMiddleware,
  buildIdempotentMutationContext,
  paymentsSendEnabled,
  readJsonBody,
  requireChainBackedMutation,
  respond,
  runIdempotentMutation,
  service,
  stripIdempotencyKey,
});

const handleOperationalRoute = createOperationalRoutes({
  authConfig,
  gateway,
  metrics,
  metricsAuthRequired,
  metricsBearerToken,
  mutationBackendConfig,
  pimlicoClient,
  respond,
  service,
  stateStore,
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const requestId = resolveRequestId(request);
  const requestLogger = logger.child({ requestId });
  const startedAt = process.hrtime.bigint();
  // Stash CORS headers + request id on the response so JSON and SSE responders
  // can echo them back without each route needing to thread them through.
  response._corsHeaders = resolveCorsHeaders(request);
  response._requestId = requestId;
  response.on("finish", () => {
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    const pathLabel = metricPathLabel(pathname);
    metrics.counter("http_requests_total").inc({
      method: request.method ?? "UNKNOWN",
      path: pathLabel,
      status: String(response.statusCode ?? 0)
    });
    metrics.histogram("http_request_duration_ms").observe(
      { method: request.method ?? "UNKNOWN", path: pathLabel },
      durationMs
    );
    requestLogger.info(
      {
        method: request.method,
        path: pathname,
        status: response.statusCode,
        durationMs,
        ip: extractClientKey(request, { trustProxy })
      },
      "http.response"
    );
  });

  if (request.method === "OPTIONS") {
    // CORS preflight: only acknowledge origins on the allowlist. Unlisted
    // origins get a 204 with no CORS headers, so the browser rejects them.
    response.writeHead(204, response._corsHeaders);
    response.end();
    return;
  }

  try {
    // ---------- public routes ----------

    if (await handlePublicMetadataRoute({ request, response, pathname })) {
      return;
    }

    if (await handleOperationalRoute({ request, response, pathname })) {
      return;
    }

    if (await handleJobRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleShareRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleAdminJobsRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleAdminSessionsRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleAccountRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleSessionRoute({ request, response, url, pathname })) {
      return;
    }

    if (request.method === "GET" && await handleSchemaRoute({ request, response, pathname })) {
      return;
    }

    if (request.method === "GET" && await handleGasRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleVerifierRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleProfileRoute({ request, response, url, pathname, requestLogger })) {
      return;
    }

    if (await handleBadgeRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleActivityRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handlePolicyRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleContentRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleDisputeRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleAuthRoute({ request, response, url, pathname })) {
      return;
    }

    // ---------- protected routes ----------

    if (await handleEventRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleXcmRequestRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleAdminStatusRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleUsdcLiquidityRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleAdminCapabilityRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleAdminGithubRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handleAdminXcmRoute({ request, response, url, pathname })) {
      return;
    }

    if (request.method === "POST" && await handleGasRoute({ request, response, url, pathname })) {
      return;
    }

    if (await handlePaymentRoute({ request, response, url, pathname })) {
      return;
    }

    return respond(response, 404, { error: "not_found" });
  } catch (error) {
    const normalized = normalizeError(error);
    const extraHeaders = { "x-request-id": requestId };
    const retryAfter = normalized.details?.retryAfterSeconds;
    if (normalized.statusCode === 429 && Number.isFinite(retryAfter)) {
      extraHeaders["retry-after"] = String(Math.max(1, Math.ceil(retryAfter)));
    }
    const logLevel = (normalized.statusCode ?? 500) >= 500 ? "error" : "warn";
    requestLogger[logLevel](
      {
        method: request.method,
        path: pathname,
        status: normalized.statusCode ?? 500,
        code: normalized.code,
        err: error instanceof Error ? error : new Error(String(error))
      },
      "http.error"
    );
    if ((normalized.statusCode ?? 500) === 401 || (normalized.statusCode ?? 500) === 403) {
      metrics.counter("auth_failures_total").inc({ code: normalized.code ?? "unknown" });
    }
    if ((normalized.statusCode ?? 500) >= 500) {
      // 5xx only — we deliberately don't ship 4xx noise to Sentry.
      observability.captureException(error instanceof Error ? error : new Error(String(error)), {
        requestId,
        method: request.method,
        path: pathname,
        status: normalized.statusCode ?? 500,
        code: normalized.code
      });
    }
    const errorPayload = {
      error: normalized.code ?? "internal_error",
      message: normalized.message ?? "internal_error",
      details: normalized.details,
      requestId
    };
    if (normalized.code === "chain_backend_required" && normalized.details?.reason) {
      errorPayload.reason = normalized.details.reason;
    }
    return respond(
      response,
      normalized.statusCode ?? 500,
      errorPayload,
      extraHeaders
    );
  }
});

server.listen(port, () => {
  logger.info(
    {
      port,
      authMode: authConfig.mode,
      stateStoreBackend: stateStore.constructor.name,
      mutationBackend: mutationBackendConfig.mode,
      blockchainEnabled: Boolean(gateway?.isEnabled?.()),
      pimlicoEnabled: Boolean(pimlicoClient?.isEnabled?.())
    },
    "http.listening"
  );
});
