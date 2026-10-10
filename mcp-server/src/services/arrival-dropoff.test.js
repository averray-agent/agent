import assert from "node:assert/strict";
import test from "node:test";

import { SelfIdentityRegistry } from "../core/self-identity-registry.js";
import { ArrivalObservatory, NOT_REPORTED } from "./arrival-observatory.js";
import {
  DROP_OFF_FIELD_NOTE,
  dropOffCode,
  dropOffSnapshot,
  createDropOffSeries,
  recordDropOff as recordSeries
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
  assert.equal(early.errorsByStage.absentMeans, NOT_REPORTED);
  assert.equal(early.errorsByStage["24h"], NOT_REPORTED);
  assert.equal(early.errorsByStage["7d"], NOT_REPORTED);
  assert.equal(early.errorsByStage.sinceCutover.http.external.browsed["401:unauthorized"], 1);
  assert.equal(early.errorsByStage.sinceCutover.http.self.claimed["500:internal_error"], 1);
  assert.equal(early.errorsByStage.sinceCutover.http.external.claimed["500:internal_error"], undefined);
  assert.equal(early.errorsByStage.sinceCutover.mcp.ambiguous.browsed.rate_limited, 1);
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
  assert.equal(covered.errorsByStage["24h"].mcp.external.reached["-32601"], 1);
  // The 401 landed in the hour that starts before this window, so 24h does not
  // stretch back across that partial bucket. sinceCutover still has it.
  assert.equal(covered.errorsByStage["24h"].http.external.browsed["401:unauthorized"], undefined);
  assert.equal(covered.errorsByStage["7d"], NOT_REPORTED);
  assert.equal(covered.errorsByStage.sinceCutover.http.external.browsed["401:unauthorized"], 1);
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
  const counts = snapshot.errorsByStage.sinceCutover.http.external.reached;
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
  assert.equal(unavailable.errorsByStage["24h"], NOT_REPORTED);
  assert.equal(unavailable.errorsByStage["7d"], NOT_REPORTED);
  assert.equal(unavailable.errorsByStage.sinceCutover, NOT_REPORTED);
  assert.equal(JSON.stringify(unavailable.errorsByStage).includes(":0"), false);
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
  assert.equal("errorsByStage" in copied, false);
  assert.equal(copied.funnelExternal.browsed, snapshot.funnelExternal.browsed);
  const older = { ...copied };
  assert.equal(older.errorsByStage, undefined);
  assert.notEqual(older.errorsByStage, 0);
  const withoutField = dropOffSnapshot(createDropOffSeries(), { nowMs: 1, unavailable: "unread" });
  assert.equal(withoutField["24h"], NOT_REPORTED);
});

test("a later error does not erase an earlier stage, and protocol garbage is unclassified", async () => {
  const wallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const qa = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const { observatory } = harness({
    identityRegistry: new SelfIdentityRegistry({ qaEngineerWallets: [qa] })
  });
  await observatory.recordHttp({
    method: "GET",
    pathname: "/jobs",
    outcome: { kind: "http", status: 429, code: "rate_limited" }
  });
  await observatory.recordHttp({ method: "POST", pathname: "/jobs/claim", wallet, outcome: { ok: true } });
  await observatory.recordHttp({ method: "POST", pathname: "/jobs/submit", wallet, outcome: { ok: true } });
  await observatory.linkWallet({ wallet: qa, clientInfo: { name: "linked-client", version: "1" } });
  await observatory.recordDropOff({
    clientInfo: { name: "linked-client", version: "1" },
    tool: "listJobs",
    outcome: { kind: "tool", code: "rate_limited" }
  });
  await observatory.recordDropOff({
    actor: "unclassified",
    stage: "reached",
    outcome: { kind: "jsonrpc", code: -32700 }
  });
  await observatory.recordDropOff({
    actor: "unclassified",
    stage: "reached",
    outcome: { kind: "jsonrpc", code: -32600 }
  });

  const snapshot = await observatory.getSnapshot();
  const http = snapshot.errorsByStage.sinceCutover.http;
  assert.equal(http.external.browsed["429:rate_limited"], 1);
  assert.equal(http.external.claimed["429:rate_limited"], undefined);
  assert.equal(snapshot.funnelHttpExternal.claimed, 1);
  assert.equal(snapshot.funnelHttpExternal.submitted, 1);
  assert.equal(snapshot.errorsByStage.sinceCutover.mcp.self.browsed.rate_limited, 1);
  assert.equal(snapshot.errorsByStage.sinceCutover.mcp.external.browsed.rate_limited, undefined);
  assert.equal(snapshot.errorsByStage.sinceCutover.mcp.unclassified.reached["-32700"], 1);
  assert.equal(snapshot.errorsByStage.sinceCutover.mcp.unclassified.reached["-32600"], 1);
  assert.equal(snapshot.errorsByStage.sinceCutover.mcp.external.reached["-32700"], undefined);
  assert.equal(snapshot.funnelExternal.reached, 0);
  assert.match(snapshot.errorsByStage.measures, /one pre-auth request = one visit/u);
});

test("24h excludes the hour that starts before the window, and unavailable survives a successful load", () => {
  const series = createDropOffSeries();
  const hour = 60 * 60 * 1_000;
  const day = 24 * hour;
  series.collectionSinceMs = 0;
  recordImported(series, 30 * 60 * 1_000, "early");
  const nowMs = (30 * 60 * 1_000) + day;
  recordImported(series, nowMs, "current");
  const covered = dropOffSnapshot(series, { nowMs });
  assert.equal(covered["24h"].mcp.external.reached.early, undefined);
  assert.equal(covered["24h"].mcp.external.reached.current, 1);
  assert.equal(covered.sinceCutover.mcp.external.reached.early, 1);

  const failedLater = dropOffSnapshot(series, { nowMs, unavailable: "arrival state could not be read" });
  assert.equal(failedLater["24h"], NOT_REPORTED);
  assert.equal(failedLater["7d"], NOT_REPORTED);
  assert.equal(failedLater.sinceCutover, NOT_REPORTED);
  assert.equal(JSON.stringify(failedLater).includes("current"), false);
});

function recordImported(series, nowMs, code) {
  recordSeries(series, { nowMs, door: "mcp", actor: "external", stage: "reached", code });
}
