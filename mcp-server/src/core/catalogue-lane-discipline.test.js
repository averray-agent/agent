import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCatalogueDefinitionsHaveLanes,
  CatalogueLaneDiscipline,
  DEFAULT_CATALOGUE_LANE_REGISTRY,
  LANE_BACKLOG_SATURATED,
  LANE_BUDGET_EXHAUSTED,
  LANE_PAUSED,
  validateCatalogueLaneRegistry
} from "./catalogue-lane-discipline.js";
import { DEFAULT_WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW } from "./catalogue-daily-budget.js";

const NOW = new Date("2026-08-13T12:00:00.000Z");

function job(id, lane = "liveness", rewardAmount = 0.5) {
  return { id, lane, rewardAmount, rewardAsset: "USDC" };
}

function stateStore(sessions = []) {
  const states = new Map();
  const locks = new Map();
  return {
    async getServiceState(scope) {
      return states.get(scope);
    },
    async upsertServiceState(scope, state) {
      const next = { ...(states.get(scope) ?? {}), ...structuredClone(state) };
      states.set(scope, next);
      return next;
    },
    async listRecentSessions(limit, offset = 0) {
      return sessions.slice(offset, offset + limit);
    },
    async acquireClaimLock(lockId, owner) {
      if (locks.has(lockId) && locks.get(lockId) !== owner) return false;
      locks.set(lockId, owner);
      return true;
    },
    async releaseClaimLock(lockId, owner) {
      if (locks.get(lockId) === owner) locks.delete(lockId);
    }
  };
}

function registry(entries = {}) {
  return validateCatalogueLaneRegistry({
    liveness: {
      hypothesis: "liveness hypothesis",
      dailyCapRaw: "1000000",
      stopCondition: "liveness stop",
      paused: false
    },
    "oss-anchored": {
      hypothesis: "oss hypothesis",
      dailyCapRaw: "1000000",
      stopCondition: "oss stop",
      paused: false
    },
    ...entries
  });
}

test("D3 startup validation names the packet for unlaned definitions", () => {
  assert.throws(
    () => assertCatalogueDefinitionsHaveLanes([{ id: "unlaned" }], registry()),
    /PACKET_D3_LANE_DISCIPLINE\.md: catalogue definition unlaned is missing lane/u
  );
});

test("D3 startup validation refuses incomplete lane registry entries", () => {
  assert.throws(
    () => validateCatalogueLaneRegistry({ liveness: { hypothesis: "test", dailyCapRaw: "1" } }),
    /PACKET_D3_LANE_DISCIPLINE\.md: lane liveness is missing stopCondition/u
  );
});

test("lane budget allows the exact cap, refuses the next post, and leaves another lane available", async () => {
  const store = stateStore();
  const discipline = new CatalogueLaneDiscipline({
    stateStore: store,
    registry: registry(),
    gasEstimateUsdc: 0,
    now: () => NOW,
    logger: { info() {} }
  });
  const posted = [];

  await discipline.post(job("live-1"), async () => posted.push("live-1"));
  await discipline.post(job("live-2"), async () => posted.push("live-2"));
  await assert.rejects(
    discipline.post(job("live-3", "liveness", 0.000001), async () => posted.push("live-3")),
    (error) => {
      assert.equal(error.code, LANE_BUDGET_EXHAUSTED);
      assert.equal(error.details.lane, "liveness");
      assert.equal(error.details.resumeAt, "2026-08-14T12:00:00.000Z");
      return true;
    }
  );
  await discipline.post(job("oss-1", "oss-anchored", 0.5), async () => posted.push("oss-1"));

  assert.deepEqual(posted, ["live-1", "live-2", "oss-1"]);
  assert.equal(DEFAULT_WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW, 25_000_000);
  assert.equal(
    Object.values(DEFAULT_CATALOGUE_LANE_REGISTRY).reduce(
      (total, lane) => total + Number(lane.dailyCapRaw),
      0
    ),
    23_000_000
  );
});

test("posted exposure persists across service recreation and includes expected brokered gas", async () => {
  const store = stateStore();
  const first = new CatalogueLaneDiscipline({
    stateStore: store,
    registry: registry(),
    gasEstimateUsdc: 0.059,
    now: () => NOW
  });
  await first.post(job("first", "liveness", 0.1), async () => undefined);

  const restarted = new CatalogueLaneDiscipline({
    stateStore: store,
    registry: registry(),
    gasEstimateUsdc: 0.059,
    now: () => NOW
  });
  const board = await restarted.getBoardSnapshot();
  const lane = board.lanes.find((entry) => entry.id === "liveness");
  assert.equal(lane.exposure24h.usedRaw, "159000");
  assert.equal(lane.jobsPosted24h, 1);
});

test("paused lane creates nothing while an unpaused lane still posts", async () => {
  const discipline = new CatalogueLaneDiscipline({
    stateStore: stateStore(),
    registry: registry({
      liveness: {
        hypothesis: "liveness hypothesis",
        dailyCapRaw: "1000000",
        stopCondition: "liveness stop",
        paused: true
      }
    }),
    gasEstimateUsdc: 0,
    now: () => NOW
  });
  let actions = 0;
  await assert.rejects(
    discipline.post(job("paused"), async () => { actions += 1; }),
    (error) => error.code === LANE_PAUSED && error.details.retryWhen === "operator_resumes_lane"
  );
  await discipline.post(job("open", "oss-anchored"), async () => { actions += 1; });
  assert.equal(actions, 1);
});

