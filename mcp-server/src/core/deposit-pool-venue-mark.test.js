import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError } from "./errors.js";
import {
  DEFAULT_VENUE_MARK_DUST_FLOOR_RAW,
  DEFAULT_VENUE_MARK_TOLERANCE_BPS,
  evaluateVenueMark,
  loadDepositPoolVenueMarkConfig,
  markedSharePrice
} from "./deposit-pool-venue-mark.js";

// Live mainnet state, Asset Hub block 19868771 (2026-08-25T12:01:36Z), pool
// 0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30. These are read values, not
// illustrative numbers, and they pin the case this gate exists for.
const LIVE = {
  costBasisRaw: 9_500_000n,
  markedRaw: 9_400_000n,
  bufferRaw: 15_895_226n,
  totalAssetsRaw: 25_395_226n,
  totalSupplyRaw: 25_527_339n
};

test("the live 2026-08-25 shortfall blocks deposits and states the overstatement plainly", () => {
  const verdict = evaluateVenueMark({
    costBasisRaw: LIVE.costBasisRaw,
    markedRaw: LIVE.markedRaw,
    totalAssetsRaw: LIVE.totalAssetsRaw
  });
  assert.equal(verdict.status, "shortfall_exceeds_tolerance");
  assert.equal(verdict.depositsBlocked, true);
  assert.equal(verdict.shortfall.raw, "100000");
  assert.equal(verdict.surplus.raw, "0");
  // 25.395226 * 10bps = 0.025395, and the shortfall clears it by ~3.9x.
  assert.equal(verdict.tolerance.raw, "25395");
  assert.match(verdict.statement, /overstates NAV/u);
  assert.equal(verdict.source, "venue_adapter_managed_assets");
});

test("no venue position makes the check inert rather than merely passing", () => {
  const verdict = evaluateVenueMark({ costBasisRaw: 0n, markedRaw: null, totalAssetsRaw: 25_395_226n });
  assert.equal(verdict.status, "not_deployed");
  assert.equal(verdict.depositsBlocked, false);
  assert.equal(verdict.shortfall.raw, "0");
  assert.match(verdict.statement, /cannot diverge/u);
});

test("an unreadable mark with capital at the venue fails closed and never reads as healthy", () => {
  const verdict = evaluateVenueMark({
    costBasisRaw: LIVE.costBasisRaw,
    markedRaw: undefined,
    totalAssetsRaw: LIVE.totalAssetsRaw,
    unreadableReason: "venue_managed_assets_read_failed"
  });
  assert.equal(verdict.status, "unreadable");
  assert.equal(verdict.depositsBlocked, true);
  assert.equal(verdict.marked, null);
  // A null shortfall is "not known", which must never be rendered as zero.
  assert.equal(verdict.shortfall, null);
  assert.equal(verdict.reason, "venue_managed_assets_read_failed");
});

test("shortfall inside tolerance passes without pretending the gap is absent", () => {
  const verdict = evaluateVenueMark({
    costBasisRaw: 9_500_000n,
    markedRaw: 9_499_000n,
    totalAssetsRaw: 25_395_226n
  });
  assert.equal(verdict.status, "ok");
  assert.equal(verdict.depositsBlocked, false);
  assert.equal(verdict.shortfall.raw, "1000");
});

test("surplus is disclosed as an understated price and never gates the door", () => {
  // Once recordRemotePosition lands, accrued venue yield puts marked ABOVE
  // cost basis. That dilutes existing holders, but gating it would close the
  // door in the pool's normal earning state.
  const verdict = evaluateVenueMark({
    costBasisRaw: 9_400_000n,
    markedRaw: 9_414_667n,
    totalAssetsRaw: 25_295_226n
  });
  assert.equal(verdict.status, "surplus");
  assert.equal(verdict.depositsBlocked, false);
  assert.equal(verdict.surplus.raw, "14667");
  assert.equal(verdict.shortfall.raw, "0");
  assert.match(verdict.statement, /understates NAV/u);
});

test("the dust floor keeps raw-unit noise from closing the door on a tiny pool", () => {
  const verdict = evaluateVenueMark({
    costBasisRaw: 1_000_000n,
    markedRaw: 999_500n,
    totalAssetsRaw: 1_000_000n // 10bps = 1000 raw, below the 1000 dust floor
  });
  assert.equal(verdict.tolerance.raw, DEFAULT_VENUE_MARK_DUST_FLOOR_RAW.toString());
  assert.equal(verdict.status, "ok");
  assert.equal(verdict.depositsBlocked, false);
});

test("tolerance scales with NAV so the gate does not loosen as the pool grows", () => {
  const small = evaluateVenueMark({ costBasisRaw: 1n, markedRaw: 1n, totalAssetsRaw: 25_000_000n });
  const large = evaluateVenueMark({ costBasisRaw: 1n, markedRaw: 1n, totalAssetsRaw: 1_000_000_000n });
  assert.equal(small.tolerance.raw, "25000");
  assert.equal(large.tolerance.raw, "1000000");
});

test("a zero tolerance admits no shortfall at all", () => {
  const verdict = evaluateVenueMark({
    costBasisRaw: 9_500_000n,
    markedRaw: 9_499_999n,
    totalAssetsRaw: 25_395_226n,
    toleranceBps: 0,
    dustFloorRaw: 0n
  });
  assert.equal(verdict.tolerance.raw, "0");
  assert.equal(verdict.depositsBlocked, true);
});

test("marked share price reports the honest venue-marked NAV beside the quoted one", () => {
  const marked = markedSharePrice({
    bufferAssetsRaw: LIVE.bufferRaw,
    markedRaw: LIVE.markedRaw,
    totalSupplyRaw: LIVE.totalSupplyRaw
  });
  assert.equal(marked.model, "venue-marked-to-adapter");
  assert.equal(marked.totalAssets.raw, "25295226");
  // Quoted price at this block is 0.994825; marked is 0.990907.
  assert.equal(marked.assetsPerShare.raw, "990907");
  assert.equal(markedSharePrice({ bufferAssetsRaw: 1n, markedRaw: null, totalSupplyRaw: 1n }), null);
});

test("config defaults hold and malformed overrides fail loudly", () => {
  const defaults = loadDepositPoolVenueMarkConfig({});
  assert.equal(defaults.toleranceBps, DEFAULT_VENUE_MARK_TOLERANCE_BPS);
  assert.equal(defaults.dustFloorRaw, DEFAULT_VENUE_MARK_DUST_FLOOR_RAW);

  const custom = loadDepositPoolVenueMarkConfig({
    DEPOSIT_POOL_VENUE_MARK_TOLERANCE_BPS: "25",
    DEPOSIT_POOL_VENUE_MARK_DUST_FLOOR_RAW: "5000"
  });
  assert.equal(custom.toleranceBps, 25);
  assert.equal(custom.dustFloorRaw, 5_000n);

  assert.throws(
    () => loadDepositPoolVenueMarkConfig({ DEPOSIT_POOL_VENUE_MARK_TOLERANCE_BPS: "-1" }),
    ConfigError
  );
  assert.throws(
    () => loadDepositPoolVenueMarkConfig({ DEPOSIT_POOL_VENUE_MARK_DUST_FLOOR_RAW: "0.5" }),
    ConfigError
  );
});
