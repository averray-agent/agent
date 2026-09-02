import test from "node:test";
import assert from "node:assert/strict";

import { isNativeGasAsset, NATIVE_GAS_ASSET_SYMBOLS } from "./assets.js";

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
