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
  assertParAaveUnwindQuote,
  assertAaveSwapEvent,
  assertRecallParameters,
  assertWireCarriesTopic,
  assertRecallRequestBinding,
  assertRequestBinding,
  assertUnstaged,
  assertVenuePostage,
  buildCancelPlan,
  buildRecallStageCall,
  computeRecallShares,
  deriveLaneRecallRequestId,
  deriveRecallParameters,
  deriveStagingParameters,
  deriveLaneRequestId,
  parseArgs,
  pendingWithdrawLegs,
  reconcilePoolRecall,
  reconcilePoolTranche,
  selectRecallDispatchFee,
  unwindAccrualCeiling,
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

function pendingRecall(overrides = {}) {
  return { kind: 1, status: 1, requestedAssets: 500_000n, settledAssets: 0n, returnBy: 2_000_000_000n, claimed: false, ...overrides };
}

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
  assert.match(source, /recall \? PoolLaneRecallRuntime : BankXcmV22Runtime/u);
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

test("recall binding refuses wrong kind and any pool/venue mismatch", () => {
  const recall = { deploymentId: 1n, requestedAssets: 500_000n, returnedAssets: 0n, adapterRequestId: REQUEST, status: 1 };
  assert.doesNotThrow(() => assertRecallRequestBinding({
    requested: REQUEST,
    activeRequestId: REQUEST,
    activeRecallId: 1n,
    recallId: 1n,
    recall,
    venueRequest: pendingRecall(),
  }));
  assert.throws(() => assertRecallRequestBinding({
    requested: REQUEST,
    activeRequestId: REQUEST,
    activeRecallId: 1n,
    recallId: 1n,
    recall,
    venueRequest: pendingRecall({ kind: 0 }),
  }), /not a live recall request/u);
  assert.throws(() => assertRecallRequestBinding({
    requested: REQUEST,
    activeRequestId: REQUEST,
    activeRecallId: 2n,
    recallId: 1n,
    recall,
    venueRequest: pendingRecall(),
  }), /active recall/u);
  assert.throws(() => assertRecallRequestBinding({
    requested: REQUEST,
    activeRequestId: REQUEST,
    activeRecallId: 1n,
    recallId: 1n,
    recall: { ...recall, adapterRequestId: OTHER },
    venueRequest: pendingRecall(),
  }), /bound to/u);
  assert.throws(() => assertRecallRequestBinding({
    requested: REQUEST,
    activeRequestId: REQUEST,
    activeRecallId: 1n,
    recallId: 1n,
    recall: { ...recall, requestedAssets: 499_999n },
    venueRequest: pendingRecall(),
  }), /requestedAssets does not match/u);
});

test("recall share math uses ceilDiv and accepts small rebase drift", () => {
  assert.equal(computeRecallShares({ requestedAssets: 500_000n, venueAssets: 1_950_001n, venueShares: 1_950_000n }), 500_000n);
  assert.equal(computeRecallShares({ requestedAssets: 500_001n, venueAssets: 1_950_001n, venueShares: 1_950_000n }), 500_001n);
  assert.throws(() => computeRecallShares({ requestedAssets: 1n, venueAssets: 0n, venueShares: 1n }), /non-zero/u);
  assert.throws(() => computeRecallShares({ requestedAssets: 1n, venueAssets: 1n, venueShares: 0n }), /non-zero/u);
  assert.throws(() => computeRecallShares({ requestedAssets: 2n, venueAssets: 1n, venueShares: 1n }), /exceeds live venue shares/u);
});

test("recall parameters hard-bind minimumOutput to requestedAssets", () => {
  const parameters = deriveRecallParameters({
    requestedAssets: 500_000n,
    venueAssets: 1_950_001n,
    venueShares: 1_950_000n,
    maxFeePerLeg: 40_000n,
    returnBy: 2_000_000_000n,
    nonce: 2n,
  });
  assert.deepEqual(parameters, {
    shares: 500_000n,
    lane: {
      sellAmount: 500_000n,
      minimumOutput: 500_000n,
      maxFeePerLeg: 40_000n,
      dispatchDeadline: 2_000_000_000n,
      nonce: 2n,
    },
  });
  assert.equal(assertRecallParameters({ parameters: parameters.lane, requestedAssets: 500_000n }), true);
  assert.throws(() => assertRecallParameters({ parameters: { ...parameters.lane, minimumOutput: 499_999n }, requestedAssets: 500_000n }), /minimumOutput must equal requestedAssets/u);
  const encoded = buildRecallStageCall({ requestId: REQUEST, parameters: parameters.lane, requestedAssets: 500_000n });
  assert.match(encoded.data, /^0x[0-9a-f]+$/u);
  assert.deepEqual(encoded.decoded, {
    requestId: REQUEST,
    sellAmount: 500_000n,
    minimumOutput: 500_000n,
    maxFeePerLeg: 40_000n,
    dispatchDeadline: 2_000_000_000n,
    nonce: 2n,
  });
});

