import assert from "node:assert/strict";
import test from "node:test";

import { createJobRoutes } from "../http/job-routes.js";
import { createDepositPoolRoutes } from "../http/deposit-pool-routes.js";
import { createCreditPoolRoutes } from "../http/credit-pool-routes.js";
import { createExternalJobRoutes } from "../http/external-job-routes.js";
import { DEPOSIT_POOL_RISK_DISCLOSURE } from "../../core/deposit-pool-disclosure.js";
import { CREDIT_POOL_RISK_DISCLOSURE } from "../../core/credit-pool-disclosure.js";
import { buildDiscoveryManifest } from "../../core/discovery-manifest.js";
import { LIST_VERIFICATION_PROFILES_DESCRIPTION } from "../../core/verify-product-copy.js";
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

function makePublicRoute(fullCapabilities, posterOnboarding = { mode: "open" }) {
  return async ({ request, response, pathname }) => {
    if (request.method !== "GET") return false;
    if (pathname === "/onboarding") {
      respond(response, 200, fullCapabilities);
      return true;
    }
    if (pathname === "/poster/onboarding") {
      respond(response, 200, posterOnboarding);
      return true;
    }
    return false;
  };
}

function makeExternalJobRoute(externalPostingService) {
  return createExternalJobRoutes({
    authMiddleware: async () => ({ wallet: "0x1111111111111111111111111111111111111111", claims: {} }),
    enforceLimit: async () => {},
    externalPostingService,
    rateLimitConfig: { externalDrafts: { limit: 30, windowSeconds: 60 } },
    readJsonBody,
    respond
  });
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
  assert.match(
    byName.get("listJobs").inputSchema.properties.since.description,
    /ISO 8601 or epoch milliseconds/u
  );
});

