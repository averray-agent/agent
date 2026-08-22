import { randomUUID } from "node:crypto";

import { normalizeError } from "../../core/errors.js";
import { getMcpTool, MCP_TOOLS } from "./tools.js";

export const MODERN_MCP_VERSION = "2026-07-28";
export const LEGACY_MCP_VERSION = "2025-11-25";
export const SUPPORTED_MCP_VERSIONS = Object.freeze([
  MODERN_MCP_VERSION,
  LEGACY_MCP_VERSION
]);

export const MCP_SERVER_INFO = Object.freeze({
  name: "averray-agent-platform",
  title: "Averray Agent Platform",
  version: "0.4.0",
  websiteUrl: "https://averray.com"
});

export const MCP_BROWSER_INFO = Object.freeze({
  name: "Averray MCP endpoint",
  type: "mcp_protocol_endpoint",
  description: "This is an MCP protocol endpoint, not a browser page.",
  transport: "streamable_http",
  connect: {
    url: "https://api.averray.com/mcp",
    clientConfig: {
      mcpServers: {
        averray: {
          transport: "streamable-http",
          url: "https://api.averray.com/mcp"
        }
      }
    }
  },
  plainHttpAlternative: {
    method: "GET",
    path: "/verify/profiles",
    url: "https://api.averray.com/verify/profiles",
    description: "Browse the published verification profiles over plain HTTP."
  }
});

const SERVER_CAPABILITIES = Object.freeze({
  tools: { listChanged: false }
});
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const TOOL_LIST_TTL_MS = 300_000;
const DEFAULT_LEGACY_SESSION_TTL_MS = 30 * 60 * 1000;

export class UnsupportedProtocolVersionError extends Error {
  constructor(requested, supported = SUPPORTED_MCP_VERSIONS) {
    super("Unsupported protocol version.");
    this.name = "UnsupportedProtocolVersionError";
    this.code = UNSUPPORTED_PROTOCOL_VERSION;
    this.data = {
      supported: [...supported],
      requested
    };
  }
}

/**
 * Observability must never be able to refuse a request. The observatory guards
 * itself, but the door does not rely on that — any recorder injected here is
 * treated as untrusted, so a broken one costs a data point, not an arrival.
 */
async function recordArrival(arrivals, method, entry) {
  try {
    await arrivals?.[method]?.(entry);
  } catch {
    // Deliberately swallowed.
  }
}

export function createMcpRoute({
  arrivals,
  authMiddleware,
  clientIp,
  enforceLimit,
  executeTool,
  legacySessionTtlMs = DEFAULT_LEGACY_SESSION_TTL_MS,
  now = () => Date.now(),
  randomUUIDImpl = randomUUID,
  rateLimitConfig,
  readJsonBody,
  respond,
  serverInfo = MCP_SERVER_INFO,
  tools = MCP_TOOLS
}) {
  const legacySessions = new Map();

  return async function handleMcpRoute({ request, response, pathname }) {
    if (request.method === "GET" && pathname === "/mcp") {
      respond(response, 200, MCP_BROWSER_INFO, { "cache-control": "public, max-age=300" });
      return true;
    }

    if (request.method !== "POST" || pathname !== "/mcp") {
      return false;
    }

    let message;
    try {
      message = await readJsonBody(request);
    } catch (error) {
      const code = error?.message === "Invalid JSON body." ? -32700 : -32600;
      sendError(response, respond, 400, null, code, error?.message ?? "Invalid request.");
      return true;
    }

    if (!isJsonRpcMessage(message)) {
      sendError(response, respond, 400, message?.id ?? null, -32600, "Invalid JSON-RPC request.");
      return true;
    }

    if (!originAllowed(request, response)) {
      sendError(response, respond, 403, message.id ?? null, -32000, "Origin is not allowed.");
      return true;
    }

    if (message.method === "initialize") {
      handleLegacyInitialize({
        legacySessions,
        legacySessionTtlMs,
        message,
        now,
        randomUUIDImpl,
        request,
        respond,
        response,
        serverInfo
      });
      // A legacy handshake never reaches dispatchRequest, so it is recorded
      // here. A REJECTED handshake counts too: a client that cannot open a
      // session is exactly the arrival we most want to know about.
      await recordArrival(arrivals, "recordReach", {
        era: "legacy",
        clientInfo: message.params?.clientInfo,
        ip: clientIp?.(request)
      });
      return true;
    }

    const meta = requestMeta(message);
    if (meta && Object.hasOwn(meta, PROTOCOL_VERSION_META_KEY)) {
      await handleModernRequest({
        arrivals,
        authMiddleware,
        clientIp,
        enforceLimit,
        executeTool,
        message,
        meta,
        rateLimitConfig,
        request,
        respond,
        response,
        serverInfo,
        tools
      });
      return true;
    }

    if (request.headers?.["mcp-session-id"]) {
      await handleLegacyRequest({
        arrivals,
        authMiddleware,
        clientIp,
        enforceLimit,
        executeTool,
        legacySessions,
        message,
        now,
        rateLimitConfig,
        request,
        respond,
        response,
        serverInfo,
        tools
      });
      return true;
    }

    if (request.headers?.["mcp-protocol-version"] === MODERN_MCP_VERSION) {
      sendError(
        response,
        respond,
        400,
        message.id ?? null,
        HEADER_MISMATCH,
        `Header mismatch: request is missing params._meta.${PROTOCOL_VERSION_META_KEY}.`
      );
      return true;
    }

    sendError(
      response,
      respond,
      400,
      message.id ?? null,
      -32600,
      "Open with modern per-request _meta or a legacy initialize request."
    );
    return true;
  };
}

