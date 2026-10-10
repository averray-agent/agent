import assert from "node:assert/strict";
import test from "node:test";

import { SelfIdentityRegistry } from "../core/self-identity-registry.js";
import { ArrivalObservatory, NOT_REPORTED } from "./arrival-observatory.js";
import {
  DROP_OFF_FIELD_NOTE,
  dropOffCode,
  dropOffSnapshot,
  createDropOffSeries
} from "./arrival-dropoff.js";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

function harness({ now = () => 10_000, identityRegistry } = {}) {
  const state = new Map();
  const stateStore = {
    async getServiceState(scope) { return state.get(scope); },
    async upsertServiceState(scope, value) {
      state.set(scope, { ...(state.get(scope) ?? {}), ...value });
      return state.get(scope);
    }
  };
  return {
    state,
    observatory: new ArrivalObservatory({
      stateStore,
      now,
      flushIntervalMs: 0,
      identityRegistry
    })
  };
}

test("drop-off codes are an allow-list plus other, and messages are not codes", () => {
  assert.equal(dropOffCode({ ok: true }), undefined);
  assert.equal(dropOffCode({ kind: "http", status: 401, code: "unauthorized" }), "401:unauthorized");
  assert.equal(dropOffCode({ kind: "http", status: 401, code: "Bearer sk-live-secret" }), "401:other");
  assert.equal(dropOffCode({ kind: "http", status: 418, code: "unauthorized" }), "other");
  assert.equal(dropOffCode({ kind: "jsonrpc", code: -32601 }), "-32601");
  assert.equal(dropOffCode({ kind: "jsonrpc", code: -1 }), "other");
  assert.equal(dropOffCode({ kind: "tool", code: "rate_limited" }), "rate_limited");
  assert.equal(dropOffCode({ kind: "tool", code: "password=hunter2" }), "other");
  assert.equal(dropOffCode(undefined), undefined);
});

test("a measured drop-off is additive, windowed, and unmeasured windows stay not reported", async () => {
  let nowMs = 1_000;
  const qa = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const { observatory } = harness({
    now: () => nowMs,
    identityRegistry: new SelfIdentityRegistry({ qaEngineerWallets: [qa] })
  });

  await observatory.recordHttp({
    method: "GET",
    pathname: "/jobs",
    outcome: {
      kind: "http",
      status: 401,
      code: "unauthorized",
      message: "Authorization: Bearer sk-live-SECRET"
    }
  });
  await observatory.recordHttp({
    method: "POST",
    pathname: "/jobs/claim",
    wallet: qa,
    outcome: { kind: "http", status: 500, code: "internal_error" }
  });
  await observatory.recordDropOff({
    tool: "listJobs",
    clientInfo: { name: "Anthropic/ClaudeAI", version: "1" },
    outcome: { kind: "tool", code: "rate_limited", message: "slow down hunter2" }
  });
  await observatory.recordHttp({
    method: "GET",
    pathname: "/health",
    outcome: { kind: "http", status: 500, code: "internal_error" }
  });

  const early = await observatory.getSnapshot();
  assert.equal(early.schemaVersion, "averray.arrivals.v1");
  assert.equal(early.dropOff.absentMeans, NOT_REPORTED);
  assert.equal(early.dropOff["24h"], NOT_REPORTED);
  assert.equal(early.dropOff["7d"], NOT_REPORTED);
  assert.equal(early.dropOff.sinceCutover.http.external.browsed["401:unauthorized"], 1);
  assert.equal(early.dropOff.sinceCutover.http.self.claimed["500:internal_error"], 1);
  assert.equal(early.dropOff.sinceCutover.http.external.claimed["500:internal_error"], undefined);
  assert.equal(early.dropOff.sinceCutover.mcp.ambiguous.browsed.rate_limited, 1);
  assert.equal(early.funnelHttpExternal.browsed, 1);
  assert.equal(JSON.stringify(early).includes("SECRET"), false);
  assert.equal(JSON.stringify(early).includes("hunter2"), false);
  assert.equal(JSON.stringify(early).includes("Authorization"), false);

  nowMs += DAY;
  await observatory.recordDropOff({
    stage: "reached",
    outcome: { kind: "jsonrpc", code: -32601 }
  });
  const covered = await observatory.getSnapshot();
  assert.equal(covered.dropOff["24h"].mcp.external.reached["-32601"], 1);
  assert.equal(covered.dropOff["24h"].http.external.browsed["401:unauthorized"], 1);
  assert.equal(covered.dropOff["7d"], NOT_REPORTED);
  assert.equal(covered.dropOff.sinceCutover.http.external.browsed["401:unauthorized"], 1);
  assert.match(DROP_OFF_FIELD_NOTE, /not zero/u);
});

test("more than eight codes fold into other and a failed read is not reported", async () => {
  const statuses = [400, 401, 403, 404, 409, 422, 429, 500, 502];
  const { observatory } = harness();
  for (const status of statuses) {
    const times = status === 502 ? 1 : 2;
    for (let index = 0; index < times; index += 1) {
      await observatory.recordDropOff({
        door: "http",
        stage: "reached",
        outcome: { kind: "http", status, code: "invalid_request" }
      });
    }
  }
  const snapshot = await observatory.getSnapshot();
  const counts = snapshot.dropOff.sinceCutover.http.external.reached;
  assert.equal(counts["502:invalid_request"], undefined);
  assert.equal(counts.other, 1);
  assert.equal(Object.keys(counts).filter((key) => key !== "other").length, 8);

  const failing = new ArrivalObservatory({
    stateStore: {
      async getServiceState() { throw new Error("redis down"); },
      async upsertServiceState() { throw new Error("redis down"); }
    },
    now: () => 5_000,
    flushIntervalMs: 0,
    loadRetryIntervalMs: 60_000
  });
  const unavailable = await failing.getSnapshot();
  assert.equal(unavailable.dropOff["24h"], NOT_REPORTED);
  assert.equal(unavailable.dropOff["7d"], NOT_REPORTED);
  assert.equal(unavailable.dropOff.sinceCutover, NOT_REPORTED);
  assert.equal(JSON.stringify(unavailable.dropOff).includes(":0"), false);
});

test("an older arrivals consumer that ignores unknown fields does not read drop-off as zero", async () => {
  const { observatory } = harness();
  await observatory.recordDropOff({
    stage: "browsed",
    outcome: { kind: "tool", code: "not_found" }
  });
  const snapshot = await observatory.getSnapshot();
  const hermesKeys = [
    "schemaVersion", "funnel", "funnelExternal", "funnelSelf",
    "funnelAmbiguous", "funnelHttp", "distinct", "clients"
  ];
  const copied = {};
  for (const key of hermesKeys) {
    if (snapshot[key] !== undefined) copied[key] = snapshot[key];
  }
  assert.equal("dropOff" in copied, false);
  assert.equal(copied.funnelExternal.browsed, snapshot.funnelExternal.browsed);
  const older = { ...copied };
  delete older.dropOff;
  assert.equal(older.dropOff, undefined);
  assert.notEqual(older.dropOff, 0);
  const withoutField = dropOffSnapshot(createDropOffSeries(), { nowMs: 1, unavailable: "unread" });
  assert.equal(withoutField["24h"], NOT_REPORTED);
});