test("listVerificationProfiles names Base x402 discovery without restating a price", () => {
  const tool = MCP_TOOLS.find(({ name }) => name === "listVerificationProfiles");
  const discovered = buildDiscoveryManifest().tools.find(({ name }) => name === "listVerificationProfiles");

  assert.equal(tool.description, LIST_VERIFICATION_PROFILES_DESCRIPTION);
  assert.equal(discovered.description, LIST_VERIFICATION_PROFILES_DESCRIPTION);
  assert.match(tool.description, /https:\/\/api\.averray\.com\/\.well-known\/x402/u);
  assert.match(tool.description, /USDC 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 on Base eip155:8453/u);
  assert.doesNotMatch(tool.description, /(?:\b5(?:\.0+)?\s*USDC\b|\b5000000\b|\$5\b)/iu);
  assert.doesNotMatch(tool.description, /(?:eip155:420420419|asset 1337|0x0000053900000000000000000000000001200000)/iu);
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
    if (request.method === "POST" && pathname === "/account/deposit/transactions") {
      respond(response, 200, {
        available: true,
        templates: [
          { step: "approve", unsigned: true },
          { step: "deposit", unsigned: true, prerequisite: "approve_confirmed_on_chain" }
        ]
      });
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

function assertTwoSidedWelcome(welcome) {
  assert.match(welcome.what, /pays agents/u);
  assert.match(welcome.what, /sells verified outcomes/u);
  assert.ok(Array.isArray(welcome.buyerPath) && welcome.buyerPath.length > 0, "buyerPath must be non-empty");
  assert.match(welcome.buyerPath.join(" "), /never billed/iu);
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
  assertTwoSidedWelcome(welcome);
  assert.deepEqual(welcome.proofToPay, {
    summary: "Escrow for work you commission from a counterparty you already chose; funds release on PASS only.",
    page: "https://averray.com/proof-to-pay"
  });
  assert.match(welcome.freshWallet, /only from starter jobs marked onboardingWaiverEligible/u);
  assert.equal(
    welcome.progression,
    "Completions raise your claim caps; deposits raise them further — see getAccountPosition and explainEligibility for yours."
  );
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

test("deleting buyerPath fails the two-sided welcome guard by name", async () => {
  const execute = createMcpToolExecutor({
    handleAuthRoute: async () => false,
    handleJobRoute: async () => false,
    handlePublicMetadataRoute: makePublicRoute({ discoveryUrl: "https://averray.com/.well-known/agent-tools.json" })
  });
  const welcome = await execute(
    "getPlatformCapabilities",
    {},
    { request: { headers: {}, socket: { remoteAddress: "127.0.0.1" } } }
  );
  const mutated = structuredClone(welcome);
  delete mutated.buyerPath;

  assert.throws(
    () => assertTwoSidedWelcome(mutated),
    /buyerPath must be non-empty/u
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
    handleExternalJobRoute: makeExternalJobRoute({
      createDraft: async (_wallet, payload) => ({ draftId: "draft-1", definition: payload.definition }),
      buildPostJobTransactions: async (_wallet, draftId) => ({ draftId, templates: [{ unsigned: true }] })
    }),
    handleJobRoute: makeJobRoute(service, "mcp"),
    handleLockedTierRoute: async ({ response, pathname }) => {
      respond(response, pathname.endsWith("/consent") ? 201 : 200, { pathname });
      return true;
    },
    handlePublicMetadataRoute: makePublicRoute({ discoveryUrl: "https://example.test/agent-tools.json" }),
    handleVerifyRoute: async ({ response, pathname }) => {
      respond(response, 200, { pathname, profiles: [] });
      return true;
    }
  });
  const request = {
    headers: { authorization: "Bearer test-token" },
    socket: { remoteAddress: "127.0.0.1" }
  };
  const args = {
    getPlatformCapabilities: {},
    getPosterOnboarding: {},
    draftJob: { definition: { rewardAmount: "1" } },
    buildPostJobTransactions: { draftId: "draft-1" },
    listVerificationProfiles: {},
    listJobs: {},
    getJobDefinition: { jobId: "job-1" },
    validateJobSubmission: { jobId: "job-1", submission: {} },
    preflightJob: { jobId: "job-1" },
    estimateNetReward: { jobId: "job-1" },
    explainEligibility: { jobId: "job-1" },
    getDepositPoolInfo: {},
    getAccountPosition: { asset: "USDC" },
    buildWithdrawTransactions: { asset: "USDC", amount: "1" },
    buildAccountDepositTransactions: { asset: "USDC", amount: "1" },
    quoteLockedDeposit: { tier: "t30", amountRaw: "1", consentNonce: "nonce0001" },
    createLockedDeposit: {
      terms: {},
      termsHash: `0x${"1".repeat(64)}`,
      consentSignature: `0x${"1".repeat(130)}`
    },
    requestLockedDepositExit: { lockId: `0x${"1".repeat(64)}` },
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
    "getPosterOnboarding",
    "buildPostJobTransactions",
    "listVerificationProfiles",
    "listJobs",
    "getJobDefinition",
    "validateJobSubmission",
    "preflightJob",
    "estimateNetReward",
    "explainEligibility",
    "getDepositPoolInfo",
    "getAccountPosition",
    "quoteLockedDeposit",
    "buildDepositPoolTransactions",
    "getCreditInfo",
    "buildCreditTransactions"
  ];

  for (const name of idempotentReads) {
    assert.equal(byName[name].annotations.readOnlyHint, true, name);
    assert.equal(byName[name].annotations.idempotentHint, true, name);
  }
  assert.equal(byName.fetchAuthNonce.annotations.readOnlyHint, true);
  assert.equal(byName.draftJob.annotations.readOnlyHint, false);
  assert.equal(byName.draftJob.annotations.idempotentHint, false);
  assert.equal(byName.buildWithdrawTransactions.annotations.readOnlyHint, false);
  assert.equal(byName.buildAccountDepositTransactions.annotations.readOnlyHint, false);
  assert.equal(byName.createLockedDeposit.annotations.readOnlyHint, false);
  assert.equal(byName.requestLockedDepositExit.annotations.readOnlyHint, false);
  assert.equal(byName.buildWithdrawTransactions.annotations.idempotentHint, true);
  assert.equal(byName.buildAccountDepositTransactions.annotations.idempotentHint, true);
  assert.match(byName.buildWithdrawTransactions.description, /lifetime-once 0\.03 DOT/u);
  assert.match(byName.buildAccountDepositTransactions.description, /no depositFor/iu);
  assert.match(byName.buildAccountDepositTransactions.description, /brokered claim does not broker the deposit/iu);
  assert.match(byName.buildAccountDepositTransactions.description, /pay.*gas.*DOT/iu);
  assert.equal(byName.fetchAuthNonce.annotations.destructiveHint, false);
  assert.equal(byName.refreshAuthToken.annotations.destructiveHint, false);
  assert.equal(byName.claimJob.annotations.idempotentHint, true);
  assert.match(byName.claimJob.description, /same wallet and jobId/u);
  assert.match(byName.claimJob.description, /exceed 10 seconds/u);
  assert.deepEqual(byName.claimJob._meta["com.averray/auth"].scopes, ["jobs:claim"]);
  assert.deepEqual(byName.submitWork._meta["com.averray/auth"].scopes, ["jobs:submit"]);
  assert.equal(byName.getDepositPoolInfo._meta["com.averray/auth"].required, false);
  assert.equal(byName.getPosterOnboarding._meta["com.averray/auth"].required, false);
  assert.equal(byName.draftJob._meta["com.averray/auth"].required, true);
  assert.equal(byName.buildPostJobTransactions._meta["com.averray/auth"].required, true);
  assert.equal(byName.getAccountPosition._meta["com.averray/auth"].required, true);
  assert.equal(byName.buildWithdrawTransactions._meta["com.averray/auth"].required, true);
  assert.equal(byName.buildAccountDepositTransactions._meta["com.averray/auth"].required, true);
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

test("poster MCP tools are payload-identical to the shared onboarding and draft HTTP routes", async () => {
  const posterOnboarding = {
    mode: "open",
    chain: { name: "Polkadot Hub", chainId: 420420419, caip2: "eip155:420420419" },
    token: { name: "Hub USDC", assetId: 1337, decimals: 6, x402Payable: false },
    economics: { feeSemantics: "poster_additive", minRewardUsdc: "1" }
  };
  const externalPostingService = {
    async createDraft(wallet, payload) {
      return {
        wallet,
        draftId: "draft-1",
        definition: payload.definition,
        fundingRequirement: { posterReservedRaw: "1050000" }
      };
    },
    async buildPostJobTransactions(wallet, draftId) {
      return {
        wallet,
        draftId,
        depositAmountRaw: "950000",
        templates: [{ step: "create", unsigned: true, value: "0" }]
      };
    }
  };
  const handlePublicMetadataRoute = makePublicRoute({}, posterOnboarding);
  const handleExternalJobRoute = makeExternalJobRoute(externalPostingService);
  const execute = createMcpToolExecutor({
    handleAuthRoute: async () => false,
    handleExternalJobRoute,
    handleJobRoute: async () => false,
    handlePublicMetadataRoute
  });
  const request = {
    headers: { authorization: "Bearer poster-token" },
    socket: { remoteAddress: "127.0.0.1" }
  };

  const onboardingHttp = await invokeHttpRoute(handlePublicMetadataRoute, {
    method: "GET",
    path: "/poster/onboarding",
    sourceRequest: request
  });
  assert.deepEqual(await execute("getPosterOnboarding", {}, { request }), onboardingHttp.body);

  const definition = { rewardAmount: "1", inputSchemaRef: "schema://jobs/coding-input" };
  const draftHttp = await invokeHttpRoute(handleExternalJobRoute, {
    body: { definition },
    headers: request.headers,
    method: "POST",
    path: "/jobs/draft",
    sourceRequest: request
  });
  assert.deepEqual(await execute("draftJob", { definition }, { request }), draftHttp.body);

  const buildHttp = await invokeHttpRoute(handleExternalJobRoute, {
    body: {},
    headers: request.headers,
    method: "POST",
    path: "/jobs/draft/draft-1/transactions",
    sourceRequest: request
  });
  assert.deepEqual(
    await execute("buildPostJobTransactions", { draftId: "draft-1" }, { request }),
    buildHttp.body
  );
});

test("MCP postJob surface accepts no signing or relay material", async () => {
  const names = ["getPosterOnboarding", "draftJob", "buildPostJobTransactions"];
  const byName = Object.fromEntries(MCP_TOOLS.map((entry) => [entry.name, entry]));
  for (const name of names) {
    const input = JSON.stringify(byName[name].inputSchema);
    assert.doesNotMatch(
      input,
      /private.?key|mnemonic|signature|signed.?transaction|raw.?transaction|broadcast/iu,
      `${name} must not accept signing or relay material`
    );
  }

  const handleExternalJobRoute = makeExternalJobRoute({
    async buildPostJobTransactions(wallet, draftId) {
      return {
        wallet,
        draftId,
        templates: [{ unsigned: true }],
        broadcast: {
          signer: "your own wallet",
          note: "Sign locally and submit through your own RPC. Averray has no signed-transaction relay."
        },
        boundary: {
          platformHoldsFunds: false,
          platformMovesFunds: false,
          platformBrokersFunds: false,
          platformSigns: false,
          platformSeesKeys: false,
          signedTransactionRelay: false
        }
      };
    }
  });
  const execute = createMcpToolExecutor({
    handleAuthRoute: async () => false,
    handleExternalJobRoute,
    handleJobRoute: async () => false,
    handlePublicMetadataRoute: async () => false
  });
  const built = await execute(
    "buildPostJobTransactions",
    { draftId: "draft-1" },
    {
      request: {
        headers: { authorization: "Bearer poster-token" },
        socket: { remoteAddress: "127.0.0.1" }
      }
    }
  );

  assert.ok(built.templates.every(({ unsigned }) => unsigned === true));
  assert.equal(built.boundary.platformSigns, false);
  assert.equal(built.boundary.signedTransactionRelay, false);
  assert.equal("signedTransaction" in built, false);
  assert.equal("rawTransaction" in built, false);
});

test("MCP account deposit surface accepts no signing, custody, or relay material", () => {
  const tool = MCP_TOOLS.find(({ name }) => name === "buildAccountDepositTransactions");
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["amount", "asset"]);
  assert.doesNotMatch(
    JSON.stringify(tool.inputSchema),
    /private.?key|mnemonic|signature|signed.?transaction|raw.?transaction|broadcast|relay/iu
  );
  assert.equal(tool.inputSchema.properties.amount.pattern, "^[1-9][0-9]*$");
});

test("listJobs returns the same value through MCP and its HTTP route", async () => {
  const priorityWindow = {
    openAt: "2026-08-22T12:05:00.000Z",
    qualifiesWith: "≥ 1 USDC vested deposit and no outstanding credit draw"
  };
  const jobs = [
    {
      id: "job-1",
      title: "One",
      state: "open",
      description: "First",
      visible: true,
      listedAt: "2026-08-22T12:00:00.000Z",
      priorityWindow
    },
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
  const path = "/jobs?wallet=0xworker&format=compact&limit=2&state=open&since=1787356800000";
  const viaHttp = await invokeHttpRoute(httpRoute, {
    method: "GET",
    path,
    sourceRequest
  });
  const viaMcp = await execute("listJobs", {
    wallet: "0xworker",
    format: "compact",
    limit: 2,
    state: "open",
    since: 1_787_356_800_000
  }, { request: sourceRequest });

  assert.equal(viaHttp.statusCode, 200);
  assert.deepEqual(viaMcp, viaHttp.body);
  assert.equal(viaMcp.count, 2);
  assert.ok(viaMcp.jobs.every((job) => job.id !== "job-hidden"));
  assert.equal(viaMcp.jobs[0].listedAt, "2026-08-22T12:00:00.000Z");
  assert.deepEqual(viaMcp.jobs[0].priorityWindow, priorityWindow);
});

test("preflight and reward advisory tools use the existing authenticated job handlers", async () => {
  const calls = [];
  const priorityWindow = {
    openAt: "2026-08-22T12:05:00.000Z",
    qualifiesWith: "≥ 1 USDC vested deposit and no outstanding credit draw"
  };
  const service = {
    preflightJob: async (wallet, jobId) => {
      calls.push(["preflightJob", wallet, jobId]);
      return {
        wallet,
        jobId,
        eligible: false,
        reason: "priority_window_active",
        openAt: priorityWindow.openAt,
        priorityWindow
      };
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
    {
      wallet: "0xworker",
      jobId: "job-2",
      eligible: false,
      reason: "priority_window_active",
      openAt: priorityWindow.openAt,
      priorityWindow
    }
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
