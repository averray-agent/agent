import assert from "node:assert/strict";
import test from "node:test";

import { createHostedCanaryClaimantAttribution } from "../core/claimant-attribution.js";
import { SelfIdentityRegistry } from "../core/self-identity-registry.js";
import { ARRIVAL_STAGES } from "./arrival-stage-map.js";
import { buildArrivalOperatorView } from "./arrival-operator-view.js";

const OUTSIDER = "0x1111111111111111111111111111111111111111";
const CANARY = "0x2222222222222222222222222222222222222222";
const ACCEPTANCE = "0x3333333333333333333333333333333333333333";
const AUG_11 = Date.parse("2026-08-11T08:00:00.000Z");
const NOW = Date.parse("2026-08-16T12:00:00.000Z");

function entry({ wallet, door = "http", furthestStage = "submitted", atMs = AUG_11 } = {}) {
  const tool = door === "http" ? "POST /jobs/submit" : "submitWork";
  return {
    key: `wallet:${wallet}`,
    wallet,
    name: null,
    firstSeenMs: atMs,
    lastSeenMs: atMs,
    furthestStage,
    calls: 1,
    tools: { [tool]: 1 }
  };
}

function stateStore(sessions) {
  return {
    async listRecentSessions(limit, offset) {
      return sessions.slice(offset, offset + limit);
    }
  };
}

function resolvedSession({ wallet, sessionId, claimedAt, claimantAttribution } = {}) {
  return {
    sessionId,
    jobId: `job-${sessionId}`,
    wallet,
    status: "resolved",
    claimedAt: new Date(claimedAt).toISOString(),
    submittedAt: new Date(claimedAt + 30_000).toISOString(),
    resolvedAt: new Date(claimedAt + 60_000).toISOString(),
    updatedAt: new Date(claimedAt + 60_000).toISOString(),
    protocolHistory: ["http"],
    claimantAttribution,
    payoutTx: { status: 1, txHash: `0x${String(sessionId).padStart(64, "0")}` }
  };
}

function baseInput(overrides = {}) {
  return {
    nowMs: NOW,
    identityRegistry: new SelfIdentityRegistry(),
    clients: [],
    httpClients: [],
    totals: Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, 0])),
    actorTotals: {
      outsider: Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, 0])),
      ours: Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, 0])),
      unknown: Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, 0]))
    },
    httpTotals: Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, 0])),
    httpActorTotals: {
      outsider: Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, 0])),
      ours: Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, 0])),
      unknown: Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, 0]))
    },
    observingSinceMs: Date.parse("2026-08-08T00:00:00.000Z"),
    httpObservingSinceMs: Date.parse("2026-08-11T00:00:00.000Z"),
    stateStore: stateStore([]),
    platformService: { listJobs: () => [] },
    ...overrides
  };
}

test("derives the 2026-08-11 furthest-ever payout burst and posted-work verdict from evidence", async () => {
  const sessions = Array.from({ length: 42 }, (_, index) => resolvedSession({
    wallet: OUTSIDER,
    sessionId: index + 1,
    claimedAt: AUG_11 + index * 10 * 60_000
  }));
  const input = baseInput({
    httpTotals: { ...baseInput().httpTotals, submitted: 1 },
    stateStore: stateStore(sessions)
  });

  const beforePosting = await buildArrivalOperatorView(input);
  assert.equal(beforePosting.outsiders.furthestEver.stage, "settled");
  assert.equal(beforePosting.outsiders.furthestEver.payouts, 42);
  assert.equal(beforePosting.outsiders.furthestEver.payoutWindow, "12h");
  assert.equal(new Date(beforePosting.outsiders.furthestEver.atMs).toISOString().slice(0, 10), "2026-08-11");
  assert.equal(beforePosting.outsiders.furthestEver.door, "http");
  assert.deepEqual(beforePosting.outsiders.postedWork, {
    window: "all-time",
    status: "never",
    count: 0,
    firstAtMs: null
  });

  input.platformService = {
    listJobs: () => [{
      source: { type: "external", createdAt: "2026-08-16T13:00:00.000Z" }
    }]
  };
  const afterPosting = await buildArrivalOperatorView(input);
  assert.equal(afterPosting.outsiders.postedWork.status, "observed");
  assert.equal(afterPosting.outsiders.postedWork.count, 1);
});

