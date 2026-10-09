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
import { buildMcpWelcome, createMcpToolExecutor, MCP_TOOLS } from "./tools.js";
import { createMcpRoute, MODERN_MCP_VERSION } from "./handler.js";
import { DISCOVERY_TOOLS, CONNECTED_ONLY_TOOLS } from "../../core/discovery-manifest.js";
import { ACCOUNT_ACTION_PARITY_MAPPINGS } from "../../core/agent-surface-parity.js";
import { MetricRegistry } from "../../core/metrics.js";

const NOW = new Date("2026-10-09T12:00:00Z");
const domain = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
const request = {
  profile: "mcp-failure-semantics-v1", profileVersion: 1,
  target: { endpoint: "https://example.test/mcp", transport: "streamable_http" }, inputs: {}
};
const context = { request: { headers: {}, socket: { remoteAddress: "192.0.2.10" } } };

function harness() {
  const calls = { limits: [], captures: 0, logs: [] };
  const store = new MemoryStateStore();
  const gate = new X402VerificationPaymentGate({
    config: { enabled: true, mode: "enabled", network: "eip155:8453", chainId: 8453,
      asset: domain.verifyingContract, payTo: "0x1111111111111111111111111111111111111111",
      assetEip712Name: domain.name, assetEip712Version: domain.version,
      publicOrigin: "https://api.averray.com", captureMarginSeconds: 600 },
    provider: { getNetwork: async () => ({ chainId: 8453n }) },
    tokenContract: { name: async () => domain.name, DOMAIN_SEPARATOR: async () => TypedDataEncoder.hashDomain(domain), authorizationState: async () => false },
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
  assert.deepEqual(h.calls.limits[0], h.calls.limits[1], "same HTTP rate-limit bucket, key and config");
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
    assert.equal(polled.billing.status, "not_billed"); // X2 standardizes the public status.
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
});

test("X1 conflicting transports and malformed metadata are rejected without echoing proof", async () => {
  const h = harness();
  for (const [args, meta] of [
    [{ ...request, paymentSignature: "secret" }, { "x402/payment": {} }],
    [request, { "x402/payment": "secret" }]
  ]) {
    const response = await callMcp(h.mcp, "startVerificationRun", args, meta);
    assert.equal(response.body.result.isError, true);
    assert.doesNotMatch(JSON.stringify(response), /secret/u);
  }
  assert.deepEqual(await h.store.listActiveVerificationRuns(100), []);
});
