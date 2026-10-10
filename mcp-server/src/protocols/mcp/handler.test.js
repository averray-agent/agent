import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ArrivalObservatory } from "../../services/arrival-observatory.js";
import { ArrivalSessionTrail } from "../../services/arrival-session-trail.js";
import { SelfIdentityRegistry } from "../../core/self-identity-registry.js";
import { MemoryStateStore } from "../../core/state-store.js";
import { createAuthMiddleware } from "../../auth/middleware.js";
import { signToken } from "../../auth/jwt.js";
import { MCP_TOOLS } from "./tools.js";

import { createRateLimiter } from "../../auth/rate-limit.js";
import { AuthenticationError, ConflictError, RateLimitError } from "../../core/errors.js";
import { MetricRegistry } from "../../core/metrics.js";
import { MemoryStateStore as RateLimitStateStore } from "../../core/state-store.js";
import { respond } from "../http/http-helpers.js";
import {
  createMcpRoute,
  LEGACY_MCP_VERSION,
  MCP_BROWSER_INFO,
  MCP_CORS_HEADERS,
  MCP_INSTALL,
  MCP_SERVER_INFO,
  MODERN_MCP_VERSION,
  SUPPORTED_MCP_VERSIONS
} from "./handler.js";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";

function createHarness(overrides = {}) {
  const limitCalls = [];
  const legacySessions = overrides.legacySessions ?? new Map();
  const metrics = overrides.metrics ?? new MetricRegistry();
  const handler = createMcpRoute({
    arrivals: overrides.arrivals,
    sessionTrail: overrides.sessionTrail,
    authMiddleware: overrides.authMiddleware ?? (async () => ({ wallet: "0xauthed" })),
    clientIp: () => "198.51.100.8",
    enforceLimit: async (bucket, key, config) => {
      limitCalls.push({ bucket, key, config });
      await overrides.enforceLimit?.(bucket, key, config);
    },
    executeTool: overrides.executeTool ?? (async (name) => ({ name, jobs: [{ id: "job-1" }] })),
    legacySessionTtlMs: overrides.legacySessionTtlMs ?? 60_000,
    legacySessionMax: overrides.legacySessionMax,
    legacySessions,
    logger: overrides.logger,
    metrics,
    now: overrides.now ?? (() => 1_000_000),
    randomUUIDImpl: overrides.randomUUIDImpl ?? (() => "legacy-session-1"),
    rateLimitConfig: {
      mcpRequests: { limit: 120, windowSeconds: 60 },
      mcpAnonymous: { limit: 10, windowSeconds: 60 },
      mcpAuthenticated: { limit: 20, windowSeconds: 60 },
      ...overrides.rateLimitConfig
    },
    readJsonBody: overrides.readJsonBody ?? (async (request) => request.body),
    respond,
    ...(overrides.tools ? { tools: overrides.tools } : {})
  });
  return { handler, legacySessions, limitCalls, metrics };
}

async function call(handler, body, headers = {}) {
  const request = {
    method: "POST",
    headers,
    body,
    socket: { remoteAddress: "198.51.100.8" }
  };
  const response = capturedResponse();
  const handled = await handler({ request, response, pathname: "/mcp" });
  const text = Buffer.concat(response.chunks).toString("utf8");
  return {
    handled,
    statusCode: response.statusCode,
    headers: response.headers,
    body: text ? JSON.parse(text) : undefined
  };
}

async function callRead(handler, method = "GET") {
  const request = {
    method,
    headers: {},
    socket: { remoteAddress: "198.51.100.8" }
  };
  const response = capturedResponse();
  const handled = await handler({ request, response, pathname: "/mcp" });
  const text = Buffer.concat(response.chunks).toString("utf8");
  return {
    handled,
    statusCode: response.statusCode,
    headers: response.headers,
    body: text ? JSON.parse(text) : undefined
  };
}

const callGet = (handler) => callRead(handler, "GET");

function capturedResponse() {
  return {
    _corsHeaders: {},
    chunks: [],
    headers: {},
    statusCode: 200,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    end(chunk = undefined) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(String(chunk), "utf8"));
    }
  };
}

function modernRequest(method, params = {}, version = MODERN_MCP_VERSION, id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        [META_VERSION]: version,
        [META_CAPABILITIES]: {},
        [META_CLIENT]: { name: "modern-test", version: "1.0.0" }
      }
    }
  };
}

function modernHeaders(method, name = undefined, version = MODERN_MCP_VERSION) {
  return {
    "mcp-protocol-version": version,
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {})
  };
}

test("static GET /mcp explains the protocol before auth and points browsers to plain HTTP", async () => {
  const { handler, limitCalls } = createHarness({
    authMiddleware: async () => {
      throw new Error("GET /mcp must not authenticate");
    }
  });
  const result = await callGet(handler);

  assert.equal(result.handled, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["cache-control"], "public, max-age=300");
  assert.deepEqual(result.body, MCP_BROWSER_INFO);
  assert.equal(result.body.connect.clientConfig.mcpServers.averray.url, "https://api.averray.com/mcp");
  assert.deepEqual(result.body.install, MCP_INSTALL);
  assert.equal(result.body.install.npm.package, "@averray/mcp");
  assert.equal(
    result.body.install.claudeCode.command,
    "claude mcp add --transport http averray https://api.averray.com/mcp"
  );
  assert.deepEqual(result.body.install.claudeDesktop.clientConfig, {
    mcpServers: {
      averray: {
        command: "npx",
        args: ["-y", "@averray/mcp"]
      }
    }
  });

  const cursorUrl = new URL(result.body.install.cursor.deeplink);
  assert.equal(cursorUrl.protocol, "cursor:");
  assert.equal(cursorUrl.hostname, "anysphere.cursor-deeplink");
  assert.equal(cursorUrl.pathname, "/mcp/install");
  assert.equal(cursorUrl.searchParams.get("name"), "averray");
  assert.deepEqual(
    JSON.parse(Buffer.from(cursorUrl.searchParams.get("config"), "base64").toString("utf8")),
    { url: "https://api.averray.com/mcp" }
  );
  assert.equal(result.body.plainHttpAlternative.path, "/verify/profiles");
  assert.deepEqual(limitCalls, []);
});

