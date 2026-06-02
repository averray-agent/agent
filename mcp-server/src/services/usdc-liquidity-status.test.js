import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUsdcLiquidityStatus,
  createUsdcLiquidityStatusService,
  formatUsdcRaw,
  loadUsdcLiquidityConfig,
  parseUsdcAmountToRaw
} from "./usdc-liquidity-status.js";

const POSTER = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const RESERVE = "0x3333333333333333333333333333333333333333";

test("parseUsdcAmountToRaw handles 6-decimal USDC amounts", () => {
  assert.equal(parseUsdcAmountToRaw("0", "amount"), 0n);
  assert.equal(parseUsdcAmountToRaw("8.5", "amount"), 8_500_000n);
  assert.equal(parseUsdcAmountToRaw("0.000001", "amount"), 1n);
  assert.equal(formatUsdcRaw(8_500_000n), "8.5");
  assert.throws(
    () => parseUsdcAmountToRaw("0.0000001", "amount"),
    /at most 6 fractional digits/u
  );
});

test("loadUsdcLiquidityConfig parses a generic account registry", () => {
  const config = loadUsdcLiquidityConfig({
    USDC_LIQUIDITY_CHAIN: "testnet",
    USDC_LIQUIDITY_ACCOUNTS_JSON: JSON.stringify([
      { role: "poster", account: POSTER, floorUsdc: 10, targetUsdc: 50, lastRefillAt: "2026-06-01T00:00:00.000Z" },
      { role: "worker", account: WORKER, floorUsdc: "0.25", targetUsdc: "1.5", refillPending: "true" }
    ]),
    USDC_LIQUIDITY_TREASURY_RESERVE_ACCOUNT: RESERVE,
    USDC_LIQUIDITY_TREASURY_RESERVE_FLOOR_USDC: "100"
  });

  assert.equal(config.chain, "testnet");
  assert.equal(config.accounts[0].account, POSTER);
  assert.equal(config.accounts[0].floorRaw, 10_000_000n);
  assert.equal(config.accounts[1].account, "0x2222222222222222222222222222222222222222");
  assert.equal(config.accounts[1].refillPending, true);
  assert.equal(config.treasuryReserve.account, RESERVE);
  assert.equal(config.treasuryReserve.floorRaw, 100_000_000n);
});

test("loadUsdcLiquidityConfig rejects target below floor", () => {
  assert.throws(
    () => loadUsdcLiquidityConfig({
      USDC_LIQUIDITY_ACCOUNTS_JSON: JSON.stringify([
        { role: "poster", account: POSTER, floorUsdc: 10, targetUsdc: 5 }
      ])
    }),
    /targetUsdc must be >= floorUsdc/u
  );
});

test("buildUsdcLiquidityStatus returns pinned shape plus desired refill math", async () => {
  const status = await buildUsdcLiquidityStatus({
    config: loadUsdcLiquidityConfig({
      USDC_LIQUIDITY_CHAIN: "testnet",
      USDC_LIQUIDITY_ACCOUNTS_JSON: JSON.stringify([
        { role: "poster", account: POSTER, floorUsdc: 10, targetUsdc: 50 },
        { role: "worker", account: WORKER, floorUsdc: 1, targetUsdc: 10 }
      ]),
      USDC_LIQUIDITY_TREASURY_RESERVE_ACCOUNT: RESERVE,
      USDC_LIQUIDITY_TREASURY_RESERVE_FLOOR_USDC: 20
    }),
    now: () => new Date("2026-06-02T12:00:00.000Z"),
    readLiquidRaw: async (account) => ({
      [POSTER]: "8500000",
      [WORKER]: "12000000",
      [RESERVE]: "420000000"
    })[account]
  });

  assert.deepEqual(status, {
    asOf: "2026-06-02T12:00:00.000Z",
    chain: "testnet",
    accounts: [
      {
        role: "poster",
        account: POSTER,
        liquidUsdc: 8.5,
        liquidUsdcRaw: "8500000",
        floorUsdc: 10,
        floorUsdcRaw: "10000000",
        targetUsdc: 50,
        targetUsdcRaw: "50000000",
        desiredUsdc: 41.5,
        desiredUsdcRaw: "41500000",
        refillPending: false,
        lastRefillAt: null
      },
      {
        role: "worker",
        account: WORKER,
        liquidUsdc: 12,
        liquidUsdcRaw: "12000000",
        floorUsdc: 1,
        floorUsdcRaw: "1000000",
        targetUsdc: 10,
        targetUsdcRaw: "10000000",
        desiredUsdc: 0,
        desiredUsdcRaw: "0",
        refillPending: false,
        lastRefillAt: null
      }
    ],
    treasuryReserveHealthy: true,
    treasuryReserveUsdc: 420,
    treasuryReserveUsdcRaw: "420000000",
    treasuryReserveAccount: RESERVE,
    treasuryReserveFloorUsdc: 20,
    treasuryReserveFloorUsdcRaw: "20000000",
    totalDesiredUsdc: 41.5,
    totalDesiredUsdcRaw: "41500000"
  });
});

test("buildUsdcLiquidityStatus marks reserve unhealthy when it cannot cover desired refill", async () => {
  const status = await buildUsdcLiquidityStatus({
    config: loadUsdcLiquidityConfig({
      USDC_LIQUIDITY_ACCOUNTS_JSON: JSON.stringify([
        { role: "poster", account: POSTER, floorUsdc: 10, targetUsdc: 50 }
      ]),
      USDC_LIQUIDITY_TREASURY_RESERVE_ACCOUNT: RESERVE,
      USDC_LIQUIDITY_TREASURY_RESERVE_FLOOR_USDC: 20
    }),
    readLiquidRaw: async (account) => ({
      [POSTER]: "8500000",
      [RESERVE]: "30000000"
    })[account]
  });

  assert.equal(status.accounts[0].desiredUsdcRaw, "41500000");
  assert.equal(status.treasuryReserveHealthy, false);
});

test("createUsdcLiquidityStatusService reads AgentAccountCore positions through the gateway", async () => {
  const calls = [];
  const service = createUsdcLiquidityStatusService({
    config: loadUsdcLiquidityConfig({
      USDC_LIQUIDITY_ACCOUNTS_JSON: JSON.stringify([
        { role: "poster", account: POSTER, floorUsdc: 10, targetUsdc: 50 }
      ]),
      USDC_LIQUIDITY_TREASURY_RESERVE_ACCOUNT: RESERVE
    }),
    gateway: {
      isEnabled: () => true,
      async getAccountPosition(account, asset) {
        calls.push({ account, asset });
        return {
          position: {
            liquidRaw: account === POSTER ? "8500000" : "420000000"
          }
        };
      }
    },
    now: () => new Date("2026-06-02T12:00:00.000Z")
  });

  const status = await service.getStatus();

  assert.deepEqual(calls, [
    { account: POSTER, asset: "USDC" },
    { account: RESERVE, asset: "USDC" }
  ]);
  assert.equal(status.accounts[0].desiredUsdcRaw, "41500000");
});

test("createUsdcLiquidityStatusService fails closed when chain gateway is disabled", async () => {
  const service = createUsdcLiquidityStatusService({
    config: loadUsdcLiquidityConfig({}),
    gateway: { isEnabled: () => false }
  });

  await assert.rejects(
    () => service.getStatus(),
    /requires an enabled blockchain gateway/u
  );
});