test("recall lane request identity is withdraw-kind and nonce-bound", () => {
  const one = deriveLaneRecallRequestId({ venueAddress: VENUE, asset: "0x0000053900000000000000000000000001200000", shares: 500_000n, nonce: 1n });
  const two = deriveLaneRecallRequestId({ venueAddress: VENUE, asset: "0x0000053900000000000000000000000001200000", shares: 500_000n, nonce: 2n });
  assert.match(one, /^0x[0-9a-f]{64}$/u);
  assert.notEqual(one, two);
});

test("fresh recall quote holds filler-level par within the accrual ceiling", () => {
  const amount = 500_000n;
  const base = { fillerType: "AAVE", assetIn: 1003, assetOut: 22, amountInRaw: amount.toString(), amountOutRaw: amount.toString() };
  assert.equal(assertParAaveUnwindQuote(base, amount), true);
  // Measured live 2026-08-14: the filler grosses the redemption up by accrued
  // interest — 500,032/500,032 against a requested 500,000 is a healthy quote.
  const accrued = { ...base, amountInRaw: "500032", amountOutRaw: "500032" };
  assert.equal(assertParAaveUnwindQuote(accrued, amount), true);
  assert.throws(() => assertParAaveUnwindQuote({ ...base, assetIn: 22, assetOut: 1003 }, amount), /1003→22/u);
  assert.throws(() => assertParAaveUnwindQuote({ ...base, amountOutRaw: (amount - 1n).toString() }, amount), /filler-level par/u);
  assert.throws(() => assertParAaveUnwindQuote({ ...base, amountInRaw: "499999", amountOutRaw: "499999" }, amount), /accrual-bounded window/u);
  const ceiling = unwindAccrualCeiling(amount);
  const over = (amount + ceiling + 1n).toString();
  assert.throws(() => assertParAaveUnwindQuote({ ...base, amountInRaw: over, amountOutRaw: over }, amount), /accrual-bounded window/u);
});

test("unwind accrual ceiling scales with size and floors for small trades", () => {
  assert.equal(unwindAccrualCeiling(500_000n), 516n);
  assert.equal(unwindAccrualCeiling(1_000n), 17n);
  assert.throws(() => unwindAccrualCeiling(0n), /unwind expected input/u);
});

test("venue postage must stay above the ceremony liveness threshold", () => {
  assert.equal(assertVenuePostage({ raw: 500_000_000n }), 500_000_000n);
  assert.throws(() => assertVenuePostage({ raw: 499_999_999n }), /postage/u);
});

test("recall JIT fee doubles fresh quote, caps, and preserves the 1.5x floor", () => {
  assert.deepEqual(selectRecallDispatchFee({ quote: 18_000n, maximum: 40_000n, available: 50_000n }), {
    feeAmount: 36_000n,
    feeSource: "fresh_remote_quote_x2",
  });
  assert.deepEqual(selectRecallDispatchFee({ quote: 20_013n, maximum: 40_000n, available: 50_000n }), {
    feeAmount: 40_000n,
    feeSource: "fresh_remote_quote_capped",
  });
  assert.throws(() => selectRecallDispatchFee({ quote: 27_000n, maximum: 40_000n, available: 50_000n }), /1.5×/u);
  assert.throws(() => selectRecallDispatchFee({ quote: 18_000n, maximum: 40_000n, available: 35_999n }), /cannot fund/u);
});

test("recall cancel is kind-agnostic and does not duplicate pool-side settlement", () => {
  const plan = buildCancelPlan({ venueAddress: VENUE, poolAddress: POOL, requestId: REQUEST, recallId: 1n, kind: "recall" });
  assert.deepEqual(plan.map(({ name, to, value }) => ({ name, to, value })), [
    { name: "cancelUnstaged", to: VENUE, value: "0" },
  ]);
});

