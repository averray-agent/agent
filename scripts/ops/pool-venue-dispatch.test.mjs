import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  MAX_FEE_PER_LEG_RAW,
  MIN_DISPATCH_MARGIN_SECONDS,
  assertDispatchMargin,
  assertFeeCeiling,
  assertParAaveQuote,
  assertRequestBinding,
  assertUnstaged,
  buildCancelPlan,
  deriveStagingParameters,
  deriveLaneRequestId,
  parseArgs,
  reconcilePoolTranche,
} from "./pool-venue-dispatch.mjs";
import { assertObservability } from "./pool-venue-ceremony.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "pool-venue-dispatch.mjs");
const REQUEST = `0x${"11".repeat(32)}`;
const OTHER = `0x${"22".repeat(32)}`;
const ZERO32 = `0x${"00".repeat(32)}`;
const OPERATOR = "0x5a6836c6D4d293F6E5377E6c28054F4171915813";
const VENUE = "0xE2801E6C640e0180798912649fD567E1Ea459a35";
const POOL = "0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30";

function pendingRequest(overrides = {}) {
  return { kind: 0, status: 1, requestedAssets: 2_000_000n, settledAssets: 0n, returnBy: 2_000_000_000n, claimed: false, ...overrides };
}

test("CLI is dry-run by default and requires explicit ceremony flags for writes", () => {
  const parsed = parseArgs(["stage-dispatch", "--profile", "mainnet", "--request-id", REQUEST, "--deployment-id", "1"]);
  assert.equal(parsed.commit, false);
  assert.equal(parsed.useKms, false);
  assert.equal(parsed.maxFeePerLeg, MAX_FEE_PER_LEG_RAW.toString());
});

test("wrong requestId fails loud before staging", () => {
  assert.throws(() => assertRequestBinding({
    requested: REQUEST,
    activeRequestId: OTHER,
    deployment: { adapterRequestId: REQUEST },
    venueRequest: pendingRequest(),
  }), /Wrong requestId/u);
  assert.throws(() => assertRequestBinding({
    requested: REQUEST,
    activeRequestId: REQUEST,
    deployment: { adapterRequestId: OTHER },
    venueRequest: pendingRequest(),
  }), /Wrong requestId/u);
});

test("already-staged request fails loud", () => {
  assert.doesNotThrow(() => assertUnstaged({ laneRequestId: ZERO32 }));
  assert.throws(() => assertUnstaged({ laneRequestId: OTHER }), /already staged/u);
});

test("stale pool observability refuses the venue ceremony", () => {
  assert.throws(() => assertObservability({
    available: true,
    pool: POOL,
    reconciled: true,
    flows: { status: "ok" },
    block: { timestamp: 1_000 },
  }, { poolAddress: POOL, chainTimestamp: 1_601n }), /stale or future-dated/u);
});

test("fee over the packet ceiling refuses", () => {
  assert.equal(assertFeeCeiling(MAX_FEE_PER_LEG_RAW), MAX_FEE_PER_LEG_RAW);
  assert.throws(() => assertFeeCeiling(MAX_FEE_PER_LEG_RAW + 1n), /exceeds the Packet 7 maximum/u);
});

test("six-hour dispatch margin is a hard stage/cancel boundary", () => {
  assert.equal(assertDispatchMargin({ nowSeconds: 1_000n, returnBy: 1_000n + BigInt(MIN_DISPATCH_MARGIN_SECONDS) }), BigInt(MIN_DISPATCH_MARGIN_SECONDS));
  assert.throws(() => assertDispatchMargin({ nowSeconds: 1_000n, returnBy: 1_000n + BigInt(MIN_DISPATCH_MARGIN_SECONDS) - 1n }), /Run cancel instead/u);
});

