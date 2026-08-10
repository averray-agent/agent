import assert from "node:assert/strict";
import test from "node:test";

import { ArrivalObservatory, normalizeClientInfo, resolveSelfClients, stageRank } from "./arrival-observatory.js";

function harness({ failStore = false, now = () => 1_000, loadRetryIntervalMs } = {}) {
  const state = new Map();
  const counters = [];
  const reads = [];
  let failing = failStore;
  const stateStore = {
    async getServiceState(scope) {
      reads.push(scope);
      if (failing) throw new Error("redis down");
      return state.get(scope);
    },
    async upsertServiceState(scope, value) {
      if (failing) throw new Error("redis down");
      state.set(scope, value);
      return value;
    }
  };
  const metrics = {
    counter(name, help, labelNames) {
      return { inc: (labels) => counters.push({ name, labelNames, labels }) };
    }
  };
  return {
    state,
    counters,
    reads,
    recover() { failing = false; },
    observatory: new ArrivalObservatory({ stateStore, metrics, now, flushIntervalMs: 0, loadRetryIntervalMs })
  };
}

// Scope the observatory persists under. Hardcoded so that renaming it without
// updating the tests fails loudly instead of quietly loading nothing.
const STATE_SCOPE = "arrival-observatory";

const CLAUDE = { name: "claude-ai", version: "1.2.0" };

test("tool calls map onto the arrival funnel", async () => {
  const { observatory } = harness();
  await observatory.recordReach({ era: "modern", clientInfo: CLAUDE, ip: "1.2.3.4" });
  await observatory.recordTool({ tool: "listJobs", clientInfo: CLAUDE, ip: "1.2.3.4" });
  await observatory.recordTool({ tool: "preflightJob", clientInfo: CLAUDE, ip: "1.2.3.4" });
  await observatory.recordTool({ tool: "fetchAuthNonce", clientInfo: CLAUDE, ip: "1.2.3.4" });

  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.funnel.reached, 1);
  assert.equal(snapshot.funnel.browsed, 1);
  assert.equal(snapshot.funnel.evaluated, 1);
  // The stage nothing had ever reached when this was built.
  assert.equal(snapshot.funnel.identified, 1);
  assert.equal(snapshot.distinct.furthest, "identified");
  assert.equal(snapshot.clients.length, 1);
  assert.equal(snapshot.clients[0].name, "claude-ai");
});

test("furthest stage never regresses when a client browses again", async () => {
  const { observatory } = harness();
  await observatory.recordTool({ tool: "claimJob", clientInfo: CLAUDE });
  await observatory.recordTool({ tool: "listJobs", clientInfo: CLAUDE });
  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.clients[0].furthestStage, "claimed");
});

test("declared clients and anonymous callers are counted apart", async () => {
  const { observatory } = harness();
  await observatory.recordReach({ clientInfo: CLAUDE, ip: "1.1.1.1" });
  await observatory.recordReach({ ip: "9.9.9.9" });
  await observatory.recordReach({ ip: "9.9.9.9" });

  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.distinct.declared, 1);
  // Same address twice is one caller, not two.
  assert.equal(snapshot.distinct.anonymous, 1);
});

// The snapshot is served from a PUBLIC monitor route, so an address must never
// reach it. Only a salted digest is retained, and only to tell callers apart.
test("raw IP addresses are never retained", async () => {
  const { observatory, state } = harness();
  await observatory.recordReach({ ip: "203.0.113.77" });
  const snapshot = await observatory.getSnapshot();
  const serialized = JSON.stringify(snapshot) + JSON.stringify([...state.values()]);
  assert.doesNotMatch(serialized, /203\.0\.113\.77/u);
  assert.match(snapshot.clients[0].key, /^anon:[0-9a-f]{12}$/u);
});

// A self-declared client name is attacker-controlled and unbounded. If it ever
// became a Prometheus label it would blow up series cardinality.
test("client identity never becomes a metric label", async () => {
  const { observatory, counters } = harness();
  await observatory.recordTool({ tool: "listJobs", clientInfo: { name: "evil-\u0000-agent", version: "9" } });
  assert.equal(counters.length, 1);
  assert.deepEqual(counters[0].labelNames, ["stage", "actor"]);
  assert.deepEqual(counters[0].labels, { stage: "browsed", actor: "client" });
  assert.doesNotMatch(JSON.stringify(counters[0].labels), /evil/u);
});

