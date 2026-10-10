import assert from "node:assert/strict";
import test from "node:test";

import { SelfIdentityRegistry } from "../core/self-identity-registry.js";
import { ArrivalAlerts, ARRIVAL_ALERT_COOLDOWN_MS, ARRIVAL_ALERT_SEEN_CAP, NOT_REPORTED } from "./arrival-alerts.js";
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

test("successful authenticated visits alert once, and a shared client name is not an external client", async () => {
  let nowMs = 10_000;
  const registry = new SelfIdentityRegistry({ qaEngineerWallets: [QA] });
  const store = memoryStore();
  const alerts = new ArrivalAlerts({
    stateStore: store,
    identityRegistry: registry,
    now: () => nowMs,
    flushIntervalMs: 0,
    cooldownMs: 1_000,
    sessionTrail: {
      async get(id) {
        return id === `wallet:${EXTERNAL}` ? { session: { id } } : undefined;
      }
    }
  });
  const observatory = new ArrivalObservatory({
    stateStore: memoryStore(),
    now: () => nowMs,
    flushIntervalMs: 0,
    alerts,
    identityRegistry: registry
  });

  await observatory.recordTool({
    tool: "listJobs",
    clientInfo: { name: "junk-scanner", version: "9" }
  });
  await observatory.recordHttp({
    method: "POST",
    pathname: "/auth/nonce",
    wallet: EXTERNAL,
    outcome: { ok: true }
  });
  await observatory.recordHttp({
    method: "POST",
    pathname: "/jobs/claim",
    wallet: EXTERNAL,
    outcome: { kind: "http", status: 409, code: "conflict" }
  });
  await observatory.recordHttp({
    method: "POST",
    pathname: "/jobs/claim",
    wallet: EXTERNAL,
    clientInfo: { name: "Anthropic/ClaudeAI", version: "1" },
    outcome: { ok: true }
  });
  await observatory.recordHttp({
    method: "POST",
    pathname: "/jobs/submit",
    wallet: EXTERNAL,
    clientInfo: { name: "averray-roadmap", version: "1" },
    outcome: { ok: true }
  });
  await observatory.recordHttp({
    method: "POST",
    pathname: "/jobs/claim",
    wallet: QA,
    clientInfo: { name: "outsider-tool", version: "0.1" },
    outcome: { ok: true }
  });

  const listed = await alerts.list();
  const ids = [...listed.ready, ...listed.pending].map((alert) => alert.id);
  assert.equal(ids.some((id) => id.includes("junk-scanner")), false);
  assert.equal(ids.some((id) => id.includes("claude")), false);
  assert.equal(ids.some((id) => id.includes("averray-roadmap")), false);
  assert.equal(ids.some((id) => id.includes(QA)), false);
  assert.equal(ids.filter((id) => id === `external_wallet_first:${EXTERNAL}`).length, 1);
  assert.equal(ids.filter((id) => id === `external_wallet_first_claim:${EXTERNAL}`).length, 1);
  assert.equal(ids.filter((id) => id === `external_wallet_first_submit:${EXTERNAL}`).length, 1);
  const claim = [...listed.ready, ...listed.pending].find((alert) => alert.kind === "external_wallet_first_claim");
  assert.equal(claim.href, `/admin/arrivals/sessions?id=${encodeURIComponent(`wallet:${EXTERNAL}`)}`);
  assert.equal(claim.trail, "linked");

  const restarted = new ArrivalAlerts({
    stateStore: store,
    identityRegistry: registry,
    now: () => nowMs,
    flushIntervalMs: 0,
    cooldownMs: 1_000
  });
  await restarted.note({
    wallet: EXTERNAL,
    stage: "claimed",
    success: true,
    authenticated: true
  });
  const again = await restarted.list();
  const againIds = [...again.ready, ...again.pending].map((alert) => alert.id);
  assert.equal(againIds.filter((id) => id === `external_wallet_first:${EXTERNAL}`).length, 1);
  assert.equal(againIds.filter((id) => id === `external_wallet_first_claim:${EXTERNAL}`).length, 1);

  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.alerts, undefined);
});

