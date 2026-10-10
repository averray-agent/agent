import assert from "node:assert/strict";
import test from "node:test";

import { ArrivalObservatory } from "./arrival-observatory.js";
import {
  ArrivalSessionTrail,
  NOT_REPORTED,
  SESSION_RECORD_CAP,
  SESSION_STEP_CAP,
  resultClassFromOutcome
} from "./arrival-session-trail.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DAY = 24 * 60 * 60 * 1_000;

function trail(now = () => 1_000) {
  const state = new Map();
  const stateStore = {
    async getServiceState(scope) { return state.get(scope); },
    async upsertServiceState(scope, value) {
      state.set(scope, { ...(state.get(scope) ?? {}), ...value });
      return state.get(scope);
    },
    async deleteServiceState(scope) { state.delete(scope); }
  };
  return {
    state,
    trail: new ArrivalSessionTrail({ stateStore, now, flushIntervalMs: 0 })
  };
}

test("a wallet session is one stitched record and pre-auth is only counted", async () => {
  const { trail: sessions } = trail();
  await sessions.observe({
    wallet: WALLET.toUpperCase(),
    clientInfo: { name: "qa-sweep", version: "1" },
    protocolVersion: "2026-07-28",
    door: "http",
    name: "GET /jobs",
    resultClass: resultClassFromOutcome({ statusCode: 200 }),
    stage: "browsed"
  });
  await sessions.observe({
    wallet: WALLET,
    door: "http",
    name: "POST /jobs/claim",
    resultClass: resultClassFromOutcome({ outcome: { kind: "http", status: 401 } }),
    stage: "claimed"
  });
  await sessions.observe({
    door: "http",
    name: "GET /jobs",
    resultClass: "ok",
    stage: "browsed"
  });
  await sessions.observe({
    mcpSessionId: "legacy-session-1",
    clientInfo: { name: "legacy", version: "" },
    door: "mcp",
    name: "listJobs",
    resultClass: resultClassFromOutcome({ outcome: { kind: "tool", code: "rate_limited" } }),
    stage: "browsed"
  });

  const listed = await sessions.list();
  assert.equal(listed.preAuth.stitched, false);
  assert.equal(listed.preAuth.count, 1);
  assert.match(listed.preAuth.note, /not stitched/u);
  assert.equal(listed.sessions.length, 2);
  const wallet = listed.sessions.find((entry) => entry.id === `wallet:${WALLET}`);
  assert.equal(wallet.stitched, true);
  assert.equal(wallet.clientName, "qa-sweep");
  assert.equal(wallet.clientVersion, "1");
  assert.equal(wallet.protocolVersion, "2026-07-28");
  assert.equal(wallet.furthestStage, "browsed");
  assert.equal(wallet.clientNameSource, "declared");
  assert.deepEqual(wallet.steps.map((step) => step.resultClass), ["ok", "401"]);
  const detail = await sessions.get(wallet.id);
  assert.equal(detail.session.steps.length, 2);
  assert.equal(await sessions.get("wallet:missing"), undefined);
});

test("a Redis write failure does not reject the trail observation", async () => {
  const sessions = new ArrivalSessionTrail({
    stateStore: {
      async getServiceState() { return undefined; },
      async upsertServiceState() { throw new Error("redis down"); }
    },
    now: () => 5_000,
    flushIntervalMs: 0
  });
  await assert.doesNotReject(() => sessions.observe({
    wallet: WALLET,
    door: "http",
    name: "GET /jobs",
    resultClass: "ok",
    stage: "browsed"
  }));
});