test("pure canary and acceptance work stays out of the outsider verdict", async () => {
  const sessions = [
    resolvedSession({
      wallet: CANARY,
      sessionId: 101,
      claimedAt: NOW - 60_000,
      claimantAttribution: createHostedCanaryClaimantAttribution()
    }),
    resolvedSession({ wallet: ACCEPTANCE, sessionId: 102, claimedAt: NOW - 120_000 })
  ];
  const view = await buildArrivalOperatorView(baseInput({
    identityRegistry: new SelfIdentityRegistry({ acceptanceWallets: [ACCEPTANCE] }),
    httpClients: [
      entry({ wallet: CANARY, atMs: NOW - 60_000 }),
      entry({ wallet: ACCEPTANCE, atMs: NOW - 120_000 })
    ],
    httpTotals: { ...baseInput().httpTotals, submitted: 2 },
    stateStore: stateStore(sessions)
  }));

  assert.equal(view.outsiders.week.identified, 0);
  assert.equal(view.outsiders.week.worked, 0);
  assert.equal(view.ours.day.canaryRuns, 1);
  assert.equal(view.ours.day.acceptanceRuns, 1);
  assert.equal(view.ours.day.window, "24h");
});

test("raw doors label call instrumentation and use monotonic wallet journeys after identity", async () => {
  const httpClients = [entry({ wallet: OUTSIDER, furthestStage: "submitted" })];
  const httpTotals = {
    reached: 460,
    browsed: 3,
    evaluated: 17,
    identified: 1,
    authenticated: 1,
    claimed: 1,
    submitted: 1
  };
  const input = baseInput({ httpClients, httpTotals });
  input.httpActorTotals.outsider.submitted = 1;
  const view = await buildArrivalOperatorView(input);
  const rows = Object.fromEntries(view.doors.http.rows.map((row) => [row.stage, row]));

  assert.equal(view.doors.http.window, "all-time");
  assert.equal(rows.reached.unit, "calls");
  assert.match(rows.reached.instrumentation, /requests reaching/u);
  assert.equal(rows.browsed.unit, "calls");
  assert.match(rows.evaluated.instrumentation, /route\/tool calls/u);
  for (const stage of ["identified", "authenticated", "claimed", "submitted"]) {
    assert.equal(rows[stage].unit, "agents");
    assert.match(rows[stage].instrumentation, /distinct SIWE wallets/u);
  }
  assert.deepEqual(
    ["identified", "authenticated", "claimed", "submitted"].map((stage) => rows[stage].outsider),
    [1, 1, 1, 1]
  );
  // 484 durable total calls minus the one retained submitted call. The
  // remainder stays unknown; it is never retroactively assigned to outsiders.
  assert.equal(view.unknown.preSplitCalls, 483);
});

test("a wallet crossing both doors remains one agent without assigning HTTP work to MCP", async () => {
  const view = await buildArrivalOperatorView(baseInput({
    clients: [entry({ wallet: OUTSIDER, door: "mcp", furthestStage: "browsed" })],
    httpClients: [entry({ wallet: OUTSIDER, door: "http", furthestStage: "submitted" })],
    totals: { ...baseInput().totals, browsed: 1 },
    httpTotals: { ...baseInput().httpTotals, submitted: 1 }
  }));
  const mcpRows = Object.fromEntries(view.doors.mcp.rows.map((row) => [row.stage, row]));
  const httpRows = Object.fromEntries(view.doors.http.rows.map((row) => [row.stage, row]));

  assert.equal(view.outsiders.furthestEver.agents, 1);
  assert.equal(mcpRows.submitted.outsider, 0);
  assert.equal(httpRows.submitted.outsider, 1);
});
