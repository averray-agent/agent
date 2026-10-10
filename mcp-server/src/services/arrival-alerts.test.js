import assert from "node:assert/strict";
import test from "node:test";

import { SelfIdentityRegistry } from "../core/self-identity-registry.js";
import { ArrivalAlerts, ARRIVAL_ALERT_COOLDOWN_MS, ARRIVAL_ALERT_SEEN_CAP, CLIENT_FIRSTS_WALLET_CAP, CLIENT_NAME_FIRSTS_PER_WALLET_PER_DAY, NOT_REPORTED, SUPPRESSED_SUBJECT_CAP } from "./arrival-alerts.js";
import { ArrivalSessionTrail } from "./arrival-session-trail.js";
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
        return id === `wallet:${EXTERNAL}` ? { session: { id }, persisted: true } : undefined;
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
    sessionTrail: { async get(id) { return { session: { id }, persisted: true }; } }
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

test("one wallet's client names do not fill the queue", async () => {
  const alerts = new ArrivalAlerts({
    stateStore: memoryStore(),
    now: () => 12_000,
    flushIntervalMs: 60_000,
    cooldownMs: 60_000
  });
  for (let index = 0; index < 6_000; index += 1) {
    await alerts.note({
      wallet: EXTERNAL,
      clientInfo: { name: `flood-${index}`, version: "1" },
      stage: "browsed",
      success: true,
      authenticated: true
    });
  }
  const real = `0x${"e".repeat(40)}`;
  await alerts.note({ wallet: real, stage: "claimed", success: true, authenticated: true });
  const listed = await alerts.list();
  const rows = [...listed.ready, ...listed.pending];
  assert.equal(rows.filter((alert) => alert.kind === "external_client_first").length, CLIENT_NAME_FIRSTS_PER_WALLET_PER_DAY);
  assert.equal(listed.clientNameFirstEventsOverCap, 6_000 - CLIENT_NAME_FIRSTS_PER_WALLET_PER_DAY);
  await alerts.note({
    wallet: EXTERNAL,
    clientInfo: { name: "flood-3", version: "1" },
    stage: "browsed",
    success: true,
    authenticated: true
  });
  assert.equal((await alerts.list()).clientNameFirstEventsOverCap, 6_000 - CLIENT_NAME_FIRSTS_PER_WALLET_PER_DAY + 1);
  assert.equal(rows.some((alert) => alert.id === `external_wallet_first:${real}`), true);
  assert.equal(rows.some((alert) => alert.id === `external_wallet_first_claim:${real}`), true);
});

test("suppressed subjects are capped and the overflow is reported", async () => {
  let nowMs = 7_000;
  const alerts = new ArrivalAlerts({
    stateStore: memoryStore(),
    now: () => nowMs,
    flushIntervalMs: 60_000,
    cooldownMs: 60_000
  });
  for (let index = 0; index < 51 + SUPPRESSED_SUBJECT_CAP; index += 1) {
    await alerts.note({
      wallet: `0x${index.toString(16).padStart(40, "0")}`,
      stage: "browsed",
      success: true,
      authenticated: true
    });
  }
  const atCap = await alerts.list();
  assert.equal(atCap.suppressedSubjectOverflow, 0);
  await alerts.note({
    wallet: `0x${"ab".repeat(20)}`,
    stage: "browsed",
    success: true,
    authenticated: true
  });
  const overflow = await alerts.list();
  assert.equal(overflow.suppressedSubjectOverflow, 1);
  assert.equal(overflow.suppressed, SUPPRESSED_SUBJECT_CAP + 1);
});

