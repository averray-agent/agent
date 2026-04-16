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

const {
  platformService: service,
  verifierService,
  stateStore,
  gateway,
  pimlicoClient,
  eventBus,
  authConfig,
  authMiddleware
} = createPlatformRuntime();
const port = Number(process.env.PORT ?? 8787);

const SIWE_STATEMENT = "Sign in to the Agent Platform.";

function respond(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload, null, 2));
}

function respondSse(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }

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

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  try {
    // ---------- public routes ----------

    if (request.method === "GET" && pathname === "/") {
      return respond(response, 200, {
        name: "agent-platform",
        status: "ok",
        authMode: authConfig.mode,
        endpoints: [
          "/health",
          "/onboarding",
          "/auth/nonce",
          "/auth/verify",
          "/events",
          "/account",
          "/account/fund",
          "/reputation",
          "/session",
          "/sessions",
          "/jobs",
          "/jobs/preflight",
          "/jobs/recommendations",
          "/gas/health",
          "/gas/capabilities",
          "/gas/quote",
          "/gas/sponsor",
          "/verifier/handlers",
          "/admin/jobs"
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

    if (request.method === "GET" && pathname === "/onboarding") {
      return respond(response, 200, service.getPlatformCapabilities());
    }

    if (request.method === "GET" && pathname === "/jobs") {
      return respond(response, 200, service.listJobs());
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

    // ---------- auth routes ----------

    if (request.method === "POST" && pathname === "/auth/nonce") {
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
      const payload = await readJsonBody(request);
      const message = typeof payload?.message === "string" ? payload.message : "";
      const signature = typeof payload?.signature === "string" ? payload.signature : "";
      if (!message || !signature) {
        throw new ValidationError("message and signature are required.");
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

      const { token, claims } = signToken(
        { sub: verified.recoveredAddress },
        { secret: authConfig.signingSecret, expiresInSeconds: authConfig.tokenTtlSeconds }
      );

      return respond(response, 200, {
        token,
        wallet: verified.recoveredAddress,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        tokenType: "Bearer"
      });
    }

    // ---------- protected routes ----------

    if (request.method === "GET" && pathname === "/events") {
      const auth = await authMiddleware(request, url, { allowQueryToken: true });
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

      request.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe?.();
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
      // TODO(auth-rbac): gate behind admin scope once RBAC lands.
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
      await ensureSessionOwnership(sessionId, auth.wallet);
      return respond(response, 200, await service.submitWork(sessionId, "http", evidence));
    }

    if (request.method === "POST" && pathname === "/verifier/run") {
      // TODO(auth-rbac): gate behind verifier scope once RBAC lands.
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const evidence = url.searchParams.get("evidence") ?? "";
      const metadataURI = url.searchParams.get("metadataURI") ?? "ipfs://pending-badge";
      return respond(response, 200, await verifierService.verifySubmission({ sessionId, evidence, metadataURI }));
    }

    return respond(response, 404, { error: "not_found" });
  } catch (error) {
    const normalized = normalizeError(error);
    return respond(response, normalized.statusCode ?? 500, {
      error: normalized.code ?? "internal_error",
      message: normalized.message ?? "internal_error",
      details: normalized.details
    });
  }
});

server.listen(port, () => {
  console.log(`HTTP adapter listening on :${port} (auth: ${authConfig.mode})`);
});