// Observability that can take the front door down is worse than none.
test("a broken state store never propagates to the caller", async () => {
  const { observatory } = harness({ failStore: true });
  await assert.doesNotReject(observatory.recordReach({ clientInfo: CLAUDE }));
  await assert.doesNotReject(observatory.recordTool({ tool: "claimJob", clientInfo: CLAUDE }));
  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.schemaVersion, "averray.arrivals.v1");
});

// Zero outsiders is a finding; no reading is an instrument failure. The split
// has to keep them apart the way the total already does, or a board that
// cannot reach the state store renders "0 external" as if we had measured it.
test("a split that could not be read is null, never zero", async () => {
  const { observatory } = harness({ failStore: true });
  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.unavailable, "arrival state could not be read");
  assert.equal(snapshot.funnel.browsed, null);
  assert.equal(snapshot.funnelExternal.browsed, null);
  assert.equal(snapshot.funnelSelf.browsed, null);
});

// An unreachable feed must be a NAMED instrument failure, never a funnel of
// zeros that reads as "nobody arrived". The load flag used to be set before the
// read, so a store that was down at startup left the observatory looking
// loaded: the first record() ate the throw and every snapshot after it served
// in-memory counts as measured truth, with no marker at all.
test("a snapshot after a failed load still says the state could not be read", async () => {
  const { observatory } = harness({ failStore: true });
  await observatory.recordReach({ clientInfo: CLAUDE });
  await observatory.recordTool({ tool: "listJobs", clientInfo: CLAUDE });

  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.unavailable, "arrival state could not be read");
  // Not zero — unknown. Every figure withheld, including the ones a post-failure
  // call had already accumulated in memory.
  assert.equal(snapshot.funnel.reached, null);
  assert.equal(snapshot.funnel.browsed, null);
  assert.equal(snapshot.distinct.furthestExternal, null);
  assert.deepEqual(snapshot.clients, []);
});

// Retrying is right; retrying on every call is not. A store that is down must
// not cost the front door a round trip per request.
test("a failed load is not retried on every single call", async () => {
  const { observatory, reads } = harness({ failStore: true });
  await observatory.recordReach({ clientInfo: CLAUDE });
  await observatory.recordTool({ tool: "listJobs", clientInfo: CLAUDE });
  await observatory.getSnapshot();
  assert.equal(reads.length, 1);
});

test("a failed load is retried once the interval passes, not latched forever", async () => {
  const { observatory, state, recover } = harness({ failStore: true, loadRetryIntervalMs: 0 });
  state.set(STATE_SCOPE, { totals: { reached: 4 }, clients: [] });
  await observatory.recordReach({ clientInfo: CLAUDE });
  assert.equal((await observatory.getSnapshot()).unavailable, "arrival state could not be read");

  recover();
  await observatory.recordReach({ clientInfo: CLAUDE });
  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.unavailable, undefined);
  // Resumes from the persisted baseline rather than restarting the count at the
  // outage — 4 arrivals before it, 1 after.
  assert.equal(snapshot.funnel.reached, 5);
});

// The pre-set flag also served as concurrency control: it stopped a second
// caller starting its own read and overwriting counts the first had already
// applied. The in-flight promise has to keep doing that job.
test("concurrent first callers read persisted state once", async () => {
  const { observatory, reads } = harness();
  await Promise.all([
    observatory.recordReach({ clientInfo: CLAUDE }),
    observatory.recordTool({ tool: "listJobs", clientInfo: CLAUDE }),
    observatory.getSnapshot()
  ]);
  assert.equal(reads.length, 1);
  assert.equal((await observatory.getSnapshot()).funnel.reached, 1);
});

test("client table is capped and evicts the least recently seen", async () => {
  const { observatory } = harness({ now: (() => { let t = 0; return () => (t += 10); })() });
  observatory.maxClients = 3;
  for (let index = 0; index < 6; index += 1) {
    await observatory.recordReach({ clientInfo: { name: `agent-${index}`, version: "1" } });
  }
  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.clients.length, 3);
  assert.deepEqual(snapshot.clients.map((entry) => entry.name), ["agent-5", "agent-4", "agent-3"]);
  // Totals survive eviction — the funnel is a count, not a sample.
  assert.equal(snapshot.funnel.reached, 6);
});