test("HEAD /mcp mirrors GET headers with an empty body", async () => {
  const { handler } = createHarness({
    authMiddleware: async () => {
      throw new Error("HEAD /mcp must not authenticate");
    }
  });

  const get = await callRead(handler, "GET");
  const head = await callRead(handler, "HEAD");

  assert.equal(head.handled, true);
  assert.equal(head.statusCode, 200);
  assert.deepEqual(head.headers, get.headers);
  assert.equal(head.body, undefined);
});

test("MCP CORS contract is wildcard without cookie credentials", () => {
  assert.equal(MCP_CORS_HEADERS["access-control-allow-origin"], "*");
  assert.match(MCP_CORS_HEADERS["access-control-allow-methods"], /POST/u);
  assert.match(MCP_CORS_HEADERS["access-control-allow-methods"], /GET/u);
  assert.match(MCP_CORS_HEADERS["access-control-allow-methods"], /OPTIONS/u);
  for (const header of ["Mcp-Session-Id", "Mcp-Method", "Content-Type", "Authorization"]) {
    assert.match(MCP_CORS_HEADERS["access-control-allow-headers"], new RegExp(header, "u"));
  }
  assert.equal(MCP_CORS_HEADERS["access-control-expose-headers"], "Mcp-Session-Id");
  assert.equal(MCP_CORS_HEADERS["access-control-allow-credentials"], undefined);
});

test("modern server/discover returns versions, capabilities, and identity without a session", async () => {
  const { handler } = createHarness();
  const result = await call(
    handler,
    modernRequest("server/discover"),
    modernHeaders("server/discover")
  );

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.result.supportedVersions, [...SUPPORTED_MCP_VERSIONS]);
  assert.deepEqual(result.body.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(
    result.body.result._meta["io.modelcontextprotocol/serverInfo"],
    MCP_SERVER_INFO
  );
  assert.equal(result.body.result.resultType, "complete");
  assert.equal(result.body.result.ttlMs, 300_000);
  assert.equal(result.body.result.cacheScope, "public");
  assert.equal("mcp-session-id" in result.headers, false);
});

test("tools/list and tools/call use the same injected configured tool surface", async () => {
  const tools = [{
    name: "configuredTool",
    description: "Configured limit: 32768 bytes.",
    inputSchema: { type: "object", additionalProperties: false }
  }];
  const { handler } = createHarness({ tools });

  const listed = await call(handler, modernRequest("tools/list"), modernHeaders("tools/list"));
  assert.deepEqual(listed.body.result.tools, tools);

  const called = await call(
    handler,
    modernRequest("tools/call", { name: "configuredTool", arguments: {} }),
    modernHeaders("tools/call", "configuredTool")
  );
  assert.equal(called.body.result.isError, false);
  assert.equal(called.body.result.structuredContent.name, "configuredTool");
});

test("modern requests require matching Streamable HTTP headers", async () => {
  const { handler } = createHarness();
  const missing = await call(handler, modernRequest("tools/list"), {
    "mcp-method": "tools/list"
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.error.code, -32020);

  const mismatched = await call(
    handler,
    modernRequest("tools/call", { name: "listJobs", arguments: {} }),
    modernHeaders("tools/call", "getJobDefinition")
  );
  assert.equal(mismatched.statusCode, 400);
  assert.equal(mismatched.body.error.code, -32020);
});

test("ping is legacy-only and never executes or authenticates a tool", async () => {
  const { handler } = createHarness({ executeTool() { throw new Error("must not execute"); }, authMiddleware() { throw new Error("must not authenticate"); } });
  const result = await call(handler, modernRequest("ping"), modernHeaders("ping"));
  assert.equal(result.body.error.code, -32601);
  const bare = await call(handler, { jsonrpc: "2.0", id: "liveness", method: "ping" });
  assert.equal(bare.statusCode, 200);
  assert.deepEqual(bare.body.result, {});
  assert.equal(bare.headers["mcp-protocol-version"], LEGACY_MCP_VERSION);
});

test("unsupported modern version returns -32022 and echoes the version", async () => {
  const { handler } = createHarness();
  const requested = "2027-01-01";
  const result = await call(
    handler,
    modernRequest("server/discover", {}, requested),
    modernHeaders("server/discover", undefined, requested)
  );

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error.code, -32022);
  assert.deepEqual(result.body.error.data, { supported: [...SUPPORTED_MCP_VERSIONS], requested });
  for (const method of ["tools/call", "tools/list"]) {
    const refused = await call(handler, modernRequest(method, { name: "claimJob", arguments: {} }, requested),
      modernHeaders(method, method === "tools/call" ? "claimJob" : undefined, requested));
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.body.error.code, -32022);
    assert.deepEqual(refused.body.error.data, { supported: [...SUPPORTED_MCP_VERSIONS], requested });
  }
});