test("a full pending queue does not consume the dedup set, and anonymous names do not either", async () => {
  let nowMs = 5_000;
  const alerts = new ArrivalAlerts({
    stateStore: memoryStore(),
    now: () => nowMs,
    flushIntervalMs: 0,
    cooldownMs: 60_000
  });
  for (let index = 0; index < 60; index += 1) {
    await alerts.note({
      clientInfo: { name: `anon-${index}`, version: "1" },
      stage: "browsed",
      success: true,
      authenticated: false
    });
  }
  let quiet = await alerts.list();
  assert.equal(quiet.ready.length + quiet.pending.length, 0);

  for (let index = 0; index < 52; index += 1) {
    const wallet = `0x${(index + 1).toString(16).padStart(40, "b")}`;
    await alerts.note({ wallet, stage: "browsed", success: true, authenticated: true });
  }
  const held = `0x${"c".repeat(40)}`;
  await alerts.note({ wallet: held, stage: "browsed", success: true, authenticated: true });
  const full = await alerts.list();
  const fullIds = [...full.ready, ...full.pending].map((alert) => alert.id);
  assert.equal(fullIds.includes(`external_wallet_first:${held}`), false);
  const summary = [...full.ready, ...full.pending].find((alert) => alert.kind === "suppressed_firsts");
  assert.ok(summary.suppressedCount >= 1);
  assert.match(summary.id, new RegExp(`^suppressed_firsts:\\d+:${summary.suppressedCount}$`, "u"));
  assert.equal(summary.trail, NOT_REPORTED);
  assert.equal(summary.href, null);
  assert.match(summary.trailNote, /not linked/u);

  nowMs = 5_000 + 60_000;
  await alerts.list();
  await alerts.note({ wallet: held, stage: "browsed", success: true, authenticated: true });
  const retried = await alerts.list();
  const retriedIds = [...retried.ready, ...retried.pending].map((alert) => alert.id);
  assert.equal(retriedIds.includes(`external_wallet_first:${held}`), true);
});

