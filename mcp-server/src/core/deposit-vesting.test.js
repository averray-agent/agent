import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_WORKER_DEPOSIT_VESTING_HOURS,
  calculateDepositVesting,
  loadDepositVestingConfig
} from "./deposit-vesting.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW_SECONDS = Date.parse("2026-08-13T12:00:00.000Z") / 1_000;

function poolEvent(type, {
  assetsRaw,
  ageSeconds,
  owner = WALLET,
  blockNumber = 100,
  logIndex = 0
} = {}) {
  return {
    type,
    owner,
    assetsRaw: String(assetsRaw),
    blockNumber,
    logIndex,
    blockTimestamp: NOW_SECONDS - ageSeconds
  };
}

function vested(events) {
  return calculateDepositVesting(events, {
    wallet: WALLET,
    now: new Date(NOW_SECONDS * 1_000),
    vestingHours: 48
  });
}

test("deposit vesting defaults to the ratified 48-hour ramp", () => {
  assert.equal(DEFAULT_WORKER_DEPOSIT_VESTING_HOURS, 48);
  assert.deepEqual(loadDepositVestingConfig({}), { vestingHours: 48 });
  assert.deepEqual(loadDepositVestingConfig({ WORKER_DEPOSIT_VESTING_HOURS: "72" }), {
    vestingHours: 72
  });
  assert.throws(
    () => loadDepositVestingConfig({ WORKER_DEPOSIT_VESTING_HOURS: "0" }),
    /WORKER_DEPOSIT_VESTING_HOURS must be a positive integer/u
  );
});

test("vesting is linear at 0h, 24h, 48h and the one-second boundaries", () => {
  const duration = 48 * 60 * 60;
  const assets = 96_000_000n;
  for (const [ageSeconds, expected] of [
    [0, 0n],
    [1, assets / BigInt(duration)],
    [24 * 60 * 60, assets / 2n],
    [duration - 1, assets * BigInt(duration - 1) / BigInt(duration)],
    [duration, assets],
    [duration + 1, assets]
  ]) {
    assert.equal(
      vested([poolEvent("Deposit", { assetsRaw: assets, ageSeconds })]).vestedRaw,
      expected,
      `age ${ageSeconds}s`
    );
  }
});

test("partial withdrawals burn newest tranches first and preserve older standing", () => {
  const result = vested([
    poolEvent("Deposit", { assetsRaw: 10_000_000n, ageSeconds: 72 * 60 * 60, blockNumber: 100 }),
    poolEvent("Deposit", { assetsRaw: 10_000_000n, ageSeconds: 24 * 60 * 60, blockNumber: 101 }),
    poolEvent("Withdraw", { assetsRaw: 6_000_000n, ageSeconds: 0, blockNumber: 102 })
  ]);

  assert.equal(result.vestedRaw, 12_000_000n);
  assert.deepEqual(result.tranches.map((tranche) => tranche.remainingRaw), [10_000_000n, 4_000_000n]);
});

test("a same-block withdrawal removes a flash deposit before it buys capacity", () => {
  const result = vested([
    poolEvent("Deposit", { assetsRaw: 100_000_000n, ageSeconds: 0, blockNumber: 100, logIndex: 1 }),
    poolEvent("Withdraw", { assetsRaw: 100_000_000n, ageSeconds: 0, blockNumber: 100, logIndex: 2 })
  ]);

  assert.equal(result.vestedRaw, 0n);
  assert.deepEqual(result.tranches, []);
});

test("venue yield events never create vested principal", () => {
  const result = vested([
    poolEvent("Deposit", { assetsRaw: 10_000_000n, ageSeconds: 48 * 60 * 60 }),
    poolEvent("VenueReturnRecorded", { assetsRaw: 50_000_000n, ageSeconds: 0, blockNumber: 101 })
  ]);

  assert.equal(result.vestedRaw, 10_000_000n);
  assert.equal(result.tranches.length, 1);
});