test("initialize selects an expiring 2025-11-25 session on the same endpoint", async () => {
  const { handler } = createHarness();
  const initialized = await call(handler, {
    jsonrpc: "2.0",
    id: "init-1",
    method: "initialize",
    params: {
      protocolVersion: LEGACY_MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "legacy-test", version: "1.0.0" }
    }
  });
  assert.equal(initialized.statusCode, 200);
  assert.equal(initialized.body.result.protocolVersion, LEGACY_MCP_VERSION);
  assert.equal(initialized.body.result.resultType, undefined);
  assert.equal(initialized.headers["mcp-session-id"], "legacy-session-1");

  const sessionHeaders = {
    "mcp-session-id": initialized.headers["mcp-session-id"],
    "mcp-protocol-version": LEGACY_MCP_VERSION
  };
  const ready = await call(handler, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {}
  }, sessionHeaders);
  assert.equal(ready.statusCode, 202);
  assert.equal(ready.body, undefined);

  const listed = await call(handler, {
    jsonrpc: "2.0",
    id: "list-1",
    method: "tools/list",
    params: {}
  }, sessionHeaders);
  assert.equal(listed.statusCode, 200);
  assert.ok(listed.body.result.tools.some((tool) => tool.name === "listJobs"));

  const listJobs = await call(handler, {
    jsonrpc: "2.0",
    id: "call-1",
    method: "tools/call",
    params: {
      name: "listJobs",
      arguments: {},
      _meta: { progressToken: "legacy-progress" }
    }
  }, sessionHeaders);
  assert.equal(listJobs.statusCode, 200);
  assert.equal(listJobs.body.result.resultType, undefined);
  assert.equal(listJobs.body.result.isError, false);
  assert.deepEqual(JSON.parse(listJobs.body.result.content[0].text), {
    name: "listJobs",
    jobs: [{ id: "job-1" }]
  });
});

test("an initialized legacy session accepts a missing version header but refuses an explicit mismatch", async () => {
  const { handler } = createHarness();
  const initialized = await call(handler, {
    jsonrpc: "2.0",
    id: "init-header-fallback",
    method: "initialize",
    params: {
      protocolVersion: LEGACY_MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "headerless-legacy-test", version: "1.0.0" }
    }
  });
  const sessionHeaders = {
    "mcp-session-id": initialized.headers["mcp-session-id"]
  };

  const ready = await call(handler, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {}
  }, sessionHeaders);
  assert.equal(ready.statusCode, 202);

  const listed = await call(handler, {
    jsonrpc: "2.0",
    id: "headerless-tools-list",
    method: "tools/list",
    params: {}
  }, sessionHeaders);
  assert.equal(listed.statusCode, 200);
  assert.ok(listed.body.result.tools.some((tool) => tool.name === "listJobs"));

  const mismatched = await call(handler, {
    jsonrpc: "2.0",
    id: "mismatched-tools-list",
    method: "tools/list",
    params: {}
  }, {
    ...sessionHeaders,
    "mcp-protocol-version": MODERN_MCP_VERSION
  });
  assert.equal(mismatched.statusCode, 400);
  assert.equal(mismatched.body.error.code, -32020);
  assert.match(mismatched.body.error.message, /does not match the session version/u);
});

test("unsupported initialize offers the newest legacy protocol and binds the negotiated session", async () => {
  const { handler } = createHarness();
  const result = await call(handler, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "legacy-test", version: "1.0.0" }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.result.protocolVersion, LEGACY_MCP_VERSION);
  const headers = { "mcp-session-id": result.headers["mcp-session-id"], "mcp-protocol-version": LEGACY_MCP_VERSION };
  await call(handler, { jsonrpc: "2.0", method: "notifications/initialized" }, headers);
  const ping = await call(handler, { jsonrpc: "2.0", id: 2, method: "ping" }, headers);
  assert.equal(ping.statusCode, 200);
  assert.deepEqual(ping.body.result, {});
  assert.equal(ping.headers["mcp-protocol-version"], LEGACY_MCP_VERSION);
});

test("initialize with 2026-07-28 creates a legacy session with consistent response headers", async () => {
  const { handler, legacySessions } = createHarness();
  const initialized = await call(handler, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: MODERN_MCP_VERSION, capabilities: {},
      clientInfo: { name: "modern-offer", version: "1.0.0" } }
  }, { "mcp-protocol-version": MODERN_MCP_VERSION });
  assert.equal(initialized.statusCode, 200);
  assert.equal(initialized.body.result.protocolVersion, LEGACY_MCP_VERSION);
  assert.equal(initialized.headers["mcp-protocol-version"], LEGACY_MCP_VERSION);
  const sessionId = initialized.headers["mcp-session-id"];
  assert.equal(legacySessions.get(sessionId).protocolVersion, LEGACY_MCP_VERSION);
  const headers = { "mcp-session-id": sessionId, "mcp-protocol-version": LEGACY_MCP_VERSION };
  await call(handler, { jsonrpc: "2.0", method: "notifications/initialized" }, headers);
  for (const method of ["ping", "tools/list"]) {
    const response = await call(handler, { jsonrpc: "2.0", id: 2, method }, headers);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["mcp-protocol-version"], LEGACY_MCP_VERSION);
    assert.equal(response.body.result.resultType, undefined);
  }
});

test("all callers see protected tools and an anonymous protected call is a clean auth error", async () => {
  const { handler } = createHarness({
    executeTool: async (name) => {
      if (name === "claimJob") {
        throw new AuthenticationError("Authentication required.", "missing_token", {
          requiresAuth: true,
          requiredCapabilities: ["jobs:claim"]
        });
      }
      return {};
    }
  });
  const listed = await call(handler, modernRequest("tools/list"), modernHeaders("tools/list"));
  assert.equal(listed.body.result.ttlMs, 300_000);
  assert.equal(listed.body.result.cacheScope, "public");
  const claimTool = listed.body.result.tools.find((tool) => tool.name === "claimJob");
  assert.deepEqual(claimTool._meta["com.averray/auth"], {
    scheme: "SIWE_JWT",
    required: true,
    scopes: ["jobs:claim"],
    requiredAction: "wallet_sign_in"
  });

  const called = await call(
    handler,
    modernRequest("tools/call", { name: "claimJob", arguments: { jobId: "job-1" } }),
    modernHeaders("tools/call", "claimJob")
  );
  assert.equal(called.statusCode, 200);
  assert.equal(called.body.result.isError, true);
  assert.equal(called.body.result.structuredContent.error, "missing_token");
  assert.deepEqual(called.body.result.structuredContent.details.requiredCapabilities, ["jobs:claim"]);
});

