import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";

import { McpEgressGrantService } from "./mcp-egress-grant-service.js";
import { McpEgressGrantVerifierServer } from "./mcp-egress-grant-verifier-server.js";

const authConfig = {
  jwtBackend: "hmac",
  signingSecret: "mcp-egress-test-secret-that-is-long-enough-1234",
  secrets: ["mcp-egress-test-secret-that-is-long-enough-1234"]
};

test("signed egress grants are short lived and bind exact run, profile, and declared authority", async () => {
  const service = new McpEgressGrantService({ authConfig });
  const grant = await service.mint({
    runId: "verify-grant-one",
    profileRef: "mcp-failure-semantics-v1@1",
    endpoint: "https://MCP.example.test/path",
    timeoutMs: 30_000
  });
  assert.equal(grant.authority, "mcp.example.test:443");
  assert.deepEqual(await service.verify({
    token: grant.token,
    authority: "mcp.example.test:443",
    runId: "verify-grant-one"
  }), {
    allowed: true,
    authority: "mcp.example.test:443",
    runId: "verify-grant-one",
    profileRef: "mcp-failure-semantics-v1@1"
  });
  await assert.rejects(() => service.verifyBoundary({ token: grant.token, authority: "second.example.test:443" }), /authority binding is invalid/u);
  await assert.rejects(() => service.verify({ token: grant.token, authority: grant.authority, runId: "verify-grant-two" }), /runId binding is invalid/u);
});

test("grant validation is exposed only over its private Unix socket", async (t) => {
  const service = new McpEgressGrantService({ authConfig });
  const grant = await service.mint({
    runId: "verify-socket-one",
    profileRef: "mcp-failure-semantics-v1@1",
    endpoint: "https://socket.example.test/mcp",
    timeoutMs: 30_000
  });
  const socketPath = join("/tmp", `amg-${randomUUID()}.sock`);
  const server = new McpEgressGrantVerifierServer({ grantService: service, logger: { info() {}, warn() {} } });
  try {
    await server.listen({ socketPath });
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("local sandbox forbids Unix-domain listeners; Linux CI exercises the socket");
      return;
    }
    throw error;
  }
  try {
    assert.deepEqual(await verifyOverSocket(socketPath, { token: grant.token, authority: grant.authority }), {
      status: 200,
      body: { allowed: true, authority: grant.authority, runId: "verify-socket-one", profileRef: "mcp-failure-semantics-v1@1" }
    });
    assert.equal((await verifyOverSocket(socketPath, { token: grant.token, authority: "second.example.test:443" })).status, 403);
    assert.equal(server.server.address(), socketPath);
  } finally {
    await server.close();
  }
});

function verifyOverSocket(socketPath, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: "/verify",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
