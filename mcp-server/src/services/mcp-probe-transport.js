import http from "node:http";
import https from "node:https";
import tls from "node:tls";

export class EgressPolicyDeniedError extends Error {
  constructor(message = "The MCP egress boundary refused a destination outside the declared endpoint.") {
    super(message);
    this.name = "EgressPolicyDeniedError";
  }
}

export class TargetUnavailableError extends Error {
  constructor(message = "The MCP endpoint could not be reached.") {
    super(message);
    this.name = "TargetUnavailableError";
  }
}

export class TargetAuthenticationError extends Error {
  constructor(message = "The MCP endpoint refused the supplied scoped credential.") {
    super(message);
    this.name = "TargetAuthenticationError";
  }
}

export class ProbeTimeoutError extends Error {
  constructor(message = "The MCP endpoint did not answer within the bounded probe window.") {
    super(message);
    this.name = "ProbeTimeoutError";
  }
}

export class McpProtocolError extends Error {
  constructor(error, response = undefined) {
    super(String(error?.message ?? "MCP request returned a protocol error."));
    this.name = "McpProtocolError";
    this.code = Number(error?.code);
    this.data = error?.data;
    this.response = response;
  }
}

export class McpHttpStatusError extends Error {
  constructor(statusCode, body) {
    super(`MCP endpoint returned HTTP ${statusCode}.`);
    this.name = "McpHttpStatusError";
    this.statusCode = Number(statusCode);
    this.body = String(body ?? "").slice(0, 4_096);
  }
}

export class McpProbeTransport {
  constructor({ endpoint, transport, proxyUrl, egressGrant, credential, timeoutMs = 5_000, allowInsecureHttp = false } = {}) {
    this.endpoint = parseEndpoint(endpoint, { allowInsecureHttp });
    this.transport = String(transport);
    if ((this.transport === "streamable_http" && !new Set(["https:", "http:"]).has(this.endpoint.protocol))
        || (this.transport === "websocket" && this.endpoint.protocol !== "wss:")) {
      throw new Error("MCP transport and endpoint protocol do not form an allowed fixed-suite pair.");
    }
    this.proxyUrl = parseProxyUrl(proxyUrl);
    this.egressGrant = requiredString(egressGrant, "MCP egress grant");
    this.credential = credential === undefined ? undefined : requiredString(credential, "MCP scoped credential");
    this.timeoutMs = boundedTimeout(timeoutMs);
  }

  createSession({ authenticated = true, timeoutMs = this.timeoutMs } = {}) {
    const common = {
      endpoint: this.endpoint,
      proxyUrl: this.proxyUrl,
      egressGrant: this.egressGrant,
      credential: authenticated ? this.credential : undefined,
      timeoutMs: boundedTimeout(timeoutMs)
    };
    if (this.transport === "streamable_http") return new StreamableHttpMcpSession(common);
    if (this.transport === "websocket") return new WebSocketMcpSession(common);
    throw new Error(`Unsupported fixed MCP transport ${this.transport}.`);
  }
}

class StreamableHttpMcpSession {
  constructor(options) {
    Object.assign(this, options);
    this.nextId = 1;
    this.sessionId = undefined;
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "averray-mcp-failure-semantics", version: "1" }
    });
    await this.notify("notifications/initialized", {});
    return result;
  }

  async request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    const id = this.nextId++;
    const response = await postMcpJson({
      ...this,
      timeoutMs,
      payload: { jsonrpc: "2.0", id, method, params }
    });
    this.sessionId ??= firstHeader(response.headers["mcp-session-id"]);
    const document = parseMcpDocument(response.body);
    if (document?.error) throw new McpProtocolError(document.error, document);
    if (document?.id !== id || !("result" in (document ?? {}))) {
      throw new Error("MCP endpoint returned a malformed JSON-RPC response.");
    }
    return document.result;
  }

  async notify(method, params) {
    const response = await postMcpJson({ ...this, payload: { jsonrpc: "2.0", method, params } });
    this.sessionId ??= firstHeader(response.headers["mcp-session-id"]);
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await postMcpJson({ ...this, method: "DELETE", payload: undefined });
    } catch {
      // Session cleanup is best-effort and carries no credential persistence.
    }
  }
}

class WebSocketMcpSession {
  constructor(options) {
    Object.assign(this, options);
    this.nextId = 1;
    this.pending = new Map();
    this.socket = undefined;
  }