test("recall fee ledger closes requested assets and shared remote-float deltas exactly", () => {
  assert.deepEqual(reconcilePoolRecall({
    requestedAssets: 500_000n,
    sharesSold: 500_000n,
    swapOutput: 500_000n,
    floatBefore: 58_000n,
    floatAfterSell: 538_000n,
    floatAfterHome: 38_000n,
    homeArrival: 498_600n,
  }), {
    requestedAssetsRaw: 500_000n,
    sharesSoldRaw: 500_000n,
    aUsdcBurnedRaw: 500_000n,
    asset22SwapOutputRaw: 500_000n,
    exitAccrualRaw: 0n,
    rebaseResidueRaw: 0n,
    sellExecutionFeeRaw: 20_000n,
    remoteHomeDebitRaw: 500_000n,
    homeArrivalRaw: 498_600n,
    homeExecutionAndDeliveryFeeRaw: 1_400n,
    requestedAssetsReconciled: true,
    remoteFloatReconciled: true,
  });
  assert.throws(() => reconcilePoolRecall({
    requestedAssets: 500_000n,
    sharesSold: 500_000n,
    swapOutput: 500_000n,
    floatBefore: 58_000n,
    floatAfterSell: 538_000n,
    floatAfterHome: 38_001n,
    homeArrival: 498_600n,
  }), /did not debit exactly requestedAssets/u);
  // Exit accrual (measured live 2026-08-14): the filler pays out 500,032 for
  // 500,000 shares sold — the extra 32 raw is realized yield landing in float.
  const accrued = reconcilePoolRecall({
    requestedAssets: 500_000n,
    sharesSold: 500_000n,
    swapOutput: 500_032n,
    floatBefore: 58_000n,
    floatAfterSell: 538_032n,
    floatAfterHome: 38_032n,
    homeArrival: 498_600n,
  });
  assert.equal(accrued.exitAccrualRaw, 32n);
  assert.equal(accrued.rebaseResidueRaw, 32n);
  assert.equal(accrued.requestedAssetsReconciled, true);
  assert.equal(accrued.remoteFloatReconciled, true);
  assert.throws(() => reconcilePoolRecall({
    requestedAssets: 500_000n,
    sharesSold: 500_000n,
    swapOutput: 499_999n,
    floatBefore: 58_000n,
    floatAfterSell: 537_999n,
    floatAfterHome: 37_999n,
    homeArrival: 498_600n,
  }), /filler-par accrual bounds/u);
});

test("dry-run swap assert accepts the measured dryRunXcm event shape (no Xcm operationStack entry)", () => {
  // Shape measured live 2026-08-14: DryRunApi.dryRunXcm records Broadcast.Swapped3
  // with operationStack [{Router}] only — the Xcm(topic) entry exists solely in
  // real block execution. Request binding in dry-run comes from execution scope
  // plus the wire's SetTopic suffix (assertWireCarriesTopic below).
  const measured = {
    section: "broadcast",
    method: "Swapped3",
    data: {
      fillerType: "AAVE",
      operation: "ExactIn",
      inputs: [{ asset: "1,003", amount: "500,000" }],
      outputs: [{ asset: "22", amount: "500,000" }],
      fees: [],
      operationStack: [{ Router: "10,576,956" }],
    },
  };
  const swap = assertAaveSwapEvent([measured], { assetIn: 1003, assetOut: 22, expectedInput: 500_000n });
  assert.equal(swap.amountInRaw, 500_000n);
  assert.equal(swap.amountOutRaw, 500_000n);
  assert.equal(swap.exitAccrualRaw, 0n);
  const accrued = { ...measured, data: { ...measured.data, inputs: [{ asset: "1,003", amount: "500,032" }], outputs: [{ asset: "22", amount: "500,032" }] } };
  const accruedSwap = assertAaveSwapEvent([accrued], { assetIn: 1003, assetOut: 22, expectedInput: 500_000n });
  assert.equal(accruedSwap.exitAccrualRaw, 32n);
  const parBreak = { ...measured, data: { ...measured.data, inputs: [{ asset: "1,003", amount: "500,032" }], outputs: [{ asset: "22", amount: "500,031" }] } };
  assert.throws(() => assertAaveSwapEvent([parBreak], { assetIn: 1003, assetOut: 22, expectedInput: 500_000n }), /malformed AAVE/u);
  assert.throws(
    () => assertAaveSwapEvent([], { assetIn: 1003, assetOut: 22, expectedInput: 500_000n }),
    /carried 0 .*expected exactly one/u,
  );
  assert.throws(
    () => assertAaveSwapEvent([measured, measured], { assetIn: 1003, assetOut: 22, expectedInput: 500_000n }),
    /carried 2 .*expected exactly one/u,
  );
  const short = { ...measured, data: { ...measured.data, inputs: [{ asset: "1,003", amount: "499,999" }], outputs: [{ asset: "22", amount: "499,999" }] } };
  assert.throws(
    () => assertAaveSwapEvent([short], { assetIn: 1003, assetOut: 22, expectedInput: 500_000n }),
    /malformed AAVE/u,
  );
});