function handleLegacyInitialize({
  legacySessions,
  legacySessionTtlMs,
  message,
  now,
  randomUUIDImpl,
  request,
  respond,
  response,
  serverInfo
}) {
  const requested = message.params?.protocolVersion;
  if (requested !== LEGACY_MCP_VERSION) {
    sendUnsupportedVersion(response, respond, message.id, requested);
    return;
  }
  const headerVersion = request.headers?.["mcp-protocol-version"];
  if (headerVersion && headerVersion !== requested) {
    sendError(
      response,
      respond,
      400,
      message.id,
      HEADER_MISMATCH,
      `Header mismatch: MCP-Protocol-Version '${headerVersion}' does not match initialize protocolVersion '${requested}'.`
    );
    return;
  }
  if (!isImplementation(message.params?.clientInfo) || !isPlainObject(message.params?.capabilities)) {
    sendError(response, respond, 400, message.id, -32602, "initialize requires clientInfo and capabilities.");
    return;
  }

  pruneExpiredSessions(legacySessions, now());
  const sessionId = randomUUIDImpl();
  legacySessions.set(sessionId, {
    clientCapabilities: message.params.capabilities,
    clientInfo: message.params.clientInfo,
    expiresAt: now() + legacySessionTtlMs,
    initialized: false,
    protocolVersion: LEGACY_MCP_VERSION,
    ttlMs: legacySessionTtlMs
  });
  sendResult(response, respond, 200, message.id, {
    protocolVersion: LEGACY_MCP_VERSION,
    capabilities: SERVER_CAPABILITIES,
    serverInfo,
    instructions: serverInstructions()
  }, {
    "mcp-protocol-version": LEGACY_MCP_VERSION,
    "mcp-session-id": sessionId
  });
}

async function handleLegacyRequest({
  arrivals,
  authMiddleware,
  clientIp,
  enforceLimit,
  executeTool,
  legacySessions,
  message,
  now,
  rateLimitConfig,
  request,
  respond,
  response,
  serverInfo,
  tools
}) {
  const sessionId = request.headers?.["mcp-session-id"];
  const session = legacySessions.get(sessionId);
  if (!session || session.expiresAt <= now()) {
    legacySessions.delete(sessionId);
    sendError(response, respond, 404, message.id ?? null, -32001, "MCP session not found or expired.");
    return;
  }
  const headerVersion = request.headers?.["mcp-protocol-version"];
  if (!headerVersion) {
    sendError(response, respond, 400, message.id ?? null, HEADER_MISMATCH, "Missing MCP-Protocol-Version header.");
    return;
  }
  if (!SUPPORTED_MCP_VERSIONS.includes(headerVersion)) {
    sendUnsupportedVersion(response, respond, message.id, headerVersion);
    return;
  }
  if (headerVersion !== session.protocolVersion) {
    sendError(
      response,
      respond,
      400,
      message.id ?? null,
      HEADER_MISMATCH,
      `MCP-Protocol-Version '${headerVersion}' does not match the session version '${session.protocolVersion}'.`
    );
    return;
  }
  session.expiresAt = now() + session.ttlMs;

  if (message.method === "notifications/initialized" && !Object.hasOwn(message, "id")) {
    session.initialized = true;
    sendEmpty(response, 202, response._corsHeaders);
    return;
  }
  if (!session.initialized) {
    sendError(response, respond, 400, message.id ?? null, -32600, "Legacy session is not initialized.");
    return;
  }

  await dispatchRequest({
    arrivals,
    authMiddleware,
    clientInfo: session.clientInfo,
    clientIp,
    enforceLimit,
    era: "legacy",
    executeTool,
    message,
    rateLimitConfig,
    request,
    respond,
    response,
    serverInfo,
    tools
  });
}