test("the record cap evicts the least recently seen and reports how many were dropped", async () => {
  const { state, trail: sessions } = trail();
  for (let index = 0; index < SESSION_RECORD_CAP + 1; index += 1) {
    const wallet = `0x${index.toString(16).padStart(40, "0")}`;
    await sessions.observe({
      wallet,
      door: "http",
      name: "GET /jobs",
      resultClass: "ok",
      stage: "browsed"
    });
  }
  const listed = await sessions.list({ limit: 100, offset: 0 });
  assert.equal(listed.sessions.length, 100);
  assert.equal(listed.nextOffset, 100);
  const rest = await sessions.list({ limit: 100, offset: listed.nextOffset });
  assert.equal(rest.sessions.length, 100);
  assert.equal(rest.nextOffset, null);
  assert.equal(listed.droppedRecords, 1);
  assert.equal(rest.droppedRecords, 1);
  const evicted = "wallet:0x" + "0".repeat(40);
  assert.equal(await sessions.get(evicted), undefined);
  assert.equal(state.has(`arrival-session-record:${evicted}`), false);
});

test("steps cap at 200, retention is 30 days, and a failed read is not reported", async () => {
  let nowMs = 5_000;
  const { state, trail: sessions } = trail(() => nowMs);
  for (let index = 0; index < SESSION_STEP_CAP + 3; index += 1) {
    await sessions.observe({
      wallet: WALLET,
      door: "mcp",
      name: `tool-${index}`,
      resultClass: "ok",
      stage: "browsed"
    });
  }
  const full = await sessions.get(`wallet:${WALLET}`);
  assert.equal(full.session.steps.length, SESSION_STEP_CAP);
  assert.equal(full.session.stepsTruncated, true);
  assert.equal(full.session.stepsDropped, 3);
  assert.equal(full.session.steps[0].name, "tool-3");

  nowMs += 31 * DAY;
  const expired = await sessions.list();
  assert.equal(expired.sessions.length, 0);
  assert.equal(expired.preAuth.count, 0);
  assert.equal([...state.keys()].some((key) => key.startsWith("arrival-session-record:")), false);

  const failing = new ArrivalSessionTrail({
    stateStore: {
      async getServiceState() { throw new Error("redis down"); },
      async upsertServiceState() { throw new Error("redis down"); }
    },
    now: () => 1
  });
  const unread = await failing.list();
  assert.equal(unread.preAuth.count, NOT_REPORTED);
  assert.equal(unread.sessions, null);
  assert.equal(JSON.stringify(unread).includes(":0"), false);
});

test("a missing client or protocol version is not reported, and the public funnel has no trail", async () => {
  const { trail: sessions } = trail();
  await sessions.observe({
    mcpSessionId: "legacy-session-1",
    door: "mcp",
    name: "initialize",
    resultClass: "ok",
    stage: "reached"
  });
  const record = (await sessions.list()).sessions[0];
  assert.equal(record.clientName, NOT_REPORTED);
  assert.equal(record.clientVersion, NOT_REPORTED);
  assert.equal(record.protocolVersion, NOT_REPORTED);
  assert.equal(resultClassFromOutcome({ outcome: { kind: "tool", code: "password=hunter2" } }), "other");

  const observatory = new ArrivalObservatory({
    stateStore: {
      async getServiceState() { return undefined; },
      async upsertServiceState() { return undefined; }
    },
    now: () => 1_000,
    flushIntervalMs: 0
  });
  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.sessions, undefined);
  assert.equal(JSON.stringify(snapshot).includes("legacy-session-1"), false);
});

test("a failed per-record write does not mark the session persisted", async () => {
  const state = new Map();
  const sessions = new ArrivalSessionTrail({
    stateStore: {
      async getServiceState(scope) { return state.get(scope); },
      async upsertServiceState(scope, value) {
        if (String(scope).startsWith("arrival-session-record:")) throw new Error("record write failed");
        state.set(scope, { ...(state.get(scope) ?? {}), ...value });
        return state.get(scope);
      },
      async deleteServiceState(scope) { state.delete(scope); }
    },
    now: () => 100_000,
    flushIntervalMs: 0
  });
  await sessions.observe({
    wallet: WALLET,
    door: "http",
    name: "GET /auth/session",
    resultClass: "ok",
    stage: "reached"
  });
  const got = await sessions.get(`wallet:${WALLET}`);
  assert.ok(got.session);
  assert.equal(got.persisted, false);
  assert.equal(await sessions.persist(`wallet:${WALLET}`), false);
  assert.equal((await sessions.get(`wallet:${WALLET}`)).persisted, false);
});