test("legacy sessions are scoped by id and expire", async () => {
  let now = 10_000;
  const { handler } = createHarness({
    legacySessionTtlMs: 50,
    now: () => now
  });
  const initialized = await call(handler, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LEGACY_MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "legacy-test", version: "1.0.0" }
    }
  });
  now += 51;
  const expired = await call(handler, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  }, {
    "mcp-session-id": initialized.headers["mcp-session-id"],
    "mcp-protocol-version": LEGACY_MCP_VERSION
  });

  assert.equal(expired.statusCode, 404);
  assert.equal(expired.body.error.code, -32001);
});

test("anonymous and authenticated tool calls consume separate rate-limit buckets", async () => {
  const { handler, limitCalls } = createHarness({
    authMiddleware: async () => ({ wallet: "0xabc" })
  });
  const body = modernRequest("tools/call", { name: "listJobs", arguments: {} });
  await call(handler, body, modernHeaders("tools/call", "listJobs"));
  await call(handler, { ...body, id: 2 }, {
    ...modernHeaders("tools/call", "listJobs"),
    authorization: "Bearer valid-token"
  });

  assert.deepEqual(limitCalls.map(({ bucket, key }) => ({ bucket, key })), [
    { bucket: "mcp_requests_anonymous", key: "198.51.100.8" },
    { bucket: "mcp_tools_anonymous", key: "198.51.100.8" },
    { bucket: "mcp_tools_authenticated", key: "0xabc" }
  ]);
});

function legacyInitialize(id = 1, params = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LEGACY_MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "legacy-test", version: "1.0.0" },
      ...params
    }
  };
}

test("anonymous initialize requests obey the configured per-IP request budget", async () => {
  let sessionCount = 0;
  const limit = 120;
  const stateStore = new RateLimitStateStore();
  const { handler, legacySessions, limitCalls } = createHarness({
    enforceLimit: createRateLimiter({ stateStore, logger: { warn() {} } }),
    randomUUIDImpl: () => `legacy-session-${++sessionCount}`,
    rateLimitConfig: { mcpRequests: { limit, windowSeconds: 60 } }
  });
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 10_000; i += 1) {
    try {
      const result = await call(handler, legacyInitialize(i));
      assert.equal(result.statusCode, 200);
      accepted += 1;
    } catch (error) {
      assert.ok(error instanceof RateLimitError);
      assert.equal(error.statusCode, 429);
      assert.equal(error.code, "rate_limited");
      assert.equal(error.details.bucket, "mcp_requests_anonymous");
      assert.equal(error.details.limit, limit);
      assert.equal(error.details.remaining, 0);
      assert.ok(error.details.retryAfterSeconds >= 1);
      refused += 1;
    }
  }
  assert.equal(accepted, limit);
  assert.equal(refused, 10_000 - limit);
  assert.equal(sessionCount, limit);
  assert.equal(legacySessions.size, limit);
  assert.equal(limitCalls.length, 10_000);
  assert.ok(limitCalls.every(({ bucket, key }) => bucket === "mcp_requests_anonymous" && key === "198.51.100.8"));
});

test("legacy initialize requests with a bearer header consume the per-IP request budget", async () => {
  let sessionCount = 0;
  const { handler, legacySessions, limitCalls } = createHarness({
    authMiddleware: async () => { throw new Error("initialize does not authenticate a bearer header"); },
    enforceLimit: createRateLimiter({ stateStore: new RateLimitStateStore(), logger: { warn() {} } }),
    randomUUIDImpl: () => `legacy-session-${++sessionCount}`,
    rateLimitConfig: { mcpRequests: { limit: 2, windowSeconds: 60 } }
  });
  const headers = { authorization: "Bearer synthetic-client-token" };
  for (let id = 0; id < 2; id += 1) {
    const result = await call(handler, legacyInitialize(id), headers);
    assert.equal(result.statusCode, 200);
  }
  await assert.rejects(() => call(handler, legacyInitialize(3), headers), (error) => {
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.statusCode, 429);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.details.bucket, "mcp_requests_anonymous");
    assert.equal(error.details.limit, 2);
    return true;
  });
  assert.equal(sessionCount, 2);
  assert.equal(legacySessions.size, 2);
  assert.equal(limitCalls.length, 3);
  assert.ok(limitCalls.every(({ bucket, key }) => bucket === "mcp_requests_anonymous" && key === "198.51.100.8"));
});

test("anonymous MCP methods share a request budget before session activity", async () => {
  const { handler, legacySessions } = createHarness({
    enforceLimit: createRateLimiter({ stateStore: new RateLimitStateStore(), logger: { warn() {} } }),
    rateLimitConfig: { mcpRequests: { limit: 2, windowSeconds: 60 } }
  });
  await call(handler, modernRequest("server/discover"), modernHeaders("server/discover"));
  await call(handler, modernRequest("tools/list"), modernHeaders("tools/list"));
  await assert.rejects(() => call(handler, legacyInitialize()), RateLimitError);
  assert.equal(legacySessions.size, 0);
});

