import assert from "node:assert/strict";
import test from "node:test";
import { TypedDataEncoder, Wallet } from "ethers";
import { MemoryStateStore } from "../../core/state-store.js";
import { VerificationRunService } from "../../services/verification-run-service.js";
import { VerificationProfileRegistry } from "../../services/verification-profile-registry.js";
import { X402VerificationPaymentGate } from "../../payments/x402-verification-payment-gate.js";
import { createVerifyRoutes } from "../http/verify-routes.js";
import { readJsonBody, respond } from "../http/http-helpers.js";
import { invokeHttpRoute } from "./route-adapter.js";
import { buildMcpWelcome, createMcpToolExecutor, MCP_TOOLS, MCP_WELCOME_TOKEN_BUDGET } from "./tools.js";
import { createMcpRoute, MODERN_MCP_VERSION } from "./handler.js";
import { DISCOVERY_TOOLS, CONNECTED_ONLY_TOOLS } from "../../core/discovery-manifest.js";
import { ACCOUNT_ACTION_PARITY_MAPPINGS } from "../../core/agent-surface-parity.js";
import { MetricRegistry } from "../../core/metrics.js";
import { VERIFY_BILLING_RULE } from "../../core/verify-product-copy.js";
import { assertBaseOnlyX402Surface } from "../../payments/x402-discovery.js";

const NOW = new Date("2026-10-09T12:00:00Z");
const domain = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
const request = {
  profile: "mcp-failure-semantics-v1", profileVersion: 1,
  target: { endpoint: "https://example.test/mcp", transport: "streamable_http" }, inputs: {}
};
const context = { request: { headers: {}, socket: { remoteAddress: "192.0.2.10" } } };

function harness({ balance = 5_000_000n, balanceError } = {}) {
  const calls = { limits: [], captures: 0, logs: [], balances: [] };
  const store = new MemoryStateStore();
  const gate = new X402VerificationPaymentGate({
    config: { enabled: true, mode: "enabled", network: "eip155:8453", chainId: 8453,
      asset: domain.verifyingContract, payTo: "0x1111111111111111111111111111111111111111",
      assetEip712Name: domain.name, assetEip712Version: domain.version,
      publicOrigin: "https://api.averray.com", captureMarginSeconds: 600 },
    provider: { getNetwork: async () => ({ chainId: 8453n }), getBlockNumber: async () => 100 },
    tokenContract: { name: async () => domain.name, DOMAIN_SEPARATOR: async () => TypedDataEncoder.hashDomain(domain), authorizationState: async () => false,
      balanceOf: async (payer) => { calls.balances.push(payer); if (balanceError) throw balanceError; return balance; } },
    captureTokenContract: { transferWithAuthorization: async () => { calls.captures++; throw new Error("unexpected capture"); } },
    now: () => NOW
  });
  const service = new VerificationRunService({ stateStore: store, profileRegistry: new VerificationProfileRegistry(), paymentGate: gate, now: () => NOW });
  const route = createVerifyRoutes({
    enforceLimit: async (...args) => calls.limits.push(args),
    rateLimitConfig: { verifierRun: { limit: 5, windowSeconds: 60 } },
    readJsonBody, respond, verificationRunService: service
  });
  const execute = createMcpToolExecutor({ handleVerifyRoute: route });
  const mcp = createMcpRoute({
    executeTool: execute, authMiddleware: async () => undefined, clientIp: () => "192.0.2.10",
    enforceLimit: async () => {}, rateLimitConfig: { mcpRequests: {}, mcpAnonymous: {}, mcpAuthenticated: {} },
    readJsonBody, respond, metrics: new MetricRegistry(),
    logger: { warn: (...args) => calls.logs.push(args), error: (...args) => calls.logs.push(args) }
  });
  return { store, service, gate, route, execute, mcp, calls };
}

async function proof(challenge) {
  const wallet = Wallet.createRandom();
  const authorization = {
    from: wallet.address, to: challenge.accepts[0].payTo, value: challenge.accepts[0].amount,
    validAfter: String(NOW.getTime() / 1000 - 1), validBefore: String(NOW.getTime() / 1000 + 900),
    nonce: "0x" + "c".repeat(64)
  };
  const signature = await wallet.signTypedData(domain, { TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }
  ] }, authorization);
  const payload = { x402Version: 2, accepted: challenge.accepts[0], payload: { authorization, signature } };
  return { payload, header: Buffer.from(JSON.stringify(payload)).toString("base64"), signature };
}

async function callMcp(mcp, name, args, meta = {}) {
  return invokeHttpRoute(mcp, {
    method: "POST", path: "/mcp", sourceRequest: context.request,
    headers: { "mcp-method": "tools/call", "mcp-name": name, "mcp-protocol-version": MODERN_MCP_VERSION },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_MCP_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, ...meta
    } } }
  });
}

