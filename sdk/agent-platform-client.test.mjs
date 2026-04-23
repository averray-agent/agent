import assert from "node:assert/strict";
import test from "node:test";

import { AgentPlatformClient } from "./agent-platform-client.js";

test("builder read helpers call the expected public endpoints", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test/",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    }
  });

  await client.getDiscoveryManifest();
  await client.getSessionStateMachine();
  await client.listJobSchemas();
  await client.getJobSchema("review-input.json");
  await client.getAgentProfile("0x1234567890123456789012345678901234567890");
  await client.getAgentBadge("session/with space");

  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.example.test/agent-tools.json",
    "https://api.example.test/session/state-machine",
    "https://api.example.test/schemas/jobs",
    "https://api.example.test/schemas/jobs/review-input.json",
    "https://api.example.test/agents/0x1234567890123456789012345678901234567890",
    "https://api.example.test/badges/session%2Fwith%20space"
  ]);
});

test("authenticated helpers send bearer token and compact JSON bodies", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    token: "test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    }
  });

  await client.allocateIdleFunds({
    amount: 5,
    strategyId: "polkadot-vdot",
    idempotencyKey: "alloc-1",
    destination: undefined
  });
  await client.sendToAgent({
    recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    amount: "1.5"
  });

  assert.equal(calls[0].url, "https://api.example.test/account/allocate");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.get("authorization"), "Bearer test-token");
  assert.equal(calls[0].options.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    asset: "DOT",
    amount: 5,
    strategyId: "polkadot-vdot",
    idempotencyKey: "alloc-1"
  });

  assert.equal(calls[1].url, "https://api.example.test/payments/send");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    asset: "DOT",
    amount: "1.5"
  });
});

test("listSessions builds optional query string without empty params", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    }
  });

  await client.listSessions();
  await client.listSessions({ limit: 10, jobId: "starter job" });

  assert.equal(calls[0].url, "https://api.example.test/sessions");
  assert.equal(calls[1].url, "https://api.example.test/sessions?limit=10&jobId=starter+job");
});

test("request throws server-provided error messages", async () => {
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    fetchImpl: async () => jsonResponse({ message: "nope" }, { status: 400 })
  });

  await assert.rejects(() => client.getHealth(), /nope/u);
});

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}
