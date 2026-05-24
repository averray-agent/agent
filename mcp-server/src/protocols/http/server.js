import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createPlatformRuntime } from "../../services/bootstrap.js";
import {
  assertMutationBackendAvailable,
  getMutationBackendStatus
} from "../../core/mutation-backend.js";
import {
  buildCapabilityWarnings,
  resolveCapabilityHealth,
  resolveServiceHealth
} from "../../core/health-capability.js";
import {
  AuthorizationError,
  ConflictError,
  normalizeError,
  ValidationError
} from "../../core/errors.js";
import { hashCanonicalContent } from "../../core/canonical-content.js";
import { extractClientKey } from "../../auth/rate-limit.js";
import { hasRole } from "../../auth/config.js";
import { resolveRequestId } from "../../core/logger.js";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
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
import { createBadgeRoutes } from "./badge-routes.js";
import { createContentRoutes } from "./content-routes.js";
import { createDisputeRoutes } from "./dispute-routes.js";
import { createEventRoutes } from "./event-routes.js";
import { createGasRoutes } from "./gas-routes.js";
import { createJobRoutes } from "./job-routes.js";
import { createPolicyRoutes } from "./policy-routes.js";
import { createProfileRoutes } from "./profile-routes.js";
import { createSchemaRoutes } from "./schema-routes.js";
import { createSessionRoutes } from "./session-routes.js";
import { createVerifierRoutes } from "./verifier-routes.js";
import { createXcmRequestRoutes } from "./xcm-request-routes.js";
import { OPERATOR_SIGNERS, makePolicy } from "../../core/builtin-policies.js";

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

const METRICS_BEARER_TOKEN = process.env.METRICS_BEARER_TOKEN?.trim() || undefined;
const METRICS_AUTH_REQUIRED = parseRequiredFlag(
  process.env.METRICS_AUTH_REQUIRED,
  process.env.NODE_ENV === "production" ? "1" : "0"
);
const port = Number(process.env.PORT ?? 8787);

const inFlightIdempotentMutations = new Map();

function respond(response, statusCode, payload, extraHeaders = {}) {
  const headers = {
    "content-type": "application/json",
    ...(response._corsHeaders ?? {}),
    ...extraHeaders
  };
  if (response._requestId && !headers["x-request-id"]) {
    headers["x-request-id"] = response._requestId;
  }
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(payload, null, 2));
}

