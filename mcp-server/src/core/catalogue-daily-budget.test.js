import test from "node:test";
import assert from "node:assert/strict";

import {
  CATALOGUE_DAILY_BUDGET_EXHAUSTED_REASON,
  CatalogueDailyBudget,
  loadCatalogueDailyBudgetConfig
} from "./catalogue-daily-budget.js";
import { MemoryStateStore } from "./state-store.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = new Date("2026-08-13T12:00:00.000Z");
const CANDIDATE = {
  reservedRewardUsdc: 0.25,
  brokeredGasUsdc: 0.059,
  totalUsdc: 0.309
};

function catalogueJob(overrides = {}) {
  return { id: "catalogue-job", source: "curated", rewardAsset: "USDC", rewardAmount: 0.25, ...overrides };
}

function externalJob() {
  return catalogueJob({ source: "external", poster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
}

function policy(stateStore, budgetRaw = 25_000_000) {
  return new CatalogueDailyBudget({
    stateStore,
    budgetRaw,
    now: () => NOW
  });
}

async function putClaim(stateStore, {
  id,
  claimedAt,
  status = "resolved",
  candidate = CANDIDATE
}) {
  await stateStore.upsertSession({
    sessionId: id,
    jobId: `${id}-job`,
    wallet: WALLET,
    status,
    claimedAt,
    jobSnapshot: { definition: catalogueJob({ id: `${id}-job` }) },
    catalogueDailyBudget: {
      version: "catalogue-daily-budget-v1",
      candidate
    }
  });
}

test("catalogue global budget has the reviewed default and zero kill-switch", () => {
  assert.deepEqual(loadCatalogueDailyBudgetConfig({}), { budgetRaw: 25_000_000, newcomerBudgetRaw: 2_000_000 });
  assert.deepEqual(
    loadCatalogueDailyBudgetConfig({ WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW: "0" }),
    { budgetRaw: 0, newcomerBudgetRaw: 2_000_000 }
  );
  assert.throws(
    () => new CatalogueDailyBudget({
      stateStore: { listRecentSessions: async () => [] }
    }),
    /requires a durable global claim lock/u
  );
});

test("zero global budget refuses catalogue while an external claim still passes", async () => {
  const budget = policy(new MemoryStateStore(), 0);
  const catalogue = await budget.evaluate({
    job: catalogueJob(),
    workerExposure: { candidate: CANDIDATE }
  });
  const external = await budget.evaluate({
    job: externalJob(),
    workerExposure: { candidate: CANDIDATE }
  });

  assert.equal(catalogue.eligible, false);
  assert.equal(catalogue.reason, CATALOGUE_DAILY_BUDGET_EXHAUSTED_REASON);
  assert.equal(external.eligible, true);
  assert.equal(external.applies, false);
});

test("configured 5 USDC rolling budget refuses excess, accepts the boundary, and exempts external work", async () => {
  const stateStore = new MemoryStateStore();
  await putClaim(stateStore, {
    id: "global-oldest",
    claimedAt: "2026-08-12T13:00:00.000Z",
    candidate: { reservedRewardUsdc: 4.75, brokeredGasUsdc: 0, totalUsdc: 4.75 }
  });
  const budget = policy(stateStore, loadCatalogueDailyBudgetConfig({
    WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW: "5000000"
  }).budgetRaw);
  const boundary = await budget.evaluate({
    catalogueAccess: { established: true },
    job: catalogueJob(),
    workerExposure: { candidate: { reservedRewardUsdc: 0.25, brokeredGasUsdc: 0, totalUsdc: 0.25 } }
  });
  assert.equal(boundary.eligible, true);
  assert.equal(boundary.projectedCatalogueExposureRaw, "5000000");

  const refused = await budget.evaluate({
    job: catalogueJob(),
    workerExposure: { candidate: CANDIDATE }
  });
  const external = await budget.evaluate({
    job: externalJob(),
    workerExposure: { candidate: CANDIDATE }
  });

  assert.equal(refused.eligible, false);
  assert.equal(refused.reason, CATALOGUE_DAILY_BUDGET_EXHAUSTED_REASON);
  assert.equal(refused.retryAfter, "2026-08-13T13:00:00.000Z");
  assert.equal(refused.catalogueDailyBudgetUsedRaw, "4750000");
  assert.equal(refused.projectedCatalogueExposureRaw, "5059000");
  assert.equal(refused.catalogueDailyBudgetRaw, "5000000");
  assert.equal(external.eligible, true);
  assert.equal(external.applies, false);
});

test("settlement never refunds the rolling global catalogue window", async () => {
  const stateStore = new MemoryStateStore();
  await putClaim(stateStore, {
    id: "settled-catalogue",
    claimedAt: "2026-08-13T11:00:00.000Z",
    status: "resolved"
  });

  const status = await policy(stateStore).getStatus();
  assert.equal(status.usedRaw, "309000");
  assert.equal(status.claimCount, 1);
  assert.equal(status.windowSeconds, 86_400);
});

const dollar = { reservedRewardUsdc: 0.941, brokeredGasUsdc: 0.059, totalUsdc: 1 };
const request = { job: catalogueJob(), workerExposure: { candidate: dollar } };

test("legacy exposure and both v2 classes remain global; newcomer release times use only newcomer spend", async () => {
  const store = new MemoryStateStore();
  let now = Date.parse("2026-08-13T11:59:59Z");
  const budget = new CatalogueDailyBudget({ stateStore: store, now: () => now });
  const v1 = "2026-08-12T12:00:00Z";
  await putClaim(store, { id: "legacy", claimedAt: v1, candidate: dollar });
  for (const [newcomer, at] of [[true, "2026-08-12T18:00:00Z"], [false, "2026-08-12T11:59:59.500Z"]]) {
    await store.upsertSession({ sessionId: String(newcomer), claimedAt: at, status: "claimed",
      catalogueDailyBudget: { version: "catalogue-daily-budget-v2", newcomer, candidate: dollar } });
  }
  const before = await budget.getStatus();
  assert.equal(before.usedRaw, "3000000");
  assert.deepEqual(before.newcomer, { totalRaw: "2000000", usedRaw: "2000000", remainingRaw: "0",
    total: 2, used: 2, remaining: 0, claimCount: 2, nextReleaseAt: "2026-08-13T12:00:00.000Z" });
  const refused = await budget.evaluate(request);
  assert.equal(refused.reason, "catalogue_newcomer_budget_exhausted");
  assert.equal(refused.retryAfter, before.newcomer.nextReleaseAt);
  const both = await budget.evaluate({ ...request, workerExposure: { candidate: { reservedRewardUsdc: 2, totalUsdc: 2, brokeredGasUsdc: 0 } } });
  assert.equal(both.retryAfter, "2026-08-13T18:00:00.000Z");
  now += 2000;
  assert.equal((await budget.evaluate(request)).eligible, true);
  assert.equal((await budget.getStatus()).newcomer.usedRaw, "1000000");
});

test("global refusal takes precedence even when a newcomer fits the pool", async () => {
  const store = new MemoryStateStore();
  await store.upsertSession({ sessionId: "prior", claimedAt: NOW.toISOString(), status: "claimed",
    catalogueDailyBudget: { version: "catalogue-daily-budget-v2", newcomer: false, candidate: dollar } });
  const decision = await policy(store, 1_500_000).evaluate(request);
  assert.equal(decision.reason, "catalogue_daily_budget_exhausted");
  assert.equal(decision.eligible, false);
});

test("missing and empty newcomer settings are bounded; malformed settings fail startup", () => {
  const key = "WORKER_CATALOGUE_NEWCOMER_DAILY_BUDGET_RAW";
  for (const value of [undefined, ""]) assert.equal(loadCatalogueDailyBudgetConfig({ [key]: value }).newcomerBudgetRaw, 2_000_000);
  for (const value of [" ", "2.5", "2e6", "-1", "NaN", "99999999999999999999999"]) {
    assert.throws(() => loadCatalogueDailyBudgetConfig({ [key]: value }), { name: "ConfigError" });
  }
});

test("zero pool refuses even zero-cost newcomers; external work skips all shared reads", async () => {
  const store = new MemoryStateStore();
  const budget = new CatalogueDailyBudget({ stateStore: store, newcomerBudgetRaw: 0 });
  const free = { ...request, workerExposure: { candidate: { reservedRewardUsdc: 0, brokeredGasUsdc: 0, totalUsdc: 0 } } };
  assert.equal((await budget.evaluate(free)).reason, "catalogue_newcomer_budget_exhausted");
  assert.equal((await budget.evaluate({ ...request, catalogueAccess: { established: true } })).eligible, true);
  let reads = 0;
  store.listRecentSessions = () => { reads++; throw Error(WALLET); };
  const external = await budget.evaluate({ ...request, job: externalJob() });
  assert.equal(external.eligible, true);
  assert.equal(external.applies, false);
  assert.equal(reads, 0);
  for (const response of [() => { throw Error(WALLET); }, () => null]) {
    store.listRecentSessions = response;
    const failed = await budget.evaluate(request);
    assert.equal(failed.eligible, false);
    assert.equal(failed.reason, "catalogue_daily_budget_unavailable");
    assert.doesNotMatch(JSON.stringify(failed), /0x[\da-f]{40}/i);
  }
});