test("counts survive a restart by reloading persisted state", async () => {
  const { observatory, state } = harness();
  await observatory.recordTool({ tool: "verifySiwe", clientInfo: CLAUDE });
  await observatory.maybeFlush(true);

  const restarted = new ArrivalObservatory({
    stateStore: { async getServiceState(scope) { return state.get(scope); }, async upsertServiceState() {} },
    metrics: { counter: () => ({ inc() {} }) },
    now: () => 2_000
  });
  const snapshot = await restarted.getSnapshot();
  assert.equal(snapshot.funnel.authenticated, 1);
  assert.equal(snapshot.clients[0].name, "claude-ai");
});

test("unknown tools count as reach rather than being dropped or guessed", async () => {
  const { observatory } = harness();
  await observatory.recordTool({ tool: "somethingNew", clientInfo: CLAUDE });
  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.funnel.reached, 1);
  assert.equal(snapshot.funnel.browsed, 0);
});

test("client info is normalized and bounded", () => {
  assert.equal(normalizeClientInfo(undefined), null);
  assert.equal(normalizeClientInfo({ name: "   " }), null);
  assert.deepEqual(normalizeClientInfo({ name: "x" }), { name: "x", version: "unknown" });
  assert.equal(normalizeClientInfo({ name: "a".repeat(200) }).name.length, 64);
  assert.ok(stageRank("submitted") > stageRank("reached"));
  assert.equal(stageRank("nonsense"), -1);
});

// A settlement count alone flatters us, which is why the composition split
// exists for jobs. Arrivals had no equivalent, so our own canary, smoke and
// adversarial traffic sat in the funnel indistinguishable from a real agent.
test("our own traffic is separated from outsiders", async () => {
  const { observatory } = harness();
  observatory.selfClients = resolveSelfClients({ ARRIVAL_SELF_CLIENTS: "worker-canary,Smoke-Probe" });

  await observatory.recordTool({ tool: "listJobs", clientInfo: { name: "averray-adversarial", version: "1" } });
  await observatory.recordTool({ tool: "listJobs", clientInfo: { name: "worker-canary", version: "1" } });
  await observatory.recordTool({ tool: "listJobs", clientInfo: { name: "smoke-probe", version: "1" } });
  await observatory.recordReach({ clientInfo: { name: "glama", version: "1" } });

  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.distinct.self, 3);
  assert.equal(snapshot.distinct.declared, 4);

  const external = snapshot.clients.filter((entry) => !entry.self).map((entry) => entry.name);
  assert.deepEqual(external, ["glama"]);
});

// The number that answers "has an OUTSIDER looked?". If our own probes can move
// it, every adversarial run and canary silently manufactures demand evidence.
test("our own traffic can never move the external furthest stage", async () => {
  const { observatory } = harness();
  observatory.selfClients = resolveSelfClients({ ARRIVAL_SELF_CLIENTS: "worker-canary" });

  await observatory.recordTool({ tool: "claimJob", clientInfo: { name: "averray-probe", version: "1" } });
  await observatory.recordTool({ tool: "submitWork", clientInfo: { name: "worker-canary", version: "1" } });
  await observatory.recordReach({ clientInfo: { name: "mcpbeat", version: "1" } });

  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.distinct.furthest, "submitted");
  // An outsider has only ever reached the door.
  assert.equal(snapshot.distinct.furthestExternal, "reached");
});

// The funnel is what a headline renders, so the mark has to reach it and not
// stop at the client list. Live on 2026-08-10 `browsed` was 2 with one of the
// two being our own roadmap probe, and the ops board said two agents browsed.
test("our own traffic never inflates the external funnel", async () => {
  const { observatory } = harness();
  observatory.selfClients = resolveSelfClients({ ARRIVAL_SELF_CLIENTS: "worker-canary" });

  await observatory.recordTool({ tool: "listJobs", clientInfo: { name: "averray-roadmap-probe", version: "1" } });
  await observatory.recordTool({ tool: "listJobs", clientInfo: { name: "worker-canary", version: "1" } });
  await observatory.recordTool({ tool: "listJobs", clientInfo: { name: "sasame-audit", version: "0.2" } });
  await observatory.recordTool({ tool: "claimJob", clientInfo: { name: "averray-roadmap-probe", version: "1" } });

  const snapshot = await observatory.getSnapshot();
  // Every call including ours — the meaning averray.arrivals.v1 always had.
  assert.equal(snapshot.funnel.browsed, 3);
  // The only count that answers "did an OUTSIDER browse?".
  assert.equal(snapshot.funnelExternal.browsed, 1);
  assert.equal(snapshot.funnelSelf.browsed, 2);
  // Our probe claimed a job. No outsider ever has, and this must say so.
  assert.equal(snapshot.funnel.claimed, 1);
  assert.equal(snapshot.funnelExternal.claimed, 0);
  assert.equal(snapshot.funnelSelf.claimed, 1);
});

