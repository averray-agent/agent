import http from "node:http";

const mode = process.env.MCP_FIXTURE_MODE === "bad_destructive" ? "bad_destructive" : "good";
const port = Number(process.env.PORT ?? 8080);
const expectedCredential = "fixture-scoped-token";

const tools = [
  {
    name: "protected_read",
    inputSchema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
    _meta: { "averray/verification": { suiteVersion: 1, authProbe: { arguments: { value: "probe" } } } }
  },
  {
    name: "timeout_probe",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    _meta: { "averray/verification": { suiteVersion: 1, timeoutProbe: { arguments: {} } } }
  },
  {
    name: "destructive_probe",
    inputSchema: { type: "object", additionalProperties: false, required: ["resource"], properties: { resource: { type: "string" }, confirmation: { type: "string" } } },
    annotations: { destructiveHint: true },
    _meta: { "averray/verification": { suiteVersion: 1, destructiveProbe: { argumentsWithoutConfirmation: { resource: "fixture" } } } }
  }
];

http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") return json(response, 200, { ok: true, mode });
  if (request.method === "DELETE") return empty(response, 204);
  if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
  let message;
  try { message = JSON.parse(await body(request)); } catch { return json(response, 400, { error: "malformed_request" }); }
  if (!Object.hasOwn(message, "id")) return empty(response, 202);
  const reply = (result) => json(response, 200, { jsonrpc: "2.0", id: message.id, result });
  const fail = (code, text) => json(response, 200, { jsonrpc: "2.0", id: message.id, error: { code, message: text } });
  if (message.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `fixture-${mode}`, version: "1" } });
  if (message.method === "tools/list") return reply({ tools });
  if (message.method !== "tools/call") return fail(-32601, "Method not found");
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  if (name === "protected_read") {
    if (request.headers.authorization !== `Bearer ${expectedCredential}`) return fail(-32001, "Authentication required");
    if (Object.keys(args).some((key) => key !== "value") || typeof args.value !== "string") return fail(-32602, "Invalid params");
    return reply({ content: [{ type: "text", text: "ok" }] });
  }
  if (name === "timeout_probe") {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return fail(-32008, "Operation timed out and session recovered");
  }
  if (name === "destructive_probe") {
    if (mode === "bad_destructive") return reply({ content: [{ type: "text", text: "acted" }] });
    if (args.confirmation !== "CONFIRM") return fail(-32602, "Explicit confirmation required");
    return reply({ content: [{ type: "text", text: "acted" }] });
  }
  return fail(-32601, "Tool not found");
}).listen(port, "0.0.0.0", () => console.log(JSON.stringify({ event: "mcp_fixture.listening", mode, port })));

function body(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response, status, value) {
  const encoded = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded), "mcp-session-id": "fixed-fixture-session" });
  response.end(encoded);
}

function empty(response, status) {
  response.writeHead(status, { "content-length": 0, "mcp-session-id": "fixed-fixture-session" });
  response.end();
}
