import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationError } from "../../core/errors.js";
import { respond } from "../http/http-helpers.js";
import {
  createMcpRoute,
  LEGACY_MCP_VERSION,
  MCP_SERVER_INFO,
  MODERN_MCP_VERSION,
  SUPPORTED_MCP_VERSIONS
} from "./handler.js";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";

function createHarness(overrides = {}) {
  const limitCalls = [];
  const handler = createMcpRoute({
    authMiddleware: overrides.authMiddleware ?? (async () => ({ wallet: "0xauthed" })),
    clientIp: () => "198.51.100.8",
    enforceLimit: async (bucket, key, config) => {
      limitCalls.push({ bucket, key, config });
    },
    executeTool: overrides.executeTool ?? (async (name) => ({ name, jobs: [{ id: "job-1" }] })),
    legacySessionTtlMs: overrides.legacySessionTtlMs ?? 60_000,
    now: overrides.now ?? (() => 1_000_000),
    randomUUIDImpl: () => "legacy-session-1",
    rateLimitConfig: {
      mcpAnonymous: { limit: 10, windowSeconds: 60 },
      mcpAuthenticated: { limit: 20, windowSeconds: 60 }
    },
    readJsonBody: async (request) => request.body,
    respond
  });
  return { handler, limitCalls };
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
  assert.deepEqual(result.body.error.data, {
    supported: [...SUPPORTED_MCP_VERSIONS],
    requested
  });
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

test("unsupported initialize version also uses -32022 with the required data", async () => {
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

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error.code, -32022);
  assert.deepEqual(result.body.error.data, {
    supported: [...SUPPORTED_MCP_VERSIONS],
    requested: "2025-06-18"
  });
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
    { bucket: "mcp_tools_anonymous", key: "198.51.100.8" },
    { bucket: "mcp_tools_authenticated", key: "0xabc" }
  ]);
});