test("a client with no wallet is not an external-client alert, and a failed read is not zero", async () => {
  const alerts = new ArrivalAlerts({ stateStore: memoryStore(), now: () => 5_000, flushIntervalMs: 0, cooldownMs: ARRIVAL_ALERT_COOLDOWN_MS });
  await alerts.note({
    clientInfo: { name: "wanderer", version: "2" },
    stage: "reached",
    success: true,
    authenticated: false
  });
  const listed = await alerts.list();
  assert.equal(listed.ready.length, 0);
  assert.equal(listed.pending.length, 0);

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

test("a nonce or a 409 claim alone raises nothing", async () => {
  const registry = new SelfIdentityRegistry();
  const alerts = new ArrivalAlerts({
    stateStore: memoryStore(),
    identityRegistry: registry,
    now: () => 8_000,
    flushIntervalMs: 0,
    cooldownMs: 0
  });
  const observatory = new ArrivalObservatory({
    stateStore: memoryStore(),
    now: () => 8_000,
    flushIntervalMs: 0,
    alerts,
    identityRegistry: registry
  });
  await observatory.recordHttp({
    method: "POST",
    pathname: "/auth/nonce",
    wallet: EXTERNAL,
    clientInfo: { name: "wanderer", version: "1" },
    outcome: { ok: true }
  });
  await observatory.recordHttp({
    method: "POST",
    pathname: "/jobs/claim",
    wallet: EXTERNAL,
    outcome: { kind: "http", status: 409, code: "conflict" }
  });
  const listed = await alerts.list();
  assert.equal(listed.ready.length + listed.pending.length, 0);
});

test("sixty nonce and anonymous reads do not consume firsts, and a later claim is queued", async () => {
  const registry = new SelfIdentityRegistry();
  const alerts = new ArrivalAlerts({
    stateStore: memoryStore(),
    identityRegistry: registry,
    now: () => 9_000,
    flushIntervalMs: 0,
    cooldownMs: 0,
    sessionTrail: { async get(id) { return { session: { id } }; } }
  });
  const observatory = new ArrivalObservatory({
    stateStore: memoryStore(),
    now: () => 9_000,
    flushIntervalMs: 0,
    alerts,
    identityRegistry: registry
  });
  for (let index = 0; index < 60; index += 1) {
    const wallet = `0x${(index + 1).toString(16).padStart(40, "d")}`;
    const clientInfo = { name: `probe-${index}`, version: "1" };
    await observatory.recordHttp({
      method: "POST",
      pathname: "/auth/nonce",
      wallet,
      clientInfo,
      outcome: { ok: true }
    });
    await observatory.recordHttp({
      method: "GET",
      pathname: "/openapi.json",
      clientInfo,
      outcome: { ok: true }
    });
  }
  const real = `0x${"e".repeat(40)}`;
  await observatory.recordHttp({
    method: "POST",
    pathname: "/jobs/claim",
    wallet: real,
    outcome: { ok: true }
  });
  const ids = (await alerts.list()).ready.concat((await alerts.list()).pending).map((alert) => alert.id);
  const listed = await alerts.list();
  const all = [...listed.ready, ...listed.pending].map((alert) => alert.id);
  assert.equal(all.some((id) => id.startsWith("external_client_first:")), false);
  assert.equal(all.some((id) => id.startsWith("external_wallet_first:0xd")), false);
  assert.equal(all.includes(`external_wallet_first:${real}`), true);
  assert.equal(all.includes(`external_wallet_first_claim:${real}`), true);
  assert.equal(ids.includes(`external_wallet_first:${real}`), true);
});

test("a missing session record is not linked, and repeated suppressed subjects share one changing id", async () => {
  let nowMs = 4_000;
  const alerts = new ArrivalAlerts({
    stateStore: memoryStore(),
    now: () => nowMs,
    flushIntervalMs: 0,
    cooldownMs: 60_000,
    sessionTrail: { async get() { return undefined; } }
  });
  await alerts.note({
    wallet: EXTERNAL,
    stage: "browsed",
    success: true,
    authenticated: true
  });
  const open = await alerts.list();
  const first = [...open.ready, ...open.pending].find((alert) => alert.kind === "external_wallet_first");
  assert.equal(first.trail, NOT_REPORTED);
  assert.equal(first.href, null);
  assert.match(first.trailNote, /no session record/u);

  const capped = new ArrivalAlerts({
    stateStore: memoryStore(),
    now: () => nowMs,
    flushIntervalMs: 0,
    cooldownMs: 60_000
  });
  for (let index = 0; index < 51; index += 1) {
    await capped.note({
      wallet: `0x${(index + 1).toString(16).padStart(40, "a")}`,
      stage: "browsed",
      success: true,
      authenticated: true
    });
  }
  const repeated = `0x${"f".repeat(40)}`;
  await capped.note({ wallet: repeated, stage: "browsed", success: true, authenticated: true });
  await capped.note({ wallet: repeated, stage: "browsed", success: true, authenticated: true });
  const once = await capped.list();
  const summary = [...once.ready, ...once.pending].filter((alert) => alert.kind === "suppressed_firsts");
  assert.equal(summary.length, 1);
  assert.equal(summary[0].suppressedCount, 1);
  const second = `0x${"e".repeat(40)}`;
  await capped.note({ wallet: second, stage: "browsed", success: true, authenticated: true });
  const twice = await capped.list();
  const next = [...twice.ready, ...twice.pending].filter((alert) => alert.kind === "suppressed_firsts");
  assert.equal(next.length, 1);
  assert.equal(next[0].suppressedCount, 2);
  assert.notEqual(next[0].id, summary[0].id);
  assert.match(next[0].id, /suppressed_firsts:\d+:2$/u);
});

test("a full seen set reports how many firsts are no longer tracked", async () => {
  const alerts = new ArrivalAlerts({
    stateStore: memoryStore(),
    now: () => 6_000,
    flushIntervalMs: 60_000,
    cooldownMs: 0
  });
  for (let index = 0; index < ARRIVAL_ALERT_SEEN_CAP; index += 1) {
    await alerts.note({
      wallet: `0x${index.toString(16).padStart(40, "0")}`,
      stage: "browsed",
      success: true,
      authenticated: true
    });
  }
  const atCap = await alerts.list();
  assert.equal(atCap.firstsNoLongerTracked, 0);
  const extra = `0x${"f".repeat(40)}`;
  await alerts.note({ wallet: extra, stage: "browsed", success: true, authenticated: true });
  await alerts.note({ wallet: extra, stage: "browsed", success: true, authenticated: true });
  const listed = await alerts.list();
  assert.equal(listed.firstsNoLongerTracked, 1);
  assert.equal([...listed.ready, ...listed.pending].some((alert) => alert.subject === extra), false);
});