test("a trail that is unreadable, throws, or unpersisted is not linked", async () => {
  const noteWallet = async (sessionTrail) => {
    const alerts = new ArrivalAlerts({
      stateStore: memoryStore(),
      sessionTrail,
      now: () => 4_000,
      flushIntervalMs: 60_000,
      cooldownMs: 0
    });
    await alerts.note({ wallet: EXTERNAL, stage: "browsed", success: true, authenticated: true });
    const listed = await alerts.list();
    const row = [...listed.ready, ...listed.pending].find((alert) => alert.kind === "external_wallet_first");
    return row;
  };
  const unread = await noteWallet({
    async get() { return { unavailable: "arrival session trail could not be read" }; }
  });
  assert.ok(unread);
  assert.equal(unread.trail, NOT_REPORTED);
  assert.equal(unread.href, null);
  assert.match(unread.trailNote, /could not be read/u);

  const thrown = await noteWallet({
    async get() { throw new Error("trail down"); }
  });
  assert.ok(thrown);
  assert.equal(thrown.trail, NOT_REPORTED);
  assert.match(thrown.trailNote, /could not be read/u);

  const trail = new ArrivalSessionTrail({
    stateStore: {
      async getServiceState() { return undefined; },
      async upsertServiceState() { throw new Error("redis down"); },
      async deleteServiceState() {}
    },
    now: () => 4_000,
    flushIntervalMs: 0
  });
  await trail.observe({
    wallet: EXTERNAL,
    door: "http",
    name: "GET /auth/session",
    resultClass: "ok",
    stage: "reached"
  });
  assert.equal((await trail.get(`wallet:${EXTERNAL}`)).persisted, false);
  const unpersisted = await noteWallet(trail);
  assert.equal(unpersisted.trail, NOT_REPORTED);
  assert.equal(unpersisted.href, null);
  assert.match(unpersisted.trailNote, /unpersisted/u);
});

test("a queued milestone is flushed immediately", async () => {
  const writes = [];
  const alerts = new ArrivalAlerts({
    stateStore: {
      async getServiceState() { return undefined; },
      async upsertServiceState(_scope, value) {
        writes.push(value);
        return value;
      }
    },
    sessionTrail: {
      async get(id) { return { session: { id }, persisted: true }; }
    },
    now: () => 1_000,
    flushIntervalMs: 60_000,
    cooldownMs: 60_000
  });
  await alerts.note({ wallet: EXTERNAL, stage: "browsed", success: true, authenticated: true });
  assert.equal(writes.length, 1);
  const flushed = [...writes[0].pending, ...writes[0].ready];
  assert.equal(flushed.some((alert) => alert.id === `external_wallet_first:${EXTERNAL}`), true);
});

test("the alerts route reports firsts that are no longer tracked", async () => {
  const alerts = new ArrivalAlerts({
    stateStore: memoryStore(),
    now: () => 6_000,
    flushIntervalMs: 60_000,
    cooldownMs: 0
  });
  for (let index = 0; index < ARRIVAL_ALERT_SEEN_CAP + 1; index += 1) {
    await alerts.note({
      wallet: `0x${index.toString(16).padStart(40, "0")}`,
      stage: "browsed",
      success: true,
      authenticated: true
    });
  }
  const response = {};
  const route = createAdminArrivalAlertRoutes({
    authMiddleware: async () => ({ wallet: "0xabc" }),
    respond: (_response, status, body) => { response.statusCode = status; response.body = body; },
    arrivalAlerts: alerts
  });
  assert.equal(await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/arrivals/alerts"),
    pathname: "/admin/arrivals/alerts"
  }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.firstsNoLongerTracked, 1);
});

