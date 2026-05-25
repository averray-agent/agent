// Tests for scripts/ops/audit-launch-readiness.mjs.
//
// The audit itself hits Hub TestNet, so we don't exercise main() here.
// Instead we cover the pure logic that decides whether the backend
// signer has enough USDC for a claim — the same calculation the
// contract performs in EscrowCore.claimJobFor (reward + claimStake +
// claimFee). If this diverges from the chain, the audit's "required"
// number diverges too, and the operator gets a misleading gap.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  resolveRewardRaw,
  computeRequiredClaimAmount,
  formatUsdc
} from "./audit-launch-readiness.mjs";

// --- parseArgs ------------------------------------------------------------

test("parseArgs: defaults to testnet profile and no --min-reward override", () => {
  const args = parseArgs([]);
  assert.equal(args.profile, "testnet");
  assert.equal(args.minRewardRaw, undefined);
});

test("parseArgs: --profile picks a non-default deployments file", () => {
  const args = parseArgs(["--profile", "mainnet"]);
  assert.equal(args.profile, "mainnet");
});

test("parseArgs: --min-reward captures the raw base-unit string", () => {
  const args = parseArgs(["--min-reward", "100000"]);
  assert.equal(args.minRewardRaw, "100000");
});

test("parseArgs: ignores unknown flags rather than throwing", () => {
  const args = parseArgs(["--unknown", "value", "--profile", "testnet"]);
  assert.equal(args.profile, "testnet");
});

// --- resolveRewardRaw -----------------------------------------------------

test("resolveRewardRaw: default is 0.1 USDC = 100_000 raw (matches run-hosted-worker-loop)", () => {
  assert.equal(resolveRewardRaw({}), 100_000n);
  assert.equal(resolveRewardRaw({ cliRaw: undefined, envDecimal: undefined }), 100_000n);
  assert.equal(resolveRewardRaw({ cliRaw: "", envDecimal: "" }), 100_000n);
});

test("resolveRewardRaw: --min-reward takes precedence over env", () => {
  assert.equal(
    resolveRewardRaw({ cliRaw: "250000", envDecimal: "0.1" }),
    250_000n
  );
});

test("resolveRewardRaw: PRODUCT_PROOF_REWARD_AMOUNT env parses decimal USDC", () => {
  assert.equal(resolveRewardRaw({ envDecimal: "0.1" }), 100_000n);
  assert.equal(resolveRewardRaw({ envDecimal: "1.234567" }), 1_234_567n);
  assert.equal(resolveRewardRaw({ envDecimal: "5" }), 5_000_000n);
});

test("resolveRewardRaw: rejects zero or negative --min-reward", () => {
  assert.throws(() => resolveRewardRaw({ cliRaw: "0" }), /must be positive/u);
});

test("resolveRewardRaw: rejects env with more than 6 fractional digits", () => {
  assert.throws(
    () => resolveRewardRaw({ envDecimal: "0.1234567" }),
    /6 decimal places/u
  );
});

test("resolveRewardRaw: rejects non-decimal env input", () => {
  assert.throws(() => resolveRewardRaw({ envDecimal: "1e6" }), /positive decimal/u);
  assert.throws(() => resolveRewardRaw({ envDecimal: "-1" }), /positive decimal/u);
  assert.throws(() => resolveRewardRaw({ envDecimal: "abc" }), /positive decimal/u);
});

// --- computeRequiredClaimAmount ------------------------------------------

test("computeRequiredClaimAmount: today's testnet params (10% stake + 2% fee on 0.1 USDC reward)", () => {
  // Live testnet params (deployments/testnet.json):
  //   reward = 100_000 raw (0.1 USDC)
  //   stake  = 100_000 * 1000 / 10_000 = 10_000   (defaultClaimStakeBps=1000)
  //   fee    = 100_000 *  200 / 10_000 =  2_000   (claimFeeBps=200)
  //   total  = 112_000 raw = 0.112 USDC
  // The 2026-05-25 hosted failure had positions.liquid = 100_000 raw, short
  // by exactly 12_000 raw.
  const required = computeRequiredClaimAmount({
    reward: 100_000n,
    defaultClaimStakeBps: 1000,
    claimFeeBps: 200
  });
  assert.equal(required, 112_000n);
});

test("computeRequiredClaimAmount: zero bps means required == reward", () => {
  const required = computeRequiredClaimAmount({
    reward: 100_000n,
    defaultClaimStakeBps: 0,
    claimFeeBps: 0
  });
  assert.equal(required, 100_000n);
});

test("computeRequiredClaimAmount: accepts bigint, number, and string reward", () => {
  const params = { defaultClaimStakeBps: 1000, claimFeeBps: 200 };
  assert.equal(computeRequiredClaimAmount({ reward: 100_000n, ...params }), 112_000n);
  assert.equal(computeRequiredClaimAmount({ reward: 100_000, ...params }), 112_000n);
  assert.equal(computeRequiredClaimAmount({ reward: "100000", ...params }), 112_000n);
});

test("computeRequiredClaimAmount: uses integer division like the contract", () => {
  // reward = 7 raw, stakeBps = 1000 → stake = 7 * 1000 / 10000 = 0 (floor).
  // Same rounding the EVM uses for uint256 division — the audit MUST agree
  // or the gap will be off by 1 raw at small amounts.
  const required = computeRequiredClaimAmount({
    reward: 7n,
    defaultClaimStakeBps: 1000,
    claimFeeBps: 200
  });
  assert.equal(required, 7n);
});

test("computeRequiredClaimAmount: rejects non-positive reward and negative bps", () => {
  assert.throws(
    () => computeRequiredClaimAmount({ reward: 0n, defaultClaimStakeBps: 1000, claimFeeBps: 200 }),
    /reward must be positive/u
  );
  assert.throws(
    () => computeRequiredClaimAmount({ reward: 100_000n, defaultClaimStakeBps: -1, claimFeeBps: 200 }),
    /bps values must be non-negative/u
  );
});

// --- formatUsdc -----------------------------------------------------------

test("formatUsdc: integer USDC has no decimals appended", () => {
  assert.equal(formatUsdc(0n), "0");
  assert.equal(formatUsdc(1_000_000n), "1");
  assert.equal(formatUsdc(10_000_000n), "10");
});

test("formatUsdc: fractional USDC keeps significant digits and trims trailing zeros", () => {
  assert.equal(formatUsdc(100_000n), "0.1");
  assert.equal(formatUsdc(112_000n), "0.112");
  assert.equal(formatUsdc(50_000n), "0.05");
  assert.equal(formatUsdc(1n), "0.000001");
});

test("formatUsdc: matches the gap the audit would print for the 2026-05-25 failure", () => {
  // signer.liquid = 100_000 raw (0.10 USDC), required = 112_000 raw (0.112).
  // Gap = 12_000 raw = 0.012 USDC. This is the literal string the operator
  // copies into `fund-signer-usdc-deposit.mjs --amount <gap>`.
  const liquid = 100_000n;
  const required = computeRequiredClaimAmount({
    reward: 100_000n,
    defaultClaimStakeBps: 1000,
    claimFeeBps: 200
  });
  const gap = required - liquid;
  assert.equal(gap, 12_000n);
  assert.equal(formatUsdc(gap), "0.012");
});
