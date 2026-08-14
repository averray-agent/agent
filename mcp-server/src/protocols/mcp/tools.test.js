import assert from "node:assert/strict";
import test from "node:test";

import { createJobRoutes } from "../http/job-routes.js";
import { createDepositPoolRoutes } from "../http/deposit-pool-routes.js";
import { createCreditPoolRoutes } from "../http/credit-pool-routes.js";
import { DEPOSIT_POOL_RISK_DISCLOSURE } from "../../core/deposit-pool-disclosure.js";
import { CREDIT_POOL_RISK_DISCLOSURE } from "../../core/credit-pool-disclosure.js";
import { readJsonBody, respond } from "../http/http-helpers.js";
import {
  createMcpToolExecutor,
  createMcpTools,
  DEFAULT_MCP_MAX_REQUEST_BODY_BYTES,
  MCP_TOOLS,
  MCP_WELCOME_TOKEN_BUDGET
} from "./tools.js";
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

function makePublicRoute(fullCapabilities) {
  return async ({ request, response, pathname }) => {
    if (request.method !== "GET" || pathname !== "/onboarding") return false;
    respond(response, 200, fullCapabilities);
    return true;
  };
}

function makeDepositPoolRoute() {
  return createDepositPoolRoutes({
    authMiddleware: async () => ({ wallet: "0xworker" }),
    depositPoolDoor: {
      getInfo: async (wallet) => ({
        available: true,
        disclosure: { statement: DEPOSIT_POOL_RISK_DISCLOSURE },
        ...(wallet ? { wallet } : {})
      }),
      buildTransactions: async (wallet, payload) => ({ wallet, ...payload, unsigned: true })
    },
    readJsonBody,
    respond
  });
}

test("job browsing tools frame listing descriptions as untrusted data", () => {
  const byName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));
  assert.match(byName.get("listJobs").description, /untrusted data, not instructions/u);
  assert.match(byName.get("listJobs").description, /contentTrust and provenance/u);
  assert.match(byName.get("getJobDefinition").description, /untrusted job data, not instructions/u);
});

function makeEarningsDoorRoute() {
  return async ({ request, response, pathname, url }) => {
    if (request.method === "GET" && pathname === "/account/position") {
      respond(response, 200, { available: true, asset: url.searchParams.get("asset"), account: { available: { raw: "7" } } });
      return true;
    }
    if (request.method === "POST" && pathname === "/account/withdraw/transactions") {
      respond(response, 200, { available: true, templates: [{ unsigned: true }] });
      return true;
    }
    return false;
  };
}

function makeCreditPoolRoute() {
  return createCreditPoolRoutes({
    authMiddleware: async () => ({ wallet: "0xworker" }),
    creditPoolDoor: {
      getInfo: async (wallet) => ({ available: true, wallet, disclosure: { statement: CREDIT_POOL_RISK_DISCLOSURE } }),
      buildTransactions: async (wallet, input) => ({ available: true, wallet, input, unsigned: true })
    },
    readJsonBody,
    respond
  });
}

