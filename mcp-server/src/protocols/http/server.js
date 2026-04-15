import { createServer } from "node:http";
import { createPlatformRuntime } from "../../services/bootstrap.js";
import { normalizeError } from "../../core/errors.js";

const { platformService: service, verifierService, stateStore, gateway, pimlicoClient } = createPlatformRuntime();
const port = Number(process.env.PORT ?? 8787);

function respond(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload, null, 2));
}

function requireWallet(url) {
  const wallet = url.searchParams.get("wallet")?.trim();
  if (!wallet) {
    const error = new Error("wallet query parameter is required.");
    error.name = "ValidationError";
    throw error;
  }
  return wallet;
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
    const error = new Error("Invalid JSON body.");
    error.name = "ValidationError";
    throw error;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (request.method === "GET" && pathname === "/") {
      return respond(response, 200, {
        name: "agent-platform",
        status: "ok",
        endpoints: [
          "/health",
          "/onboarding",
          "/account",
          "/reputation",
          "/session",
          "/sessions",
          "/jobs",
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

    if (request.method === "GET" && pathname === "/account") {
      return respond(response, 200, await service.getAccountSummary(requireWallet(url)));
    }

    if (request.method === "GET" && pathname === "/reputation") {
      return respond(response, 200, await service.getReputation(requireWallet(url)));
    }

    if (request.method === "GET" && pathname === "/session") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      try {
        return respond(response, 200, await service.resumeSession(sessionId));
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "session_not_found") {
          return respond(response, 404, { status: "not_found", sessionId });
        }
        throw normalized;
      }
    }

    if (request.method === "GET" && pathname === "/sessions") {
      const wallet = url.searchParams.get("wallet") || undefined;
      const limit = Number(url.searchParams.get("limit") ?? 8);
      const jobId = url.searchParams.get("jobId") ?? undefined;
      return respond(
        response,
        200,
        await service.listSessionHistory({
          wallet,
          limit: Number.isFinite(limit) ? limit : 8,
          jobId
        })
      );
    }

    if (request.method === "GET" && pathname === "/jobs/recommendations") {
      return respond(response, 200, await service.recommendJobs(requireWallet(url)));
    }

    if (request.method === "GET" && pathname === "/jobs") {
      return respond(response, 200, service.listJobs());
    }

    if (request.method === "GET" && pathname === "/gas/health") {
      return respond(response, 200, await pimlicoClient.healthCheck());
    }

    if (request.method === "GET" && pathname === "/gas/capabilities") {
      return respond(response, 200, pimlicoClient.getCapabilities());
    }

    if (request.method === "GET" && pathname === "/jobs/definition") {
      return respond(response, 200, service.getJobDefinition(url.searchParams.get("jobId") ?? ""));
    }

    if (request.method === "POST" && pathname === "/admin/jobs") {
      const payload = await readJsonBody(request);
      return respond(response, 201, service.createJob(payload));
    }

    if (request.method === "POST" && pathname === "/gas/quote") {
      const payload = await readJsonBody(request);
      return respond(response, 200, await pimlicoClient.quoteUserOperation(payload.userOperation));
    }

    if (request.method === "POST" && pathname === "/gas/sponsor") {
      const payload = await readJsonBody(request);
      return respond(
        response,
        200,
        await pimlicoClient.sponsorUserOperation(payload.userOperation, payload.context ?? {})
      );
    }

    if (request.method === "POST" && pathname === "/jobs/claim") {
      const wallet = requireWallet(url);
      const jobId = url.searchParams.get("jobId") ?? "";
      const idempotencyKey = url.searchParams.get("idempotencyKey") ?? `${wallet}:${jobId}`;
      return respond(response, 200, await service.claimJob(wallet, jobId, "http", idempotencyKey));
    }

    if (request.method === "POST" && pathname === "/jobs/submit") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const evidence = url.searchParams.get("evidence") ?? "submitted-via-http";
      return respond(response, 200, await service.submitWork(sessionId, "http", evidence));
    }

    if (request.method === "POST" && pathname === "/verifier/run") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const evidence = url.searchParams.get("evidence") ?? "";
      const metadataURI = url.searchParams.get("metadataURI") ?? "ipfs://pending-badge";
      return respond(response, 200, await verifierService.verifySubmission({ sessionId, evidence, metadataURI }));
    }

    if (request.method === "GET" && pathname === "/verifier/result") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      return respond(response, 200, await verifierService.getResult(sessionId) ?? { status: "not_found" });
    }

    if (request.method === "GET" && pathname === "/verifier/handlers") {
      return respond(response, 200, { handlers: verifierService.listHandlers() });
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
  console.log(`HTTP adapter listening on :${port}`);
});