async function handleModernRequest({
  arrivals,
  authMiddleware,
  clientIp,
  enforceLimit,
  executeTool,
  message,
  meta,
  rateLimitConfig,
  request,
  respond,
  response,
  serverInfo,
  tools
}) {
  const bodyVersion = meta[PROTOCOL_VERSION_META_KEY];
  const headerVersion = request.headers?.["mcp-protocol-version"];
  if (!headerVersion) {
    sendError(response, respond, 400, message.id ?? null, HEADER_MISMATCH, "Missing MCP-Protocol-Version header.");
    return;
  }
  if (headerVersion !== bodyVersion) {
    sendError(
      response,
      respond,
      400,
      message.id ?? null,
      HEADER_MISMATCH,
      `Header mismatch: MCP-Protocol-Version '${headerVersion}' does not match _meta protocolVersion '${bodyVersion}'.`
    );
    return;
  }
  if (!SUPPORTED_MCP_VERSIONS.includes(bodyVersion) || bodyVersion !== MODERN_MCP_VERSION) {
    sendUnsupportedVersion(response, respond, message.id, bodyVersion);
    return;
  }
  if (!isPlainObject(meta[CLIENT_CAPABILITIES_META_KEY])) {
    sendError(response, respond, 400, message.id ?? null, -32602, `Missing or invalid _meta.${CLIENT_CAPABILITIES_META_KEY}.`);
    return;
  }
  if (meta[CLIENT_INFO_META_KEY] !== undefined && !isImplementation(meta[CLIENT_INFO_META_KEY])) {
    sendError(response, respond, 400, message.id ?? null, -32602, `Invalid _meta.${CLIENT_INFO_META_KEY}.`);
    return;
  }

  const headerMethod = request.headers?.["mcp-method"];
  if (!headerMethod || headerMethod !== message.method) {
    sendError(
      response,
      respond,
      400,
      message.id ?? null,
      HEADER_MISMATCH,
      !headerMethod
        ? "Missing Mcp-Method header."
        : `Header mismatch: Mcp-Method '${headerMethod}' does not match body method '${message.method}'.`
    );
    return;
  }
  if (message.method === "tools/call") {
    const bodyName = message.params?.name;
    const headerName = decodeHeaderValue(request.headers?.["mcp-name"]);
    if (!headerName || headerName !== bodyName) {
      sendError(
        response,
        respond,
        400,
        message.id ?? null,
        HEADER_MISMATCH,
        !headerName
          ? "Missing Mcp-Name header."
          : `Header mismatch: Mcp-Name '${headerName}' does not match body name '${bodyName}'.`
      );
      return;
    }
  }

  await dispatchRequest({
    arrivals,
    authMiddleware,
    clientInfo: meta[CLIENT_INFO_META_KEY],
    clientIp,
    enforceLimit,
    era: "modern",
    executeTool,
    message,
    rateLimitConfig,
    request,
    respond,
    response,
    serverInfo,
    tools
  });
}

