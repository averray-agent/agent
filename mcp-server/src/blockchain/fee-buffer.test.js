import test from "node:test";
import assert from "node:assert/strict";

import { bufferFeeData, applyGasFeeBuffer } from "./fee-buffer.js";

test("bufferFeeData raises 1559 fee ceilings by the buffer bps", () => {
  const out = bufferFeeData({ gasPrice: null, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n }, 2000);
  assert.equal(out.maxFeePerGas, 1_200_000_000n); // +20%
  assert.equal(out.maxPriorityFeePerGas, 120_000_000n); // +20%
  assert.equal(out.gasPrice, null);
});

test("bufferFeeData raises legacy gasPrice and preserves null 1559 fields", () => {
  const out = bufferFeeData({ gasPrice: 500n, maxFeePerGas: null, maxPriorityFeePerGas: null }, 1000);
  assert.equal(out.gasPrice, 550n); // +10%
  assert.equal(out.maxFeePerGas, null);
});

test("bufferFeeData is a no-op for a non-positive buffer or null feeData", () => {
  const fd = { gasPrice: 500n, maxFeePerGas: null, maxPriorityFeePerGas: null };
  assert.equal(bufferFeeData(fd, 0), fd);
  assert.equal(bufferFeeData(fd, -5), fd);
  assert.equal(bufferFeeData(null, 2000), null);
});

test("applyGasFeeBuffer patches getFeeData; skips when the buffer is non-positive", async () => {
  const raw = { gasPrice: 1000n, maxFeePerGas: 2000n, maxPriorityFeePerGas: 100n };
  const provider = { getFeeData: async () => raw };
  applyGasFeeBuffer(provider, 2500);
  const buffered = await provider.getFeeData();
  assert.equal(buffered.maxFeePerGas, 2500n); // 2000 * 1.25
  assert.equal(buffered.gasPrice, 1250n); //     1000 * 1.25

  const p2 = { getFeeData: async () => raw };
  const orig = p2.getFeeData;
  applyGasFeeBuffer(p2, 0);
  assert.equal(p2.getFeeData, orig); // left unpatched
});