function bearerTokenMatches(header, expectedToken) {
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const actualToken = header.slice(prefix.length);
  const actual = Buffer.from(actualToken);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseRequiredFlag(value, defaultValue) {
  const normalized = String(value ?? defaultValue).trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
}

async function readJsonBody(request, { maxBytes = httpConfig.maxBodyBytes } = {}) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maxBytes) {
      throw new ValidationError(`Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new ValidationError("Invalid JSON body.");
  }
}

function parseTopics(url) {
  return parseCsvParam(url, "topics");
}

function parseCsvParam(url, name) {
  return url.searchParams
    .get(name)
    ?.split(",")
    .map((topic) => topic.trim())
    .filter(Boolean) ?? [];
}

function parseEventFilters(url, { includeWallet = false } = {}) {
  const filters = {
    topics: parseTopics(url),
    sources: parseCsvParam(url, "sources").concat(parseCsvParam(url, "source")),
    phases: parseCsvParam(url, "phases").concat(parseCsvParam(url, "phase")),
    severities: parseCsvParam(url, "severities").concat(parseCsvParam(url, "severity")),
    correlationId: url.searchParams.get("correlationId")?.trim() || undefined
  };
  if (includeWallet) {
    filters.eventWallet = url.searchParams.get("eventWallet")?.trim() || url.searchParams.get("wallet")?.trim() || undefined;
  }
  return filters;
}

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

function safeChecksum(raw) {
  try {
    return getAddress(raw);
  } catch {
    return raw;
  }
}

function parseLimit(url, fallback = 50, max = 250) {
  const raw = Number(url.searchParams.get("limit") ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(raw), max);
}

function parsePositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = Number(value ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(raw), max);
}

function buildBadgeReceipt(badge) {
  const averray = badge.averray ?? {};
  return {
    sessionId: averray.sessionId,
    jobId: averray.jobId,
    worker: averray.worker,
    kind: "badge",
    issuedAt: averray.completedAt,
    signers: [
      { wallet: averray.poster, status: "posted" },
      { wallet: averray.verifier, status: "signed" }
    ],
    evidenceHash: averray.evidenceHash,
    blockRef: averray.chainJobId,
    badge
  };
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

async function listBadgeReceipts(limit = 100) {
  const sessions = await service.listRecentSessions(limit);
  const receipts = [];
  for (const session of sessions) {
    let badge;
    try {
      badge = buildBadgeFromSession({
        session,
        job: service.getJobDefinition(session.jobId),
        verification: session.verification,
        context: {
          publicBaseUrl: process.env.PUBLIC_BASE_URL,
          posterAddress: process.env.DEFAULT_POSTER_ADDRESS,
          verifierAddress: process.env.DEFAULT_VERIFIER_ADDRESS
        }
      });
    } catch {
      continue;
    }
    receipts.push(buildBadgeReceipt(badge));
  }
  return receipts;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
  );
}

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

function compactWallet(wallet) {
  const value = String(wallet ?? "");
  if (value.length <= 12) return value || "system";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function auditTime(value) {
  const date = new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return "00:00:00";
  return date.toISOString().slice(11, 19);
}

function auditDay(value) {
  const date = new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) return "today";
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const day = date.toISOString().slice(0, 10);
  if (day === today) return "today";
  if (day === yesterday) return "yesterday";
  return day;
}

function auditActor(handle, address, tone = "muted") {
  const label = String(handle ?? "system");
  return {
    handle: label,
    address: address ?? "averray.platform",
    initials: label.slice(0, 2).toUpperCase(),
    tone
  };
}

function auditEvent({ id, at, source, category, action, actor, summary, target, hash, tone, link }) {
  return compactObject({
    id,
    at: auditTime(at),
    day: auditDay(at),
    source,
    category,
    action,
    actor,
    summary,
    target,
    hash,
    tone,
    link
  });
}

async function listAuditEvents(limit = 100) {
  const sessions = await service.listRecentSessions(limit);
  const events = [];
  for (const session of sessions) {
    const actor = auditActor(`agent-${compactWallet(session.wallet)}`, compactWallet(session.wallet), "sage");
    events.push(auditEvent({
      id: `audit-${session.sessionId}-claimed`,
      at: session.createdAt ?? session.updatedAt,
      source: "system",
      category: "runs",
      action: "session.claimed",
      actor,
      summary: `Claimed ${session.jobId}.`,
      target: session.sessionId,
      hash: session.chainJobId,
      link: { label: "Open run ->", href: "/runs" }
    }));
    if (session.submittedAt || session.submission) {
      events.push(auditEvent({
        id: `audit-${session.sessionId}-submitted`,
        at: session.submittedAt ?? session.updatedAt,
        source: "system",
        category: "runs",
        action: "session.submitted",
        actor,
        summary: `Submitted evidence for ${session.jobId}.`,
        target: session.sessionId,
        link: { label: "Open session ->", href: "/sessions" }
      }));
    }
    if (session.verification || session.verificationSummary) {
      events.push(auditEvent({
        id: `audit-${session.sessionId}-verified`,
        at: session.verifiedAt ?? session.updatedAt,
        source: "operator",
        category: "verifier",
        action: "verification.resolved",
        actor: auditActor("verifier", compactWallet(process.env.DEFAULT_VERIFIER_ADDRESS), "blue"),
        summary: `Verifier resolved ${session.jobId} as ${session.status}.`,
        target: session.sessionId,
        tone: session.status === "disputed" ? "warn" : "accent",
        link: { label: "Open receipt ->", href: "/receipts" }
      }));
    }
  }
  for (const policy of listPolicies()) {
    events.push(auditEvent({
      id: `audit-policy-${policy.id}`,
      at: policy.lastChange?.at,
      source: "operator",
      category: "policy",
      action: policy.state === "Pending" ? "policy.proposed" : "policy.active",
      actor: auditActor(OPERATOR_SIGNERS[policy.lastChange?.author]?.role ?? "operator", OPERATOR_SIGNERS[policy.lastChange?.author]?.addr, "ink"),
      summary: `${policy.tag}: ${policy.lastChange?.text}`,
      target: policy.tag,
      tone: policy.state === "Pending" ? "warn" : "neutral",
      link: { label: "Open policy ->", href: "/policies" }
    }));
  }
  // Surface capability grant/revoke audit events alongside policy
  // and run lifecycle ones so the audit log has a single feed for
  // governance changes. Read-only — no state mutation.
  if (typeof stateStore?.listCapabilityGrants === "function") {
    const grants = await stateStore.listCapabilityGrants({ limit: Math.min(limit, 100) }).catch(() => []);
    for (const grant of grants) {
      const issuer = compactWallet(grant.issuedBy);
      const subject = compactWallet(grant.subject);
      events.push(auditEvent({
        id: `audit-capability-grant-${grant.id}`,
        at: grant.issuedAt,
        source: "operator",
        category: "policy",
        action: "capability.grant",
        actor: auditActor("operator", issuer, "ink"),
        summary: `Granted ${grant.capabilities.length} capabilit${grant.capabilities.length === 1 ? "y" : "ies"} to ${subject}${grant.scope ? ` (${grant.scope})` : ""}.`,
        target: grant.id,
        tone: "neutral",
        link: { label: "Open grants ->", href: "/capabilities" }
      }));
      if (grant.status === "revoked" && grant.revokedAt) {
        events.push(auditEvent({
          id: `audit-capability-revoke-${grant.id}`,
          at: grant.revokedAt,
          source: "operator",
          category: "policy",
          action: "capability.revoke",
          actor: auditActor("operator", compactWallet(grant.revokedBy), "warn"),
          summary: `Revoked grant ${grant.id} for ${subject}${grant.revokeNote ? ` — ${grant.revokeNote}` : ""}.`,
          target: grant.id,
          tone: "warn",
          link: { label: "Open grants ->", href: "/capabilities" }
        }));
      }
    }
  }
  return events
    .sort((left, right) => String(right.day + right.at).localeCompare(String(left.day + left.at)))
    .slice(0, limit);
}

async function listAlerts(limit = 20) {
  const [sessions, disputes] = await Promise.all([
    service.listRecentSessions(limit),
    listDisputes(limit)
  ]);
  const alerts = [];
  for (const dispute of disputes) {
    alerts.push({
      id: `alert-${dispute.id}`,
      tone: "warn",
      title: "Dispute awaiting verdict",
      ref: dispute.sessionId,
      body: `Stake of ${dispute.stakedAmount} DOT remains locked until a verifier verdict is recorded.`,
      ctaLabel: "Open disputes ->",
      ctaHref: "/disputes"
    });
  }
  const pendingPolicies = listPolicies().filter((policy) => policy.state === "Pending");
  for (const policy of pendingPolicies) {
    alerts.push({
      id: `alert-${policy.id}`,
      tone: "warn",
      title: "Policy awaiting second signer",
      ref: policy.tag,
      body: `${policy.signersReq} signatures required before this rule can gate live work.`,
      ctaLabel: "Open policies ->",
      ctaHref: "/policies"
    });
  }
  const submitted = sessions.filter((session) => ["submitted", "disputed"].includes(session.status));
  for (const session of submitted.slice(0, Math.max(0, limit - alerts.length))) {
    alerts.push({
      id: `alert-session-${session.sessionId}`,
      tone: session.status === "disputed" ? "warn" : "accent",
      title: session.status === "disputed" ? "Run needs human review" : "Submitted run ready for verification",
      ref: session.sessionId,
      body: `${session.jobId} is currently ${session.status}.`,
      ctaLabel: "Open runs ->",
      ctaHref: "/runs"
    });
  }
  return alerts.slice(0, limit);
}

async function persistContentRecord(record) {
  await contentRecoveryLog?.append?.(record);
  await stateStore.upsertContent?.(record);
  return record;
}

function resolveCorsHeaders(request) {
  const origin = request.headers?.origin;
  if (!origin || typeof origin !== "string") {
    return {};
  }
  if (httpConfig.allowAllOrigins) {
    return buildCorsHeaders("*");
  }
  if (httpConfig.allowedOrigins.has(origin)) {
    return buildCorsHeaders(origin);
  }
  return {};
}

function buildCorsHeaders(allowOrigin) {
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": httpConfig.allowedMethods,
    "access-control-allow-headers": httpConfig.allowedHeaders,
    "access-control-expose-headers": httpConfig.exposedHeaders,
    "access-control-max-age": String(httpConfig.maxAgeSeconds),
    vary: "origin"
  };
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

/**
 * Normalise a URL path into a low-cardinality metric label. Without this
 * every unique `sessionId` / `jobId` becomes its own Prometheus series,
 * which defeats the purpose. Known static paths pass through; anything
 * else collapses to a bucket label so scrape payloads stay small.
 */
function metricPathLabel(pathname) {
  const known = new Set([
    "/",
    "/health",
    "/metrics",
    "/agent-tools.json",
    "/.well-known/agent-tools.json",
    "/onboarding",
    "/jobs",
    "/jobs/definition",
    "/jobs/recommendations",
    "/jobs/preflight",
    "/jobs/claim",
    "/jobs/submit",
    "/jobs/tiers",
    "/session/state-machine",
    "/strategies",
    "/admin/jobs",
    "/admin/jobs/timeline",
    "/admin/sessions",
    "/admin/jobs/ingest/github",
    "/admin/jobs/ingest/openapi",
    "/admin/jobs/ingest/open-data",
    "/admin/jobs/ingest/osv",
    "/admin/jobs/ingest/standards",
    "/admin/jobs/ingest/wikipedia",
    "/admin/jobs/lifecycle",
    "/admin/jobs/pause",
    "/admin/jobs/resume",
    "/admin/xcm/observe",
    "/admin/xcm/finalize",
    "/account",
    "/account/allocate",
    "/account/borrow",
    "/account/borrow-capacity",
    "/account/deallocate",
    "/account/fund",
    "/account/repay",
    "/account/strategies",
    "/auth/session",
    "/payments/send",
    "/reputation",
    "/session",
    "/session/timeline",
    "/sessions",
    "/xcm/request",
    "/jobs/sub",
    "/events",
    "/auth/nonce",
    "/auth/verify",
    "/agents",
    "/badges",
    "/alerts",
    "/audit",
    "/policies",
    "/content",
    "/disputes",
    "/verifier/handlers",
    "/verifier/result",
    "/verifier/replay",
    "/verifier/run",
    "/gas/health",
    "/gas/capabilities",
    "/gas/quote",
    "/gas/sponsor"
  ]);
  if (known.has(pathname)) return pathname;
  // Collapse sessionId/wallet-scoped routes to a single label so Prometheus
  // doesn't create one series per session or wallet.
  if (/^\/disputes\/[^/]+\/verdict$/u.test(pathname)) return "/disputes/:id/verdict";
  if (/^\/disputes\/[^/]+\/release$/u.test(pathname)) return "/disputes/:id/release";
  if (pathname.startsWith("/disputes/")) return "/disputes/:id";
  if (/^\/content\/[^/]+\/publish$/u.test(pathname)) return "/content/:hash/publish";
  if (pathname.startsWith("/content/")) return "/content/:hash";
  if (pathname.startsWith("/policies/")) return "/policies/:tag";
  if (pathname.startsWith("/badges/")) return "/badges/:sessionId";
  if (pathname.startsWith("/agents/")) return "/agents/:wallet";
  return "other";
}

function parseIdempotencyKey(payload = {}) {
  return typeof payload?.idempotencyKey === "string" && payload.idempotencyKey.trim()
    ? payload.idempotencyKey.trim()
    : undefined;
}

function stripIdempotencyKey(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const { idempotencyKey, ...rest } = payload;
  return rest;
}

function buildMutationRequestHash({ route, wallet, payload }) {
  return hashCanonicalContent({
    route,
    wallet,
    payload: stripIdempotencyKey(payload)
  });
}

function buildIdempotentMutationContext({ route, auth, payload, normalizedPayload, bucket }) {
  const idempotencyKey = parseIdempotencyKey(payload);
  return {
    bucket,
    key: idempotencyKey ? `${auth.wallet}:${idempotencyKey}` : undefined,
    requestHash: buildMutationRequestHash({
      route,
      wallet: auth.wallet,
      payload: normalizedPayload ?? payload
    })
  };
}

function buildScopedIdempotentMutationContext({ route, auth, scope, payload, normalizedPayload, bucket }) {
  const idempotencyKey = parseIdempotencyKey(payload);
  return {
    bucket,
    key: idempotencyKey ? `${auth.wallet}:${scope}:${idempotencyKey}` : undefined,
    requestHash: buildMutationRequestHash({
      route,
      wallet: auth.wallet,
      payload: normalizedPayload ?? payload
    })
  };
}

function normalizeOptionalString(value) {
  return typeof value === "string" ? value.trim() : undefined;
}

function normalizeNumberLike(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function isMutationReceiptEnvelope(receipt) {
  return Boolean(
    receipt
    && typeof receipt === "object"
    && typeof receipt.requestHash === "string"
    && Object.prototype.hasOwnProperty.call(receipt, "response")
  );
}

async function getIdempotentMutationReplay({ bucket, key, requestHash }) {
  if (!key) {
    return undefined;
  }
  const existing = await stateStore.getMutationReceipt?.(bucket, key);
  if (!existing) {
    return undefined;
  }
  if (!isMutationReceiptEnvelope(existing)) {
    return { statusCode: 200, body: existing };
  }
  if (existing.requestHash !== requestHash) {
    throw new ConflictError(
      "Idempotency key was already used with a different request payload.",
      "idempotency_key_payload_mismatch",
      {
        bucket,
        originalRequestHash: existing.requestHash,
        requestHash
      }
    );
  }
  return { statusCode: 200, body: existing.response };
}

async function storeIdempotentMutationReceipt({ bucket, key, requestHash, response, statusCode }) {
  if (!key) {
    return response;
  }
  await stateStore.upsertMutationReceipt?.(bucket, key, {
    requestHash,
    statusCode,
    response,
    createdAt: new Date().toISOString()
  });
  return response;
}

async function respondWithMutationReceipt(response, context, statusCode, body) {
  await storeIdempotentMutationReceipt({
    ...context,
    response: body,
    statusCode
  });
  return respond(response, statusCode, body);
}

async function runIdempotentMutation(response, context, statusCode, operation) {
  const replay = await getIdempotentMutationReplay(context);
  if (replay) {
    return respond(response, replay.statusCode, replay.body);
  }

  const inFlightKey = context.key ? `${context.bucket}:${context.key}` : undefined;
  if (inFlightKey) {
    const inFlight = inFlightIdempotentMutations.get(inFlightKey);
    if (inFlight) {
      if (inFlight.requestHash !== context.requestHash) {
        throw new ConflictError(
          "Idempotency key was already used with a different request payload.",
          "idempotency_key_payload_mismatch",
          {
            bucket: context.bucket,
            originalRequestHash: inFlight.requestHash,
            requestHash: context.requestHash
          }
        );
      }
      throw new ConflictError(
        "Idempotent mutation is already in flight. Retry with the same payload after the first request completes.",
        "idempotency_key_in_flight",
        {
          bucket: context.bucket,
          requestHash: context.requestHash
        }
      );
    }
    inFlightIdempotentMutations.set(inFlightKey, {
      requestHash: context.requestHash,
      startedAt: new Date().toISOString()
    });
  }

  try {
    const body = await operation();
    return respondWithMutationReceipt(response, context, statusCode, body);
  } finally {
    if (inFlightKey) {
      inFlightIdempotentMutations.delete(inFlightKey);
    }
  }
}

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

const handleActivityRoute = createActivityRoutes({
  authMiddleware,
  listAlerts,
  listAuditEvents,
  parseLimit,
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

    if (request.method === "GET" && pathname === "/") {
      return respond(response, 200, {
        name: "agent-platform",
        status: "ok",
        authMode: authConfig.mode,
        endpoints: [
          "/health",
          "/metrics",
          "/agent-tools.json",
          "/onboarding",
          "/auth/nonce",
          "/auth/verify",
          "/auth/refresh",
          "/auth/logout",
          "/auth/session",
          "/events",
          "/account",
          "/account/allocate",
          "/account/borrow",
          "/account/borrow-capacity",
          "/account/deallocate",
          "/account/fund",
          "/account/repay",
          "/account/strategies",
          "/xcm/request",
          "/payments/send",
          "/reputation",
          "/session",
          "/session/timeline",
          "/sessions",
          "/jobs",
          "/jobs/sub",
          "/jobs/tiers",
          "/agents",
          "/agents/:wallet",
          "/badges",
          "/badges/:sessionId",
          "/alerts",
          "/audit",
          "/policies",
          "/policies/:tag",
          "/disputes",
          "/disputes/:id",
          "/disputes/:id/verdict",
          "/disputes/:id/release",
          "/strategies",
          "/admin/jobs/pause",
          "/admin/jobs/resume",
          "/jobs/preflight",
          "/jobs/recommendations",
          "/gas/health",
          "/gas/capabilities",
          "/gas/quote",
          "/gas/sponsor",
          "/verifier/handlers",
          "/verifier/replay",
          "/admin/jobs",
          "/admin/jobs/timeline",
          "/admin/sessions",
          "/admin/jobs/ingest/github",
          "/admin/jobs/ingest/openapi",
          "/admin/jobs/ingest/open-data",
          "/admin/jobs/ingest/osv",
          "/admin/jobs/ingest/standards",
          "/admin/jobs/ingest/wikipedia",
          "/admin/jobs/fire",
          "/admin/jobs/lifecycle",
          "/admin/jobs/pause",
          "/admin/jobs/resume",
          "/admin/xcm/observe",
          "/admin/xcm/finalize",
          "/admin/status",
          "/admin/github/status"
        ]
      });
    }

    if (request.method === "GET" && pathname === "/health") {
      // Package B (P1.1b) — health truth split. `serviceHealth` is the
      // API-process liveness contract: state-store reachable + auth
      // config loaded. HTTP status follows `serviceHealth.ok` alone, so
      // a trust-core-only launch (chain disabled, treasury capability
      // unavailable) still returns 200/"ok" at the liveness layer and
      // surfaces the capability state via `capabilityHealth`. Legacy
      // top-level `components` is preserved for existing consumers.
      const [storeHealth, chainHealth, gasHealth, xcmWatcherStatus] = await Promise.all([
        stateStore.healthCheck?.() ?? { ok: true, backend: stateStore.constructor.name },
        gateway?.healthCheck?.() ?? { ok: false, backend: "blockchain", enabled: false, mode: "disabled" },
        pimlicoClient?.healthCheck?.() ?? { ok: true, backend: "pimlico", enabled: false, mode: "disabled" },
        service?.xcmSettlementWatcher?.getStatus?.()?.catch?.(() => undefined) ?? undefined
      ]);
      const mutationBackendStatus = await getMutationBackendStatus({
        gateway,
        config: mutationBackendConfig,
        route: "/health",
        gatewayStatus: chainHealth
      }).catch(() => ({ ok: false, route: "/health" }));

      const serviceHealth = resolveServiceHealth({ stateStoreHealth: storeHealth, authConfig });
      const capabilityHealth = resolveCapabilityHealth({
        blockchainHealth: chainHealth,
        mutationBackendStatus,
        xcmWatcherStatus,
        // Backend has no direct indexer URL dependency today; the field
        // resolves to "unavailable" via the helper's default branch.
        // Wiring an explicit probe is a follow-up.
        indexerProbe: undefined,
        gasSponsorHealth: gasHealth
      });

      return respond(response, serviceHealth.ok ? 200 : 503, {
        status: serviceHealth.ok ? "ok" : "degraded",
        auth: { mode: authConfig.mode, domain: authConfig.domain, chainId: authConfig.chainId },
        serviceHealth,
        capabilityHealth,
        // Structured, codeable warnings derived from capabilityHealth.
        // Operator dashboards / smoke checks can match on `code` rather
        // than parsing prose. Empty array when every capability is in
        // its happy state.
        warnings: buildCapabilityWarnings(capabilityHealth),
        components: {
          stateStore: storeHealth,
          blockchain: chainHealth,
          gasSponsor: gasHealth
        }
      });
    }

    if (request.method === "GET" && pathname === "/status/providers") {
      // Public, sanitized counterpart to /admin/status.providerOperations.
      // Returns the same shape minus lastRun.errors[] / lastRun.skipped[]
      // (those carry candidate URLs / stack traces / internal IDs).
      // External trust dashboards can call this without auth to show
      // "is each ingestion provider healthy?" without leaking internals.
      return respond(response, 200, await service.getPublicProviderOperations());
    }

    if (request.method === "GET" && pathname === "/metrics") {
      // Fail closed in production: public metrics reveal request paths,
      // status-code mix, and operational posture.
      if (METRICS_AUTH_REQUIRED && !METRICS_BEARER_TOKEN) {
        return respond(response, 503, { error: "metrics_auth_unconfigured" });
      }
      if (METRICS_AUTH_REQUIRED) {
        const header = request.headers.authorization ?? "";
        if (!bearerTokenMatches(header, METRICS_BEARER_TOKEN)) {
          return respond(response, 401, { error: "unauthorized" });
        }
      }
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4",
        ...(response._corsHeaders ?? {}),
        "x-request-id": response._requestId ?? ""
      });
      response.end(metrics.serialize());
      return;
    }

    if (request.method === "GET" && pathname === "/onboarding") {
      return respond(response, 200, service.getPlatformCapabilities());
    }

    if (
      request.method === "GET"
      && (pathname === "/agent-tools.json" || pathname === "/.well-known/agent-tools.json")
    ) {
      // Discovery manifest. The canonical copy is served by the static
      // site at https://averray.com/.well-known/agent-tools.json — this
      // API mirror lets MCP clients that only know the api host still
      // find the capability listing. Both `/agent-tools.json` and the
      // RFC 8615-conformant `/.well-known/agent-tools.json` are served
      // from the same handler so a spec-following MCP client can
      // discover the same manifest at the same path it uses on the
      // canonical host. Bumps refer to
      // discovery/.well-known/agent-tools.json in the repo.
      return respond(
        response,
        200,
        buildDiscoveryManifest({
          baseUrl: process.env.PUBLIC_BASE_URL?.trim() || undefined
        }),
        { "cache-control": "public, max-age=300" }
      );
    }

    if (await handleJobRoute({ request, response, url, pathname })) {
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

    if (request.method === "POST" && pathname === "/payments/send") {
      // Agent-to-agent transfer. Pillar 5 of docs/AGENT_BANKING.md.
      // Authenticated: the signed-in wallet is the sender, and the
      // backend relays via AgentAccountCore.sendToAgentFor so the hot
      // signer key on the platform is the one paying gas, not the user.
      const auth = await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      const recipientRaw = String(payload?.recipient ?? "").trim();
      if (!/^0x[a-fA-F0-9]{40}$/u.test(recipientRaw)) {
        throw new ValidationError("recipient must be a 0x-prefixed 20-byte hex address.");
      }
      const recipient = safeChecksum(recipientRaw);
      if (recipient.toLowerCase() === auth.wallet.toLowerCase()) {
        throw new ValidationError("recipient must differ from the sender.");
      }
      const asset = typeof payload?.asset === "string" && payload.asset.trim()
        ? payload.asset.trim().toUpperCase()
        : "DOT";
      const amount = Number(payload?.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ValidationError("amount must be a positive number.");
      }
      const idempotency = buildIdempotentMutationContext({
        route: "/payments/send",
        auth,
        payload,
        normalizedPayload: {
          ...stripIdempotencyKey(payload),
          recipient,
          asset,
          amount
        },
        bucket: "payments_send"
      });
      return await runIdempotentMutation(response, idempotency, 200, async () => {
        await requireChainBackedMutation("/payments/send");
        const balances = await service.sendToAgent(auth.wallet, recipient, asset, amount);
        return {
          status: "sent",
          from: auth.wallet,
          to: recipient,
          asset,
          amount,
          balances
        };
      });
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