test("X1 quote equals unpaid HTTP, strips all inherited payment paths, and creates no run", async () => {
  const h = harness();
  h.service.requireDiscoveryPayment = async () => assert.fail("MCP quote must retain its real request body");
  const direct = await invokeHttpRoute(h.route, { method: "POST", path: "/verify/runs", body: request, sourceRequest: context.request });
  assert.equal(direct.statusCode, 402);
  const paid = await proof(direct.body);
  const quote = await h.execute("quoteVerificationRun", request, {
    request: { ...context.request, headers: { "payment-signature": paid.header, "x-payment": paid.header, "verification-payment": paid.header } },
    meta: { "x402/payment": paid.payload }
  });
  const { ranWork, customerFunds, ...challenge } = quote;
  assert.deepEqual(challenge, direct.body);
  assert.equal(ranWork, false);
  assert.equal(customerFunds, "unchanged");
  assert.deepEqual(await h.store.listActiveVerificationRuns(100), []);
  assert.equal(h.calls.captures, 0);
  assert.equal(h.calls.limits.length, 2);
  assert.equal(h.calls.limits[1][0], "verify_runs");
  assert.deepEqual(h.calls.limits[0], h.calls.limits[1], "same HTTP rate-limit bucket, key and config");
});

test("X1c connected and directory MCP tool descriptions keep x402 on Base only", () => {
  assertBaseOnlyX402Surface(MCP_TOOLS.map((tool) => tool.description));
});

for (const scenario of ["insufficient", "unavailable"]) {
  test(`X1f HTTP and MCP start preserve the ${scenario} balance refusal without a run`, async () => {
    const h = harness({ balance: 0n, balanceError: scenario === "unavailable" ? new Error("private RPC detail") : undefined });
    const quote = await h.execute("quoteVerificationRun", request, context);
    const paid = await proof(quote);
    assert.equal(h.calls.balances.length, 0, "free quote does not read a payer balance");
    const code = scenario === "insufficient" ? "payment_insufficient_balance" : "payment_balance_unavailable";
    const statusCode = scenario === "insufficient" ? 402 : 503;
    const action = scenario === "insufficient" ? "fund_wallet_or_sign_fresh_authorization" : "retry_when_base_reads_recover";
    for (const start of [
      () => invokeHttpRoute(h.route, { method: "POST", path: "/verify/runs", body: request, headers: { "payment-signature": paid.header } }),
      () => h.execute("startVerificationRun", { ...request, paymentSignature: paid.header }, context)
    ]) {
      await assert.rejects(start(), (error) => {
        assert.equal(error.statusCode, statusCode);
        assert.equal(error.code, code);
        assert.equal(error.details.action, action);
        return true;
      });
    }
    const response = await callMcp(h.mcp, "startVerificationRun", request, { "x402/payment": paid.payload });
    assert.equal(response.body.result.isError, true);
    assert.match(JSON.stringify(response.body), new RegExp(code, "u"));
    assert.match(JSON.stringify(response.body), new RegExp(action, "u"));
    assert.ok(!JSON.stringify(response.body).includes(paid.signature));
    assert.ok(!JSON.stringify(response.body).includes("private RPC detail"));
    assert.equal(h.calls.balances.length, 3);
    assert.equal(h.calls.captures, 0);
    assert.equal(h.store.verificationRuns.size, 0);
    assert.equal(h.store.verificationAuthorizationRuns.size, 0);
    assert.equal(h.store.verificationPaymentRuns.size, 0);
  });
}

test("X1e HTTP and MCP share authorization ownership across differently wrapped proofs", async () => {
  const h = harness();
  const quote = await h.execute("quoteVerificationRun", request, context);
  const paid = await proof(quote);
  const started = await invokeHttpRoute(h.route, { method: "POST", path: "/verify/runs", body: request,
    headers: { "payment-signature": paid.header } });
  assert.equal(started.statusCode, 200);
  assert.equal(started.body.requestHash, undefined, "reservation binding stays private");
  const replay = await h.execute("startVerificationRun", { ...request,
    paymentSignature: Buffer.from(JSON.stringify(paid.payload, null, 2)).toString("base64") }, context);
  assert.equal(replay.runId, started.body.runId);
  const changed = { ...request, target: { ...request.target, endpoint: "https://other.example/mcp" } };
  const otherQuote = await h.execute("quoteVerificationRun", changed, context);
  const rewrapped = { ...paid.payload, accepted: otherQuote.accepts[0] };
  const response = await callMcp(h.mcp, "startVerificationRun", changed, { "x402/payment": rewrapped });
  assert.equal(response.body.result.isError, true);
  assert.match(JSON.stringify(response.body), /payment_authorization_in_use/u);
  await assert.rejects(invokeHttpRoute(h.route, { method: "POST", path: "/verify/runs", body: changed,
    headers: { "payment-signature": Buffer.from(JSON.stringify(rewrapped)).toString("base64") } }),
  { statusCode: 409, code: "payment_authorization_in_use", details: { action: "sign_fresh_authorization" } });
  assert.ok(!JSON.stringify(response.body).includes(started.body.runId), "conflict must not reveal the owner");
  assert.ok(!JSON.stringify(response.body).includes("customerFunds"), "owner may still capture");
  assert.equal((await h.store.listActiveVerificationRuns()).length, 1);
  assert.equal(h.calls.captures, 0);
  assert.equal((await h.execute("getVerificationRun", { runId: replay.runId }, context)).requestHash, undefined);
});