test("two-USDC staging leaves explicit fee and operating-float headroom", () => {
  const parameters = deriveStagingParameters({ requestedAssets: 2_000_000n, maxFeePerLeg: 40_000n, floatHeadroom: 50_000n, returnBy: 2_000_000_000n, nonce: 1n });
  assert.deepEqual(parameters, {
    sellAmount: 1_950_000n,
    minimumOutput: 1_950_000n,
    maxFeePerLeg: 40_000n,
    dispatchDeadline: 2_000_000_000n,
    nonce: 1n,
  });
  assert.equal(parameters.sellAmount + 50_000n, 2_000_000n);
});

test("pool lane request identity is deterministic and nonce-bound", () => {
  const one = deriveLaneRequestId({ venueAddress: VENUE, asset: "0x0000053900000000000000000000000001200000", assets: 2_000_000n, nonce: 1n });
  const two = deriveLaneRequestId({ venueAddress: VENUE, asset: "0x0000053900000000000000000000000001200000", assets: 2_000_000n, nonce: 2n });
  assert.match(one, /^0x[0-9a-f]{64}$/u);
  assert.notEqual(one, two);
});

test("fresh par quote must be the AAVE 22 to 1003 route and exactly one-to-one", () => {
  const amount = 1_950_000n;
  const base = { fillerType: "AAVE", assetIn: 22, assetOut: 1003, amountInRaw: amount.toString(), amountOutRaw: amount.toString() };
  assert.equal(assertParAaveQuote(base, amount), true);
  assert.throws(() => assertParAaveQuote({ ...base, amountOutRaw: (amount - 1n).toString() }, amount), /not exactly 1:1/u);
});

test("cancel fallback contains only cancelUnstaged then pool settlement", () => {
  const plan = buildCancelPlan({ venueAddress: VENUE, poolAddress: POOL, requestId: REQUEST, deploymentId: 1n });
  assert.deepEqual(plan.map(({ name, to, value }) => ({ name, to, value })), [
    { name: "cancelUnstaged", to: VENUE, value: "0" },
    { name: "settleVenueDeployment", to: POOL, value: "0" },
  ]);
  assert.match(plan[0].data, /^0x[0-9a-f]+$/u);
  assert.match(plan[1].data, /^0x[0-9a-f]+$/u);
});

test("fee ledger isolates the pool tranche and refuses consumption of operating-lane float", () => {
  assert.deepEqual(reconcilePoolTranche({
    committed: 2_000_000n,
    baselineFloat: 30_000n,
    fundedFloat: 2_029_400n,
    finalFloat: 78_900n,
    deployedAUsdc: 1_950_000n,
  }), {
    committedRaw: 2_000_000n,
    fundingArrivalRaw: 1_999_400n,
    aUsdcMintedRaw: 1_950_000n,
    poolFloatRemainingRaw: 48_900n,
    fundingTransferFeeRaw: 600n,
    sellExecutionFeeRaw: 500n,
    reconciled: true,
  });
  assert.throws(() => reconcilePoolTranche({
    committed: 2_000_000n,
    baselineFloat: 30_000n,
    fundedFloat: 2_029_400n,
    finalFloat: 29_999n,
    deployedAUsdc: 1_969_401n,
  }), /consumed pre-existing operating-lane float/u);
});

test("stage-dispatch source pins FIND #20 runtime-transformed funding evidence", () => {
  const source = readFileSync(scriptPath, "utf8");
  assert.match(source, /frameSource !== "runtime_transformed_local_execute"/u);
  assert.match(source, /new BankXcmV22Runtime/u);
  assert.match(source, /poolSettleVenueDeploymentRunnable: true/u);
  assert.match(source, /request-bound Broadcast\.Swapped/u);
  assert.match(source, /preSettlementAccrualRaw/u);
  assert.match(source, /poolFloatRemainingRaw < 0n/u);
  assert.doesNotMatch(source, /--signer-secret|--private-key|PRIVATE_KEY/u);
});

test("commit without KMS refuses before RPC access", () => {
  const result = spawnSync("node", [
    scriptPath, "cancel", "--profile", "mainnet", "--request-id", REQUEST,
    "--deployment-id", "1", "--expected-signer", OPERATOR, "--commit",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--commit requires --use-kms/u);
  assert.doesNotMatch(result.stderr, /Ceremony RPC preflight/u);
});