test("legacy sessions retain a compact copy of client metadata", async () => {
  const { handler, legacySessions } = createHarness();
  const capabilities = { metadata: "x".repeat(60 * 1024), roots: { listChanged: true } };
  const clientInfo = { name: "n".repeat(256), version: "v".repeat(256), metadata: capabilities };
  const result = await call(handler, legacyInitialize(1, { capabilities, clientInfo, extra: capabilities }));
  assert.equal(result.statusCode, 200);
  const session = legacySessions.get(result.headers["mcp-session-id"]);
  assert.ok(Buffer.byteLength(JSON.stringify(session)) < 1024);
  assert.deepEqual(session.clientCapabilities, {});
  assert.deepEqual(session.clientInfo, { name: "n".repeat(128), version: "v".repeat(128) });
  assert.equal(session.protocolVersion, LEGACY_MCP_VERSION);
  clientInfo.name = "updated";
  capabilities.metadata = "updated";
  assert.equal(session.clientInfo.name, "n".repeat(128));
  assert.deepEqual(session.clientCapabilities, {});
});

test("legacy sessions keep the newest 5000 entries and count oldest-first evictions", async () => {
  let sequence = 0;
  const { handler, legacySessions, metrics } = createHarness({
    randomUUIDImpl: () => `legacy-session-${++sequence}`
  });
  for (let i = 0; i < 6_000; i += 1) {
    const result = await call(handler, legacyInitialize(i));
    assert.equal(result.statusCode, 200);
  }
  assert.equal(legacySessions.size, 5_000);
  assert.equal(legacySessions.has("legacy-session-1"), false);
  assert.equal(legacySessions.has("legacy-session-1000"), false);
  assert.equal(legacySessions.has("legacy-session-1001"), true);
  assert.equal(legacySessions.has("legacy-session-6000"), true);
  const oldest = await call(handler, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
    "mcp-session-id": "legacy-session-1"
  });
  assert.equal(oldest.statusCode, 404);
  assert.equal(oldest.body.error.code, -32001);
  const headers = { "mcp-session-id": "legacy-session-6000" };
  const ready = await call(handler, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, headers);
  assert.equal(ready.statusCode, 202);
  const newest = await call(handler, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, headers);
  assert.equal(newest.statusCode, 200);
  assert.match(metrics.serialize(), /^mcp_legacy_sessions 5000$/mu);
  assert.match(metrics.serialize(), /^mcp_legacy_sessions_evicted_total 1000$/mu);
});

test("legacy session capacity is configurable and expired entries update the gauge", async () => {
  let sequence = 0;
  let time = 10_000;
  const { handler, legacySessions, metrics } = createHarness({
    legacySessionMax: 2,
    legacySessionTtlMs: 50,
    now: () => time,
    randomUUIDImpl: () => `legacy-session-${++sequence}`
  });
  for (let i = 0; i < 3; i += 1) await call(handler, legacyInitialize(i));
  assert.equal(legacySessions.size, 2);
  assert.equal(legacySessions.has("legacy-session-1"), false);
  assert.match(metrics.serialize(), /^mcp_legacy_sessions 2$/mu);
  time += 51;
  const expired = await call(handler, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {
    "mcp-session-id": "legacy-session-2"
  });
  assert.equal(expired.statusCode, 404);
  assert.match(metrics.serialize(), /^mcp_legacy_sessions 1$/mu);
  await call(handler, legacyInitialize(4));
  assert.equal(legacySessions.size, 1);
  assert.match(metrics.serialize(), /^mcp_legacy_sessions 1$/mu);
  assert.match(metrics.serialize(), /^mcp_legacy_sessions_evicted_total 1$/mu);
  for (const legacySessionMax of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => createHarness({ legacySessionMax }), /legacySessionMax must be a positive safe integer/u);
  }
});

const AUTH_SECRET = "x".repeat(40);
const GRANT_SUBJECT = "0xabababababababababababababababababababab";
const HEADER_SUBJECT = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

function authObservatory() {
  const state = new Map();
  return new ArrivalObservatory({
    stateStore: {
      async getServiceState(scope) { return state.get(scope); },
      async upsertServiceState(scope, value) {
        state.set(scope, { ...(state.get(scope) ?? {}), ...value });
        return state.get(scope);
      }
    },
    now: () => 5_000,
    flushIntervalMs: 0,
    identityRegistry: new SelfIdentityRegistry({ qaEngineerApiKeyIds: ["grant-qa-engineer"] })
  });
}

test("a tools/call bearer is verified once, and only a service-token grant id counts as self", async () => {
  const authConfig = {
    jwtBackend: "hmac",
    secrets: [AUTH_SECRET],
    signingSecret: AUTH_SECRET,
    permissive: false,
    strict: true
  };
  const middleware = createAuthMiddleware({ authConfig, logger: { warn() {} } });
  let authCalls = 0;
  const authMiddleware = async (request, url, options) => {
    authCalls += 1;
    return middleware(request, url, options);
  };
  const serviceObservatory = authObservatory();
  const { token: serviceToken } = signToken({
    sub: GRANT_SUBJECT,
    roles: [],
    tokenKind: "service",
    serviceToken: true,
    capabilityGrantId: "grant-qa-engineer"
  }, { secret: AUTH_SECRET, expiresInSeconds: 60 });
  const { handler: serviceHandler } = createHarness({
    arrivals: serviceObservatory,
    authMiddleware
  });
  const serviceCall = await call(
    serviceHandler,
    modernRequest("tools/call", { name: "listJobs", arguments: {} }),
    { ...modernHeaders("tools/call", "listJobs"), authorization: `Bearer ${serviceToken}` }
  );
  assert.equal(serviceCall.statusCode, 200);
  assert.equal(serviceCall.body.result.isError, false);
  assert.equal(authCalls, 1);
  const serviceSnapshot = await serviceObservatory.getSnapshot();
  assert.equal(serviceSnapshot.funnelSelf.browsed, 1);
  assert.equal(serviceSnapshot.funnelExternal.browsed, 0);

  authCalls = 0;
  const headerObservatory = authObservatory();
  const { token: walletToken } = signToken({
    sub: HEADER_SUBJECT
  }, { secret: AUTH_SECRET, expiresInSeconds: 60 });
  const { handler: headerHandler } = createHarness({
    arrivals: headerObservatory,
    authMiddleware
  });
  const headerCall = await call(
    headerHandler,
    modernRequest("tools/call", { name: "listJobs", arguments: {} }),
    {
      ...modernHeaders("tools/call", "listJobs"),
      authorization: `Bearer ${walletToken}`,
      "x-averray-api-key-id": "grant-qa-engineer"
    }
  );
  assert.equal(headerCall.statusCode, 200);
  const headerSnapshot = await headerObservatory.getSnapshot();
  assert.equal(headerSnapshot.funnelSelf.browsed, 0);
  assert.equal(headerSnapshot.funnelExternal.browsed, 1);
  assert.equal(authCalls, 1);
});