for (const transport of ["argument", "meta"]) {
  test(`X1 ${transport}: paid start forwards proof, poll matches HTTP, inconclusive never captures or leaks proof`, async () => {
    const h = harness();
    const quote = await h.execute("quoteVerificationRun", request, context);
    const paid = await proof(quote);
    const result = await callMcp(h.mcp, "startVerificationRun",
      { ...request, ...(transport === "argument" ? { paymentSignature: paid.header } : {}) },
      transport === "meta" ? { "x402/payment": paid.payload } : {});
    assert.equal(result.body.result?.isError, false, JSON.stringify(result.body));
    const run = result.body.result.structuredContent;
    assert.equal(run.status, "queued");
    assert.equal(run.asyncStatus.poll.path, `/verify/runs/${run.runId}`);
    assert.equal((await h.store.listActiveVerificationRuns(100)).length, 1);
    await h.service.finalizeExecution({
      run: await h.service.getRun(run.runId), profile: h.service.profileRegistry.get(request.profile, 1),
      authorization: await h.store.getVerificationRunAuthorization(run.runId),
      execution: { status: "inconclusive", reason: "runner_fault", detail: "Unavailable fixture" }
    });
    const polled = await h.execute("getVerificationRun", { runId: run.runId }, context);
    const http = await invokeHttpRoute(h.route, { method: "GET", path: `/verify/runs/${run.runId}` });
    assert.deepEqual(polled, http.body);
    assert.equal(polled.billing.status, "not_captured");
    assert.equal(h.calls.captures, 0);
    assert.equal(http.headers["payment-response"], undefined);
    for (const text of [JSON.stringify(result), JSON.stringify(polled), JSON.stringify(h.calls.logs)]) {
      assert.ok(!text.includes(paid.header));
      assert.ok(!text.includes(paid.signature));
      assert.ok(!text.includes("paymentSignature"));
    }
  });
}

test("X1 unpaid start returns the canonical MCP payment-required envelope, not a run or generic validation shape", async () => {
  const h = harness();
  const http = await invokeHttpRoute(h.route, { method: "POST", path: "/verify/runs", body: request });
  const response = await callMcp(h.mcp, "startVerificationRun", request);
  assert.equal(response.body.result.isError, true);
  assert.deepEqual(response.body.result.structuredContent, http.body);
  assert.deepEqual(JSON.parse(response.body.result.content[0].text), http.body);
  assert.deepEqual(await h.store.listActiveVerificationRuns(100), []);
  assert.equal(h.calls.captures, 0);
  const quote = await callMcp(h.mcp, "quoteVerificationRun", request);
  assert.equal(quote.body.result.isError, false);
  assert.equal(quote.body.result.structuredContent.ranWork, false);
  assert.equal(quote.body.result.structuredContent.customerFunds, "unchanged");
});

test("X1 discovery, parity and welcome enumerate the real buyer path without a baked price", () => {
  for (const name of ["quoteVerificationRun", "startVerificationRun", "getVerificationRun"]) {
    const tool = MCP_TOOLS.find((tool) => tool.name === name);
    assert.match(tool.description, /\.well-known\/x402/u);
    assert.match(tool.description, /Base eip155:8453/u);
    assert.match(tool.description, /No verdict, no charge/u);
    assert.doesNotMatch(tool.description, /\d+(?:\.\d+)? USDC/u);
    assert.ok(buildMcpWelcome({}).buyerPath.join(" ").includes(name));
    assert.ok(ACCOUNT_ACTION_PARITY_MAPPINGS.some((row) => row.mcpTools?.includes(name)));
    assert.equal(DISCOVERY_TOOLS.some((tool) => tool.name === name), name !== "startVerificationRun");
  }
  assert.ok(CONNECTED_ONLY_TOOLS.has("startVerificationRun"));
  const welcome = buildMcpWelcome({ discoveryUrl: "https://averray.com/.well-known/agent-tools.json" });
  // V2 merges first. Reserve its exact rule even while this draft is based on main.
  welcome.githubPrSettlementRule = "GitHub PR jobs settle only when the upstream PR is merged and the verifier approves; a PR closed without merge is rejected.";
  assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify(welcome)) / 3) <= MCP_WELCOME_TOKEN_BUDGET);
});

