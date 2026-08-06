import assert from "node:assert/strict";
import test from "node:test";

import { createJobRoutes } from "../http/job-routes.js";
import { readJsonBody, respond } from "../http/http-helpers.js";
import { createMcpToolExecutor } from "./tools.js";
import { invokeHttpRoute } from "./route-adapter.js";

function makeJobRoute(service, protocol = "http") {
  return createJobRoutes({
    authMiddleware: async () => ({ wallet: "0xworker" }),
    enforceLimit: async () => {},
    ensureSessionOwnership: async () => {},
    externalPostingService: {
      filterExternalCatalogProjection: async (jobs) => jobs.filter((job) => job.visible !== false)
    },
    posterOnboardingService: {
      enrichExternalCatalogRows: async (jobs) => jobs.map((job) => ({ ...job, enriched: true }))
    },
    protocol,
    rateLimitConfig: { adminJobs: { limit: 1, windowSeconds: 60 } },
    readJsonBody,
    respond,
    service
  });
}

test("listJobs returns the same value through MCP and its HTTP route", async () => {
  const jobs = [
    { id: "job-1", title: "One", state: "open", description: "First", visible: true },
    { id: "job-hidden", title: "Hidden", state: "open", visible: false },
    { id: "job-2", title: "Two", state: "open", description: "Second", visible: true }
  ];
  const service = {
    listJobsWithSessions: async ({ wallet }) => jobs.map((job) => ({ ...job, projectedWallet: wallet }))
  };
  const httpRoute = makeJobRoute(service, "http");
  const mcpRoute = makeJobRoute(service, "mcp");
  const execute = createMcpToolExecutor({
    handleAuthRoute: async () => false,
    handleJobRoute: mcpRoute,
    handlePublicMetadataRoute: async () => false
  });
  const sourceRequest = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  const path = "/jobs?wallet=0xworker&format=compact&limit=2&state=open";
  const viaHttp = await invokeHttpRoute(httpRoute, {
    method: "GET",
    path,
    sourceRequest
  });
  const viaMcp = await execute("listJobs", {
    wallet: "0xworker",
    format: "compact",
    limit: 2,
    state: "open"
  }, { request: sourceRequest });

  assert.equal(viaHttp.statusCode, 200);
  assert.deepEqual(viaMcp, viaHttp.body);
  assert.equal(viaMcp.count, 2);
  assert.ok(viaMcp.jobs.every((job) => job.id !== "job-hidden"));
});

test("claimJob uses the shared HTTP handler with MCP as the protocol label", async () => {
  const calls = [];
  const service = {
    claimJob: async (wallet, jobId, protocol, idempotencyKey) => {
      calls.push({ wallet, jobId, protocol, idempotencyKey });
      return { sessionId: "session-1" };
    }
  };
  const execute = createMcpToolExecutor({
    handleAuthRoute: async () => false,
    handleJobRoute: makeJobRoute(service, "mcp"),
    handlePublicMetadataRoute: async () => false
  });
  const request = {
    headers: { authorization: "Bearer token" },
    socket: { remoteAddress: "127.0.0.1" }
  };

  const result = await execute("claimJob", {
    jobId: "job-1",
    idempotencyKey: "idem-1"
  }, { request });

  assert.deepEqual(result, { sessionId: "session-1" });
  assert.deepEqual(calls, [{
    wallet: "0xworker",
    jobId: "job-1",
    protocol: "mcp",
    idempotencyKey: "idem-1"
  }]);
});

test("SIWE MCP tools delegate to the existing auth route handler", async () => {
  const calls = [];
  const handleAuthRoute = async ({ request, response, pathname }) => {
    const payload = await readJsonBody(request);
    calls.push({ pathname, payload, authorization: request.headers.authorization });
    respond(response, 200, { pathname, payload });
    return true;
  };
  const execute = createMcpToolExecutor({
    handleAuthRoute,
    handleJobRoute: async () => false,
    handlePublicMetadataRoute: async () => false
  });
  const request = {
    headers: { authorization: "Bearer current-token", cookie: "refresh_token=ignored" },
    socket: { remoteAddress: "127.0.0.1" }
  };

  await execute("fetchAuthNonce", {
    wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }, { request });
  await execute("verifySiwe", {
    message: "signed message",
    signature: `0x${"1".repeat(130)}`
  }, { request });
  await execute("refreshAuthToken", {}, { request });

  assert.deepEqual(calls.map(({ pathname }) => pathname), [
    "/auth/nonce",
    "/auth/verify",
    "/auth/refresh"
  ]);
  assert.equal(calls[2].authorization, "Bearer current-token");
});