test("successful listJobs and tools/list steps are recorded after the rate limit", async () => {
  const steps = [];
  const sessionTrail = { async observe(entry) { steps.push(entry); } };
  const { handler } = createHarness({ sessionTrail });
  const listed = await call(
    handler,
    modernRequest("tools/list"),
    modernHeaders("tools/list")
  );
  const jobs = await call(
    handler,
    modernRequest("tools/call", { name: "listJobs", arguments: {} }),
    modernHeaders("tools/call", "listJobs")
  );
  assert.equal(listed.statusCode, 200);
  assert.equal(jobs.body.result.isError, false);
  assert.deepEqual(steps.map((step) => [step.name, step.resultClass, step.stage]), [
    ["tools/list", "ok", "reached"],
    ["listJobs", "ok", "browsed"]
  ]);
});

test("a client-supplied mcp session id is not a trail key unless the server issued it", async () => {
  const steps = [];
  const sessionTrail = { async observe(entry) { steps.push(entry); } };
  const { handler, legacySessions } = createHarness({ sessionTrail });
  await call(handler, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LEGACY_MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "legacy-test", version: "0.1.0" }
    }
  });
  steps.length = 0;
  await call(handler, { jsonrpc: "2.0", id: 2, method: "tools/list" }, {
    "mcp-session-id": "forged-session",
    "mcp-protocol-version": LEGACY_MCP_VERSION
  });
  assert.equal(steps[0].mcpSessionId, undefined);
  steps.length = 0;
  const liveId = [...legacySessions.keys()][0];
  legacySessions.get(liveId).initialized = true;
  await call(handler, { jsonrpc: "2.0", id: 3, method: "tools/list" }, {
    "mcp-session-id": liveId,
    "mcp-protocol-version": LEGACY_MCP_VERSION
  });
  assert.equal(steps.at(-1).mcpSessionId, liveId);
});

test("parse and invalid JSON-RPC errors are unclassified, not external", async () => {
  const recorded = [];
  const arrivals = {
    async recordDropOff(entry) { recorded.push(entry); }
  };
  const refuseTrail = { async observe() { throw new Error("pre-limit garbage must not be stitched"); } };
  const { handler } = createHarness({
    arrivals,
    sessionTrail: refuseTrail,
    readJsonBody: async () => { throw new Error("Invalid JSON body."); }
  });
  const parsed = await call(handler, { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(parsed.statusCode, 400);
  assert.equal(recorded[0].actor, "unclassified");
  assert.equal(recorded[0].outcome.code, -32700);

  const invalid = [];
  const { handler: invalidHandler } = createHarness({
    arrivals: { async recordDropOff(entry) { invalid.push(entry); } },
    sessionTrail: refuseTrail
  });
  const rejected = await call(invalidHandler, { nope: true });
  assert.equal(rejected.statusCode, 400);
  assert.equal(invalid[0].actor, "unclassified");
  assert.equal(invalid[0].outcome.code, -32600);
});

test("tool failures record a drop-off code and never the error message", async () => {
  const recorded = [];
  const arrivals = {
    async recordTool() {},
    async recordDropOff(entry) { recorded.push(entry); }
  };
  const { handler } = createHarness({
    arrivals,
    executeTool: async () => { throw new Error("secret token sk-live-DO-NOT-STORE"); }
  });
  const result = await call(
    handler,
    modernRequest("tools/call", { name: "listJobs", arguments: {} }),
    modernHeaders("tools/call", "listJobs")
  );
  assert.equal(result.body.result.isError, true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].outcome.kind, "tool");
  assert.equal(recorded[0].outcome.code, "internal_error");
  assert.equal(recorded[0].tool, "listJobs");
  assert.equal(JSON.stringify(recorded).includes("sk-live"), false);
  assert.equal(Object.hasOwn(recorded[0].outcome, "message"), false);
});

test("tool failures are logged once and counted without request arguments", async () => {
  const logged = [];
  const { handler, metrics } = createHarness({
    executeTool: async () => { throw new Error("tool unavailable"); },
    logger: { warn(fields, message) { logged.push({ fields, message }); } }
  });
  const result = await call(handler, modernRequest("tools/call", { name: "listJobs", arguments: {} }),
    modernHeaders("tools/call", "listJobs"));
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.result.isError, true);
  assert.equal(result.body.result.structuredContent.error, "internal_error");
  assert.deepEqual(logged, [{ fields: { tool: "listJobs", code: "internal_error" }, message: "mcp.tool_error" }]);
  assert.match(metrics.serialize(), /^mcp_tool_calls_total\{tool="listJobs",outcome="error"\} 1$/mu);
  assert.doesNotMatch(metrics.serialize(), /outcome="success"/u);
});