test("X1 conflicting transports and malformed metadata are rejected without echoing proof", async () => {
  const h = harness();
  for (const [args, meta] of [
    [{ ...request, paymentSignature: "secret" }, { "x402/payment": {} }],
    [request, { "x402/payment": "secret" }]
  ]) {
    const response = await callMcp(h.mcp, "startVerificationRun", args, meta);
    assert.equal(response.body.result.isError, true);
    assert.equal(response.body.result.structuredContent.billing.status, "not_captured");
    assert.equal(response.body.result.structuredContent.billingRule, VERIFY_BILLING_RULE);
    assert.doesNotMatch(JSON.stringify(response), /secret/u);
  }
  assert.deepEqual(await h.store.listActiveVerificationRuns(100), []);
});

for (const transport of ["http", "mcp"]) {
  for (const outcome of ["approved", "rejected", "inconclusive", "platform_fault", "capture_failure"]) {
    test(`X2 ${transport}: ${outcome} billing contract is explicit and capture follows a decisive verdict only`, async () => {
      const h = harness();
      let attempts = 0;
      let captured = 0;
      h.gate.reconcileCapture = async () => ({ status: "failed" }); // Proven reverted capture fixture.
      h.gate.capture = async () => {
        attempts++;
        if (outcome === "capture_failure") throw new Error("capture fixture failed");
        captured++;
        return { transactionHash: "0x" + "a".repeat(64) };
      };
      h.service.evaluatePinnedProfile = async () => ({
        outcome: outcome === "capture_failure" ? "approved" : outcome,
        reasonCode: "FIXTURE", reason: "fixture", workerConsequence: "none"
      });
      const challenge = await h.execute("quoteVerificationRun", request, context);
      assert.equal(challenge.billing.status, "not_captured");
      assert.equal(challenge.billingRule, VERIFY_BILLING_RULE);
      const paid = await proof(challenge);
      async function start() {
        if (transport === "http") return invokeHttpRoute(h.route, {
          method: "POST", path: "/verify/runs", body: request, headers: { "payment-signature": paid.header }
        });
        const response = await callMcp(h.mcp, "startVerificationRun", request, { "x402/payment": paid.payload });
        assert.equal(response.body.result.isError, false);
        return { body: response.body.result.structuredContent, headers: response.headers };
      }
      const queued = await start();
      assert.equal(queued.body.billing.status, "authorized");
      assert.equal(queued.body.billingRule, VERIFY_BILLING_RULE);
      assert.equal(captured, 0);
      const run = await h.service.getRun(queued.body.runId);
      await h.service.finalizeExecution({
        run, profile: h.service.profileRegistry.get(request.profile, 1),
        authorization: await h.store.getVerificationRunAuthorization(run.runId),
        execution: { status: ["inconclusive", "platform_fault"].includes(outcome) ? outcome : "decidable", reason: "runner_fault", detail: "fixture" }
      });
      const completed = await start(); // Replay returns the same completed run, never re-captures.
      const decisive = ["approved", "rejected"].includes(outcome);
      assert.equal(completed.body.billing.status, decisive ? "captured" : "not_captured");
      assert.equal(completed.body.billingRule, VERIFY_BILLING_RULE);
      if (outcome === "capture_failure") {
        assert.equal(completed.body.verdict.outcome, "inconclusive");
        assert.equal(completed.body.verdict.reasonCode, "runner_fault");
        assert.equal(completed.body.verdict.reason, "runner_fault");
        assert.match(completed.body.verdict.detail, /Payment transaction reverted/u);
      }
      assert.equal(captured, decisive ? 1 : 0);
      assert.equal(attempts, decisive || outcome === "capture_failure" ? 1 : 0);
      if (!decisive) assert.equal(completed.headers["payment-response"], undefined);
      if (decisive && transport === "http") assert.ok(completed.headers["payment-response"]);
      const polled = await h.execute("getVerificationRun", { runId: run.runId }, context);
      assert.deepEqual(polled, completed.body);
    });
  }
}

test("X2 historical not_billed run is projected as not_captured without rewriting persisted data", async () => {
  const h = harness();
  const legacy = { runId: "legacy", status: "complete", billing: { status: "not_billed", amountRaw: "0" } };
  await h.store.reserveVerificationRun(legacy, { paymentId: "legacy", authorization: {} });
  const response = await h.execute("getVerificationRun", { runId: "legacy" }, context);
  assert.equal(response.billing.status, "not_captured");
  assert.equal(response.billingRule, VERIFY_BILLING_RULE);
  assert.equal((await h.store.getVerificationRun("legacy")).billing.status, "not_billed");
});