  async initialize() {
    await this.open();
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "averray-mcp-failure-semantics", version: "1" }
    });
    await this.notify("notifications/initialized", {});
    return result;
  }

  async open() {
    if (this.socket) return;
    const tunnel = await openTunnel({
      proxyUrl: this.proxyUrl,
      authority: endpointAuthority(this.endpoint),
      egressGrant: this.egressGrant,
      timeoutMs: this.timeoutMs
    });
    const secureSocket = await wrapTls(tunnel, this.endpoint, this.timeoutMs);
    const { WebSocket } = await import("ws");
    const headers = this.credential ? { authorization: `Bearer ${this.credential}` } : {};
    this.socket = new WebSocket(this.endpoint, { headers, createConnection: () => secureSocket });
    await waitForWebSocketOpen(this.socket, this.timeoutMs);
    this.socket.on("message", (raw) => this.receive(raw));
    this.socket.on("close", () => this.rejectPending(new TargetUnavailableError("MCP WebSocket closed during the probe.")));
    this.socket.on("error", () => this.rejectPending(new TargetUnavailableError()));
  }

  async request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    await this.open();
    const id = this.nextId++;
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProbeTimeoutError());
      }, boundedTimeout(timeoutMs));
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
    if (response?.error) throw new McpProtocolError(response.error, response);
    return response.result;
  }

  async notify(method, params) {
    await this.open();
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  receive(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const pending = this.pending.get(message?.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    pending.resolve(message);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    this.socket?.close();
    this.socket = undefined;
  }
}

async function postMcpJson({ endpoint, proxyUrl, egressGrant, credential, timeoutMs, sessionId, payload, method = "POST" }) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const tunnel = await openTunnel({
    proxyUrl,
    authority: endpointAuthority(endpoint),
    egressGrant,
    timeoutMs
  });
  const secure = endpoint.protocol === "https:" ? await wrapTls(tunnel, endpoint, timeoutMs) : tunnel;
  const transport = endpoint.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const agent = new transport.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => {
      callback?.(null, secure);
      return secure;
    };
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(credential ? { authorization: `Bearer ${credential}` } : {})
    };
    const request = transport.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
      path: `${endpoint.pathname}${endpoint.search}`,
      method,
      headers,
      agent
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 512 * 1024) {
          request.destroy(new Error("MCP response exceeded the fixed 512 KiB evidence limit."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode === 401 || response.statusCode === 403) {
          reject(new TargetAuthenticationError());
          return;
        }
        if (Number(response.statusCode) >= 400) {
          reject(new McpHttpStatusError(response.statusCode, responseBody));
          return;
        }
        resolve({ statusCode: response.statusCode, headers: response.headers, body: responseBody });
      });
    });
    const timer = setTimeout(() => request.destroy(new ProbeTimeoutError()), boundedTimeout(timeoutMs));
    timer.unref?.();
    request.on("close", () => clearTimeout(timer));
    request.on("error", (error) => reject(classifyTransportError(error)));
    request.end(body);
  });
}

function openTunnel({ proxyUrl, authority, egressGrant, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: proxyUrl.hostname,
      port: proxyUrl.port,
      method: "CONNECT",
      path: authority,
      headers: { "proxy-authorization": `Bearer ${egressGrant}` }
    });
    const timer = setTimeout(() => request.destroy(new ProbeTimeoutError("MCP egress proxy did not answer.")), timeoutMs);
    timer.unref?.();
    request.on("connect", (response, socket, head) => {
      clearTimeout(timer);
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(response.statusCode === 403
          ? new EgressPolicyDeniedError()
          : new TargetUnavailableError("MCP egress proxy could not establish the declared endpoint tunnel."));
        return;
      }
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    request.on("response", (response) => {
      clearTimeout(timer);
      response.resume();
      reject(response.statusCode === 403 ? new EgressPolicyDeniedError() : new TargetUnavailableError());
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(classifyTransportError(error));
    });
    request.end();
  });
}

function wrapTls(socket, endpoint, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername: endpoint.hostname,
      rejectUnauthorized: true
    });
    const timer = setTimeout(() => secure.destroy(new ProbeTimeoutError("MCP TLS handshake timed out.")), timeoutMs);
    timer.unref?.();
    secure.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(secure);
    });
    secure.once("error", (error) => {
      clearTimeout(timer);
      reject(classifyTransportError(error));
    });
  });
}

function parseMcpDocument(body) {
  const source = String(body ?? "").trim();
  if (!source) return {};
  if (source.startsWith("data:")) {
    const events = source.split(/\r?\n/u).filter((line) => line.startsWith("data:"));
    return JSON.parse(events.at(-1).slice(5).trim());
  }
  return JSON.parse(source);
}

function parseEndpoint(value, { allowInsecureHttp }) {
  const endpoint = new URL(String(value));
  const allowed = allowInsecureHttp ? new Set(["https:", "wss:", "http:"]) : new Set(["https:", "wss:"]);
  if (!allowed.has(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.hostname) {
    throw new Error("MCP endpoint protocol or authority is invalid.");
  }
  return endpoint;
}

function parseProxyUrl(value) {
  const proxy = new URL(requiredString(value, "MCP egress proxy URL"));
  if (proxy.protocol !== "http:" || proxy.username || proxy.password || !proxy.hostname) {
    throw new Error("MCP egress proxy must be an internal plain-HTTP URL without credentials.");
  }
  if (!proxy.port) proxy.port = "8080";
  return proxy;
}

function endpointAuthority(endpoint) {
  return `${endpoint.hostname}:${endpoint.port || (endpoint.protocol === "http:" ? 80 : 443)}`;
}

function classifyTransportError(error) {
  if (process.env.MCP_PROBER_DIAGNOSTICS === "1") {
    console.warn(JSON.stringify({ event: "mcp_prober.transport_error", name: error?.name, code: error?.code }));
  }
  if (error instanceof EgressPolicyDeniedError
      || error instanceof TargetAuthenticationError
      || error instanceof ProbeTimeoutError
      || error instanceof McpHttpStatusError) return error;
  const code = String(error?.code ?? "");
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ENOTFOUND"
      || code === "EAI_AGAIN" || code.startsWith("ERR_TLS") || code.startsWith("CERT_")
      || code.startsWith("DEPTH_") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return new TargetUnavailableError();
  }
  return error instanceof Error ? error : new Error(String(error));
}

function waitForWebSocketOpen(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
    timer.unref?.();
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      reject(response.statusCode === 401 || response.statusCode === 403
        ? new TargetAuthenticationError()
        : new TargetUnavailableError());
    });
    socket.once("error", () => { clearTimeout(timer); reject(new TargetUnavailableError()); });
  });
}

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 30_000) throw new Error("MCP probe timeout is outside 100..30000ms.");
  return parsed;
}

function requiredString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function firstHeader(value) {
  if (Array.isArray(value)) return String(value[0] ?? "").trim() || undefined;
  return String(value ?? "").trim() || undefined;
}