test("successful tool calls count a success outcome", async () => {
  const { handler, metrics } = createHarness();
  const result = await call(handler, modernRequest("tools/call", { name: "listJobs", arguments: {} }),
    modernHeaders("tools/call", "listJobs"));
  assert.equal(result.body.result.isError, false);
  assert.match(metrics.serialize(), /^mcp_tool_calls_total\{tool="listJobs",outcome="success"\} 1$/mu);
});

test("the front door records who arrived and how far they got", async () => {
  const recorded = [];
  const arrivals = {
    async recordReach(entry) { recorded.push({ kind: "reach", ...entry }); },
    async recordTool(entry) { recorded.push({ kind: "tool", ...entry }); }
  };
  const { handler } = createHarness({ arrivals });

  await call(handler, modernRequest("tools/call", { name: "fetchAuthNonce", arguments: {} }),
    modernHeaders("tools/call", "fetchAuthNonce"));

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, "tool");
  assert.equal(recorded[0].tool, "fetchAuthNonce");
  assert.equal(recorded[0].era, "modern");
  assert.deepEqual(recorded[0].clientInfo, { name: "modern-test", version: "1.0.0" });
});

test("a legacy handshake is recorded even though it never reaches dispatch", async () => {
  const recorded = [];
  const arrivals = {
    async recordReach(entry) { recorded.push(entry); },
    async recordTool(entry) { recorded.push(entry); }
  };
  const { handler } = createHarness({ arrivals });

  await call(handler, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LEGACY_MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "legacy-test", version: "0.1.0" }
    }
  });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].era, "legacy");
  assert.deepEqual(recorded[0].clientInfo, { name: "legacy-test", version: "0.1.0" });
});

// Observability must never be able to refuse a request.
test("a throwing arrivals recorder does not break the door", async () => {
  const arrivals = {
    async recordReach() { throw new Error("observatory exploded"); },
    async recordTool() { throw new Error("observatory exploded"); }
  };
  const { handler } = createHarness({ arrivals });
  const result = await call(handler, modernRequest("tools/list"), modernHeaders("tools/list"));
  assert.equal(result.statusCode, 200);
});

test("successful MCP SIWE links the declared client hint to the measured wallet", async () => {
  const links = [];
  const arrivals = {
    async recordTool() {},
    async linkWallet(entry) { links.push(entry); }
  };
  const wallet = "0x1111111111111111111111111111111111111111";
  const { handler } = createHarness({
    arrivals,
    executeTool: async () => ({ wallet, token: "redacted" })
  });

  const result = await call(
    handler,
    modernRequest("tools/call", {
      name: "verifySiwe",
      arguments: { message: "signed challenge", signature: `0x${"11".repeat(65)}` }
    }),
    modernHeaders("tools/call", "verifySiwe")
  );

  assert.equal(result.statusCode, 200);
  assert.deepEqual(links, [{
    wallet,
    clientInfo: { name: "modern-test", version: "1.0.0" }
  }]);
});

test("fetchAuthNonce does not link a client name to the unsigned wallet", async () => {
  const links = [];
  const recorded = [];
  const observed = [];
  const wallet = "0x3333333333333333333333333333333333333333";
  const arrivals = {
    async recordTool(entry) { recorded.push(entry); },
    async linkWallet(entry) { links.push(entry); }
  };
  const { handler } = createHarness({
    arrivals,
    sessionTrail: { async observe(entry) { observed.push(entry); } },
    authMiddleware: async (request) => {
      request._arrivalWallet = wallet;
      return { wallet };
    }
  });

  const result = await call(
    handler,
    modernRequest("tools/call", { name: "fetchAuthNonce", arguments: { wallet } }),
    { ...modernHeaders("tools/call", "fetchAuthNonce"), authorization: "Bearer valid-token" }
  );

  assert.equal(result.statusCode, 200);
  assert.deepEqual(links, []);
  assert.equal(recorded[0].tool, "fetchAuthNonce");
  assert.equal(recorded[0].wallet, undefined);
  assert.equal(observed.at(-1).wallet, undefined);
});

test("a nonce and a failed claim do not raise an arrival alert", async () => {
  const wallet = "0x4444444444444444444444444444444444444444";
  const nonceNotes = [];
  const { handler: nonceHandler } = createHarness({
    arrivals: {
      async recordTool() {},
      async linkWallet() {},
      async noteArrivalAlert(entry) { nonceNotes.push(entry); }
    },
    authMiddleware: async (request) => {
      request._arrivalWallet = wallet;
      return { wallet };
    }
  });
  const nonce = await call(
    nonceHandler,
    modernRequest("tools/call", { name: "fetchAuthNonce", arguments: { wallet } }),
    { ...modernHeaders("tools/call", "fetchAuthNonce"), authorization: "Bearer valid-token" }
  );
  assert.equal(nonce.statusCode, 200);
  assert.equal(nonceNotes.every((entry) => entry.wallet === undefined && entry.authenticated !== true), true);

  const claimNotes = [];
  const { handler: claimHandler } = createHarness({
    arrivals: {
      async recordTool() {},
      async recordDropOff() {},
      async linkWallet() {},
      async noteArrivalAlert(entry) { claimNotes.push(entry); }
    },
    authMiddleware: async (request) => {
      request._arrivalWallet = wallet;
      return { wallet };
    },
    executeTool: async () => { throw new ConflictError("already claimed"); }
  });
  const claim = await call(
    claimHandler,
    modernRequest("tools/call", { name: "claimJob", arguments: { jobId: "job-1" } }),
    { ...modernHeaders("tools/call", "claimJob"), authorization: "Bearer valid-token" }
  );
  assert.equal(claim.statusCode, 200);
  assert.equal(claim.body.result.isError, true);
  assert.equal(claimNotes.length, 0);
});

