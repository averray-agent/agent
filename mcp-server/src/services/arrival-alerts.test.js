import assert from "node:assert/strict";
import test from "node:test";

import { SelfIdentityRegistry } from "../core/self-identity-registry.js";
import { ArrivalAlerts, ARRIVAL_ALERT_COOLDOWN_MS, NOT_REPORTED } from "./arrival-alerts.js";
import { ArrivalObservatory } from "./arrival-observatory.js";
import { createAdminArrivalAlertRoutes } from "../protocols/http/admin-arrival-alert-routes.js";

const EXTERNAL = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const QA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function memoryStore() {
  const state = new Map();
  return {
    async getServiceState(scope) { return state.get(scope); },
    async upsertServiceState(scope, value) {
      state.set(scope, { ...(state.get(scope) ?? {}), ...value });
      return state.get(scope);
    }
  };
}

test("first external client, wallet, claim, and submit alert once and link to the session trail", async () => {
  let nowMs = 10_000;
  const alerts = new ArrivalAlerts({ stateStore: memoryStore(), now: () => nowMs, flushIntervalMs: 0, cooldownMs: 1_000 });
  const observatory = new ArrivalObservatory({
    stateStore: memoryStore(),
    now: () => nowMs,
    flushIntervalMs: 0,
    alerts,
    identityRegistry: new SelfIdentityRegistry({ qaEngineerWallets: [QA] })
  });

  await observatory.recordTool({
    tool: "listJobs",
    clientInfo: { name: "Outsider", version: "0.1" },
    mcpSessionId: "legacy-session-1"
  });
  await observatory.recordTool({
    tool: "listJobs",
    clientInfo: { name: "Outsider", version: "0.1" },
    mcpSessionId: "legacy-session-1"
  });
  await observatory.recordHttp({ method: "POST", pathname: "/jobs/claim", wallet: EXTERNAL });
  await observatory.recordHttp({ method: "POST", pathname: "/jobs/claim", wallet: EXTERNAL });
  await observatory.recordHttp({ method: "POST", pathname: "/jobs/submit", wallet: EXTERNAL });
  await observatory.recordHttp({ method: "POST", pathname: "/jobs/claim", wallet: QA });
  await observatory.recordTool({
    tool: "listJobs",
    clientInfo: { name: "Anthropic/ClaudeAI", version: "1" }
  });

  const listed = await alerts.list();
  const ids = [...listed.ready, ...listed.pending].map((alert) => alert.id);
  assert.deepEqual(ids.filter((id) => id.startsWith("external_client_first:outsider@")), ["external_client_first:outsider@0.1"]);
  assert.equal(ids.filter((id) => id === "external_wallet_first_claim:" + EXTERNAL).length, 1);
  assert.equal(ids.filter((id) => id === "external_wallet_first_submit:" + EXTERNAL).length, 1);
  assert.equal(ids.some((id) => id.includes("claude")), false);
  assert.equal(ids.some((id) => id.includes(QA)), false);
  const client = [...listed.ready, ...listed.pending].find((alert) => alert.kind === "external_client_first");
  assert.equal(client.trail, "linked");
  assert.equal(client.href, "/admin/arrivals/sessions?id=mcp%3Alegacy-session-1");
  const claim = [...listed.ready, ...listed.pending].find((alert) => alert.kind === "external_wallet_first_claim");
  assert.equal(claim.href, `/admin/arrivals/sessions?id=${encodeURIComponent("wallet:" + EXTERNAL)}`);
  assert.equal(listed.ready.length, 1);
  assert.ok(listed.pending.length >= 1);

  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.alerts, undefined);
  assert.equal(JSON.stringify(snapshot).includes("external_client_first"), false);
});

test("a client with no session is linked as not reported, and a failed read is not zero", async () => {
  const alerts = new ArrivalAlerts({ stateStore: memoryStore(), now: () => 5_000, flushIntervalMs: 0, cooldownMs: ARRIVAL_ALERT_COOLDOWN_MS });
  await alerts.note({
    actor: "client",
    clientInfo: { name: "wanderer", version: "2" },
    stage: "reached"
  });
  const listed = await alerts.list();
  assert.equal(listed.ready[0].trail, NOT_REPORTED);
  assert.equal(listed.ready[0].href, null);

  const failing = new ArrivalAlerts({
    stateStore: {
      async getServiceState() { throw new Error("redis down"); },
      async upsertServiceState() { throw new Error("redis down"); }
    },
    now: () => 1
  });
  const unread = await failing.list();
  assert.equal(unread.ready, null);
  assert.equal(unread.pending, null);
  assert.equal(unread.saturated, NOT_REPORTED);
});

test("alert reads require admin:status and are not on the public arrivals or transparency routes", async () => {
  const calls = [];
  const route = createAdminArrivalAlertRoutes({
    authMiddleware: async (_request, _url, options) => { calls.push(options); return { wallet: "0xabc" }; },
    respond: (response, status, body) => { response.statusCode = status; response.body = body; },
    arrivalAlerts: { async list() { return { schemaVersion: "averray.arrival-alerts.v1", ready: [], pending: [] }; } }
  });
  const response = {};
  assert.equal(await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/arrivals/alerts"),
    pathname: "/admin/arrivals/alerts"
  }), true);
  assert.deepEqual(calls[0].requireCapabilities, ["admin:status", "ops:view"]);
  assert.equal(await route({
    request: { method: "GET" },
    response: {},
    url: new URL("http://localhost/monitor/arrivals"),
    pathname: "/monitor/arrivals"
  }), false);
  assert.equal(await route({
    request: { method: "GET" },
    response: {},
    url: new URL("http://localhost/transparency"),
    pathname: "/transparency"
  }), false);
  assert.equal(response.body.ready.length, 0);
});