async function dispatchRequest({
  arrivals,
  authMiddleware,
  clientInfo,
  clientIp,
  enforceLimit,
  era,
  executeTool,
  message,
  rateLimitConfig,
  request,
  respond,
  response,
  serverInfo,
  tools
}) {
  // Both eras funnel through here, so this is the single place that sees
  // every dispatched method. Recorded BEFORE any validation or rate limit, so
  // a caller that is refused still counts as having arrived.
  await recordArrival(arrivals, message.method === "tools/call" ? "recordTool" : "recordReach", {
    tool: message.params?.name,
    era,
    clientInfo,
    ip: clientIp?.(request)
  });

  if (!Object.hasOwn(message, "id")) {
    sendError(response, respond, 400, null, -32600, "This MCP method requires a JSON-RPC id.");
    return;
  }

  const resultHeaders = {
    "mcp-protocol-version": era === "modern" ? MODERN_MCP_VERSION : LEGACY_MCP_VERSION
  };
  if (message.method === "server/discover" && era === "modern") {
    sendResult(response, respond, 200, message.id, modernResult({
      supportedVersions: [...SUPPORTED_MCP_VERSIONS],
      capabilities: SERVER_CAPABILITIES,
      instructions: serverInstructions(),
      ttlMs: TOOL_LIST_TTL_MS,
      cacheScope: "public"
    }, serverInfo), {
      ...resultHeaders,
      "cache-control": `public, max-age=${TOOL_LIST_TTL_MS / 1000}`
    });
    return;
  }
  if (message.method === "tools/list") {
    const result = { tools };
    if (era === "modern") {
      Object.assign(result, {
        resultType: "complete",
        ttlMs: TOOL_LIST_TTL_MS,
        cacheScope: "public",
        _meta: { [SERVER_INFO_META_KEY]: serverInfo }
      });
    }
    sendResult(response, respond, 200, message.id, result, era === "modern"
      ? { ...resultHeaders, "cache-control": `public, max-age=${TOOL_LIST_TTL_MS / 1000}` }
      : resultHeaders);
    return;
  }
  if (message.method === "tools/call") {
    const toolName = message.params?.name;
    const toolDefinition = typeof toolName === "string" ? getMcpTool(toolName, tools) : undefined;
    if (!toolDefinition) {
      sendError(response, respond, 400, message.id, -32602, `Unknown tool: ${String(toolName ?? "")}`);
      return;
    }
    const argumentError = validateToolArguments(toolDefinition, message.params?.arguments);
    if (argumentError) {
      sendError(response, respond, 400, message.id, -32602, `Invalid arguments for tool ${toolName}: ${argumentError}`);
      return;
    }
    try {
      await enforceToolRateLimit({
        authMiddleware,
        clientIp,
        enforceLimit,
        rateLimitConfig,
        request
      });
      if (request._arrivalWallet) {
        await recordArrival(arrivals, "linkWallet", {
          wallet: request._arrivalWallet,
          clientInfo
        });
      }
      const payload = await executeTool(toolName, message.params?.arguments, { request });
      if (toolName === "verifySiwe" && payload?.wallet) {
        await recordArrival(arrivals, "linkWallet", {
          wallet: payload.wallet,
          clientInfo
        });
      }
      sendResult(
        response,
        respond,
        200,
        message.id,
        toolResult(payload, { era, serverInfo }),
        resultHeaders
      );
    } catch (error) {
      const normalized = normalizeError(error);
      sendResult(
        response,
        respond,
        200,
        message.id,
        toolErrorResult(normalized, { era, serverInfo }),
        resultHeaders
      );
    }
    return;
  }

  sendError(response, respond, 404, message.id, -32601, `Method not found: ${message.method}`);
}

async function enforceToolRateLimit({
  authMiddleware,
  clientIp,
  enforceLimit,
  rateLimitConfig,
  request
}) {
  const hasBearer = /^Bearer\s+\S+/iu.test(String(request.headers?.authorization ?? ""));
  let auth;
  let authError;
  if (hasBearer) {
    try {
      auth = await authMiddleware(request, new URL("http://localhost/mcp"), {
        enforceRouteCapabilities: false
      });
    } catch (error) {
      authError = error;
    }
  }

  if (auth) {
    await enforceLimit("mcp_tools_authenticated", auth.wallet, rateLimitConfig.mcpAuthenticated);
  } else {
    await enforceLimit("mcp_tools_anonymous", clientIp(request), rateLimitConfig.mcpAnonymous);
  }
  if (authError) throw authError;
}

function toolResult(payload, { era, serverInfo }) {
  const result = {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: legacyStructuredContent(payload, era),
    isError: false
  };
  return era === "modern" ? modernResult(result, serverInfo) : result;
}