test("external poster-funded jobs bypass catalogue lanes", async () => {
  const discipline = new CatalogueLaneDiscipline({
    stateStore: stateStore(),
    registry: registry({
      liveness: {
        hypothesis: "liveness hypothesis",
        dailyCapRaw: "0",
        stopCondition: "liveness stop",
        paused: true
      }
    }),
    gasEstimateUsdc: 0,
    now: () => NOW
  });
  let posted = false;
  await discipline.post({
    id: "external",
    rewardAmount: 10,
    source: { type: "external" }
  }, async () => { posted = true; });
  assert.equal(posted, true);
});

test("failed posting releases its lane reservation", async () => {
  const discipline = new CatalogueLaneDiscipline({
    stateStore: stateStore(),
    registry: registry(),
    gasEstimateUsdc: 0,
    now: () => NOW
  });
  await assert.rejects(
    discipline.post(job("failed", "liveness", 1), async () => { throw new Error("post failed"); }),
    /post failed/u
  );
  await discipline.post(job("replacement", "liveness", 1), async () => undefined);
  const board = await discipline.getBoardSnapshot();
  assert.equal(board.lanes.find((lane) => lane.id === "liveness").jobsPosted24h, 1);
});

test("board payload reports lane spend, external share, retained worker cost, hypothesis and stop", async () => {
  const external = "0x1111111111111111111111111111111111111111";
  const self = "0x2222222222222222222222222222222222222222";
  const sessions = [
    settledSession("external", external, "liveness", "400000", "2026-08-12T12:01:00.000Z"),
    settledSession("self", self, "liveness", "100000", "2026-08-12T13:00:00.000Z")
  ];
  const discipline = new CatalogueLaneDiscipline({
    stateStore: stateStore(sessions),
    registry: registry(),
    gasEstimateUsdc: 0,
    selfWallets: new Set([self]),
    now: () => NOW
  });
  await discipline.post(job("posted", "liveness", 0.25), async () => undefined);

  const board = await discipline.getBoardSnapshot();
  const lane = board.lanes.find((entry) => entry.id === "liveness");
  assert.deepEqual(lane.exposure24h, {
    usedRaw: "250000",
    capRaw: "1000000",
    remainingRaw: "750000",
    used: "0.25",
    cap: "1",
    remaining: "0.75"
  });
  assert.equal(lane.jobsPosted24h, 1);
  assert.deepEqual(lane.claimantShare24h, {
    claimantCount: 2,
    externalClaimantCount: 1,
    externalShareBps: 5000
  });
  assert.equal(lane.retainedExternalWorkers14d, 1);
  assert.equal(lane.costPerRetainedExternalWorker30d.raw, "500000");
  assert.equal(lane.hypothesis, "liveness hypothesis");
  assert.equal(lane.stopCondition, "liveness stop");
  assert.equal(board.lanes.find((entry) => entry.id === "oss-anchored").claimantShare24h.externalClaimantCount, 0);
});

function settledSession(id, wallet, lane, workerAmountRaw, at) {
  return {
    sessionId: id,
    wallet,
    claimedAt: at,
    resolvedAt: at,
    jobSnapshot: { definition: { id: `${id}-job`, lane } },
    payoutTx: {
      status: 1,
      settlement: { assetSymbol: "USDC", workerAmountRaw }
    }
  };
}

// A lane whose spend cap is deliberately far out of the way, so the BACKLOG gate
// is the only thing that can refuse. Without this the daily cap fires first and
// the throttle would look tested while never running.
function roomyRegistry(maxUnclaimedBacklog = 2) {
  return validateCatalogueLaneRegistry({
    liveness: {
      hypothesis: "liveness hypothesis",
      dailyCapRaw: "100000000",
      maxUnclaimedBacklog,
      stopCondition: "liveness stop",
      paused: false
    },
    "oss-anchored": {
      hypothesis: "oss hypothesis",
      dailyCapRaw: "100000000",
      maxUnclaimedBacklog,
      stopCondition: "oss stop",
      paused: false
    }
  });
}

function claimSession(jobId, claimedAt = "2026-08-13T11:30:00.000Z") {
  return { jobId, wallet: "0x1111111111111111111111111111111111111111", claimedAt };
}