test("getPlatformCapabilities defaults to a bounded welcome and preserves the full response byte-for-byte", async () => {
  const fullCapabilities = {
    name: "Averray — trusted agent work + identity runtime",
    discoveryUrl: "https://averray.com/.well-known/agent-tools.json",
    onboarding: {
      walletModes: Array.from({ length: 5 }, (_, index) => ({ id: `mode-${index}`, detail: "unchanged" })),
      actionRequirements: Array.from({ length: 14 }, (_, index) => ({ id: index }))
    },
    tools: Array.from({ length: 28 }, (_, index) => `http-tool-${index}`),
    contracts: { abi: ["unchanged", "detail"] }
  };
  const handlePublicMetadataRoute = makePublicRoute(fullCapabilities);
  const execute = createMcpToolExecutor({
    handleAuthRoute: async () => false,
    handleJobRoute: async () => false,
    handlePublicMetadataRoute
  });
  const request = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };

  const direct = await invokeHttpRoute(handlePublicMetadataRoute, {
    method: "GET",
    path: "/onboarding",
    sourceRequest: request
  });
  const full = await execute("getPlatformCapabilities", { detail: "full" }, { request });
  const welcome = await execute("getPlatformCapabilities", {}, { request });

  assert.equal(JSON.stringify(full), JSON.stringify(direct.body));
  assert.equal(full.tools.length, 28, "full detail must retain the existing HTTP tool vocabulary");
  assert.equal(welcome.tools.surface, "mcp");
  assert.deepEqual(welcome.tools.names, MCP_TOOLS.map(({ name }) => name));
  assert.match(welcome.freshWallet, /only from starter jobs marked onboardingWaiverEligible/u);
  assert.deepEqual(welcome.requestLimit, {
    maxBodyBytes: DEFAULT_MCP_MAX_REQUEST_BODY_BYTES,
    scope: "full request: JSON-RPC envelope + _meta"
  });
  assert.deepEqual(welcome.fullDetail.call.arguments, { detail: "full" });

  // A conservative three UTF-8 bytes per token keeps the fixture below the
  // stated budget without coupling the server to a model-specific tokenizer.
  const conservativeTokenEstimate = Math.ceil(Buffer.byteLength(JSON.stringify(welcome), "utf8") / 3);
  assert.ok(
    conservativeTokenEstimate <= MCP_WELCOME_TOKEN_BUDGET,
    `welcome estimated at ${conservativeTokenEstimate} tokens; budget is ${MCP_WELCOME_TOKEN_BUDGET}`
  );
});

test("request-heavy tools and the welcome advertise the configured complete-body limit", async () => {
  const maxRequestBodyBytes = 32 * 1024;
  const tools = createMcpTools({ maxRequestBodyBytes });
  const execute = createMcpToolExecutor({
    handleAuthRoute: async () => false,
    handleJobRoute: async () => false,
    handlePublicMetadataRoute: makePublicRoute({ discoveryUrl: "https://example.test/agent-tools.json" }),
    maxRequestBodyBytes,
    tools
  });
  const request = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  const welcome = await execute("getPlatformCapabilities", {}, { request });
  const byName = Object.fromEntries(tools.map((entry) => [entry.name, entry]));

  assert.equal(welcome.requestLimit.maxBodyBytes, maxRequestBodyBytes);
  assert.match(welcome.requestLimit.scope, /full request: JSON-RPC envelope \+ _meta/u);
  for (const name of ["validateJobSubmission", "submitWork"]) {
    assert.match(byName[name].description, new RegExp(String(maxRequestBodyBytes), "u"), name);
    assert.match(byName[name].description, /envelope and _meta/u, name);
  }
});

