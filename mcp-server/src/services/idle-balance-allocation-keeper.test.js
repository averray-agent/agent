import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStateStore } from "../core/state-store.js";
import { createIdleBalanceConsentRoutes } from "../protocols/http/idle-balance-consent-routes.js";
import {
  AAC_IDLE_DEPOSIT_POOL_V21,
  ALLOCATION_KEEPER_WRITE_FUNCTIONS,
  DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER,
  DEPLOYED_DEPOSIT_POOL_V21,
  allocationKeeperWriteFunctionNames,
  classifyAllocationKeeperMovementError
} from "./idle-balance-allocation-chain.js";
import {
  IdleBalanceAllocationKeeperService,
  loadIdleBalanceAllocationKeeperConfig
} from "./idle-balance-allocation-keeper.js";

const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";
const SETTLEMENT_SIGNER = "0x5a6836c6D4d293F6E5377E6c28054F4171915813";
const ACCOUNT = "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57";
const USDC = "0x0000053900000000000000000000000001200000";
const NOW = new Date("2026-08-26T08:30:00.000Z");

test("settlement signer funding wallet is structurally excluded even with active consent", async () => {
  const config = loadIdleBalanceAllocationKeeperConfig({
    AUTH_CHAIN_ID: "420420419",
    IDLE_BALANCE_ALLOCATION_ROUTE_LIVE: "true",
    IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED: "true"
  }, {
    agentAccountAddress: ACCOUNT,
    assetAddress: USDC,
    poolAddress: DEPLOYED_DEPOSIT_POOL_V21,
    adapterAddress: DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER
  });
  assert.deepEqual(config.allocationExclusions, [{
    wallet: SETTLEMENT_SIGNER,
    role: "settlement_signer",
    source: "deployment_manifest.verifier"
  }]);

  const h = await harness({ wallets: [SETTLEMENT_SIGNER] });
  h.chain.positions.set(SETTLEMENT_SIGNER, position(16_073_522n));
  h.consent.assessAllocationAttempt = async () => {
    throw new Error("an excluded funding wallet must be rejected before consent assessment");
  };

  const result = await h.keeper.runOnce(NOW);

  assert.equal(result.allocationCount, 0);
  assert.equal(h.chain.calls.allocate.length, 0);
  assert.equal(h.chain.calls.positionReads, 0);
  assert.ok(result.skipped.some((entry) =>
    entry.wallet === SETTLEMENT_SIGNER.toLowerCase()
      && entry.reason === "allocation_excluded_operator_funding_source"));
});

test("excluded settlement signer can still deallocate an existing position", async () => {
  const h = await harness({ wallets: [SETTLEMENT_SIGNER] });
  h.chain.shares.set(SETTLEMENT_SIGNER, 4_073_522n);
  h.chain.float = floatState({
    floatRaw: 1_018_380n,
    totalAssetsRaw: 4_073_522n,
    totalSharesRaw: 4_073_522n,
    poolSharesRaw: 3_055_142n,
    poolAssetsRaw: 3_055_142n
  });
  h.consent.assessAllocationAttempt = async () => {
    throw new Error("exit must never consult consent or allocation exclusions");
  };

  const result = await h.keeper.deallocate(SETTLEMENT_SIGNER, { amountRaw: "1000000" });

  assert.equal(result.status, "deallocated");
  assert.deepEqual(h.chain.calls.deallocate, [{ wallet: SETTLEMENT_SIGNER, amountRaw: "1000000" }]);
  assert.equal(result.evidence.consent.reason, "exit_never_requires_consent");
});

test("revoked-between-scan-and-send refuses with idle_balance_consent_revoked and sends nothing", async () => {
  const h = await harness({ wallets: [WALLET_A] });
  h.chain.positions.set(WALLET_A, position(5_000_000n));
  h.consent.assessAllocationAttempt = async () => ({
    allowed: false,
    reason: "idle_balance_consent_revoked"
  });

  const result = await h.keeper.runOnce(NOW);

  assert.equal(result.allocationCount, 0);
  assert.equal(h.chain.calls.allocate.length, 0);
  assert.ok(result.skipped.some((entry) => entry.reason === "idle_balance_consent_revoked"));
});

