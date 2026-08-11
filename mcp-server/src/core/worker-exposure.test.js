import test from "node:test";
import assert from "node:assert/strict";

import {
  WorkerExposurePolicy,
  loadWorkerExposureConfig,
  WORKER_EXPOSURE_CAP_REACHED_REASON,
  WORKER_EXPOSURE_UNAVAILABLE_REASON
} from "./worker-exposure.js";
import { MemoryStateStore } from "./state-store.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function job(overrides = {}) {
  return {
    id: "job-candidate",
    source: "curated",
    rewardAsset: "USDC",
    rewardAmount: 0.5,
    ...overrides
  };
}

function economics(overrides = {}) {
  return {
    claimEconomicsWaived: true,
    claimFeeRetainedOnSuccess: false,
    ...overrides
  };
}

function policy(options = {}) {
  return new WorkerExposurePolicy({
    stateStore: options.stateStore ?? new MemoryStateStore(),
    blockchainGateway: options.blockchainGateway,
    gasEstimateUsdc: options.gasEstimateUsdc ?? 0.059,
    capUsdc: options.capUsdc ?? 1
  });
}

test("worker exposure counts reserved reward plus brokered gas for waived claims", async () => {
  const result = await policy().evaluate({ wallet: WALLET, job: job(), claimEconomics: economics() });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.candidate, {
    reservedRewardUsdc: 0.5,
    brokeredGasUsdc: 0.059,
    totalUsdc: 0.559
  });
});

test("worker exposure cap has a finite reviewed default and rejects non-positive overrides", () => {
  assert.deepEqual(loadWorkerExposureConfig({}), { capUsdc: 2.5 });
  assert.throws(
    () => loadWorkerExposureConfig({ WORKER_OPEN_EXPOSURE_CAP_USDC: "0" }),
    /WORKER_OPEN_EXPOSURE_CAP_USDC must be greater than zero/u
  );
});

test("retained post-tier claim fee removes brokered gas from operator exposure", async () => {
  const result = await policy().evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics({
      claimEconomicsWaived: false,
      claimFeeRetainedOnSuccess: true
    })
  });

  assert.deepEqual(result.candidate, {
    reservedRewardUsdc: 0.5,
    brokeredGasUsdc: 0,
    totalUsdc: 0.5
  });
});

test("open session exposure and candidate exposure enforce the cap in USDC", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession({
    sessionId: "open-1",
    wallet: WALLET,
    jobId: "job-open",
    status: "submitted",
    workerExposure: {
      candidate: {
        reservedRewardUsdc: 0.5,
        brokeredGasUsdc: 0.059,
        totalUsdc: 0.559
      }
    }
  });

  const result = await policy({ stateStore, capUsdc: 1 }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });

  assert.equal(result.eligible, false);
  assert.equal(result.reason, WORKER_EXPOSURE_CAP_REACHED_REASON);
  assert.equal(result.currentExposureUsdc, 0.559);
  assert.equal(result.projectedExposureUsdc, 1.118);
});

test("closed sessions release exposure headroom", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession({
    sessionId: "closed-1",
    wallet: WALLET,
    jobId: "job-closed",
    status: "settled",
    workerExposure: {
      candidate: {
        reservedRewardUsdc: 0.5,
        brokeredGasUsdc: 0.059,
        totalUsdc: 0.559
      }
    }
  });

  const result = await policy({ stateStore, capUsdc: 1 }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });

  assert.equal(result.eligible, true);
  assert.equal(result.currentExposureUsdc, 0);
});

test("an active session without a claim snapshot fails closed instead of counting zero", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession({
    sessionId: "unknown-1",
    wallet: WALLET,
    jobId: "job-unknown",
    status: "claimed"
  });

  const result = await policy({ stateStore }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });

  assert.equal(result.eligible, false);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, WORKER_EXPOSURE_UNAVAILABLE_REASON);
  assert.match(result.error, /no claim-time exposure inputs/u);
});

test("external poster-funded work does not consume operator exposure", async () => {
  const result = await policy().evaluate({
    wallet: WALLET,
    job: job({ source: "external", poster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    claimEconomics: economics()
  });

  assert.equal(result.eligible, true);
  assert.equal(result.applies, false);
  assert.equal(result.status, "not_applicable");
});

test("open external sessions do not consume operator exposure for a later curated claim", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession({
    sessionId: "external-open",
    wallet: WALLET,
    jobId: "external-open-job",
    status: "claimed",
    jobSnapshot: {
      definition: job({
        id: "external-open-job",
        source: "external",
        poster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }),
      claimEconomics: economics()
    }
  });

  const result = await policy({ stateStore, capUsdc: 1 }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });

  assert.equal(result.currentExposureUsdc, 0);
  assert.equal(result.currentOpenSessionCount, 0);
  assert.equal(result.eligible, true);
});

test("a live chain state, not stale local status, decides whether exposure remains open", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession({
    sessionId: "chain-closed",
    wallet: WALLET,
    jobId: "job-chain-closed",
    status: "submitted",
    workerExposure: {
      candidate: {
        reservedRewardUsdc: 0.5,
        brokeredGasUsdc: 0.059,
        totalUsdc: 0.559
      }
    }
  });
  const blockchainGateway = {
    isEnabled: () => true,
    getJob: async () => ({ state: 6 })
  };

  const result = await policy({ stateStore, blockchainGateway }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });

  assert.equal(result.currentExposureUsdc, 0);
  assert.equal(result.eligible, true);
});

test("definitely closed local sessions release exposure without replaying lifetime chain reads", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession({
    sessionId: "resolved-locally",
    wallet: WALLET,
    jobId: "job-resolved-locally",
    status: "resolved",
    workerExposure: {
      candidate: {
        reservedRewardUsdc: 0.5,
        brokeredGasUsdc: 0.059,
        totalUsdc: 0.559
      }
    }
  });
  let reads = 0;
  const blockchainGateway = {
    isEnabled: () => true,
    getJob: async () => {
      reads += 1;
      return { state: 3 };
    }
  };

  const result = await policy({ stateStore, blockchainGateway }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });

  assert.equal(result.currentExposureUsdc, 0);
  assert.equal(reads, 0);
});

test("locally rejected sessions still consult chain because their dispute window reserves exposure", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession({
    sessionId: "rejected-with-window",
    wallet: WALLET,
    jobId: "job-rejected-with-window",
    status: "rejected",
    workerExposure: {
      candidate: {
        reservedRewardUsdc: 0.5,
        brokeredGasUsdc: 0.059,
        totalUsdc: 0.559
      }
    }
  });
  let reads = 0;
  const blockchainGateway = {
    isEnabled: () => true,
    getJob: async () => {
      reads += 1;
      return { state: 4 };
    }
  };

  const result = await policy({ stateStore, blockchainGateway }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });

  assert.equal(result.currentExposureUsdc, 0.559);
  assert.equal(reads, 1);
});