test("recall wire must terminate with SetTopic(laneRequestId)", () => {
  const topic = "0x14672fbc224ef19fd91548763d2cbf7b88b4e00e74f77d48698a49dbe241dd85";
  assert.equal(assertWireCarriesTopic(`0x051c0bdeadbeef2c${topic.slice(2)}`, topic), true);
  assert.throws(() => assertWireCarriesTopic(`0x051c0bdeadbeef2c${OTHER.slice(2)}`, topic), /SetTopic/u);
  assert.throws(() => assertWireCarriesTopic(`0x051c0bdeadbeef${topic.slice(2)}`, topic), /SetTopic/u);
});

test("staged-recall resume maps dispatch bitmaps to the legs still owed", () => {
  assert.deepEqual(pendingWithdrawLegs(0n), ["withdraw_sell", "withdraw_home"]);
  assert.deepEqual(pendingWithdrawLegs(4n), ["withdraw_home"]);
  assert.deepEqual(pendingWithdrawLegs(12n), []);
  assert.throws(() => pendingWithdrawLegs(3n), /unexpected dispatch bitmap/u);
  assert.throws(() => pendingWithdrawLegs(8n), /unexpected dispatch bitmap/u);
});

test("pool-lane fee law is wired through the created dispatcher, not a dead runtime method", () => {
  const source = readFileSync(scriptPath, "utf8");
  // The dispatcher's own resolveFee is what dispatch() consults; the override
  // must wrap the created dispatcher instance (the #1128 dead-override lesson).
  assert.match(source, /createDispatcher\(\) \{\n    const dispatcher = super\.createDispatcher\(\);/u);
  assert.match(source, /dispatcher\.resolveFee = /u);
  assert.match(source, /selectRecallDispatchFee\(\{ quote: quote\.amount, maximum, available: available\.assets \}\)/u);
  assert.doesNotMatch(source, /async resolveFee\(input\) \{\n    if \(Number\(input\.legIndex\)/u);
  assert.match(source, /resumedFromStagedRequest/u);
  // bitmap 0 resumes both legs; bitmap 4 rebuilds the historical sell from
  // chain state and drives the home leg; bitmap 12 stays fail-closed.
  assert.match(source, /resumedHistoricalLeg/u);
  assert.match(source, /settle-only resume is not implemented/u);
  assert.match(source, /floatBefore: ledgerFloatBefore/u);
  // The evidence block must name real variables: the object-shorthand form of
  // these two fields was a latent ReferenceError first reached by the live
  // bitmap-4 resume (all money steps had already completed and verified).
  assert.match(source, /floatAfterSell: afterSellFloat/u);
  assert.match(source, /floatAfterHome: afterHomeFloat/u);
});

test("stage-recall source pins JIT unwind/home proofs and defers pool settlement", () => {
  const source = readFileSync(scriptPath, "utf8");
  assert.match(source, /dryRunStageAndRecallSell/u);
  assert.match(source, /assetIn: 1003/u);
  assert.match(source, /assetOut: 22/u);
  assert.match(source, /commit-recomputed/u);
  assert.match(source, /fresh_remote_quote_x2/u);
  assert.match(source, /leg: "withdraw_home"/u);
  assert.match(source, /getFunction\("settleVenueRecall"\)\.staticCall/u);
  assert.doesNotMatch(source, /signedPool\.settleVenueRecall/u);
});

test("stage-recall commit without KMS refuses before RPC access", () => {
  const result = spawnSync("node", [
    scriptPath, "stage-recall", "--profile", "mainnet", "--request-id", REQUEST,
    "--recall-id", "1", "--expected-signer", OPERATOR, "--commit",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--commit requires --use-kms/u);
  assert.doesNotMatch(result.stderr, /Ceremony RPC preflight/u);
});