test("deallocation works for a revoked-consent wallet because exit never reads consent", async () => {
  const h = await harness({ wallets: [WALLET_A] });
  h.chain.shares.set(WALLET_A, 5_000_000n);
  h.chain.float = floatState({ floatRaw: 10_000_000n, totalAssetsRaw: 5_000_000n, totalSharesRaw: 5_000_000n });
  h.consent.assessAllocationAttempt = async () => {
    throw new Error("revoked consent must not be consulted for exit");
  };

  let authCalls = 0;
  let response;
  const handleRoute = createIdleBalanceConsentRoutes({
    authMiddleware: async () => {
      authCalls += 1;
      return { wallet: WALLET_A };
    },
    idleBalanceConsentService: {},
    idleBalanceAllocationKeeper: h.keeper,
    readJsonBody: async () => ({ amountRaw: "1000000" }),
    respond: (_response, statusCode, body) => { response = { statusCode, body }; }
  });
  assert.equal(await handleRoute({
    request: { method: "POST" },
    response: {},
    url: new URL("https://api.averray.com/account/idle-allocation/deallocate"),
    pathname: "/account/idle-allocation/deallocate"
  }), true);
  const result = response.body;

  assert.equal(authCalls, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(result.status, "deallocated");
  assert.deepEqual(h.chain.calls.deallocate, [{ wallet: WALLET_A, amountRaw: "1000000" }]);
  assert.deepEqual(result.evidence.consent, {
    required: false,
    reason: "exit_never_requires_consent"
  });

  const queued = await harness({ wallets: [WALLET_A] });
  queued.chain.shares.set(WALLET_A, 5_000_000n);
  queued.chain.float = floatState({ floatRaw: 0n, totalAssetsRaw: 5_000_000n, totalSharesRaw: 5_000_000n });
  queued.consent.assessAllocationAttempt = h.consent.assessAllocationAttempt;
  const refused = await queued.keeper.deallocate(WALLET_A, { amountRaw: "1000000" });
  assert.equal(refused.status, "queued");
  assert.equal(refused.reason, "adapter_float_insufficient");
  assert.equal(queued.chain.calls.deallocate.length, 0);
  queued.chain.float = floatState({
    floatRaw: 5_000_000n,
    totalAssetsRaw: 5_000_000n,
    totalSharesRaw: 5_000_000n
  });
  await queued.keeper.runOnce(NOW);
  assert.equal((await queued.stateStore.getIdleBalanceDeallocationRequest(WALLET_A)).status, "completed");
  assert.equal(queued.chain.calls.deallocate.length, 1);
});

test("headroom arithmetic allocates 3.0 USDC from 5.0 and skips 2.4 below the 0.5 tick", async () => {
  const h = await harness({ wallets: [WALLET_A, WALLET_B] });
  h.chain.positions.set(WALLET_A, position(5_000_000n, { reservedRaw: 7_000_000n }));
  h.chain.positions.set(WALLET_B, position(2_400_000n));

  const result = await h.keeper.runOnce(NOW);

  assert.equal(result.allocationCount, 1);
  assert.equal(result.allocationTotalRaw, "3000000");
  assert.deepEqual(h.chain.calls.allocate, [{ wallet: WALLET_A, amountRaw: "3000000" }]);
  assert.ok(result.skipped.some((entry) => entry.wallet === WALLET_B && entry.reason === "allocation_below_minimum_tick"));
  const evidence = await h.stateStore.listIdleBalanceMovementEvidence({ wallet: WALLET_A });
  assert.equal(evidence[0].strategySharesDeltaRaw, "3000000");

  const debt = await harness({ wallets: [WALLET_A] });
  debt.chain.positions.set(WALLET_A, position(5_000_000n, { debtOutstandingRaw: 1_000_000n }));
  await debt.keeper.runOnce(NOW);
  assert.deepEqual(debt.chain.calls.allocate, [{ wallet: WALLET_A, amountRaw: "2000000" }]);
});

test("keeper-enable env off causes zero chain interaction regardless of consents", async () => {
  const config = loadIdleBalanceAllocationKeeperConfig({
    IDLE_BALANCE_ALLOCATION_ROUTE_LIVE: "true",
    IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED: "false"
  });
  const defaults = loadIdleBalanceAllocationKeeperConfig({});
  assert.equal(defaults.routeLive, false);
  assert.equal(defaults.keeperEnabled, false);
  assert.equal(defaults.workingHeadroomRaw, 2_000_000n);
  assert.equal(defaults.minAllocationTickRaw, 500_000n);
  assert.equal(defaults.floatTargetBps, 2_500);
  assert.equal(defaults.floatTargetRaw, 10_000_000n);
  let chainInteractions = 0;
  const chain = new Proxy({}, {
    get() {
      chainInteractions += 1;
      return async () => { throw new Error("dark keeper touched chain"); };
    }
  });
  const keeper = new IdleBalanceAllocationKeeperService({
    config,
    stateStore: new MemoryStateStore(),
    consentService: {},
    chainReader: chain,
    movementGateway: chain,
    now: () => NOW
  });

  const result = await keeper.runOnce(NOW);

  assert.equal(result.skipped[0].reason, "allocation_keeper_disabled");
  assert.equal(chainInteractions, 0);
});

test("keeper write surface is structurally closed to five functions and AAC_IDLE_DEPOSIT_POOL_V21", () => {
  assert.deepEqual(
    allocationKeeperWriteFunctionNames(),
    [...ALLOCATION_KEEPER_WRITE_FUNCTIONS].sort()
  );
  assert.equal(AAC_IDLE_DEPOSIT_POOL_V21,
    "0x4141435f49444c455f4445504f5349545f504f4f4c5f56323100000000000000");
  assert.equal(DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER, "0x1DDcA7097c752580c6561e1bF8C673D6C1665CA5");
  assert.equal(DEPLOYED_DEPOSIT_POOL_V21, "0x9B35A102d656Fb86d798aF81959e09961DEc28E0");
  assert.ok(!allocationKeeperWriteFunctionNames().includes("withdraw"));
  assert.ok(!allocationKeeperWriteFunctionNames().includes("requestStrategyDeposit"));
  assert.equal(classifyAllocationKeeperMovementError({ data: "0x90b8ec18" }, "allocateIdleFunds").code,
    "allocation_keeper_postage_approval_failed");
});

test("concurrent second run allocates nothing while the keeper lock is held", async () => {
  const h = await harness({ wallets: [WALLET_A] });
  let releaseFloatRead;
  const blocked = new Promise((resolve) => { releaseFloatRead = resolve; });
  let enteredFloatRead;
  const entered = new Promise((resolve) => { enteredFloatRead = resolve; });
  h.chain.getFloatState = async () => {
    enteredFloatRead();
    await blocked;
    return h.chain.float;
  };

  const first = h.keeper.runOnce(NOW);
  await entered;
  const second = await h.keeper.runOnce(NOW);
  releaseFloatRead();
  await first;

  assert.equal(second.allocationCount, 0);
  assert.deepEqual(second.skipped, [{ reason: "allocation_keeper_lock_held" }]);
});

test("4.073522 allocated targets a 25 percent float instead of a full-position exit", async () => {
  const h = await harness();
  h.chain.float = floatState({
    floatRaw: 0n,
    totalAssetsRaw: 4_073_522n,
    totalSharesRaw: 4_073_522n,
    poolSharesRaw: 4_073_522n,
    poolAssetsRaw: 4_073_522n
  });

  const result = await h.keeper.runOnce(NOW);

  assert.equal(result.floatAction.action, "requestFloatExit");
  assert.equal(result.floatAction.targetRaw, "1018380");
  assert.deepEqual(h.chain.calls.requestFloatExit, [{
    poolSharesRaw: "1018380",
    receiver: DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER
  }]);
  assert.notEqual(h.chain.calls.requestFloatExit[0].poolSharesRaw, "4073522");
});

test("relative float target respects its absolute cap and sweeps only the excess", async () => {
  const h = await harness();
  h.chain.float = floatState({
    floatRaw: 12_000_000n,
    totalAssetsRaw: 50_000_000n,
    totalSharesRaw: 50_000_000n,
    poolSharesRaw: 38_000_000n,
    poolAssetsRaw: 38_000_000n
  });

  const result = await h.keeper.runOnce(NOW);

  assert.equal(result.floatAction.action, "sweepToPool");
  assert.equal(result.floatAction.targetRaw, "10000000");
  assert.deepEqual(h.chain.calls.sweep, ["2000000"]);
  assert.equal(h.chain.calls.positionReads, 0);
});

test("proportional float fully backs synchronous deallocation up to its exact size", async () => {
  const covered = await harness({ wallets: [WALLET_A] });
  covered.chain.shares.set(WALLET_A, 4_073_522n);
  covered.chain.float = floatState({
    floatRaw: 1_018_380n,
    totalAssetsRaw: 4_073_522n,
    totalSharesRaw: 4_073_522n,
    poolSharesRaw: 3_055_142n,
    poolAssetsRaw: 3_055_142n
  });
  const result = await covered.keeper.deallocate(WALLET_A, { amountRaw: "1018380" });
  assert.equal(result.status, "deallocated");

  const beyond = await harness({ wallets: [WALLET_A] });
  beyond.chain.shares.set(WALLET_A, 4_073_522n);
  beyond.chain.float = structuredClone(covered.chain.float);
  const queued = await beyond.keeper.deallocate(WALLET_A, { amountRaw: "1018381" });
  assert.equal(queued.status, "queued");
  assert.equal(queued.reason, "adapter_float_insufficient");
});

test("float management runs before the consent scan and without any consent", async () => {
  const h = await harness();
  const order = [];
  const listConsents = h.stateStore.listIdleBalanceConsents.bind(h.stateStore);
  h.stateStore.listIdleBalanceConsents = async (...args) => {
    order.push("consent_scan");
    return listConsents(...args);
  };
  const requestFloatExit = h.chain.requestFloatExit.bind(h.chain);
  h.chain.requestFloatExit = async (...args) => {
    order.push("float_management");
    return requestFloatExit(...args);
  };
  h.chain.float = floatState({
    floatRaw: 0n,
    totalAssetsRaw: 4_073_522n,
    totalSharesRaw: 4_073_522n,
    poolSharesRaw: 4_073_522n,
    poolAssetsRaw: 4_073_522n
  });

  const result = await h.keeper.runOnce(NOW);

  assert.equal(result.candidateCount, 0);
  assert.deepEqual(order, ["float_management", "consent_scan"]);
});

test("matured oversized float request fulfils then sweeps surplus and restores available shares", async () => {
  const h = await harness();
  h.chain.float = floatState({
    floatRaw: 0n,
    totalAssetsRaw: 4_073_522n,
    totalSharesRaw: 4_073_522n,
    poolSharesRaw: 4_073_522n,
    poolAssetsRaw: 4_073_522n,
    poolAvailableSharesRaw: 0n
  });
  h.chain.getFloatExit = async () => ({
    requestId: "1",
    owner: DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER,
    receiver: DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER,
    sharesRaw: "4073522",
    unlockAt: Math.floor(NOW.getTime() / 1_000) - 1,
    fulfilled: false
  });
  h.chain.fulfilFloatExit = async (requestId) => {
    h.chain.calls.fulfilFloatExit.push(requestId);
    h.chain.float = floatState({
      floatRaw: 4_073_522n,
      totalAssetsRaw: 4_073_522n,
      totalSharesRaw: 4_073_522n,
      poolSharesRaw: 0n,
      poolAssetsRaw: 0n,
      poolAvailableSharesRaw: 0n
    });
    return receipt(h.chain.calls.fulfilFloatExit.length + 400, { requestIdRaw: String(requestId) });
  };
  await h.stateStore.upsertServiceState("idle-balance-allocation-keeper:float", {
    pendingExit: {
      status: "confirmed",
      requestId: "1",
      poolSharesRaw: "4073522",
      receiver: DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER,
      requestedAt: "2026-08-27T12:41:12.000Z"
    }
  });

  const result = await h.keeper.runOnce(NOW);

  assert.equal(result.floatAction.action, "fulfilFloatExitAndSweep");
  assert.equal(result.floatAction.requestId, "1");
  assert.equal(result.floatAction.amountRaw, "3055142");
  assert.equal(result.floatAction.targetRaw, "1018380");
  assert.deepEqual(h.chain.calls.fulfilFloatExit, ["1"]);
  assert.deepEqual(h.chain.calls.sweep, ["3055142"]);
  assert.equal(h.chain.float.floatRaw, "1018380");
  assert.equal(h.chain.float.poolSharesRaw, "3055142");
  assert.equal(h.chain.float.poolAvailableSharesRaw, "3055142");
  assert.ok(BigInt(h.chain.float.poolAvailableSharesRaw) > 0n);
  assert.equal((await h.stateStore.getServiceState("idle-balance-allocation-keeper:float")).pendingExit, null);
});

async function harness({ wallets = [] } = {}) {
  const stateStore = new MemoryStateStore();
  for (const wallet of wallets) {
    await stateStore.putIdleBalanceConsent({
      schemaVersion: 1,
      kind: "idle_balance_allocation_consent_v1",
      wallet,
      status: "active",
      termsHash: `0x${wallet.slice(2).padEnd(64, "0")}`,
      consentedAt: "2026-08-26T08:00:00.000Z"
    });
  }
  const chain = fakeChain();
  const consent = {
    async assessAllocationAttempt() {
      return {
        allowed: true,
        termsHash: `0x${"ab".repeat(32)}`,
        checkedAt: NOW.toISOString()
      };
    }
  };
  let id = 0;
  const keeper = new IdleBalanceAllocationKeeperService({
    config: liveConfig(),
    stateStore,
    consentService: consent,
    chainReader: chain,
    movementGateway: chain,
    settlementSignerReader: async () => SETTLEMENT_SIGNER,
    now: () => NOW,
    ownerFactory: () => `keeper-test-${++id}`,
    logger: { warn() {} }
  });
  return { keeper, stateStore, chain, consent };
}

function liveConfig() {
  return {
    enabled: true,
    routeLive: true,
    keeperEnabled: true,
    intervalMs: 60_000,
    workingHeadroomRaw: 2_000_000n,
    minAllocationTickRaw: 500_000n,
    maxAllocationsPerRun: 25,
    maxAllocationTotalRaw: 100_000_000n,
    floatTargetRaw: 10_000_000n,
    floatTargetBps: 2_500,
    allocationExclusions: [{
      wallet: SETTLEMENT_SIGNER,
      role: "settlement_signer",
      source: "deployment_manifest.verifier"
    }],
    scanLimit: 1_000,
    lockTtlSeconds: 300,
    agentAccountAddress: ACCOUNT,
    assetAddress: USDC,
    poolAddress: DEPLOYED_DEPOSIT_POOL_V21,
    adapterAddress: DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER
  };
}

function fakeChain() {
  const positions = new Map();
  const shares = new Map();
  const calls = {
    allocate: [],
    deallocate: [],
    sweep: [],
    requestFloatExit: [],
    fulfilFloatExit: [],
    positionReads: 0
  };
  return {
    positions,
    shares,
    calls,
    float: floatState({ floatRaw: 2_500_000n }),
    async getAccountPosition(wallet) {
      calls.positionReads += 1;
      return positions.get(wallet) ?? position(0n);
    },
    async getStrategyShares(wallet) {
      return (shares.get(wallet) ?? 0n).toString();
    },
    async getFloatState() {
      return this.float;
    },
    async sharesForPoolAssets(amountRaw) {
      return String(amountRaw);
    },
    async getFloatExit(requestId) {
      return {
        requestId,
        owner: DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER,
        receiver: DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER,
        sharesRaw: "1",
        unlockAt: Math.floor(NOW.getTime() / 1_000) + 100,
        fulfilled: false
      };
    },
    async allocateIdleFunds(wallet, amountRaw) {
      calls.allocate.push({ wallet, amountRaw });
      shares.set(wallet, (shares.get(wallet) ?? 0n) + BigInt(amountRaw));
      return receipt(calls.allocate.length, { amountRaw, strategySharesDeltaRaw: amountRaw });
    },
    async deallocateIdleFunds(wallet, amountRaw) {
      calls.deallocate.push({ wallet, amountRaw });
      shares.set(wallet, (shares.get(wallet) ?? 0n) - BigInt(amountRaw));
      return receipt(calls.deallocate.length + 100, {
        amountRaw,
        strategySharesDeltaRaw: `-${amountRaw}`
      });
    },
    async sweepToPool(amountRaw) {
      calls.sweep.push(amountRaw);
      const amount = BigInt(amountRaw);
      const remaining = BigInt(this.float.floatRaw) - amount;
      this.float.floatRaw = remaining.toString();
      this.float.maxWithdrawRaw = remaining.toString();
      this.float.poolAssetsRaw = (BigInt(this.float.poolAssetsRaw) + amount).toString();
      this.float.poolSharesRaw = (BigInt(this.float.poolSharesRaw) + amount).toString();
      this.float.poolAvailableSharesRaw = (BigInt(this.float.poolAvailableSharesRaw) + amount).toString();
      return receipt(calls.sweep.length + 200, { assetsRaw: amountRaw });
    },
    async requestFloatExit(input) {
      calls.requestFloatExit.push(input);
      return receipt(calls.requestFloatExit.length + 300, { requestIdRaw: "7" });
    },
    async fulfilFloatExit(requestId) {
      calls.fulfilFloatExit.push(requestId);
      return receipt(calls.fulfilFloatExit.length + 400, { requestIdRaw: String(requestId) });
    }
  };
}

function position(liquidRaw, overrides = {}) {
  return {
    liquidRaw: liquidRaw.toString(),
    reservedRaw: "0",
    strategyAllocatedRaw: "0",
    collateralLockedRaw: "0",
    jobStakeLockedRaw: "0",
    debtOutstandingRaw: "0",
    ...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, value.toString()]))
  };
}

function floatState({
  floatRaw = 0n,
  totalAssetsRaw = 10_000_000n,
  totalSharesRaw = 10_000_000n,
  poolSharesRaw = 0n,
  poolAssetsRaw = 0n,
  poolAvailableSharesRaw = poolSharesRaw
} = {}) {
  return {
    adapter: DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER,
    receiver: DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER,
    floatRaw: floatRaw.toString(),
    maxWithdrawRaw: floatRaw.toString(),
    totalAssetsRaw: totalAssetsRaw.toString(),
    totalSharesRaw: totalSharesRaw.toString(),
    poolSharesRaw: poolSharesRaw.toString(),
    poolAssetsRaw: poolAssetsRaw.toString(),
    poolAvailableSharesRaw: poolAvailableSharesRaw.toString()
  };
}

function receipt(number, extras = {}) {
  return {
    txHash: `0x${number.toString(16).padStart(64, "0")}`,
    blockNumber: number,
    ...extras
  };
}