test("authenticated MCP calls link the wallet stamped by auth middleware before dispatch", async () => {
  const links = [];
  const arrivals = {
    async recordTool() {},
    async linkWallet(entry) { links.push(entry); }
  };
  const wallet = "0x2222222222222222222222222222222222222222";
  const { handler } = createHarness({
    arrivals,
    authMiddleware: async (request) => {
      request._arrivalWallet = wallet;
      return { wallet };
    }
  });

  const result = await call(
    handler,
    modernRequest("tools/call", { name: "claimJob", arguments: { jobId: "job-1" } }),
    { ...modernHeaders("tools/call", "claimJob"), authorization: "Bearer valid-token" }
  );

  assert.equal(result.statusCode, 200);
  assert.deepEqual(links, [{
    wallet,
    clientInfo: { name: "modern-test", version: "1.0.0" }
  }]);
});


test("1,000 unregistered tool calls record only the unknown tool label", async () => {
  const arrivals = new ArrivalObservatory({ stateStore: new MemoryStateStore() });
  const { handler } = createHarness({ arrivals });
  for (let index = 0; index < 1_000; index += 1) {
    const name = `tool-${randomUUID()}`;
    const result = await call(handler, modernRequest("tools/call", { name, arguments: {} }), modernHeaders("tools/call", name));
    assert.equal(result.statusCode, 400);
  }
  await call(handler, modernRequest("tools/call", { name: "listJobs", arguments: {} }), modernHeaders("tools/call", "listJobs"));
  const snapshot = await arrivals.getSnapshot();
  const tools = snapshot.clients[0].tools;
  const registeredNames = new Set(MCP_TOOLS.map(({ name }) => name));
  assert.ok(Object.keys(tools).length <= 64);
  assert.ok(Object.keys(tools).every((name) => registeredNames.has(name) || name === "unknown_tool" || name === "other"));
  assert.deepEqual(tools, { unknown_tool: 1_000, listJobs: 1 });
});

test("an anonymous follow-up is not stitched onto a linked wallet", async () => {
  const wallet = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
  const state = new Map();
  const stateStore = {
    async getServiceState(scope) { return state.get(scope); },
    async upsertServiceState(scope, value) {
      state.set(scope, { ...(state.get(scope) ?? {}), ...value });
      return state.get(scope);
    },
    async deleteServiceState(scope) { state.delete(scope); }
  };
  const arrivals = new ArrivalObservatory({ stateStore: new MemoryStateStore(), now: () => 10_000, flushIntervalMs: 0 });
  const sessionTrail = new ArrivalSessionTrail({ stateStore, now: () => 10_000, flushIntervalMs: 0 });
  const { handler } = createHarness({
    arrivals,
    sessionTrail,
    authMiddleware: async (request) => {
      request._arrivalWallet = wallet;
      return { wallet };
    }
  });
  const headers = modernHeaders("tools/call", "listJobs");
  const authed = await call(
    handler,
    modernRequest("tools/call", { name: "listJobs", arguments: {} }),
    { ...headers, authorization: "Bearer valid-token" }
  );
  assert.equal(authed.statusCode, 200);
  const anon = await call(
    handler,
    modernRequest("tools/call", { name: "listJobs", arguments: {} }, MODERN_MCP_VERSION, 2),
    headers
  );
  assert.equal(anon.statusCode, 200);
  const record = await sessionTrail.get(`wallet:${wallet}`);
  assert.equal(record.session.steps.length, 1);
  assert.equal(record.session.steps[0].name, "listJobs");
  const listed = await sessionTrail.list();
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.preAuth.count, 1);
});

test("an MCP error on fetchAuthNonce records no drop-off for the claimed wallet", async () => {
  const claimed = "0xabababababababababababababababababababab";
  const arrivals = new ArrivalObservatory({
    stateStore: new MemoryStateStore(),
    now: () => 10_000,
    flushIntervalMs: 0,
    identityRegistry: new SelfIdentityRegistry({ qaEngineerWallets: [claimed] })
  });
  const { handler } = createHarness({
    arrivals,
    authMiddleware: async (request) => {
      request._arrivalWallet = claimed;
      return { wallet: claimed };
    },
    executeTool: async () => { throw new ConflictError("nonce refused"); }
  });
  const result = await call(
    handler,
    modernRequest("tools/call", { name: "fetchAuthNonce", arguments: { wallet: claimed } }),
    { ...modernHeaders("tools/call", "fetchAuthNonce"), authorization: "Bearer valid-token" }
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.result.isError, true);
  const snapshot = await arrivals.getSnapshot();
  const selfRow = snapshot.errorsByStage.sinceCutover.mcp.self.identified;
  assert.equal(selfRow.conflict, undefined);
  assert.equal(JSON.stringify(snapshot.errorsByStage.sinceCutover.mcp.self).includes("conflict"), false);
  assert.equal(snapshot.errorsByStage.sinceCutover.mcp.external.identified.conflict, 1);
});

test("a rate-limited MCP request produces no trail row", async () => {
  const state = new Map();
  const sessionTrail = new ArrivalSessionTrail({
    stateStore: {
      async getServiceState(scope) { return state.get(scope); },
      async upsertServiceState(scope, value) {
        state.set(scope, { ...(state.get(scope) ?? {}), ...value });
        return state.get(scope);
      },
      async deleteServiceState(scope) { state.delete(scope); }
    },
    now: () => 10_000,
    flushIntervalMs: 0
  });
  const { handler } = createHarness({
    sessionTrail,
    enforceLimit: async () => { throw new RateLimitError(); }
  });
  await assert.rejects(
    () => call(handler, modernRequest("tools/list"), modernHeaders("tools/list")),
    (error) => error instanceof RateLimitError
  );
  const listed = await sessionTrail.list();
  assert.equal(listed.sessions.length, 0);
  assert.equal(listed.preAuth.count, 0);
});
