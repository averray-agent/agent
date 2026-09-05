import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { encodeBytes32String } from "ethers";

import { importCeremonyModule } from "./ceremony-module-loader.mjs";
import { BankXcmV22Dispatcher } from "../../mcp-server/src/services/bank-xcm-flow.js";

import {
  DEFAULT_RECALL_FEE_FLOOR_RATIO_BPS,
  MAX_FEE_PER_LEG_RAW,
  MIN_RECALL_FEE_FLOOR_RATIO_BPS,
  MIN_DISPATCH_MARGIN_SECONDS,
  assertDispatchMargin,
  assertFeeCeiling,
  assertMatchingStagedDeploy,
  assertParAaveQuote,
  assertParAaveUnwindQuote,
  assertAaveSwapEvent,
  assertRecallParameters,
  assertWireCarriesTopic,
  assertRecallRequestBinding,
  assertRequestBinding,
  assertRecallFeeFloorRatioBps,
  assertUnstaged,
  assertVenuePostage,
  buildCancelPlan,
  buildRecallStageCall,
  computeRecallShares,
  deriveLaneRecallRequestId,
  deriveRecallParameters,
  deriveStagingParameters,
  deriveLaneRequestId,
  depositLegPlan,
  parseArgs,
  pendingWithdrawLegs,
  reconcilePoolRecall,
  reconcilePoolTranche,
  reconcileResumedPoolSell,
  resolveSigner,
  resolveVenueBindings,
  runDepositLegPlan,
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
const CURRENT_POOL = "0x9B35A102d656Fb86d798aF81959e09961DEc28E0";
const LANE = "0x88eE70277E486136676c0b50Ed9b7D7A1a31371f";
const strategyId = encodeBytes32String("HYDRATION_USDC_POOL_V1");

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
  assert.equal(parsed.pool, undefined);
  assert.equal(parsed.maxFeePerLeg, "40000");
  assert.equal(parsed.feeFloorRatioBps, DEFAULT_RECALL_FEE_FLOOR_RATIO_BPS.toString());

  const recall = parseArgs([
    "stage-recall", "--profile", "mainnet", "--request-id", REQUEST, "--recall-id", "1",
    "--fee-floor-ratio-bps", "13500",
  ]);
  assert.equal(recall.maxFeePerLeg, MAX_FEE_PER_LEG_RAW.toString());
  assert.equal(recall.feeFloorRatioBps, "13500");
});

test("explicit legacy pool is parsed and validated against the adapter-reported lane", () => {
  const parsed = parseArgs([
    "stage-dispatch", "--profile", "mainnet", "--pool", POOL,
    "--request-id", REQUEST, "--deployment-id", "4",
  ]);
  assert.equal(parsed.pool, POOL);
  assert.deepEqual(resolveVenueBindings({
    poolAddress: parsed.pool,
    adapterPool: POOL,
    adapterLane: LANE,
  }), { poolAddress: POOL, laneAddress: LANE });
  assert.throws(() => resolveVenueBindings({
    poolAddress: CURRENT_POOL,
    adapterPool: POOL,
    adapterLane: LANE,
  }), /refusing mixed-generation dispatch/u);
  assert.throws(() => resolveVenueBindings({
    poolAddress: POOL,
    adapterPool: POOL,
    adapterLane: "0x0000000000000000000000000000000000000000",
  }), /lane is address\(0\)/u);
});

