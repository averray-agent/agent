import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createPlatformRuntime } from "../../services/bootstrap.js";
import {
  AuthenticationError,
  AuthorizationError,
  normalizeError,
  ValidationError
} from "../../core/errors.js";
import { buildSiweMessage, verifySiweMessage } from "../../auth/siwe.js";
import { signToken } from "../../auth/jwt.js";
import { extractClientKey } from "../../auth/rate-limit.js";
import { resolveRequestId } from "../../core/logger.js";
import { getAddress } from "ethers";
import { buildBadgeFromSession } from "../../core/badge-metadata.js";
import { buildAgentProfile } from "../../core/agent-profile.js";
import { TIER_REQUIREMENTS } from "../../core/job-catalog-service.js";

const {
  platformService: service,
  verifierService,
  stateStore,
  gateway,
  pimlicoClient,
  eventBus,
  authConfig,
  authMiddleware,
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
const port = Number(process.env.PORT ?? 8787);

const SIWE_STATEMENT = "Sign in to the Agent Platform.";

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

function respondSse(response) {
  const headers = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    ...(response._corsHeaders ?? {})
  };
  if (response._requestId) {
    headers["x-request-id"] = response._requestId;
  }
  response.writeHead(200, headers);
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

function writeSseEvent(response, { id, topic, data }) {
  if (id) {
    response.write(`id: ${id}\n`);
  }
  if (topic) {
    response.write(`event: ${topic}\n`);
  }
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseTopics(url) {
  return url.searchParams
    .get("topics")
    ?.split(",")
    .map((topic) => topic.trim())
    .filter(Boolean) ?? [];
}

function generateNonce() {
  return randomBytes(16).toString("hex");
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
    "/onboarding",
    "/jobs",
    "/jobs/definition",
    "/jobs/recommendations",
    "/jobs/preflight",
    "/jobs/claim",
    "/jobs/submit",
    "/jobs/tiers",
    "/strategies",
    "/admin/jobs",
    "/account",
    "/account/fund",
    "/reputation",
    "/session",
    "/sessions",
    "/events",
    "/auth/nonce",
    "/auth/verify",
    "/verifier/handlers",
    "/verifier/result",
    "/verifier/run",
    "/gas/health",
    "/gas/capabilities",
    "/gas/quote",
    "/gas/sponsor"
  ]);
  if (known.has(pathname)) return pathname;
  // Collapse sessionId/wallet-scoped routes to a single label so Prometheus
  // doesn't create one series per session or wallet.
  if (pathname.startsWith("/badges/")) return "/badges/:sessionId";
  if (pathname.startsWith("/agents/")) return "/agents/:wallet";
  return "other";
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const requestId = resolveRequestId(request);
  const requestLogger = logger.child({ requestId });
  const startedAt = process.hrtime.bigint();
  // Stash CORS headers + request id on the response so `respond`/`respondSse`
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
          "/onboarding",
          "/auth/nonce",
          "/auth/verify",
          "/auth/logout",
          "/events",
          "/account",
          "/account/fund",
          "/reputation",
          "/session",
          "/sessions",
          "/jobs",
          "/jobs/tiers",
          "/strategies",
          "/jobs/preflight",
          "/jobs/recommendations",
          "/gas/health",
          "/gas/capabilities",
          "/gas/quote",
          "/gas/sponsor",
          "/verifier/handlers",
          "/admin/jobs",
          "/badges/:sessionId",
          "/agents/:wallet"
        ]
      });
    }

    if (request.method === "GET" && pathname === "/health") {
      const [storeHealth, chainHealth, gasHealth] = await Promise.all([
        stateStore.healthCheck?.() ?? { ok: true, backend: stateStore.constructor.name },
        gateway?.healthCheck?.() ?? { ok: true, backend: "blockchain", enabled: false, mode: "disabled" },
        pimlicoClient?.healthCheck?.() ?? { ok: true, backend: "pimlico", enabled: false, mode: "disabled" }
      ]);
      const overallOk = Boolean(storeHealth.ok) && Boolean(chainHealth.ok) && Boolean(gasHealth.ok);
      return respond(response, overallOk ? 200 : 503, {
        status: overallOk ? "ok" : "degraded",
        auth: { mode: authConfig.mode, domain: authConfig.domain, chainId: authConfig.chainId },
        components: {
          stateStore: storeHealth,
          blockchain: chainHealth,
          gasSponsor: gasHealth
        }
      });
    }

    if (request.method === "GET" && pathname === "/metrics") {
      // Optionally gated. Leave METRICS_BEARER_TOKEN unset for the standard
      // Prometheus "scrape any network peer" convention; set it to a random
      // token when /metrics is reachable from the public internet.
      if (METRICS_BEARER_TOKEN) {
        const header = request.headers.authorization ?? "";
        if (header !== `Bearer ${METRICS_BEARER_TOKEN}`) {
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

    if (request.method === "GET" && pathname === "/jobs") {
      return respond(response, 200, service.listJobs());
    }

    if (request.method === "GET" && pathname === "/strategies") {
      // Public read: which yield/strategy adapters are registered for
      // this deployment. Populated from STRATEGIES_JSON env (copied from
      // the deployment manifest). Returns an empty list when no strategy
      // adapter is registered — that's the expected state on dev/Anvil.
      return respond(
        response,
        200,
        {
          strategies,
          docs: "https://github.com/depre-dev/agent/blob/main/docs/strategies/vdot.md"
        },
        { "cache-control": "public, max-age=300" }
      );
    }

    if (request.method === "GET" && pathname === "/jobs/tiers") {
      // Public tier-requirements ladder. No auth; no per-wallet data.
      // Agents use this endpoint for discovery — "what does each tier of
      // work cost in reputation?" — without needing to sign in first.
      // Personalised progress lives on /jobs/recommendations (per-job
      // tierGate) and on the authenticated /jobs/preflight.
      return respond(
        response,
        200,
        {
          tiers: Object.entries(TIER_REQUIREMENTS).map(([tier, requires]) => ({ tier, requires }))
        },
        { "cache-control": "public, max-age=300" }
      );
    }

    if (request.method === "GET" && pathname === "/jobs/definition") {
      return respond(response, 200, service.getJobDefinition(url.searchParams.get("jobId") ?? ""));
    }

    if (request.method === "GET" && pathname === "/gas/health") {
      return respond(response, 200, await pimlicoClient.healthCheck());
    }

    if (request.method === "GET" && pathname === "/gas/capabilities") {
      return respond(response, 200, pimlicoClient.getCapabilities());
    }

    if (request.method === "GET" && pathname === "/verifier/handlers") {
      return respond(response, 200, { handlers: verifierService.listHandlers() });
    }

    if (request.method === "GET" && pathname === "/verifier/result") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      return respond(response, 200, await verifierService.getResult(sessionId) ?? { status: "not_found" });
    }

    // Public agent profile — the aggregate "LinkedIn for agents" resume.
    // Returns reputation + per-category levels + lifetime stats + ordered
    // badges. Public (no auth) so other agents/humans can verify. See
    // docs/schemas/agent-profile-v1.md for the full format.
    if (request.method === "GET" && pathname.startsWith("/agents/")) {
      const rawWallet = decodeURIComponent(pathname.slice("/agents/".length));
      if (!/^0x[a-fA-F0-9]{40}$/u.test(rawWallet)) {
        throw new ValidationError("wallet path segment must be a 0x-prefixed 20-byte hex address.");
      }
      // Sessions are keyed by the checksummed form (authMiddleware calls
      // getAddress before persisting). We accept lowercase or checksummed
      // in the URL, normalise for lookup, and return lowercase in the body
      // so consumers have a single canonical form to compare against.
      const checksummed = safeChecksum(rawWallet);
      const [reputation, sessions] = await Promise.all([
        service.getReputation(checksummed),
        service.listSessionHistory({ wallet: checksummed, limit: 64 })
      ]);
      const profile = buildAgentProfile({
        wallet: rawWallet.toLowerCase(),
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
      return respond(response, 200, profile, { "cache-control": "public, max-age=30" });
    }

    // Public badge metadata — the "LinkedIn for agents" read surface.
    // Anyone can fetch `/badges/<sessionId>` to inspect a completed job's
    // badge without auth. Returns 404 for missing or not-yet-approved
    // sessions; returns schema-compliant JSON otherwise. See
    // docs/schemas/agent-badge-v1.md for the full format.
    if (request.method === "GET" && pathname.startsWith("/badges/")) {
      const sessionId = decodeURIComponent(pathname.slice("/badges/".length));
      if (!sessionId) {
        throw new ValidationError("sessionId path segment is required.");
      }
      let session;
      try {
        session = await service.resumeSession(sessionId);
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "session_not_found") {
          return respond(response, 404, { status: "not_found", sessionId });
        }
        throw normalized;
      }
      const verification = await verifierService.getResult(sessionId);
      const job = service.getJobDefinition(session.jobId);
      try {
        const badge = buildBadgeFromSession({
          session,
          job,
          verification,
          context: {
            publicBaseUrl: process.env.PUBLIC_BASE_URL,
            posterAddress: process.env.DEFAULT_POSTER_ADDRESS,
            verifierAddress: process.env.DEFAULT_VERIFIER_ADDRESS
          }
        });
        // Keep badge JSON browser-cacheable for a minute — it's deterministic
        // once the session is resolved.
        return respond(response, 200, badge, { "cache-control": "public, max-age=60" });
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "badge_not_ready") {
          return respond(response, 404, { status: "not_ready", sessionId, reason: normalized.message });
        }
        throw normalized;
      }
    }

    // ---------- auth routes ----------

    if (request.method === "POST" && pathname === "/auth/nonce") {
      await enforceLimit("auth_nonce", clientIp(request), rateLimitConfig.authNonce);
      const payload = await readJsonBody(request);
      const wallet = String(payload?.wallet ?? "").trim();
      if (!/^0x[a-fA-F0-9]{40}$/u.test(wallet)) {
        throw new ValidationError("wallet must be a 0x-prefixed 20-byte hex address.");
      }
      const nonce = generateNonce();
      const stored = await stateStore.storeNonce?.(nonce, wallet.toLowerCase(), authConfig.nonceTtlSeconds);
      if (stored === false) {
        throw new ValidationError("Nonce collision — retry.");
      }
      const issuedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + authConfig.nonceTtlSeconds * 1000).toISOString();
      return respond(response, 200, {
        wallet,
        nonce,
        domain: authConfig.domain,
        chainId: authConfig.chainId,
        statement: SIWE_STATEMENT,
        issuedAt,
        expiresAt,
        message: buildSiweMessage({
          domain: authConfig.domain,
          address: wallet,
          statement: SIWE_STATEMENT,
          uri: `https://${authConfig.domain}`,
          chainId: authConfig.chainId,
          nonce,
          issuedAt,
          expirationTime: expiresAt
        })
      });
    }

    if (request.method === "POST" && pathname === "/auth/verify") {
      await enforceLimit("auth_verify", clientIp(request), rateLimitConfig.authVerify);
      const payload = await readJsonBody(request);
      const message = typeof payload?.message === "string" ? payload.message : "";
      const signature = typeof payload?.signature === "string" ? payload.signature : "";
      if (!message || !signature) {
        throw new ValidationError("message and signature are required.");
      }
      if (message.length > 4096) {
        throw new ValidationError("SIWE message exceeds 4096 characters.");
      }
      // EIP-191 personal_sign signatures are 65 bytes -> 132 chars incl. 0x.
      // Some wallets return r/s/v concatenated without 0x; accept both but cap
      // the length to discourage callers from submitting unrelated payloads.
      if (!/^(0x)?[0-9a-fA-F]{130,132}$/u.test(signature)) {
        throw new ValidationError("signature must be a 65-byte hex string.");
      }
      if (!authConfig.signingSecret) {
        throw new AuthenticationError(
          "Auth not configured — set AUTH_JWT_SECRETS to issue tokens.",
          "auth_not_configured"
        );
      }

      const verified = verifySiweMessage(message, signature, {
        expectedDomain: authConfig.domain,
        expectedChainId: authConfig.chainId
      });

      const consumedWallet = await stateStore.consumeNonce?.(verified.nonce);
      if (!consumedWallet) {
        throw new AuthenticationError("Nonce missing or already consumed.", "invalid_nonce");
      }
      if (!walletsMatch(consumedWallet, verified.recoveredAddress)) {
        throw new AuthenticationError("Nonce was issued for a different wallet.", "nonce_wallet_mismatch");
      }

      const roles = authConfig.resolveRoles?.(verified.recoveredAddress) ?? [];
      const { token, claims } = signToken(
        { sub: verified.recoveredAddress, roles },
        { secret: authConfig.signingSecret, expiresInSeconds: authConfig.tokenTtlSeconds }
      );

      return respond(response, 200, {
        token,
        wallet: verified.recoveredAddress,
        roles,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        tokenType: "Bearer"
      });
    }

    if (request.method === "POST" && pathname === "/auth/logout") {
      // Revoke the current JWT by its `jti`. Requires authentication so a
      // random caller can't revoke someone else's token.
      const auth = await authMiddleware(request, url);
      const jti = auth.claims?.jti;
      const exp = auth.claims?.exp;
      if (jti && Number.isFinite(exp)) {
        const ttlSeconds = Math.max(1, exp - Math.floor(Date.now() / 1000));
        await stateStore.revokeToken?.(jti, ttlSeconds);
      }
      return respond(response, 200, {
        status: "logged_out",
        wallet: auth.wallet,
        jti
      });
    }

    // ---------- protected routes ----------

    if (request.method === "GET" && pathname === "/events") {
      const auth = await authMiddleware(request, url, { allowQueryToken: true });
      await enforceLimit("events", auth.wallet, rateLimitConfig.events);
      respondSse(response);
      const filter = {
        wallet: auth.wallet,
        jobId: url.searchParams.get("jobId") ?? undefined,
        sessionId: url.searchParams.get("sessionId") ?? undefined,
        topics: parseTopics(url)
      };
      const lastEventId = request.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? undefined;
      const replay = eventBus?.replay?.(filter, lastEventId);

      if (replay?.gap) {
        writeSseEvent(response, {
          id: `gap-${Date.now()}`,
          topic: "gap",
          data: {
            topic: "gap",
            lastDelivered: lastEventId ?? null
          }
        });
      }

      for (const event of replay?.events ?? []) {
        writeSseEvent(response, { id: event.id, topic: event.topic, data: event });
      }

      const heartbeat = setInterval(() => {
        response.write(": ping\n\n");
      }, 15_000);

      const unsubscribe = eventBus?.subscribe?.(filter, (event) => {
        writeSseEvent(response, { id: event.id, topic: event.topic, data: event });
      });

      metrics.gauge("sse_active_connections").inc();
      request.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe?.();
        metrics.gauge("sse_active_connections").dec();
        response.end();
      });
      return;
    }

    if (request.method === "GET" && pathname === "/account") {
      const auth = await authMiddleware(request, url);
      return respond(response, 200, await service.getAccountSummary(auth.wallet));
    }

    if (request.method === "POST" && pathname === "/account/fund") {
      const auth = await authMiddleware(request, url);
      const asset = url.searchParams.get("asset")?.trim() || "DOT";
      const amount = Number(url.searchParams.get("amount") ?? "0");
      return respond(response, 200, await service.fundAccount(auth.wallet, asset, amount));
    }

    if (request.method === "GET" && pathname === "/reputation") {
      const auth = await authMiddleware(request, url);
      return respond(response, 200, await service.getReputation(auth.wallet));
    }

    if (request.method === "GET" && pathname === "/session") {
      const auth = await authMiddleware(request, url);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      try {
        const session = await service.resumeSession(sessionId);
        if (!walletsMatch(session.wallet, auth.wallet)) {
          throw new AuthorizationError(
            `Session ${sessionId} does not belong to authenticated wallet.`,
            "session_not_owned"
          );
        }
        return respond(response, 200, session);
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "session_not_found") {
          return respond(response, 404, { status: "not_found", sessionId });
        }
        throw normalized;
      }
    }

    if (request.method === "GET" && pathname === "/sessions") {
      const auth = await authMiddleware(request, url);
      const limit = Number(url.searchParams.get("limit") ?? 8);
      const jobId = url.searchParams.get("jobId") ?? undefined;
      return respond(
        response,
        200,
        await service.listSessionHistory({
          wallet: auth.wallet,
          limit: Number.isFinite(limit) ? limit : 8,
          jobId
        })
      );
    }

    if (request.method === "GET" && pathname === "/jobs/recommendations") {
      const auth = await authMiddleware(request, url);
      return respond(response, 200, await service.recommendJobs(auth.wallet));
    }

    if (request.method === "GET" && pathname === "/jobs/preflight") {
      const auth = await authMiddleware(request, url);
      return respond(
        response,
        200,
        await service.preflightJob(auth.wallet, url.searchParams.get("jobId") ?? "")
      );
    }

    if (request.method === "POST" && pathname === "/admin/jobs") {
      const auth = await authMiddleware(request, url, { requireRole: "admin" });
      await enforceLimit("admin_jobs", auth.wallet, rateLimitConfig.adminJobs);
      const payload = await readJsonBody(request);
      return respond(response, 201, service.createJob(payload));
    }

    if (request.method === "POST" && pathname === "/gas/quote") {
      await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      return respond(response, 200, await pimlicoClient.quoteUserOperation(payload.userOperation));
    }

    if (request.method === "POST" && pathname === "/gas/sponsor") {
      await authMiddleware(request, url);
      const payload = await readJsonBody(request);
      return respond(
        response,
        200,
        await pimlicoClient.sponsorUserOperation(payload.userOperation, payload.context ?? {})
      );
    }

    if (request.method === "POST" && pathname === "/jobs/claim") {
      const auth = await authMiddleware(request, url);
      const jobId = url.searchParams.get("jobId") ?? "";
      const idempotencyKey = url.searchParams.get("idempotencyKey") ?? `${auth.wallet}:${jobId}`;
      return respond(response, 200, await service.claimJob(auth.wallet, jobId, "http", idempotencyKey));
    }

    if (request.method === "POST" && pathname === "/jobs/submit") {
      const auth = await authMiddleware(request, url);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const evidence = url.searchParams.get("evidence") ?? "submitted-via-http";
      if (!sessionId) {
        throw new ValidationError("sessionId is required.");
      }
      if (evidence.length > 16 * 1024) {
        throw new ValidationError("evidence exceeds 16 KiB. Submit long payloads via evidenceURI once supported.");
      }
      await ensureSessionOwnership(sessionId, auth.wallet);
      return respond(response, 200, await service.submitWork(sessionId, "http", evidence));
    }

    if (request.method === "POST" && pathname === "/verifier/run") {
      const auth = await authMiddleware(request, url, { requireRole: "verifier" });
      await enforceLimit("verifier_run", auth.wallet, rateLimitConfig.verifierRun);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const evidence = url.searchParams.get("evidence") ?? "";
      const metadataURI = url.searchParams.get("metadataURI") ?? "ipfs://pending-badge";
      return respond(response, 200, await verifierService.verifySubmission({ sessionId, evidence, metadataURI }));
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
    return respond(
      response,
      normalized.statusCode ?? 500,
      {
        error: normalized.code ?? "internal_error",
        message: normalized.message ?? "internal_error",
        details: normalized.details,
        requestId
      },
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
      blockchainEnabled: Boolean(gateway?.isEnabled?.()),
      pimlicoEnabled: Boolean(pimlicoClient?.isEnabled?.())
    },
    "http.listening"
  );
});