test("repeat visits do not rewrite a trail that has no new first", async () => {
  const recordWrites = [];
  const state = new Map();
  const stateStore = {
    async getServiceState(scope) { return state.get(scope); },
    async upsertServiceState(scope, value) {
      if (String(scope).startsWith("arrival-session-record:")) recordWrites.push(scope);
      state.set(scope, value);
      return value;
    },
    async deleteServiceState() {}
  };
  const nowMs = 100_000;
  const sessionTrail = new ArrivalSessionTrail({ stateStore, now: () => nowMs });
  const alerts = new ArrivalAlerts({
    stateStore,
    sessionTrail,
    now: () => nowMs,
    cooldownMs: 60_000
  });
  const visit = async (wallet, name) => {
    await sessionTrail.observe({
      wallet,
      clientInfo: { name, version: "1" },
      door: "http",
      name: "GET /auth/session",
      resultClass: "ok",
      stage: "reached"
    });
    await alerts.note({
      wallet,
      clientInfo: { name, version: "1" },
      stage: "reached",
      success: true,
      authenticated: true
    });
  };
  await visit(EXTERNAL, "prime");
  const afterFirst = recordWrites.length;
  for (let index = 0; index < 100; index += 1) await visit(EXTERNAL, "prime");
  assert.ok(recordWrites.length - afterFirst <= 1);
  const other = `0x${"e".repeat(40)}`;
  await visit(other, "other-client");
  const listed = await alerts.list();
  const alert = [...listed.ready, ...listed.pending].find((row) => row.id === `external_wallet_first:${other}`);
  assert.equal(alert.trail, "linked");
});

test("five thousand over-cap names stay bounded and do not force a flush each time", async () => {
  const writes = [];
  const store = {
    async getServiceState() { return undefined; },
    async upsertServiceState(_scope, value) {
      writes.push(value);
      return value;
    }
  };
  const alerts = new ArrivalAlerts({
    stateStore: store,
    now: () => 12_000,
    flushIntervalMs: 60_000,
    cooldownMs: 60_000
  });
  for (let index = 0; index < 5_000; index += 1) {
    await alerts.note({
      wallet: EXTERNAL,
      clientInfo: { name: `wide-${index}`, version: "1" },
      stage: "browsed",
      success: true,
      authenticated: true
    });
  }
  const bucket = alerts.clientFirsts.get(EXTERNAL);
  assert.equal(bucket.names.size, CLIENT_NAME_FIRSTS_PER_WALLET_PER_DAY);
  assert.equal(bucket.overflow, undefined);
  assert.equal(alerts.clientNameFirstEventsOverCap, 5_000 - CLIENT_NAME_FIRSTS_PER_WALLET_PER_DAY);
  assert.ok(writes.length < 30, String(writes.length));
  const blob = JSON.stringify(writes.at(-1)?.clientFirsts ?? bucket);
  assert.ok(blob.length < 2_000, String(blob.length));
  await alerts.note({
    wallet: EXTERNAL,
    clientInfo: { name: "wide-3", version: "1" },
    stage: "browsed",
    success: true,
    authenticated: true
  });
  assert.equal(alerts.clientNameFirstEventsOverCap, 5_000 - CLIENT_NAME_FIRSTS_PER_WALLET_PER_DAY + 1);
});

test("load prunes stale days and caps wallets before any later write", async () => {
  const day = 24 * 60 * 60 * 1_000;
  const today = 5;
  const nowMs = today * day + 1_000;
  const walletAt = (prefix, index) => `0x${index.toString(16).padStart(40, prefix)}`;
  const staleStore = memoryStore();
  await staleStore.upsertServiceState("arrival-alerts", {
    clientFirsts: [
      ...[1, 2, 3].map((index) => ({
        wallet: walletAt("a", index),
        day: 1,
        names: ["old@1"]
      })),
      ...[1, 2, 3, 4].map((index) => ({
        wallet: walletAt("b", index),
        day: today,
        names: ["now@1"]
      }))
    ]
  });
  const stale = new ArrivalAlerts({ stateStore: staleStore, now: () => nowMs, flushIntervalMs: 60_000 });
  await stale.list();
  assert.equal([...stale.clientFirsts.values()].every((bucket) => bucket.day === today), true);
  assert.equal(stale.clientFirsts.size, 4);

  const crowdedStore = memoryStore();
  await crowdedStore.upsertServiceState("arrival-alerts", {
    clientFirsts: Array.from({ length: CLIENT_FIRSTS_WALLET_CAP + 25 }, (_, index) => ({
      wallet: walletAt("0", index + 1),
      day: today,
      names: ["now@1"]
    }))
  });
  const crowded = new ArrivalAlerts({ stateStore: crowdedStore, now: () => nowMs, flushIntervalMs: 60_000 });
  await crowded.list();
  assert.equal(crowded.clientFirsts.size <= CLIENT_FIRSTS_WALLET_CAP, true);
  assert.ok(crowded.clientFirstsEvicted >= 25);
});

