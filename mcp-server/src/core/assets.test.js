import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_ESCROW_ASSET, knownAssetMinBalanceRaw, isNativeGasAsset, NATIVE_GAS_ASSET_SYMBOLS } from "./assets.js";

test("Hub USDC retains its conservative local floor, distinct from the pinned chain minimum", () => {
  // assets.asset(1337) at 21634457; see docs/USDC_MINIMUM_BALANCE_POLICY.md.
  const observedChainMinimumRaw = 10000n;
  assert.equal(DEFAULT_ESCROW_ASSET.minBalanceRaw, "70000");
  assert.equal(knownAssetMinBalanceRaw(DEFAULT_ESCROW_ASSET), "70000");
  assert.equal(BigInt(DEFAULT_ESCROW_ASSET.minBalanceRaw), 7n * observedChainMinimumRaw);
});

test("native gas symbols are exactly DOT and PAS", () => {
  assert.deepEqual([...NATIVE_GAS_ASSET_SYMBOLS].sort(), ["DOT", "PAS"]);
});

test("isNativeGasAsset is case-insensitive and true only for native gas", () => {
  assert.equal(isNativeGasAsset("DOT"), true);
  assert.equal(isNativeGasAsset("dot"), true);
  assert.equal(isNativeGasAsset(" PAS "), true);
  assert.equal(isNativeGasAsset("USDC"), false);
  assert.equal(isNativeGasAsset("usdt"), false);
  // undefined normalizes to the default escrow asset (USDC) → not native gas.
  assert.equal(isNativeGasAsset(undefined), false);
});
