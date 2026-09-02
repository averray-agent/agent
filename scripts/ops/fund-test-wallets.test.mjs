import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, planBatchFund } from "./fund-test-wallets.mjs";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

test("parseArgs: defaults to a dry-run with 5 USDC / 1 PAS", () => {
  const args = parseArgs([]);
  assert.equal(args.dryRun, true);
  assert.deepEqual(args.wallets, []);
  assert.equal(args.usdc, "5");
  assert.equal(args.pas, "1");
  assert.equal(args.profile, "testnet");
});

test("parseArgs: --wallets splits on commas, --commit flips dry-run off", () => {
  const args = parseArgs(["--wallets", `${A}, ${B}`, "--usdc", "10", "--pas", "2", "--commit"]);
  assert.deepEqual(args.wallets, [A, B]);
  assert.equal(args.usdc, "10");
  assert.equal(args.pas, "2");
  assert.equal(args.dryRun, false);
});

test("parseArgs: unknown flag throws", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/u);
});

test("planBatchFund: totals scale with target count and flag no shortfall when funded", () => {
  const plan = planBatchFund({
    wallets: [A, B],
    usdcPerWallet: 5_000_000n, // 5 USDC
    pasPerWallet: 1_000_000_000_000_000_000n, // 1 PAS
    poolUsdc: 100_000_000n, // 100 USDC
    poolPas: 100_000_000_000_000_000_000n // 100 PAS
  });
  assert.deepEqual(plan.targets, [A, B]);
  assert.equal(plan.totalUsdc, 10_000_000n);
  assert.equal(plan.totalPas, 2_000_000_000_000_000_000n);
  assert.equal(plan.usdcShort, false);
  assert.equal(plan.pasShort, false);
});

test("planBatchFund: flags a USDC shortfall", () => {
  const plan = planBatchFund({
    wallets: [A, B],
    usdcPerWallet: 5_000_000n,
    pasPerWallet: 1_000_000_000_000_000_000n,
    poolUsdc: 5_000_000n, // only enough for one
    poolPas: 100_000_000_000_000_000_000n
  });
  assert.equal(plan.usdcShort, true);
});

test("planBatchFund: PAS shortfall accounts for gas headroom", () => {
  const plan = planBatchFund({
    wallets: [A],
    usdcPerWallet: 5_000_000n,
    pasPerWallet: 1_000_000_000_000_000_000n, // 1 PAS handed out
    poolUsdc: 100_000_000n,
    poolPas: 1_000_000_000_000_000_000n, // exactly 1 PAS — no room for the 0.5 gas headroom
    gasHeadroom: 500_000_000_000_000_000n
  });
  assert.equal(plan.pasShort, true);
});

test("planBatchFund: rejects a sub-existential-deposit --pas", () => {
  assert.throws(
    () =>
      planBatchFund({
        wallets: [A],
        usdcPerWallet: 5_000_000n,
        pasPerWallet: 1_000_000_000_000_000n, // 0.001 PAS — below the 0.01 floor
        poolUsdc: 100_000_000n,
        poolPas: 100_000_000_000_000_000_000n
      }),
    /existential deposit/u
  );
});

test("planBatchFund: rejects empty list, bad address, and duplicates", () => {
  const base = {
    usdcPerWallet: 5_000_000n,
    pasPerWallet: 1_000_000_000_000_000_000n,
    poolUsdc: 100_000_000n,
    poolPas: 100_000_000_000_000_000_000n
  };
  assert.throws(() => planBatchFund({ ...base, wallets: [] }), /No target wallets/u);
  assert.throws(() => planBatchFund({ ...base, wallets: ["0xnothex"] }), /valid 0x address/u);
  assert.throws(() => planBatchFund({ ...base, wallets: [A, A] }), /Duplicate/u);
});

test("planBatchFund: rejects non-positive amounts", () => {
  assert.throws(
    () => planBatchFund({ wallets: [A], usdcPerWallet: 0n, pasPerWallet: 1n, poolUsdc: 1n, poolPas: 1n }),
    /must both be positive/u
  );
});