test("client-name cap state is pruned, bounded, and still applies after restart", async () => {
  const day = 24 * 60 * 60 * 1_000;
  let nowMs = 2 * day;
  const store = memoryStore();
  await store.upsertServiceState("arrival-alerts", {
    clientFirsts: [1, 2, 3].map((index) => ({
      wallet: `0x${index.toString(16).padStart(40, "c")}`,
      day: 0,
      names: ["old@1"]
    }))
  });
  const alerts = new ArrivalAlerts({ stateStore: store, now: () => nowMs, flushIntervalMs: 0, cooldownMs: 60_000 });
  await alerts.note({
    wallet: EXTERNAL,
    clientInfo: { name: "today", version: "1" },
    stage: "browsed",
    success: true,
    authenticated: true
  });
  const saved = await store.getServiceState("arrival-alerts");
  assert.equal(saved.clientFirsts.every((entry) => entry.day === Math.floor(nowMs / day)), true);
  assert.equal(saved.clientFirsts.length, 1);

  const bounded = new ArrivalAlerts({
    stateStore: memoryStore(),
    now: () => nowMs,
    flushIntervalMs: 60_000,
    cooldownMs: 60_000
  });
  for (let index = 0; index < CLIENT_FIRSTS_WALLET_CAP + 1; index += 1) {
    await bounded.note({
      wallet: `0x${index.toString(16).padStart(40, "0")}`,
      clientInfo: { name: "only", version: "1" },
      stage: "browsed",
      success: true,
      authenticated: true
    });
  }
  const capped = await bounded.list();
  assert.equal(capped.clientFirstsEvicted >= 1, true);

  const durable = memoryStore();
  const first = new ArrivalAlerts({ stateStore: durable, now: () => nowMs, flushIntervalMs: 0, cooldownMs: 60_000 });
  for (const name of ["a", "b", "c", "d"]) {
    await first.note({
      wallet: EXTERNAL,
      clientInfo: { name, version: "1" },
      stage: "browsed",
      success: true,
      authenticated: true
    });
  }
  assert.equal((await first.list()).clientNameFirstEventsOverCap, 1);
  const restarted = new ArrivalAlerts({ stateStore: durable, now: () => nowMs, flushIntervalMs: 0, cooldownMs: 60_000 });
  await restarted.note({
    wallet: EXTERNAL,
    clientInfo: { name: "d", version: "1" },
    stage: "browsed",
    success: true,
    authenticated: true
  });
  await restarted.note({
    wallet: EXTERNAL,
    clientInfo: { name: "e", version: "1" },
    stage: "browsed",
    success: true,
    authenticated: true
  });
  const after = await restarted.list();
  assert.equal(after.clientNameFirstEventsOverCap, 3);
  const names = [...after.ready, ...after.pending]
    .filter((alert) => alert.kind === "external_client_first")
    .map((alert) => alert.subject);
  assert.equal(names.includes("d@1"), false);
  assert.equal(names.includes("e@1"), false);
});

test("a loaded suppressed-subject list is trimmed to the cap", async () => {
  const store = memoryStore();
  await store.upsertServiceState("arrival-alerts", {
    suppressedSubjects: Array.from({ length: SUPPRESSED_SUBJECT_CAP + 100 }, (_, index) => (
      `external_wallet_first:0x${index.toString(16).padStart(40, "0")}`
    )),
    suppressedSubjectOverflow: 0,
    suppressed: SUPPRESSED_SUBJECT_CAP + 100
  });
  const alerts = new ArrivalAlerts({ stateStore: store, now: () => 9_000, flushIntervalMs: 0 });
  await alerts.note({
    wallet: `0x${"f".repeat(40)}`,
    stage: "browsed",
    success: true,
    authenticated: true
  });
  const saved = await store.getServiceState("arrival-alerts");
  assert.equal(saved.suppressedSubjects.length <= SUPPRESSED_SUBJECT_CAP, true);
  assert.ok(saved.suppressedSubjectOverflow >= 100);
});