test("lane stops posting once its unclaimed backlog is full, and says what it withheld", async () => {
  const store = stateStore();
  const logged = [];
  const discipline = new CatalogueLaneDiscipline({
    stateStore: store,
    registry: roomyRegistry(2),
    gasEstimateUsdc: 0,
    now: () => NOW,
    logger: { info(details, message) { logged.push({ details, message }); } }
  });
  const posted = [];

  await discipline.post(job("live-1"), async () => posted.push("live-1"));
  await discipline.post(job("live-2"), async () => posted.push("live-2"));

  await assert.rejects(
    discipline.post(job("live-3"), async () => posted.push("live-3")),
    (error) => {
      assert.equal(error.code, LANE_BACKLOG_SATURATED);
      assert.equal(error.details.lane, "liveness");
      assert.equal(error.details.unclaimedCount, 2);
      assert.equal(error.details.maxUnclaimedBacklog, 2);
      assert.equal(error.details.withheldJobId, "live-3");
      assert.equal(error.details.oldestUnclaimedAt, NOW.toISOString());
      return true;
    }
  );

  // spend is NOT the reason — the cap is 100 USDC and three jobs cost 1.5.
  assert.deepEqual(posted, ["live-1", "live-2"]);
  // no silent caps: the refusal is on the record with its reason
  assert.ok(logged.some((entry) => entry.message === LANE_BACKLOG_SATURATED
    && entry.details.withheldJobId === "live-3"));
  // a saturated lane must not block a different lane
  await discipline.post(job("oss-1", "oss-anchored"), async () => posted.push("oss-1"));
  assert.deepEqual(posted, ["live-1", "live-2", "oss-1"]);
});

test("posting resumes as soon as a queued job is claimed", async () => {
  const claimed = [];
  const store = stateStore(claimed);
  const discipline = new CatalogueLaneDiscipline({
    stateStore: store,
    registry: roomyRegistry(2),
    gasEstimateUsdc: 0,
    now: () => NOW,
    logger: { info() {} }
  });
  const posted = [];

  await discipline.post(job("live-1"), async () => posted.push("live-1"));
  await discipline.post(job("live-2"), async () => posted.push("live-2"));
  await assert.rejects(
    discipline.post(job("live-3"), async () => posted.push("live-3")),
    (error) => error.code === LANE_BACKLOG_SATURATED
  );

  // demand arrives: one queued job gets claimed, so the lane may post again.
  claimed.push(claimSession("live-1"));
  await discipline.post(job("live-3"), async () => posted.push("live-3"));

  assert.deepEqual(posted, ["live-1", "live-2", "live-3"]);
});

test("backlog cap is validated, not silently coerced", () => {
  assert.throws(
    () => validateCatalogueLaneRegistry({
      liveness: {
        hypothesis: "h",
        dailyCapRaw: "1000000",
        maxUnclaimedBacklog: 0,
        stopCondition: "s"
      }
    }),
    /maxUnclaimedBacklog must be a positive integer/u
  );
});

test("a disposable proof job posts through a saturated lane, but still pays the budget", async () => {
  const store = stateStore();
  const discipline = new CatalogueLaneDiscipline({
    stateStore: store,
    registry: roomyRegistry(2),
    gasEstimateUsdc: 0,
    now: () => NOW,
    logger: { info() {} }
  });
  const posted = [];

  await discipline.post(job("live-1"), async () => posted.push("live-1"));
  await discipline.post(job("live-2"), async () => posted.push("live-2"));
  await assert.rejects(
    discipline.post(job("live-3"), async () => posted.push("live-3")),
    (error) => error.code === LANE_BACKLOG_SATURATED
  );

  // The canary's shape: same lane, saturated backlog, but it brings its own
  // claimant — the backlog gate must not refuse it.
  const canary = { ...job("worker-canary-1"), disposableProof: true };
  await discipline.post(canary, async () => posted.push("worker-canary-1"));
  assert.deepEqual(posted, ["live-1", "live-2", "worker-canary-1"]);

  // Budget still counts proof spend: a tight-budget lane refuses the canary on
  // BUDGET, proving the exemption is backlog-only.
  const tight = new CatalogueLaneDiscipline({
    stateStore: stateStore(),
    registry: registry(),
    gasEstimateUsdc: 0,
    now: () => NOW,
    logger: { info() {} }
  });
  await tight.post(job("a", "liveness", 1.0), async () => {});
  await assert.rejects(
    tight.post({ ...job("proof-b", "liveness", 0.5), disposableProof: true }, async () => {}),
    (error) => error.code === LANE_BUDGET_EXHAUSTED
  );
});

test("disposable proof jobs never count as backlog against ordinary posting", async () => {
  const store = stateStore();
  const discipline = new CatalogueLaneDiscipline({
    stateStore: store,
    registry: roomyRegistry(1),
    gasEstimateUsdc: 0,
    now: () => NOW,
    logger: { info() {} }
  });
  const posted = [];

  await discipline.post({ ...job("proof-1"), disposableProof: true }, async () => posted.push("proof-1"));
  await discipline.post({ ...job("proof-2"), disposableProof: true }, async () => posted.push("proof-2"));
  // Two unclaimed proof jobs sit in the window; the cap is 1. An ordinary job
  // must still post — proofs are not inventory.
  await discipline.post(job("live-1"), async () => posted.push("live-1"));
  assert.deepEqual(posted, ["proof-1", "proof-2", "live-1"]);
  // And the SECOND ordinary job is refused by the first one's backlog.
  await assert.rejects(
    discipline.post(job("live-2"), async () => posted.push("live-2")),
    (error) => error.code === LANE_BACKLOG_SATURATED && error.details.unclaimedCount === 1
  );
});