test("dispatch resolves pool explicitly and derives its lane from adapter state", () => {
  const source = readFileSync(scriptPath, "utf8");
  assert.match(source, /resolvePoolTarget\(\{\s*requestedPool: args\.pool,/u);
  assert.match(source, /resolvePoolVenuePair\(manifest, poolAddress\)/u);
  assert.match(source, /pool\.venueAdapter\(\{ blockTag: adapterBindingBlock \}\)/u);
  assert.match(source, /assertPoolVenueAdapter\(\{/u);
  assert.match(source, /venue\.pool\(\{ blockTag: adapterBindingBlock \}\)/u);
  assert.match(source, /venue\.lane\(\{ blockTag: adapterBindingBlock \}\)/u);
  assert.doesNotMatch(source, /manifest\.contracts\.depositPoolLane/u);
  assert.doesNotMatch(source, /manifest\.contracts\.hydrationDepositPoolAdapter/u);
  assert.doesNotMatch(source, /manifest\.deploymentBlocks\.hydrationDepositPoolAdapter/u);
  assert.match(source, /venueFromBlock: adapterDeploymentBlock/u);
});

test("--use-kms binds dispatch signer to the averray-signer Roles Anywhere provider", async () => {
  const credentialsProvider = async () => ({ accessKeyId: "temporary", secretAccessKey: "temporary" });
  const seen = { builder: [], signer: [] };
  class FakeKmsSigner {
    constructor(options) { seen.signer.push(options); }
    async getAddress() { return OPERATOR; }
  }
  const provider = { name: "read-provider" };
  const env = {
    AWS_REGION: "eu-central-2",
    AWS_USE_ROLES_ANYWHERE: "true",
    KMS_KEY_ID: "arn:aws:kms:eu-central-2:123456789012:key/example",
  };

  const identity = await resolveSigner({
    expectedSigner: OPERATOR,
    useKms: true,
    commit: true,
  }, provider, {
    env,
    KmsSignerClass: FakeKmsSigner,
    credentialsProviderBuilder(options) {
      seen.builder.push(options);
      return credentialsProvider;
    },
  });

  assert.equal(seen.builder.length, 1);
  assert.equal(seen.builder[0].profile, "averray-signer");
  assert.equal(seen.builder[0].env, env);
  assert.equal(seen.signer.length, 1);
  assert.equal(seen.signer[0].credentialsProvider, credentialsProvider);
  assert.equal(seen.signer[0].provider, provider);
  assert.equal(identity.backend, "aws-kms");
});

test("dispatch dry run constructs no KMS signer and requests no credentials", async () => {
  const identity = await resolveSigner({
    expectedSigner: OPERATOR,
    useKms: false,
    commit: false,
  }, { name: "read-provider" }, {
    KmsSignerClass: class RefuseKmsConstruction {
      constructor() { throw new Error("dry run constructed KMS"); }
    },
    credentialsProviderBuilder() {
      throw new Error("dry run requested credentials");
    },
  });

  assert.equal(identity.address, OPERATOR);
  assert.equal(identity.signer, null);
  assert.equal(identity.backend, "expected-signer (dry-run only)");
});

test("dispatch dual-layout import failure names both attempted paths", async () => {
  const repoPath = "file:///repo/mcp-server/src/services/venue-balance-reader.js";
  const imagePath = "file:///app/src/services/venue-balance-reader.js";
  await assert.rejects(
    importCeremonyModule({
      label: "venue balance reader",
      candidates: [repoPath, imagePath],
      importer: async () => { throw new Error("missing"); },
    }),
    (error) => error?.code === "ceremony_module_resolution_failed"
      && error.message.includes(repoPath)
      && error.message.includes(imagePath),
  );
});

test("backend image ships dispatch and only its required script helper", () => {
  const dockerfile = readFileSync(resolve(here, "..", "..", "mcp-server", "Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY scripts\/ops\/pool-venue-dispatch\.mjs \.\/scripts\/ops\/pool-venue-dispatch\.mjs$/mu);
  assert.match(dockerfile, /^COPY scripts\/ops\/capture-bank-xcm-v22-staging-quote\.mjs \.\/scripts\/ops\/capture-bank-xcm-v22-staging-quote\.mjs$/mu);
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

test("cancel still refuses an already-staged request", () => {
  assert.doesNotThrow(() => assertUnstaged({ laneRequestId: ZERO32 }));
  assert.throws(() => assertUnstaged({ laneRequestId: OTHER }), /already staged/u);
});

const DEPLOY_PARAMETERS = Object.freeze({
  sellAmount: 4_450_000n,
  minimumOutput: 4_450_000n,
  maxFeePerLeg: 40_000n,
  dispatchDeadline: 2_000_000_000n,
  nonce: 1n,
});

test("matching staged deploy parameters resume with only the undispatched leg pending", () => {
  assert.equal(assertMatchingStagedDeploy({
    stagedParameters: DEPLOY_PARAMETERS,
    stagedNonce: DEPLOY_PARAMETERS.nonce,
    expectedParameters: DEPLOY_PARAMETERS,
  }), true);
  assert.deepEqual(depositLegPlan(1n), [
    { leg: "deposit_funding", bit: 0, status: "skipped" },
    { leg: "deposit_sell", bit: 1, status: "pending" },
  ]);
  const source = readFileSync(scriptPath, "utf8");
  assert.match(source, /if \(isResume\) \{\s+assertMatchingStagedDeploy\(\{/u);
});

test("every staged deploy parameter mismatch refuses and names the differing field", () => {
  for (const field of ["sellAmount", "minimumOutput", "maxFeePerLeg", "dispatchDeadline", "nonce"]) {
    const stagedParameters = { ...DEPLOY_PARAMETERS };
    let stagedNonce = DEPLOY_PARAMETERS.nonce;
    if (field === "nonce") stagedNonce += 1n;
    else stagedParameters[field] += 1n;
    assert.throws(
      () => assertMatchingStagedDeploy({ stagedParameters, stagedNonce, expectedParameters: DEPLOY_PARAMETERS }),
      new RegExp(`Staged deploy ${field} mismatch`, "u"),
      field,
    );
  }
});

test("completed deposit legs are skipped and reported instead of dispatched", async () => {
  const calls = [];
  const results = await runDepositLegPlan({
    bitmap: 1n,
    dispatchFunding: async () => { calls.push("deposit_funding"); },
    dispatchSell: async () => { calls.push("deposit_sell"); return { txHash: OTHER }; },
  });
  assert.deepEqual(calls, ["deposit_sell"]);
  assert.deepEqual(results.deposit_funding, {
    status: "skipped",
    reason: "wrapper bitmap bit 0 is already set",
    bit: 0,
  });
  assert.equal(results.deposit_sell.status, "dispatched");
});

test("resumed deposit sell still refuses when its exact dry-run guard fails", async () => {
  let signed = 0;
  const dispatcher = new BankXcmV22Dispatcher({
    enabled: true,
    expectedWrapper: VENUE,
    readLiveRequest: async () => ({
      wrapper: VENUE,
      liveState: true,
      requestId: REQUEST,
      kind: "deposit",
      status: "pending",
      dispatchPaused: false,
      operatorMatches: true,
      bitmap: 1,
      assets: "4500000",
      parameters: {
        sellAmount: "4450000",
        minimumOutput: "4450000",
        maxFeePerLeg: "40000",
        dispatchDeadline: "2000000000",
      },
    }),
    quoteRemoteFee: async () => ({ liveState: true, amount: "17000", asOf: 2_000_000_000 }),
    quoteHomeExecutionFee: async () => ({ liveState: true, amount: "1", asOf: 2_000_000_000 }),
    readRemoteOperatingFloat: async () => ({
      liveState: true,
      assets: "6017926",
      asOf: 2_000_000_000,
      remoteRef: OTHER,
    }),
    readFundingTransferFee: async () => ({ liveState: true, amount: "643", asOf: 2_000_000_000 }),
    dryRunMessage: async () => ({
      liveState: true,
      ok: true,
      executionSucceeded: true,
      calldata: "0x1234",
      events: [],
    }),
    simulateReviveCall: async () => ({ liveState: true, success: true, weightUsed: { refTime: 1, proofSize: 1 }, storageDepositUsed: 1 }),
    estimateGas: async () => 1,
    requireArmedWatch: async () => ({ registrationSource: "chain_event" }),
    recordRemoteOperatingFloat: async () => ({ status: 1 }),
    signAndDispatch: async () => { signed += 1; return { status: 1, gasUsed: 1 }; },
    now: () => 2_000_000_000_000,
  });
  await assert.rejects(
    runDepositLegPlan({
      bitmap: 1n,
      dispatchFunding: async () => { throw new Error("completed funding leg was replayed"); },
      dispatchSell: async () => dispatcher.dispatch({ requestId: REQUEST, leg: "deposit_sell" }),
    }),
    /did not emit expected Broadcast\.Swapped/u,
  );
  assert.equal(signed, 0);
  const source = readFileSync(scriptPath, "utf8");
  assert.match(source, /const legResults = await runDepositLegPlan\(\{/u);
});

test("fully unstaged deposit dispatch retains the original funding then sell order", async () => {
  const calls = [];
  const results = await runDepositLegPlan({
    bitmap: 0n,
    dispatchFunding: async () => { calls.push("deposit_funding"); return { txHash: REQUEST }; },
    dispatchSell: async () => { calls.push("deposit_sell"); return { txHash: OTHER }; },
  });
  assert.deepEqual(calls, ["deposit_funding", "deposit_sell"]);
  assert.equal(results.deposit_funding.status, "dispatched");
  assert.equal(results.deposit_sell.status, "dispatched");
});

test("resume leaves fee policy, leg construction, and dispatch parameters unchanged", () => {
  const derived = deriveStagingParameters({
    requestedAssets: 4_500_000n,
    maxFeePerLeg: 40_000n,
    floatHeadroom: 50_000n,
    returnBy: 2_000_000_000n,
    nonce: 1n,
  });
  assert.deepEqual(derived, DEPLOY_PARAMETERS);
  assert.deepEqual(depositLegPlan(0n).map(({ leg }) => leg), ["deposit_funding", "deposit_sell"]);
  assert.throws(() => depositLegPlan(2n), /unexpected dispatch bitmap 2/u);
  const source = readFileSync(scriptPath, "utf8");
  assert.match(source, /services\.dispatcher\.dispatch\(\{ requestId: liveLaneRequestId, leg: "deposit_funding" \}\)/u);
  assert.match(source, /services\.dispatcher\.dispatch\(\{ requestId: liveLaneRequestId, leg: "deposit_sell" \}\)/u);
});

test("resumed sell evidence reconciles only the observable remaining leg", () => {
  assert.deepEqual(reconcileResumedPoolSell({
    committed: 4_500_000n,
    floatBeforeSell: 6_017_926n,
    finalFloat: 1_567_426n,
    swapInput: 4_450_000n,
    deployedAUsdc: 4_450_000n,
  }), {
    committedRaw: 4_500_000n,
    fundingArrivalRaw: null,
    fundingTransferFeeRaw: null,
    remoteFloatBeforeSellRaw: 6_017_926n,
    remoteFloatAfterSellRaw: 1_567_426n,
    swapInputRaw: 4_450_000n,
    aUsdcMintedRaw: 4_450_000n,
    sellExecutionFeeRaw: 500n,
    reconciled: false,
    remainingLegReconciled: true,
    disclosure: "Funding was dispatched before this process; its historical balance baseline is not reconstructed or invented.",
  });
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
  assert.equal(MAX_FEE_PER_LEG_RAW, 80_000n);
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

test("fee and float mutation refuses when headroom falls below maxFeePerLeg", () => {
  const authorized = {
    requestedAssets: 4_500_000n,
    maxFeePerLeg: 40_000n,
    floatHeadroom: 50_000n,
    returnBy: 2_000_000_000n,
    nonce: 1n,
  };
  assert.doesNotThrow(() => deriveStagingParameters(authorized));
  assert.throws(
    () => deriveStagingParameters({ ...authorized, floatHeadroom: 39_999n }),
    /Float headroom must be at least maxFeePerLeg/u,
  );
});

test("pool lane request identity is deterministic and nonce-bound", () => {
  const one = deriveLaneRequestId({ strategyId, venueAddress: VENUE, asset: "0x0000053900000000000000000000000001200000", assets: 2_000_000n, nonce: 1n });
  const two = deriveLaneRequestId({ strategyId, venueAddress: VENUE, asset: "0x0000053900000000000000000000000001200000", assets: 2_000_000n, nonce: 2n });
  assert.match(one, /^0x[0-9a-f]{64}$/u);
  assert.notEqual(one, two);
});

test("fresh par quote holds filler-level par within the accrual ceiling (entry direction)", () => {
  const amount = 1_950_000n;
  const base = { fillerType: "AAVE", assetIn: 22, assetOut: 1003, amountInRaw: amount.toString(), amountOutRaw: amount.toString() };
  assert.equal(assertParAaveQuote(base, amount), true);
  // Measured live 2026-08-16: staging 4,910,000 produced a 4,910,004/4,910,004
  // event — the entry direction grosses up by index accrual exactly like exit.
  const accrued = { ...base, amountInRaw: (amount + 4n).toString(), amountOutRaw: (amount + 4n).toString() };
  assert.equal(assertParAaveQuote(accrued, amount), true);
  assert.throws(() => assertParAaveQuote({ ...base, amountOutRaw: (amount - 1n).toString() }, amount), /filler-level par/u);
  assert.throws(() => assertParAaveQuote({ ...base, amountInRaw: (amount - 1n).toString(), amountOutRaw: (amount - 1n).toString() }, amount), /accrual-bounded window/u);
  const over = (amount + unwindAccrualCeiling(amount) + 1n).toString();
  assert.throws(() => assertParAaveQuote({ ...base, amountInRaw: over, amountOutRaw: over }, amount), /accrual-bounded window/u);
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
  const one = deriveLaneRecallRequestId({ strategyId, venueAddress: VENUE, asset: "0x0000053900000000000000000000000001200000", shares: 500_000n, nonce: 1n });
  const two = deriveLaneRecallRequestId({ strategyId, venueAddress: VENUE, asset: "0x0000053900000000000000000000000001200000", shares: 500_000n, nonce: 2n });
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
  assert.throws(
    () => selectRecallDispatchFee({ quote: 27_000n, maximum: 40_000n, available: 50_000n }),
    /configured 1\.5× fresh quote floor \(15000 bps\)/u,
  );
  assert.throws(() => selectRecallDispatchFee({ quote: 18_000n, maximum: 40_000n, available: 35_999n }), /cannot fund/u);
});

test("live 28,645 quote accepts the staged 40k cap at the hard-minimum 1.35x floor", () => {
  // Hydration xcmPaymentApi.queryWeightToAssetFee measured 28,588–28,645 raw
  // during 2026-08-21 12:24–13:20Z. Recall 4 has 40,000 baked on-chain.
  assert.deepEqual(selectRecallDispatchFee({
    quote: 28_645n,
    maximum: 40_000n,
    available: 50_000n,
    floorBps: 13_500n,
  }), {
    feeAmount: 40_000n,
    feeSource: "fresh_remote_quote_capped",
  });
  assert.throws(
    () => selectRecallDispatchFee({ quote: 28_645n, maximum: 40_000n, available: 50_000n }),
    /configured 1\.5× fresh quote floor \(15000 bps\)/u,
  );
});

test("hard-minimum mutation guard refuses --fee-floor-ratio-bps 13400 by name", () => {
  assert.equal(assertRecallFeeFloorRatioBps("13500"), MIN_RECALL_FEE_FLOOR_RATIO_BPS);
  assert.throws(
    () => selectRecallDispatchFee({
      quote: 28_645n,
      maximum: 40_000n,
      available: 50_000n,
      floorBps: 13_400n,
    }),
    /--fee-floor-ratio-bps 13400 is below the hard minimum 13500/u,
  );

  const result = spawnSync("node", [scriptPath, "stage-recall", "--fee-floor-ratio-bps", "13400"], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--fee-floor-ratio-bps 13400 is below the hard minimum 13500/u);
  assert.doesNotMatch(result.stderr, /Ceremony RPC preflight/u);
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
  assert.match(source, /selectRecallDispatchFee\(\{[\s\S]*floorBps: runtime\.feeFloorRatioBps,[\s\S]*\}\)/u);
  assert.match(source, /feeFloorRatioBps: args\.feeFloorRatioBps/u);
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