test("repeats of a suppressed subject do not rewrite the alerts blob", async () => {
  const writes = [];
  const alerts = new ArrivalAlerts({
    stateStore: {
      async getServiceState() { return undefined; },
      async upsertServiceState(_scope, value) {
        writes.push(value);
        return value;
      }
    },
    now: () => 8_000,
    flushIntervalMs: 60_000,
    cooldownMs: 60_000
  });
  for (let index = 0; index < 60; index += 1) {
    await alerts.note({
      wallet: `0x${index.toString(16).padStart(40, "0")}`,
      stage: "browsed",
      success: true,
      authenticated: true
    });
  }
  const suppressed = `0x${"5".repeat(40)}`;
  await alerts.note({
    wallet: suppressed,
    stage: "browsed",
    success: true,
    authenticated: true
  });
  const afterSuppressed = writes.length;
  for (let index = 0; index < 100; index += 1) {
    await alerts.note({
      wallet: suppressed,
      stage: "browsed",
      success: true,
      authenticated: true
    });
  }
  assert.equal(writes.length, afterSuppressed);
});

test("a suppressed first does not persist the trail", async () => {
  const recordWrites = [];
  const state = new Map();
  const stateStore = {
    async getServiceState(scope) { return state.get(scope); },
    async upsertServiceState(scope, value) {
      if (String(scope).startsWith("arrival-session-record:")) recordWrites.push(scope);
      state.set(scope, value);
      return value;
    },
    async deleteServiceState() {}
  };
  const nowMs = 1_000;
  const sessionTrail = new ArrivalSessionTrail({ stateStore, now: () => nowMs });
  const alerts = new ArrivalAlerts({
    stateStore,
    sessionTrail,
    now: () => nowMs,
    cooldownMs: 60_000
  });
  for (let index = 0; index < 60; index += 1) {
    await alerts.note({
      wallet: `0x${(index + 1).toString(16).padStart(40, "d")}`,
      stage: "browsed",
      success: true,
      authenticated: true
    });
  }
  const held = `0x${"e".repeat(40)}`;
  await sessionTrail.observe({
    wallet: held,
    door: "http",
    name: "GET /auth/session",
    resultClass: "ok",
    stage: "reached"
  });
  await alerts.note({ wallet: held, stage: "reached", success: true, authenticated: true });
  assert.equal(recordWrites.some((scope) => scope.endsWith(held)), false);
  const listed = await alerts.list();
  assert.equal(
    [...listed.ready, ...listed.pending].some((alert) => alert.id === `external_wallet_first:${held}`),
    false
  );
});

test("counter-only changes flush after the interval and survive restart", async () => {
  let nowMs = 50_000;
  const store = memoryStore();
  const alerts = new ArrivalAlerts({
    stateStore: store,
    now: () => nowMs,
    flushIntervalMs: 30_000,
    cooldownMs: 60_000
  });
  for (const name of ["a", "b", "c", "d"]) {
    await alerts.note({
      wallet: EXTERNAL,
      clientInfo: { name, version: "1" },
      stage: "browsed",
      success: true,
      authenticated: true
    });
  }
  assert.equal(alerts.clientNameFirstEventsOverCap, 1);
  nowMs += 31_000;
  await alerts.list();
  const restarted = new ArrivalAlerts({ stateStore: store, now: () => nowMs, flushIntervalMs: 30_000 });
  await restarted.list();
  assert.equal(restarted.clientNameFirstEventsOverCap, 1);
});
