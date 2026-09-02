import { ValidationError } from "../../core/errors.js";

export function respond(response, statusCode, payload, extraHeaders = {}) {
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

export function createJsonBodyReader({ maxBytes }) {
  return (request, options = {}) => readJsonBody(request, {
    maxBytes: options.maxBytes ?? maxBytes
  });
}

export async function readJsonBody(request, { maxBytes } = {}) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (Number.isFinite(maxBytes) && received > maxBytes) {
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

export function parseTopics(url) {
  return parseCsvParam(url, "topics");
}

export function parseCsvParam(url, name) {
  return url.searchParams
    .get(name)
    ?.split(",")
    .map((topic) => topic.trim())
    .filter(Boolean) ?? [];
}

export function parseEventFilters(url, { includeWallet = false } = {}) {
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

export function parseLimit(url, fallback = 50, max = 250) {
  const raw = Number(url.searchParams.get("limit") ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(raw), max);
}

export function parsePositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = Number(value ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(raw), max);
}

export function createCorsHeaderResolver(httpConfig) {
  return (request) => resolveCorsHeaders(request, httpConfig);
}

export function resolveCorsHeaders(request, httpConfig) {
  const origin = request.headers?.origin;
  if (!origin || typeof origin !== "string") {
    return {};
  }
  if (httpConfig.allowAllOrigins) {
    return buildCorsHeaders("*", httpConfig);
  }
  if (httpConfig.allowedOrigins.has(origin)) {
    return buildCorsHeaders(origin, httpConfig);
  }
  return {};
}

export function buildCorsHeaders(allowOrigin, httpConfig) {
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": httpConfig.allowedMethods,
    "access-control-allow-headers": httpConfig.allowedHeaders,
    "access-control-expose-headers": httpConfig.exposedHeaders,
    "access-control-max-age": String(httpConfig.maxAgeSeconds),
    vary: "origin"
  };
}

/**
 * Normalise a URL path into a low-cardinality metric label. Without this
 * every unique `sessionId` / `jobId` becomes its own Prometheus series,
 * which defeats the purpose. Known static paths pass through; anything
 * else collapses to a bucket label so scrape payloads stay small.
 */
export function metricPathLabel(pathname) {
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
    "/shares",
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
    "/account/position",
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
  if (pathname.startsWith("/shares/")) return "/shares/:token";
  return "other";
}
