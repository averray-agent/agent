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
  assert.deepEqual(loadCatalogueDailyBudgetConfig({}), { budgetRaw: 25_000_000 });
  assert.deepEqual(
    loadCatalogueDailyBudgetConfig({ WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW: "0" }),
    { budgetRaw: 0 }
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

test("global rolling exhaustion reports the oldest claim age-out while external work bypasses it", async () => {
  const stateStore = new MemoryStateStore();
  await putClaim(stateStore, {
    id: "global-oldest",
    claimedAt: "2026-08-12T13:00:00.000Z",
    candidate: { reservedRewardUsdc: 0.75, brokeredGasUsdc: 0, totalUsdc: 0.75 }
  });
  const budget = policy(stateStore, 1_000_000);

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
  assert.equal(refused.catalogueDailyBudgetUsedRaw, "750000");
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
