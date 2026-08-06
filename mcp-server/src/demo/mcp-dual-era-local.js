#!/usr/bin/env node
import { createServer } from "node:http";

import { AuthenticationError } from "../core/errors.js";
import { createJobRoutes } from "../protocols/http/job-routes.js";
import { createJsonBodyReader, respond } from "../protocols/http/http-helpers.js";
import {
  createMcpRoute,
  LEGACY_MCP_VERSION,
  MODERN_MCP_VERSION
} from "../protocols/mcp/handler.js";
import { createMcpToolExecutor } from "../protocols/mcp/tools.js";

const service = {
  listJobsWithSessions: async () => [{
    id: "mcp-smoke-job-1",
    title: "MCP dual-era smoke job",
    state: "open",
    claimState: "open",
    effectiveState: "claimable",
    claimable: true,
    category: "verification",
    description: "Deterministic local catalog row used by the MCP transcript harness."
  }]
};
const readJsonBody = createJsonBodyReader({ maxBytes: 64 * 1024 });
const authMiddleware = async () => {
  throw new AuthenticationError("Authentication required.", "missing_token");
};
const handleJobRoute = createJobRoutes({
  authMiddleware,
  enforceLimit: async () => {},
  ensureSessionOwnership: async () => {},
  protocol: "mcp",
  rateLimitConfig: { adminJobs: { limit: 60, windowSeconds: 60 } },
  readJsonBody,
  respond,
  service
});
const executeTool = createMcpToolExecutor({
  handleAuthRoute: async () => false,
  handleJobRoute,
  handlePublicMetadataRoute: async () => false
});
const handleMcpRoute = createMcpRoute({
  authMiddleware,
  clientIp: (request) => request.socket?.remoteAddress ?? "unknown",
  enforceLimit: async () => {},
  executeTool,
  rateLimitConfig: {
    mcpAnonymous: { limit: 60, windowSeconds: 60 },
    mcpAuthenticated: { limit: 300, windowSeconds: 60 }
  },
  readJsonBody,
  respond
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  response._corsHeaders = {};
  if (await handleMcpRoute({ request, response, pathname: url.pathname })) return;
  respond(response, 404, { error: "not_found" });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const endpoint = `http://127.0.0.1:${address.port}/mcp`;

try {
  const modern = await post({
    body: modernMessage(1, "tools/call", {
      name: "listJobs",
      arguments: { format: "compact", limit: 1 }
    }),
    headers: {
      "MCP-Protocol-Version": MODERN_MCP_VERSION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": "listJobs"
    }
  });

  const initialized = await post({
    body: {
      jsonrpc: "2.0",
      id: "legacy-init",
      method: "initialize",
      params: {
        protocolVersion: LEGACY_MCP_VERSION,
        capabilities: {},
        clientInfo: { name: "averray-legacy-smoke", version: "1.0.0" }
      }
    }
  });
  const sessionId = initialized.headers.get("mcp-session-id");
  const legacyHeaders = {
    "MCP-Protocol-Version": LEGACY_MCP_VERSION,
    "MCP-Session-Id": sessionId
  };
  await post({
    body: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    headers: legacyHeaders
  });
  const legacy = await post({
    body: {
      jsonrpc: "2.0",
      id: "legacy-list",
      method: "tools/call",
      params: {
        name: "listJobs",
        arguments: { format: "compact", limit: 1 }
      }
    },
    headers: legacyHeaders
  });

  console.log(JSON.stringify({
    endpoint,
    modern: summarize(modern),
    legacy: {
      initialize: {
        status: initialized.status,
        protocolVersion: initialized.body?.result?.protocolVersion,
        sessionId
      },
      listJobs: summarize(legacy)
    }
  }, null, 2));
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function modernMessage(id, method, params) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_MCP_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          name: "averray-modern-smoke",
          version: "1.0.0"
        }
      }
    }
  };
}

async function post({ body, headers = {} }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : undefined
  };
}

function summarize(response) {
  const result = response.body?.result;
  const jobs = result?.structuredContent?.jobs ?? [];
  return {
    status: response.status,
    resultType: result?.resultType ?? "legacy-implicit-complete",
    isError: result?.isError,
    count: result?.structuredContent?.count,
    firstJobId: jobs[0]?.id
  };
}