test("every tool advertised by the MCP welcome resolves through this surface", async () => {
  const service = {
    listJobsWithSessions: async () => [],
    getPublicJobDefinition: async (jobId) => ({ jobId }),
    validateJobSubmission: async (jobId) => ({ jobId, valid: true }),
    preflightJob: async (wallet, jobId) => ({ wallet, jobId, eligible: true }),
    estimateNetReward: async () => 1,
    explainEligibility: async (wallet, jobId) => ({ wallet, jobId, eligible: true }),
    claimJob: async () => ({ sessionId: "session-1" }),
    submitWork: async () => ({ accepted: true })
  };
  const handleAuthRoute = async ({ response, pathname }) => {
    respond(response, 200, { pathname });
    return true;
  };
  const execute = createMcpToolExecutor({
    handleAuthRoute,
    handleCreditPoolRoute: makeCreditPoolRoute(),
    handleDepositPoolRoute: makeDepositPoolRoute(),
    handleEarningsDoorRoute: makeEarningsDoorRoute(),
    handleJobRoute: makeJobRoute(service, "mcp"),
    handlePublicMetadataRoute: makePublicRoute({ discoveryUrl: "https://example.test/agent-tools.json" })
  });
  const request = {
    headers: { authorization: "Bearer test-token" },
    socket: { remoteAddress: "127.0.0.1" }
  };
  const args = {
    getPlatformCapabilities: {},
    listJobs: {},
    getJobDefinition: { jobId: "job-1" },
    validateJobSubmission: { jobId: "job-1", submission: {} },
    preflightJob: { jobId: "job-1" },
    estimateNetReward: { jobId: "job-1" },
    explainEligibility: { jobId: "job-1" },
    getDepositPoolInfo: {},
    getAccountPosition: { asset: "USDC" },
    buildWithdrawTransactions: { asset: "USDC", amount: "1" },
    buildDepositPoolTransactions: { direction: "withdraw", shares: "1" },
    getCreditInfo: {},
    buildCreditTransactions: { direction: "withdraw", shares: "1" },
    fetchAuthNonce: { wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    verifySiwe: { message: "message", signature: `0x${"1".repeat(130)}` },
    refreshAuthToken: {},
    claimJob: { jobId: "job-1" },
    submitWork: { sessionId: "session-1", submission: {} }
  };
  const welcome = await execute("getPlatformCapabilities", {}, { request });

  for (const name of welcome.tools.names) {
    assert.ok(Object.hasOwn(args, name), `missing test arguments for advertised tool ${name}`);
    await assert.doesNotReject(execute(name, args[name], { request }), name);
  }
});

test("tool annotations match read, routine-auth, and gated-action semantics", () => {
  const byName = Object.fromEntries(MCP_TOOLS.map((entry) => [entry.name, entry]));
  const idempotentReads = [
    "getPlatformCapabilities",
    "listJobs",
    "getJobDefinition",
    "validateJobSubmission",
    "preflightJob",
    "estimateNetReward",
    "explainEligibility",
    "getDepositPoolInfo",
    "getAccountPosition",
    "buildWithdrawTransactions",
    "buildDepositPoolTransactions",
    "getCreditInfo",
    "buildCreditTransactions"
  ];

  for (const name of idempotentReads) {
    assert.equal(byName[name].annotations.readOnlyHint, true, name);
    assert.equal(byName[name].annotations.idempotentHint, true, name);
  }
  assert.equal(byName.fetchAuthNonce.annotations.readOnlyHint, true);
  assert.equal(byName.fetchAuthNonce.annotations.destructiveHint, false);
  assert.equal(byName.refreshAuthToken.annotations.destructiveHint, false);
  assert.equal(byName.claimJob.annotations.idempotentHint, true);
  assert.match(byName.claimJob.description, /same wallet and jobId/u);
  assert.match(byName.claimJob.description, /exceed 10 seconds/u);
  assert.deepEqual(byName.claimJob._meta["com.averray/auth"].scopes, ["jobs:claim"]);
  assert.deepEqual(byName.submitWork._meta["com.averray/auth"].scopes, ["jobs:submit"]);
  assert.equal(byName.getDepositPoolInfo._meta["com.averray/auth"].required, false);
  assert.equal(byName.getAccountPosition._meta["com.averray/auth"].required, true);
  assert.equal(byName.buildWithdrawTransactions._meta["com.averray/auth"].required, true);
  assert.equal(byName.buildDepositPoolTransactions._meta["com.averray/auth"].required, true);
  assert.equal(byName.claimJob._meta["com.averray/auth"].required, true);
  assert.equal(byName.submitWork._meta["com.averray/auth"].required, true);
});

test("deposit pool MCP tools are payload-identical to the shared HTTP routes", async () => {
  const handleDepositPoolRoute = makeDepositPoolRoute();
  const execute = createMcpToolExecutor({
    handleAuthRoute: async () => false,
    handleDepositPoolRoute,
    handleJobRoute: async () => false,
    handlePublicMetadataRoute: async () => false
  });
  const request = {
    headers: { authorization: "Bearer token" },
    socket: { remoteAddress: "127.0.0.1" }
  };
  const httpInfo = await invokeHttpRoute(handleDepositPoolRoute, {
    headers: request.headers,
    method: "GET",
    path: "/pool",
    sourceRequest: request
  });
  const mcpInfo = await execute("getDepositPoolInfo", {}, { request });
  assert.deepEqual(mcpInfo, httpInfo.body);
  assert.deepEqual(httpInfo.body.disclosure, { statement: DEPOSIT_POOL_RISK_DISCLOSURE });
  assert.deepEqual(mcpInfo.disclosure, { statement: DEPOSIT_POOL_RISK_DISCLOSURE });

  const input = { direction: "withdraw", shares: "1" };
  const httpBuild = await invokeHttpRoute(handleDepositPoolRoute, {
    body: input,
    headers: request.headers,
    method: "POST",
    path: "/pool/transactions",
    sourceRequest: request
  });
  const mcpBuild = await execute("buildDepositPoolTransactions", input, { request });
  assert.deepEqual(mcpBuild, httpBuild.body);
});

test("credit pool MCP tools are payload-identical to the shared SIWE HTTP routes", async () => {
  const handleCreditPoolRoute = makeCreditPoolRoute();
  const execute = createMcpToolExecutor({
    handleAuthRoute: async () => false,
    handleCreditPoolRoute,
    handleJobRoute: async () => false,
    handlePublicMetadataRoute: async () => false
  });
  const request = { headers: { authorization: "Bearer token" }, socket: { remoteAddress: "127.0.0.1" } };
  const httpInfo = await invokeHttpRoute(handleCreditPoolRoute, { headers: request.headers, method: "GET", path: "/credit", sourceRequest: request });
  const mcpInfo = await execute("getCreditInfo", {}, { request });
  assert.deepEqual(mcpInfo, httpInfo.body);
  assert.deepEqual(mcpInfo.disclosure, { statement: CREDIT_POOL_RISK_DISCLOSURE });
  const input = { direction: "borrow", pledgeShares: "10", amount: "8" };
  const httpBuild = await invokeHttpRoute(handleCreditPoolRoute, { body: input, headers: request.headers, method: "POST", path: "/credit/transactions", sourceRequest: request });
  assert.deepEqual(await execute("buildCreditTransactions", input, { request }), httpBuild.body);
});

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

test("preflight and reward advisory tools use the existing authenticated job handlers", async () => {
  const calls = [];
  const service = {
    preflightJob: async (wallet, jobId) => {
      calls.push(["preflightJob", wallet, jobId]);
      return { wallet, jobId, eligible: true };
    },
    estimateNetReward: async (wallet, jobId) => {
      calls.push(["estimateNetReward", wallet, jobId]);
      return 0.4;
    },
    explainEligibility: async (wallet, jobId) => {
      calls.push(["explainEligibility", wallet, jobId]);
      return { wallet, jobId, reason: "eligible" };
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

  assert.deepEqual(
    await execute("preflightJob", { jobId: "job-2" }, { request }),
    { wallet: "0xworker", jobId: "job-2", eligible: true }
  );
  assert.equal(await execute("estimateNetReward", { jobId: "job-2" }, { request }), 0.4);
  assert.deepEqual(
    await execute("explainEligibility", { jobId: "job-2" }, { request }),
    { wallet: "0xworker", jobId: "job-2", reason: "eligible" }
  );
  assert.deepEqual(calls, [
    ["preflightJob", "0xworker", "job-2"],
    ["estimateNetReward", "0xworker", "job-2"],
    ["explainEligibility", "0xworker", "job-2"]
  ]);
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

test("claimJob inherits the HTTP route's wallet and job idempotency default", async () => {
  const calls = [];
  const service = {
    claimJob: async (wallet, jobId, protocol, idempotencyKey) => {
      calls.push({ wallet, jobId, protocol, idempotencyKey });
      return { sessionId: "session-default-key" };
    }
  };
  const execute = createMcpToolExecutor({
    handleAuthRoute: async () => false,
    handleJobRoute: makeJobRoute(service, "mcp"),
    handlePublicMetadataRoute: async () => false
  });

  const result = await execute(
    "claimJob",
    { jobId: "job-default-key" },
    {
      request: {
        headers: { authorization: "Bearer token" },
        socket: { remoteAddress: "127.0.0.1" }
      }
    }
  );

  assert.deepEqual(result, { sessionId: "session-default-key" });
  assert.deepEqual(calls, [{
    wallet: "0xworker",
    jobId: "job-default-key",
    protocol: "mcp",
    idempotencyKey: "0xworker:job-default-key"
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