// Same fail-safe direction as the client marking, now in the funnel: unknown
// is not ours. Undercounting our own probes is harmless; counting a probe as
// an outsider manufactures demand evidence.
test("unmarked and anonymous callers land in the external funnel", async () => {
  const { observatory } = harness();
  observatory.selfClients = resolveSelfClients({});

  await observatory.recordTool({ tool: "listJobs", clientInfo: { name: "glama", version: "1" } });
  await observatory.recordTool({ tool: "listJobs", ip: "9.9.9.9" });

  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.funnelExternal.browsed, 2);
  assert.equal(snapshot.funnelSelf.browsed, 0);
  assert.equal(snapshot.funnel.browsed, snapshot.funnelExternal.browsed);
});

test("a restart preserves the split, not just the total", async () => {
  const { observatory, state } = harness();
  observatory.selfClients = resolveSelfClients({ ARRIVAL_SELF_CLIENTS: "worker-canary" });
  await observatory.recordTool({ tool: "listJobs", clientInfo: { name: "worker-canary", version: "1" } });
  await observatory.recordTool({ tool: "listJobs", clientInfo: { name: "sasame-audit", version: "0.2" } });
  await observatory.maybeFlush(true);

  const restarted = new ArrivalObservatory({
    stateStore: { async getServiceState(scope) { return state.get(scope); }, async upsertServiceState() {} },
    metrics: { counter: () => ({ inc() {} }) },
    now: () => 2_000
  });

  const snapshot = await restarted.getSnapshot();
  assert.equal(snapshot.funnel.browsed, 2);
  assert.equal(snapshot.funnelExternal.browsed, 1);
  assert.equal(snapshot.funnelSelf.browsed, 1);
});

// State written before the split carries no actor attribution. Restoring it
// into the external count would hand every past canary call to the demand
// signal in a single deploy, which is the overstatement the split prevents.
test("pre-split persisted state restores as a total, never as outside interest", async () => {
  const { observatory, state } = harness();
  state.set("arrival-observatory", {
    observingSinceMs: 500,
    totals: { reached: 9, browsed: 2, evaluated: 0, identified: 0, authenticated: 0, claimed: 0, submitted: 0 },
    clients: []
  });

  const restored = await observatory.getSnapshot();
  assert.equal(restored.funnel.browsed, 2);
  assert.equal(restored.funnelExternal.browsed, 0);
  assert.equal(restored.funnelSelf.browsed, 0);

  // New traffic still splits normally on top of the unattributed history.
  await observatory.recordTool({ tool: "listJobs", clientInfo: { name: "sasame-audit", version: "0.2" } });
  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.funnel.browsed, 3);
  assert.equal(snapshot.funnelExternal.browsed, 1);
});

// Fail-safe direction: the failure we must never have is OVERSTATING outside
// interest, so anything unmarked counts as external.
test("unmarked traffic counts as external, never as ours", async () => {
  const { observatory } = harness();
  observatory.selfClients = resolveSelfClients({});

  await observatory.recordReach({ clientInfo: { name: "Anthropic/ClaudeAI", version: "1" } });
  await observatory.recordReach({ ip: "9.9.9.9" });

  const snapshot = await observatory.getSnapshot();
  assert.equal(snapshot.distinct.self, 0);
  assert.equal(snapshot.clients.every((entry) => entry.self === false), true);
});

test("self-client matching is case-insensitive and prefix-aware", () => {
  assert.deepEqual([...resolveSelfClients({ ARRIVAL_SELF_CLIENTS: " A , b ,, C " })], ["a", "b", "c"]);
  assert.deepEqual([...resolveSelfClients({})], []);
});
