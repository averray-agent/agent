import test from "node:test";
import assert from "node:assert/strict";

import { checkSolvencyInvariants, parseArgs } from "./solvency-watcher.mjs";

// USDC base units (6 decimals). 1_000000n = 1 USDC.

test("healthy: balance covers accounted, liquid covers debt, above floor", () => {
  const r = checkSolvencyInvariants({
    contractUsdcBalance: 100_000000n,
    signerAccounted: 50_000000n,
    signerLiquid: 40_000000n,
    signerDebt: 0n,
    absoluteFloor: 10_000000n,
  });
  assert.equal(r.healthy, true);
  assert.equal(r.violations.length, 0);
  assert.equal(r.recommendPause, false);
});

test("CRITICAL solvency-lower-bound: contract balance below signer-accounted → recommend pause", () => {
  const r = checkSolvencyInvariants({
    contractUsdcBalance: 30_000000n,
    signerAccounted: 50_000000n,
    signerLiquid: 30_000000n,
    signerDebt: 0n,
    absoluteFloor: null,
  });
  assert.equal(r.healthy, false);
  assert.equal(r.recommendPause, true);
  assert.equal(r.violations[0].invariant, "solvency-lower-bound");
  assert.equal(r.violations[0].severity, "critical");
});

test("HIGH debt-gate breach does NOT recommend pause on its own", () => {
  const r = checkSolvencyInvariants({
    contractUsdcBalance: 100_000000n,
    signerAccounted: 50_000000n,
    signerLiquid: 5_000000n,
    signerDebt: 10_000000n,
    absoluteFloor: null,
  });
  assert.equal(r.healthy, false);
  assert.equal(r.recommendPause, false); // high, not critical
  assert.equal(r.violations[0].invariant, "debt-gate");
  assert.equal(r.violations[0].severity, "high");
});

test("CRITICAL balance-floor tripwire → recommend pause", () => {
  const r = checkSolvencyInvariants({
    contractUsdcBalance: 5_000000n,
    signerAccounted: 3_000000n,
    signerLiquid: 5_000000n,
    signerDebt: 0n,
    absoluteFloor: 10_000000n,
  });
  assert.equal(r.recommendPause, true);
  assert.ok(r.violations.some((v) => v.invariant === "balance-floor" && v.severity === "critical"));
});

test("no absoluteFloor configured → floor check is skipped", () => {
  const r = checkSolvencyInvariants({
    contractUsdcBalance: 1n,
    signerAccounted: 0n,
    signerLiquid: 1n,
    signerDebt: 0n,
    absoluteFloor: null,
  });
  assert.equal(r.healthy, true);
});

test("parseArgs basics", () => {
  assert.equal(parseArgs(["--profile", "mainnet"]).profile, "mainnet");
  assert.equal(parseArgs(["--floor", "5"]).floor, "5");
  assert.equal(parseArgs([]).profile, "testnet");
  assert.throws(() => parseArgs(["--bogus"]));
});