function toolErrorResult(error, { era, serverInfo }) {
  const payload = {
    error: error.code ?? "internal_error",
    message: error.message ?? "internal_error",
    ...(error.details === undefined ? {} : { details: error.details })
  };
  const result = {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true
  };
  return era === "modern" ? modernResult(result, serverInfo) : result;
}

function modernResult(result, serverInfo) {
  return {
    resultType: "complete",
    ...result,
    _meta: {
      ...(isPlainObject(result._meta) ? result._meta : {}),
      [SERVER_INFO_META_KEY]: serverInfo
    }
  };
}

function legacyStructuredContent(payload, era) {
  if (era === "modern" || (isPlainObject(payload))) return payload;
  return { data: payload };
}

function validateToolArguments(toolDefinition, rawArguments) {
  const args = rawArguments === undefined ? {} : rawArguments;
  if (!isPlainObject(args)) return "arguments must be an object.";
  const schema = toolDefinition.inputSchema ?? {};
  const properties = schema.properties ?? {};
  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(args, required)) return `missing required property '${required}'.`;
  }
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).find((name) => !Object.hasOwn(properties, name));
    if (unknown) return `unknown property '${unknown}'.`;
  }
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!property || Object.keys(property).length === 0) continue;
    if (property.type === "string" && typeof value !== "string") return `'${name}' must be a string.`;
    if (property.type === "integer" && !Number.isInteger(value)) return `'${name}' must be an integer.`;
    if (typeof value === "string" && Number.isFinite(property.minLength) && value.length < property.minLength) {
      return `'${name}' is shorter than ${property.minLength} characters.`;
    }
    if (typeof value === "string" && Number.isFinite(property.maxLength) && value.length > property.maxLength) {
      return `'${name}' exceeds ${property.maxLength} characters.`;
    }
    if (typeof value === "string" && property.pattern && !(new RegExp(property.pattern, "u")).test(value)) {
      return `'${name}' does not match the required pattern.`;
    }
    if (Array.isArray(property.enum) && !property.enum.includes(value)) return `'${name}' is not an allowed value.`;
    if (Number.isFinite(property.minimum) && value < property.minimum) return `'${name}' is below ${property.minimum}.`;
    if (Number.isFinite(property.maximum) && value > property.maximum) return `'${name}' exceeds ${property.maximum}.`;
  }
  return undefined;
}

function requestMeta(message) {
  return isPlainObject(message.params?._meta) ? message.params._meta : undefined;
}

function isJsonRpcMessage(value) {
  if (!isPlainObject(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") return false;
  if (Object.hasOwn(value, "id")) {
    return typeof value.id === "string" || typeof value.id === "number" || value.id === null;
  }
  return true;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isImplementation(value) {
  return isPlainObject(value)
    && typeof value.name === "string"
    && value.name.length > 0
    && typeof value.version === "string"
    && value.version.length > 0;
}

function originAllowed(request, response) {
  const origin = request.headers?.origin;
  if (!origin) return true;
  return Boolean(response._corsHeaders?.["access-control-allow-origin"]);
}

function decodeHeaderValue(value) {
  if (typeof value !== "string") return undefined;
  const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/u.exec(value);
  if (!match) return value;
  try {
    return Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function pruneExpiredSessions(sessions, nowMs) {
  for (const [sessionId, session] of sessions) {
    if (session.expiresAt <= nowMs) sessions.delete(sessionId);
  }
}

function serverInstructions() {
  return "Discover all tools anonymously. Use fetchAuthNonce and verifySiwe to obtain a bearer token, then send Authorization: Bearer <token> for claimJob, submitWork, and refreshAuthToken.";
}

function sendUnsupportedVersion(response, respond, id, requested) {
  const error = new UnsupportedProtocolVersionError(requested);
  sendError(
    response,
    respond,
    400,
    id ?? null,
    error.code,
    error.message,
    error.data
  );
}

function sendResult(response, respond, statusCode, id, result, headers = {}) {
  respond(response, statusCode, { jsonrpc: "2.0", id, result }, headers);
}

function sendError(response, respond, statusCode, id, code, message, data = undefined) {
  respond(response, statusCode, {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  });
}

function sendEmpty(response, statusCode, headers = {}) {
  response.writeHead(statusCode, headers);
  response.end();
}
