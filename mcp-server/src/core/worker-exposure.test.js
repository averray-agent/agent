import test from "node:test";
import assert from "node:assert/strict";

import {
  EXTERNAL_REWARD_EXCEEDS_CAPITAL_CEILING_REASON,
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
    capUsdc: options.capUsdc ?? 1,
    vestedOpenExposureUnitRaw: options.vestedOpenExposureUnitRaw ?? 500_000,
    externalRewardCeilingBaseRaw: options.externalRewardCeilingBaseRaw ?? 1_000_000,
    externalCeilingPerVestedMilli: options.externalCeilingPerVestedMilli ?? 1_000,
    resolveVesting: options.resolveVesting ?? (async () => ({ vestedRaw: 0n, tranches: [] })),
    logger: options.logger ?? {}
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

test("worker exposure and external ceiling config carry the reviewed defaults", () => {
  assert.deepEqual(loadWorkerExposureConfig({}), {
    capUsdc: 2.5,
    vestedOpenExposureUnitRaw: 500_000,
    externalRewardCeilingBaseRaw: 1_000_000,
    externalCeilingPerVestedMilli: 1_000
  });
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

test("v3 payout retention does not refund open exposure before a successful settlement", async () => {
  const result = await policy().evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics({
      claimEconomicsWaived: false,
      claimFeeRetainedOnSuccess: false,
      gasRetentionSupported: true
    })
  });

  assert.deepEqual(result.candidate, {
    reservedRewardUsdc: 0.5,
    brokeredGasUsdc: 0.059,
    totalUsdc: 0.559
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

test("external jobs are capital-gated at the base ceiling without consuming operator exposure", async () => {
  const atBase = await policy().evaluate({
    wallet: WALLET,
    job: job({ rewardAmount: 1, source: "external", poster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    claimEconomics: economics()
  });
  const aboveBase = await policy().evaluate({
    wallet: WALLET,
    job: job({ rewardAmount: 1.000001, source: "external", poster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    claimEconomics: economics()
  });

  assert.equal(atBase.eligible, true);
  assert.equal(atBase.applies, true);
  assert.equal(atBase.consumesOperatorExposure, false);
  assert.equal(aboveBase.eligible, false);
  assert.equal(aboveBase.reason, EXTERNAL_REWARD_EXCEEDS_CAPITAL_CEILING_REASON);
  assert.equal(aboveBase.externalRewardCeilingRaw, "1000000");
});

test("ten vested USDC raises open capacity concavely and the external ceiling linearly", async () => {
  const resolveVesting = async () => ({ vestedRaw: 10_000_000n, tranches: [] });
  const catalogue = await policy({ capUsdc: 2.5, resolveVesting }).evaluate({
    wallet: WALLET,
    job: job(),
    claimEconomics: economics()
  });
  const external = await policy({ capUsdc: 2.5, resolveVesting }).evaluate({
    wallet: WALLET,
    job: job({ rewardAmount: 11, source: "external", poster: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
    claimEconomics: economics()
  });

  assert.equal(catalogue.capUsdc, 4);
  assert.equal(catalogue.openExposureRaiseUsdc, 1.5);
  assert.equal(catalogue.vestedAssetsUsdc, 10);
  assert.equal(external.eligible, true);
  assert.equal(external.externalRewardCeilingUsdc, 11);
});

test("a withdrawal reflected by the vesting resolver drops every raise immediately", async () => {
  let vestedRaw = 10_000_000n;
  const exposure = policy({
    capUsdc: 2.5,
    resolveVesting: async () => ({ vestedRaw, tranches: [] })
  });
  const before = await exposure.capacityForWallet(WALLET);
  vestedRaw = 0n;
  const after = await exposure.capacityForWallet(WALLET);

  assert.equal(before.openExposureCapUsdc, 4);
  assert.equal(before.externalRewardCeilingUsdc, 11);
  assert.equal(after.openExposureCapUsdc, 2.5);
  assert.equal(after.externalRewardCeilingUsdc, 1);
});

test("vesting read failures fail closed to the unvested capacity", async () => {
  const capacity = await policy({
    capUsdc: 2.5,
    resolveVesting: async () => { throw new Error("RPC unavailable"); }
  }).capacityForWallet(WALLET);

  assert.equal(capacity.vestedAssetsRaw, "0");
  assert.equal(capacity.openExposureCapUsdc, 2.5);
  assert.equal(capacity.externalRewardCeilingUsdc, 1);
  assert.equal(capacity.vestingAvailable, false);
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
