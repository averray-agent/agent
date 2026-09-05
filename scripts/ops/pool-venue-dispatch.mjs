#!/usr/bin/env node

/**
 * Guarded DepositPool venue staging and dispatch ceremony (Packet 7).
 *
 * Read-only is the default. The only write mode is:
 *   --commit --use-kms --expected-signer 0x...
 *
 * This driver is deliberately bound to one pool deployment request and the
 * dedicated pool lane. It never accepts a raw key and never addresses the
 * operating Hydration adapter.
 */

import {
  AbiCoder,
  Contract,
  Interface,
  getAddress,
  keccak256,
} from "ethers";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createCeremonyRpcContext } from "./ceremony-rpc.mjs";
import { importCeremonyModule } from "./ceremony-module-loader.mjs";
import {
  assertExpectedSigner,
  assertObservability,
  assertPoolVenueAdapter,
  readDeploymentManifest,
  resolvePoolTarget,
  resolvePoolVenuePair,
} from "./pool-venue-ceremony.mjs";
import { extractAaveQuote } from "./capture-bank-xcm-v22-staging-quote.mjs";

const { KmsSigner } = await importCeremonyModule({
  label: "KMS signer",
  candidates: [
    new URL("../../mcp-server/src/blockchain/kms-signer.js", import.meta.url),
    "file:///app/src/blockchain/kms-signer.js",
  ],
});
const { XCM_WRAPPER_ABI } = await importCeremonyModule({
  label: "XCM wrapper ABI",
  candidates: [
    new URL("../../mcp-server/src/blockchain/abis.js", import.meta.url),
    "file:///app/src/blockchain/abis.js",
  ],
});
const {
  BankXcmV22Runtime,
  assertConvertedAccountDeposit,
} = await importCeremonyModule({
  label: "bank XCM runtime",
  candidates: [
    new URL("../../mcp-server/src/services/bank-xcm-v22-runtime.js", import.meta.url),
    "file:///app/src/services/bank-xcm-v22-runtime.js",
  ],
});
const { VenueBalanceReader } = await importCeremonyModule({
  label: "venue balance reader",
  candidates: [
    new URL("../../mcp-server/src/services/venue-balance-reader.js", import.meta.url),
    "file:///app/src/services/venue-balance-reader.js",
  ],
});
const {
  buildKmsCredentialsProvider,
  PROFILE_BLOCKCHAIN_SIGNER,
} = await importCeremonyModule({
  label: "Roles Anywhere credentials provider",
  candidates: [
    new URL("../../mcp-server/src/services/aws-credentials.js", import.meta.url),
    "file:///app/src/services/aws-credentials.js",
  ],
});

export const MIN_DISPATCH_MARGIN_SECONDS = 6 * 60 * 60;
// Historical read budgets, not dispatch/economic policy. Cover multi-day
// recalls without allowing a bad createdAt or a stalled RPC to scan forever.
export const MAX_RECALL_HISTORY_BLOCKS = 1_000_000;
export const RECALL_HISTORY_TIMEOUT_MS = 180_000;
const RECALL_HISTORY_MARGIN_SECONDS = 5 * 60;
// Measured 2026-08-21 12:24–13:20Z: Hydration quoted 28,588–28,645 raw for
// withdraw_sell. 80,000 gives future recall stagings more than 2× headroom
// over that structural fee level while remaining a hard chain-side ceiling.
export const MAX_FEE_PER_LEG_RAW = 80_000n;
export const DEFAULT_RECALL_FEE_FLOOR_RATIO_BPS = 15_000n;
export const MIN_RECALL_FEE_FLOOR_RATIO_BPS = 13_500n;
const DEFAULT_DEPLOY_MAX_FEE_PER_LEG_RAW = 40_000n;
export const DEFAULT_FLOAT_HEADROOM_RAW = 50_000n;
// The venue image held 0.51 DOT when the recall packet was written. Requiring
// 0.05 DOT preserves multiple measured 0.01-DOT-class calls and, crucially,
// refuses the below-ED/approval-deposit state that previously surfaced only as
// ApprovalFailed(). This is liveness postage, never pool principal.
export const MIN_VENUE_POSTAGE_PLANCK = 500_000_000n;
const EXPECTED_STRATEGY_ID = "0x485944524154494f4e5f555344435f504f4f4c5f563100000000000000000000";
const EXPECTED_AUSDC = "0x2ec4884088d84e5c2970a034732e5209b0acfa93";
const EXPECTED_HYDRATION_CHAIN_ID = 222_222;
const ZERO32 = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const HIGH_WEIGHT = Object.freeze({ refTime: 100_000_000_000n, proofSize: 3_000_000n });
const HIGH_STORAGE_DEPOSIT = 5_000_000_000n;

const VENUE_ABI = [
  "function asset() view returns (address)",
  "function pool() view returns (address)",
  "function lane() view returns (address)",
  "function activeDeployRequestId() view returns (bytes32)",
  "function activeRecallRequestId() view returns (bytes32)",
  "function reservedDeployAssets() view returns (uint256)",
  "function poolRequestForLaneRequest(bytes32) view returns (bytes32)",
  "function getRequest(bytes32) view returns ((uint8 kind,uint8 status,uint256 requestedAssets,uint256 settledAssets,uint64 returnBy,bool claimed))",
  "function stageDeploy(bytes32,(uint256 sellAmount,uint256 minimumOutput,uint256 maxFeePerLeg,uint64 dispatchDeadline,uint64 nonce)) returns (bytes32)",
  "function stageRecall(bytes32,(uint256 sellAmount,uint256 minimumOutput,uint256 maxFeePerLeg,uint64 dispatchDeadline,uint64 nonce)) returns (bytes32,uint256)",
  "function cancelUnstaged(bytes32)",
  "event LaneRequestStaged(bytes32 indexed requestId,bytes32 indexed laneRequestId,uint256 laneShares)",
  "event UnstagedRequestCancelled(bytes32 indexed requestId,uint8 indexed kind)",
];

const POOL_ABI = [
  "function operator() view returns (address)",
  "function venueAdapter() view returns (address)",
  "function bufferAssets() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function venuePrincipalCostBasis() view returns (uint256)",
  "function venueDeployments(uint256) view returns (uint256 principalAssets,uint256 recalledPrincipalAssets,uint64 returnBy,bytes32 adapterRequestId,uint8 status)",
  "function activeVenueRecallId() view returns (uint256)",
  "function venueRecalls(uint256) view returns (uint256 deploymentId,uint256 requestedAssets,uint256 returnedAssets,bytes32 adapterRequestId,uint8 status)",
  "function settleVenueDeployment(uint256 deploymentId) returns (uint8 status,uint256 settledAssets)",
  "function settleVenueRecall(uint256 recallId) returns (uint8 status,uint256 returnedAssets)",
  "event VenueDeploymentSettled(uint256 indexed deploymentId,uint8 status,uint256 settledAssets)",
];

const LANE_ABI = [
  "function asset() view returns (address)",
  "function agentAccountCore() view returns (address)",
  "function xcmWrapper() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function pendingDepositAssets() view returns (uint256)",
  "function getAdapterRequest(bytes32) view returns ((uint8 kind,uint8 status,address account,address requester,address recipient,uint256 requestedAssets,uint256 requestedShares,uint256 settledAssets,uint256 settledShares,bytes32 remoteRef,bytes32 failureCode,bool settled))",
  "function settleRequest(bytes32 requestId,uint8 status,uint256 settledAssets,uint256 settledShares,uint256 observedRemoteBalanceRaw,bytes32 remoteRef,bytes32 failureCode)",
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const venueInterface = new Interface(VENUE_ABI);
const poolInterface = new Interface(POOL_ABI);

export function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
  const args = {
    command,
    profile: undefined,
    pool: undefined,
    requestId: undefined,
    deploymentId: undefined,
    recallId: undefined,
    // Keep deploy staging's 40k/50k fee/float pair intact. The raised ceiling
    // is the default only for future recall stagings, which have no deploy
    // float-headroom subtraction.
    maxFeePerLeg: (command === "stage-recall"
      ? MAX_FEE_PER_LEG_RAW
      : DEFAULT_DEPLOY_MAX_FEE_PER_LEG_RAW).toString(),
    feeFloorRatioBps: DEFAULT_RECALL_FEE_FLOOR_RATIO_BPS.toString(),
    floatHeadroom: DEFAULT_FLOAT_HEADROOM_RAW.toString(),
    laneNonce: undefined,
    observabilityUrl: undefined,
    expectedSigner: undefined,
    assetHubWs: process.env.BANK_XCM_ASSET_HUB_SUBSTRATE_RPC_URL,
    hydrationWs: process.env.BANK_XCM_HYDRATION_SUBSTRATE_RPC_URL,
    hydrationEvmRpc: process.env.BANK_XCM_HYDRATION_EVM_RPC_URL ?? "https://rpc.hydradx.cloud/",
    evidenceOut: undefined,
    commit: false,
    useKms: false,
    help: false,
  };
  const start = args.command ? 1 : 0;
  for (let index = start; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      return value;
    };
    if (flag === "--profile") args.profile = next();
    else if (flag === "--pool") args.pool = next();
    else if (flag === "--request-id") args.requestId = next();
    else if (flag === "--deployment-id") args.deploymentId = next();
    else if (flag === "--recall-id") args.recallId = next();
    else if (flag === "--max-fee-per-leg") args.maxFeePerLeg = next();
    else if (flag === "--fee-floor-ratio-bps") args.feeFloorRatioBps = next();
    else if (flag === "--float-headroom") args.floatHeadroom = next();
    else if (flag === "--lane-nonce") args.laneNonce = next();
    else if (flag === "--observability-url") args.observabilityUrl = next();
    else if (flag === "--expected-signer") args.expectedSigner = next();
    else if (flag === "--asset-hub-ws") args.assetHubWs = next();
    else if (flag === "--hydration-ws") args.hydrationWs = next();
    else if (flag === "--hydration-evm-rpc") args.hydrationEvmRpc = next();
    else if (flag === "--evidence-out") args.evidenceOut = next();
    else if (flag === "--commit") args.commit = true;
    else if (flag === "--dry-run") args.commit = false;
    else if (flag === "--use-kms") args.useKms = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

export function assertRequestBinding({ requested, activeRequestId, deployment, venueRequest }) {
  const normalized = normalizeBytes32(requested, "--request-id");
  if (normalizeBytes32(activeRequestId, "activeDeployRequestId") !== normalized) {
    throw new Error(`Wrong requestId: venue active deploy is ${activeRequestId}, not ${normalized}.`);
  }
  if (normalizeBytes32(deployment.adapterRequestId, "deployment adapterRequestId") !== normalized) {
    throw new Error(`Wrong requestId: pool deployment is bound to ${deployment.adapterRequestId}, not ${normalized}.`);
  }
  if (BigInt(venueRequest.requestedAssets) <= 0n || Number(venueRequest.kind) !== 0) {
    throw new Error("Bound venue request is not a live deploy request.");
  }
  if (venueRequest.claimed || Number(venueRequest.status) !== 1) {
    throw new Error("Bound venue request is not Pending and unclaimed.");
  }
  return normalized;
}

export function assertRecallRequestBinding({ requested, activeRequestId, activeRecallId, recallId, recall, venueRequest }) {
  const normalized = normalizeBytes32(requested, "--request-id");
  if (normalizeBytes32(activeRequestId, "activeRecallRequestId") !== normalized) {
    throw new Error(`Wrong requestId: venue active recall is ${activeRequestId}, not ${normalized}.`);
  }
  if (BigInt(activeRecallId) !== BigInt(recallId)) {
    throw new Error(`Wrong recallId: pool active recall is ${activeRecallId}, not ${recallId}.`);
  }
  if (normalizeBytes32(recall.adapterRequestId, "recall adapterRequestId") !== normalized) {
    throw new Error(`Wrong requestId: pool recall is bound to ${recall.adapterRequestId}, not ${normalized}.`);
  }
  if (BigInt(recall.requestedAssets) !== BigInt(venueRequest.requestedAssets)) {
    throw new Error("Pool recall requestedAssets does not match the venue request.");
  }
  if (BigInt(venueRequest.requestedAssets) <= 0n || Number(venueRequest.kind) !== 1) {
    throw new Error("Bound venue request is not a live recall request.");
  }
  if (venueRequest.claimed || Number(venueRequest.status) !== 1 || Number(recall.status) !== 1) {
    throw new Error("Bound recall is not Pending and unclaimed on both contracts.");
  }
  return normalized;
}

export function assertUnstaged({ laneRequestId, reverseMapping = ZERO32 }) {
  if (normalizeBytes32(laneRequestId, "laneRequestId") !== ZERO32) {
    throw new Error(`Pool request is already staged as lane request ${laneRequestId}.`);
  }
  if (normalizeBytes32(reverseMapping, "poolRequestForLaneRequest") !== ZERO32) {
    throw new Error("Lane request bridge is already occupied; refusing ambiguous staging.");
  }
}

export function assertFeeCeiling(value) {
  const fee = positiveBigInt(value, "--max-fee-per-leg");
  if (fee > MAX_FEE_PER_LEG_RAW) {
    throw new Error(`Fee ceiling ${fee} exceeds the Packet 7 maximum ${MAX_FEE_PER_LEG_RAW}.`);
  }
  return fee;
}

export function assertDispatchMargin({ nowSeconds, returnBy }) {
  const margin = BigInt(returnBy) - BigInt(nowSeconds);
  if (margin < BigInt(MIN_DISPATCH_MARGIN_SECONDS)) {
    throw new Error(
      `Only ${margin} seconds remain before returnBy; stage-dispatch requires at least ${MIN_DISPATCH_MARGIN_SECONDS}. Run cancel instead.`,
    );
  }
  return margin;
}

export function deriveStagingParameters({ requestedAssets, maxFeePerLeg, floatHeadroom, returnBy, nonce }) {
  const assets = positiveBigInt(requestedAssets, "requestedAssets");
  const maximum = assertFeeCeiling(maxFeePerLeg);
  const float = positiveBigInt(floatHeadroom, "--float-headroom");
  if (float < maximum) throw new Error("Float headroom must be at least maxFeePerLeg so a capped fresh quote remains dispatchable.");
  if (assets <= float) throw new Error("Pool tranche is too small for the authorized fee/float headroom.");
  const sellAmount = assets - float;
  return {
    sellAmount,
    // Aave's reserve/aToken route is par. This is accepted only after a fresh
    // live AAVE route sample independently proves exact 1:1 below.
    minimumOutput: sellAmount,
    maxFeePerLeg: maximum,
    dispatchDeadline: BigInt(returnBy),
    nonce: positiveBigInt(nonce, "lane nonce"),
  };
}

export function resolveVenueBindings({ poolAddress, adapterPool, adapterLane }) {
  const resolvedPool = getAddress(poolAddress);
  const boundPool = getAddress(adapterPool);
  const laneAddress = getAddress(adapterLane);
  if (boundPool !== resolvedPool) {
    throw new Error(`Venue adapter pool ${boundPool} does not match resolved pool ${resolvedPool}; refusing mixed-generation dispatch.`);
  }
  if (laneAddress === getAddress(ZERO_ADDRESS)) {
    throw new Error("Venue adapter lane is address(0); refusing dispatch without a chain-bound lane.");
  }
  return { poolAddress: resolvedPool, laneAddress };
}

export function computeRecallShares({ requestedAssets, venueAssets, venueShares }) {
  const requested = positiveBigInt(requestedAssets, "requestedAssets");
  const assets = BigInt(venueAssets);
  const shares = BigInt(venueShares);
  if (assets <= 0n || shares <= 0n) throw new Error("Recall requires non-zero live venue assets and shares.");
  const required = (requested * shares + assets - 1n) / assets;
  if (required === 0n) throw new Error("Computed recall shares is zero.");
  if (required > shares) throw new Error("Computed recall shares exceeds live venue shares.");
  return required;
}

export function assertRecallParameters({ parameters, requestedAssets }) {
  if (BigInt(parameters.minimumOutput) !== BigInt(requestedAssets)) {
    throw new Error("Recall minimumOutput must equal requestedAssets exactly.");
  }
  if (BigInt(parameters.sellAmount) <= 0n) throw new Error("Recall evidence sellAmount must contain the non-zero precomputed shares.");
  assertFeeCeiling(parameters.maxFeePerLeg);
  positiveBigInt(parameters.dispatchDeadline, "dispatchDeadline");
  positiveBigInt(parameters.nonce, "lane nonce");
  return true;
}

export function deriveRecallParameters({ requestedAssets, venueAssets, venueShares, maxFeePerLeg, returnBy, nonce }) {
  const requested = positiveBigInt(requestedAssets, "requestedAssets");
  const shares = computeRecallShares({ requestedAssets: requested, venueAssets, venueShares });
  const lane = {
    // stageRecall ignores sellAmount. Mirroring the precomputed share count in
    // this slot makes the encoded tuple independently legible without changing
    // the contract's binding inputs.
    sellAmount: shares,
    minimumOutput: requested,
    maxFeePerLeg: assertFeeCeiling(maxFeePerLeg),
    dispatchDeadline: BigInt(returnBy),
    nonce: positiveBigInt(nonce, "lane nonce"),
  };
  assertRecallParameters({ parameters: lane, requestedAssets: requested });
  return { shares, lane };
}

export function buildRecallStageCall({ requestId, parameters, requestedAssets }) {
  const normalizedRequestId = normalizeBytes32(requestId, "--request-id");
  assertRecallParameters({ parameters, requestedAssets });
  const data = venueInterface.encodeFunctionData("stageRecall", [normalizedRequestId, parameters]);
  const decoded = venueInterface.decodeFunctionData("stageRecall", data);
  const tuple = decoded[1];
  if (
    normalizeBytes32(decoded[0], "decoded requestId") !== normalizedRequestId
    || BigInt(tuple.sellAmount) !== BigInt(parameters.sellAmount)
    || BigInt(tuple.minimumOutput) !== BigInt(parameters.minimumOutput)
    || BigInt(tuple.maxFeePerLeg) !== BigInt(parameters.maxFeePerLeg)
    || BigInt(tuple.dispatchDeadline) !== BigInt(parameters.dispatchDeadline)
    || BigInt(tuple.nonce) !== BigInt(parameters.nonce)
  ) throw new Error("Encoded stageRecall tuple did not decode byte-for-byte to the reviewed parameters.");
  return {
    data,
    decoded: {
      requestId: normalizedRequestId,
      sellAmount: BigInt(tuple.sellAmount),
      minimumOutput: BigInt(tuple.minimumOutput),
      maxFeePerLeg: BigInt(tuple.maxFeePerLeg),
      dispatchDeadline: BigInt(tuple.dispatchDeadline),
      nonce: BigInt(tuple.nonce),
    },
  };
}

export function deriveLaneRequestId({ venueAddress, asset, assets, nonce }) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint8", "address", "address", "address", "uint256", "uint256", "uint64"],
    [EXPECTED_STRATEGY_ID, 0, getAddress(venueAddress), getAddress(asset), getAddress(venueAddress), BigInt(assets), 0n, BigInt(nonce)],
  ));
}

export function deriveLaneRecallRequestId({ venueAddress, asset, shares, nonce }) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint8", "address", "address", "address", "uint256", "uint256", "uint64"],
    [EXPECTED_STRATEGY_ID, 1, getAddress(venueAddress), getAddress(asset), getAddress(venueAddress), 0n, BigInt(shares), BigInt(nonce)],
  ));
}

// The par law is symmetric across directions — filler-level par with a bounded
// index-accrual gross-up above the requested input (see parAccrualCeiling in
// the staging-quote module and unwindAccrualCeiling below; same formula).
export function assertParAaveQuote(quote, expectedAmount) {
  const amount = positiveBigInt(expectedAmount, "exact quote amount");
  if (quote?.fillerType !== "AAVE" || BigInt(quote?.assetIn ?? -1) !== 22n || BigInt(quote?.assetOut ?? -1) !== 1003n) {
    throw new Error("Fresh staging quote did not use the AAVE 22→1003 route.");
  }
  const input = BigInt(quote.amountInRaw);
  const output = BigInt(quote.amountOutRaw);
  if (input !== output) throw new Error("Fresh AAVE route quote broke filler-level par (amountIn !== amountOut).");
  if (input < amount || input - amount > unwindAccrualCeiling(amount)) {
    throw new Error(`Fresh AAVE route quote amount ${input} is outside the accrual-bounded window above expected ${amount}.`);
  }
  return true;
}

// Exit-direction law, measured live 2026-08-14 (Hydration blk 13609967):
// selling N aUSDC debits the seller exactly N units, but the AAVE filler
// grosses the redemption up by interest accrued since the last index touch —
// router.Executed{amountIn: N, amountOut: N+a} with Broadcast.Swapped carrying
// N+a on BOTH sides. Par therefore holds at the filler level (in === out)
// while both amounts may exceed the requested input by a small accrual `a`
// (realized yield, landing in the remote float). The entry direction (22→1003)
// stays exact-input. Real accrual at our sizes is tens of raw units; anything
// near this ceiling is a pricing fault, not yield.
export function unwindAccrualCeiling(expectedInput) {
  return positiveBigInt(expectedInput, "unwind expected input") / 1000n + 16n;
}

export function assertParAaveUnwindQuote(quote, expectedAmount) {
  const amount = positiveBigInt(expectedAmount, "exact unwind quote amount");
  if (quote?.fillerType !== "AAVE" || BigInt(quote?.assetIn ?? -1) !== 1003n || BigInt(quote?.assetOut ?? -1) !== 22n) {
    throw new Error("Fresh recall quote did not use the AAVE 1003→22 route.");
  }
  const input = BigInt(quote.amountInRaw);
  const output = BigInt(quote.amountOutRaw);
  if (input !== output) throw new Error("Fresh AAVE unwind quote broke filler-level par (amountIn !== amountOut).");
  if (input < amount || input - amount > unwindAccrualCeiling(amount)) {
    throw new Error(`Fresh AAVE unwind quote amount ${input} is outside the accrual-bounded window above expected ${amount}.`);
  }
  return true;
}

export function assertVenuePostage(reading) {
  const raw = BigInt(reading?.raw ?? -1);
  if (raw < MIN_VENUE_POSTAGE_PLANCK) {
    throw new Error(`Venue postage ${raw} is below the ${MIN_VENUE_POSTAGE_PLANCK} planck ceremony threshold.`);
  }
  return raw;
}

export function assertRecallFeeFloorRatioBps(value) {
  const floorBps = positiveBigInt(value, "--fee-floor-ratio-bps");
  if (floorBps < MIN_RECALL_FEE_FLOOR_RATIO_BPS) {
    throw new Error(
      `--fee-floor-ratio-bps ${floorBps} is below the hard minimum ${MIN_RECALL_FEE_FLOOR_RATIO_BPS}.`,
    );
  }
  return floorBps;
}

export function selectRecallDispatchFee({
  quote,
  maximum,
  available,
  floorBps = DEFAULT_RECALL_FEE_FLOOR_RATIO_BPS,
}) {
  const quoted = positiveBigInt(quote, "recall remote fee quote");
  const cap = assertFeeCeiling(maximum);
  const configuredFloorBps = assertRecallFeeFloorRatioBps(floorBps);
  const doubled = quoted * 2n;
  const feeAmount = doubled > cap ? cap : doubled;
  if (feeAmount * 10_000n < quoted * configuredFloorBps) {
    throw new Error(
      `Recall fee ceiling is below the configured ${formatRatioBps(configuredFloorBps)}× fresh quote floor (${configuredFloorBps} bps).`,
    );
  }
  if (BigInt(available) < feeAmount) throw new Error("Remote asset-22 balance cannot fund the freshly priced recall fee budget.");
  return {
    feeAmount,
    feeSource: feeAmount === doubled ? "fresh_remote_quote_x2" : "fresh_remote_quote_capped",
  };
}

export function buildCancelPlan({ venueAddress, poolAddress, requestId, deploymentId, kind = "deploy" }) {
  const plan = [
    { name: "cancelUnstaged", to: getAddress(venueAddress), data: venueInterface.encodeFunctionData("cancelUnstaged", [requestId]), value: "0" },
  ];
  // Recall settlement is deliberately owned by pool-venue-ceremony.mjs. A
  // cancellation only terminalizes the adapter request; duplicating the pool
  // side here would violate the packet's division of labour.
  if (kind === "deploy") {
    plan.push({ name: "settleVenueDeployment", to: getAddress(poolAddress), data: poolInterface.encodeFunctionData("settleVenueDeployment", [deploymentId]), value: "0" });
  }
  return plan;
}

export function reconcilePoolTranche({ committed, baselineFloat, fundedFloat, finalFloat, deployedAUsdc }) {
  const committedRaw = BigInt(committed);
  const fundingArrivalRaw = BigInt(fundedFloat) - BigInt(baselineFloat);
  const poolFloatRemainingRaw = BigInt(finalFloat) - BigInt(baselineFloat);
  const aUsdcMintedRaw = BigInt(deployedAUsdc);
  const fundingTransferFeeRaw = committedRaw - fundingArrivalRaw;
  const sellExecutionFeeRaw = fundingArrivalRaw - aUsdcMintedRaw - poolFloatRemainingRaw;
  if (poolFloatRemainingRaw < 0n) throw new Error("Pool request consumed pre-existing operating-lane float.");
  if (fundingTransferFeeRaw < 0n || sellExecutionFeeRaw < 0n) throw new Error("Pool fee ledger contains a negative component.");
  if (aUsdcMintedRaw + poolFloatRemainingRaw + fundingTransferFeeRaw + sellExecutionFeeRaw !== committedRaw) {
    throw new Error("Pool fee ledger does not reconcile every raw unit.");
  }
  return { committedRaw, fundingArrivalRaw, aUsdcMintedRaw, poolFloatRemainingRaw, fundingTransferFeeRaw, sellExecutionFeeRaw, reconciled: true };
}

export function reconcileResumedPoolSell({ committed, floatBeforeSell, finalFloat, swapInput, deployedAUsdc }) {
  const committedRaw = BigInt(committed);
  const remoteFloatBeforeSellRaw = BigInt(floatBeforeSell);
  const remoteFloatAfterSellRaw = BigInt(finalFloat);
  const swapInputRaw = BigInt(swapInput);
  const aUsdcMintedRaw = BigInt(deployedAUsdc);
  const sellExecutionFeeRaw = remoteFloatBeforeSellRaw - remoteFloatAfterSellRaw - swapInputRaw;
  if (sellExecutionFeeRaw < 0n) throw new Error("Resumed pool sell ledger contains a negative execution fee.");
  return {
    committedRaw,
    fundingArrivalRaw: null,
    fundingTransferFeeRaw: null,
    remoteFloatBeforeSellRaw,
    remoteFloatAfterSellRaw,
    swapInputRaw,
    aUsdcMintedRaw,
    sellExecutionFeeRaw,
    reconciled: false,
    remainingLegReconciled: true,
    disclosure: "Funding was dispatched before this process; its historical balance baseline is not reconstructed or invented.",
  };
}

export function reconcilePoolRecall({ requestedAssets, sharesSold, swapOutput, floatBefore, floatAfterSell, floatAfterHome, homeArrival }) {
  const requested = BigInt(requestedAssets);
  const sold = BigInt(sharesSold);
  const output = BigInt(swapOutput);
  const before = BigInt(floatBefore);
  const afterSell = BigInt(floatAfterSell);
  const afterHome = BigInt(floatAfterHome);
  const arrival = BigInt(homeArrival);
  const sellExecutionFeeRaw = before + output - afterSell;
  const remoteHomeDebitRaw = afterSell - afterHome;
  const homeExecutionAndDeliveryFeeRaw = remoteHomeDebitRaw - arrival;
  const rebaseResidueRaw = output - requested;
  const exitAccrualRaw = output - sold;
  if (exitAccrualRaw < 0n || exitAccrualRaw > unwindAccrualCeiling(sold)) {
    throw new Error("Recall Aave unwind output is outside the filler-par accrual bounds above the shares sold.");
  }
  if (sellExecutionFeeRaw < 0n || homeExecutionAndDeliveryFeeRaw < 0n) throw new Error("Recall fee ledger contains a negative component.");
  if (remoteHomeDebitRaw !== requested) throw new Error("Recall home leg did not debit exactly requestedAssets on Hydration.");
  if (arrival + homeExecutionAndDeliveryFeeRaw !== requested) throw new Error("Recall home arrival and fees do not reconcile requestedAssets.");
  if (before + output !== afterHome + remoteHomeDebitRaw + sellExecutionFeeRaw) {
    throw new Error("Recall remote float ledger does not reconcile every raw unit.");
  }
  return {
    requestedAssetsRaw: requested,
    sharesSoldRaw: sold,
    aUsdcBurnedRaw: sold,
    asset22SwapOutputRaw: output,
    exitAccrualRaw,
    rebaseResidueRaw,
    sellExecutionFeeRaw,
    remoteHomeDebitRaw,
    homeArrivalRaw: arrival,
    homeExecutionAndDeliveryFeeRaw,
    requestedAssetsReconciled: true,
    remoteFloatReconciled: true,
  };
}

function rawAmount(value) {
  return BigInt(String(value ?? "-1").replaceAll(",", ""));
}

function extractAaveUnwindQuote(human, expectedInput) {
  if (!human?.Ok?.executionResult?.Ok) throw new Error("Hydration Router.sell unwind dry-run did not execute successfully.");
  const event = (human.Ok.emittedEvents ?? []).find((entry) =>
    String(entry.section).toLowerCase() === "broadcast"
    && /^Swapped/u.test(String(entry.method))
    && entry.data?.fillerType === "AAVE"
  );
  const input = event?.data?.inputs?.find((entry) => rawAmount(entry.asset) === 1003n);
  const output = event?.data?.outputs?.find((entry) => rawAmount(entry.asset) === 22n);
  const inputRaw = rawAmount(input?.amount ?? -1);
  const outputRaw = rawAmount(output?.amount ?? -1);
  if (
    !event || inputRaw !== outputRaw || inputRaw < BigInt(expectedInput)
    || inputRaw - BigInt(expectedInput) > unwindAccrualCeiling(expectedInput)
  ) {
    throw new Error("Hydration quote omitted a filler-par, accrual-bounded Broadcast.Swapped{AAVE,1003→22} event.");
  }
  return {
    runtimeEvent: event.method,
    fillerType: "AAVE",
    assetIn: 1003,
    assetOut: 22,
    amountInRaw: inputRaw.toString(),
    amountOutRaw: outputRaw.toString(),
    exitAccrualRaw: (inputRaw - BigInt(expectedInput)).toString(),
  };
}

async function readBeforeDeadline(operation, deadlineMs) {
  if (deadlineMs === undefined) return operation();
  const remaining = deadlineMs - Date.now();
  const timeoutError = () => new Error("Historical recall scan exceeded its read budget; refusing to dispatch.");
  if (remaining <= 0) throw timeoutError();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), remaining); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function recoverHistoricalRecallSwap(api, { requestId, createdAt, expectedInput }) {
  // Wrapper createdAt is seconds; Hydration timestamp.now is milliseconds.
  const createdAtMs = positiveBigInt(createdAt, "Staged recall createdAt") * 1_000n;
  const marginMs = BigInt(RECALL_HISTORY_MARGIN_SECONDS) * 1_000n;
  const deadlineMs = Date.now() + RECALL_HISTORY_TIMEOUT_MS;
  const read = (operation) => readBeforeDeadline(operation, deadlineMs);
  const header = await read(() => api.rpc.chain.getHeader());
  const head = header.number.toNumber();
  if (!Number.isSafeInteger(head) || head < 1) throw new Error("Historical recall scan requires a valid Hydration head.");
  const timestamps = new Map();
  const timestampAt = async (block) => {
    if (!timestamps.has(block)) {
      if (timestamps.size >= 64) throw new Error("Historical recall timestamp search exceeded 64 reads.");
      const hash = (await read(() => api.rpc.chain.getBlockHash(block))).toHex();
      const at = await read(() => api.at(hash));
      timestamps.set(block, positiveBigInt(await read(() => at.query.timestamp.now()), "Hydration block timestamp"));
    }
    return timestamps.get(block);
  };
  const headMs = await timestampAt(head);
  if (createdAtMs > headMs + marginMs) throw new Error("Staged recall createdAt is ahead of Hydration beyond the safety margin.");

  // Pad before staging for cross-chain timestamp skew; include ALL available
  // history after staging (not just a short window around it) for delayed XCM
  // execution. The captured head clamps the far side of that safety margin:
  // this single historical pass never chases newly arriving blocks.
  const startMs = createdAtMs > marginMs ? createdAtMs - marginMs : 0n;
  let low = 1;
  let high = head;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (await timestampAt(mid) < startMs) low = mid + 1;
    else high = mid;
  }
  // Include the preceding block when the timestamp falls between blocks.
  const fromBlock = Math.max(1, low - 1);
  if (head - fromBlock + 1 > MAX_RECALL_HISTORY_BLOCKS) {
    throw new Error(`Historical recall scan exceeds ${MAX_RECALL_HISTORY_BLOCKS} blocks from staged createdAt; refusing to dispatch.`);
  }
  const swap = await waitForAaveSwap(api, {
    requestId, fromBlock, toBlock: head, expectedInput,
    assetIn: 1003, assetOut: 22, attempts: 1, deadlineMs,
  });
  return {
    ...swap,
    scan: { source: "wrapper.createdAt", createdAt, safetyMarginSeconds: RECALL_HISTORY_MARGIN_SECONDS,
      fromBlock, toBlock: head, maxBlocks: MAX_RECALL_HISTORY_BLOCKS, timeoutMs: RECALL_HISTORY_TIMEOUT_MS },
  };
}

export async function waitForAaveSwap(api, { requestId, fromBlock, toBlock, expectedInput, assetIn = 22, assetOut = 1003, attempts = 30, deadlineMs }) {
  const read = (operation) => readBeforeDeadline(operation, deadlineMs);
  let nextBlock = Number(fromBlock);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const head = toBlock ?? (await read(() => api.rpc.chain.getHeader())).number.toNumber();
    for (; nextBlock <= head; nextBlock += 1) {
      const blockHash = (await read(() => api.rpc.chain.getBlockHash(nextBlock))).toHex();
      const at = await read(() => api.at(blockHash));
      const records = (await read(() => at.query.system.events())).toHuman();
      for (const record of records) {
        const event = record?.event;
        if (String(event?.section).toLowerCase() !== "broadcast" || !/^Swapped/u.test(String(event?.method))) continue;
        const xcm = (event.data?.operationStack ?? []).find((entry) => Array.isArray(entry?.Xcm))?.Xcm;
        if (String(xcm?.[0] ?? "").toLowerCase() !== requestId.toLowerCase()) continue;
        const input = event.data?.inputs?.find((entry) => rawAmount(entry.asset) === BigInt(assetIn));
        const output = event.data?.outputs?.find((entry) => rawAmount(entry.asset) === BigInt(assetOut));
        const inputRaw = rawAmount(input?.amount ?? -1);
        const outputRaw = rawAmount(output?.amount ?? -1);
        // Entry (22→1003) is exact-input; exit (1003→22) is filler-par with a
        // bounded accrual gross-up above the staged input — see the measured
        // law at unwindAccrualCeiling.
        // The filler-par accrual law is symmetric: both directions carry
        // input === output grossed up by a bounded index accrual above the
        // requested amount (entry measured live 2026-08-16: 4,910,000 staged →
        // 4,910,004/4,910,004 event).
        const inputAcceptable = inputRaw === outputRaw
          && inputRaw >= BigInt(expectedInput)
          && inputRaw - BigInt(expectedInput) <= unwindAccrualCeiling(expectedInput);
        if (event.data?.fillerType !== "AAVE" || !inputAcceptable || outputRaw <= 0n) {
          throw new Error(`Request-bound Broadcast.Swapped did not match AAVE ${assetIn}→${assetOut} filler-par accrual-bounded semantics.`);
        }
        const timestamp = await read(() => at.query.timestamp.now());
        return {
          liveState: true,
          blockNumber: nextBlock,
          blockHash,
          timestamp: timestamp.toString(),
          event: event.method,
          requestId,
          fillerType: "AAVE",
          assetIn,
          assetOut,
          amountInRaw: rawAmount(input.amount),
          amountOutRaw: rawAmount(output.amount),
        };
      }
    }
    if (toBlock !== undefined) break;
    await new Promise((done) => setTimeout(done, 6_000));
  }
  throw new Error(`Timed out without request-bound Broadcast.Swapped evidence for ${requestId}.`);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/ops/pool-venue-dispatch.mjs status --profile mainnet [--pool 0x...] --request-id 0x... --deployment-id 1 --observability-url URL --expected-signer 0x...",
    "  node scripts/ops/pool-venue-dispatch.mjs status --profile mainnet [--pool 0x...] --request-id 0x... --recall-id 1 --observability-url URL --expected-signer 0x...",
    "  node scripts/ops/pool-venue-dispatch.mjs cancel --profile mainnet [--pool 0x...] --request-id 0x... --deployment-id 1 --observability-url URL --expected-signer 0x... [--commit --use-kms]",
    "  node scripts/ops/pool-venue-dispatch.mjs cancel --profile mainnet [--pool 0x...] --request-id 0x... --recall-id 1 --observability-url URL --expected-signer 0x... [--commit --use-kms]",
    "  node scripts/ops/pool-venue-dispatch.mjs stage-dispatch --profile mainnet [--pool 0x...] --request-id 0x... --deployment-id 1 --observability-url URL --expected-signer 0x... [--max-fee-per-leg 40000] [--float-headroom 50000] [--commit --use-kms]",
    "  node scripts/ops/pool-venue-dispatch.mjs stage-recall --profile mainnet [--pool 0x...] --request-id 0x... --recall-id 1 --observability-url URL --expected-signer 0x... [--max-fee-per-leg 80000] [--fee-floor-ratio-bps 15000] [--commit --use-kms]",
    "",
    "Dry-run is the default. Writes require both --commit and --use-kms. Raw keys are never accepted.",
  ].join("\n");
}

function normalizeBytes32(value, label) {
  const normalized = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(normalized)) throw new Error(`${label} must be bytes32 hex.`);
  return normalized;
}

function positiveBigInt(value, label) {
  if (!/^[0-9]+$/u.test(String(value ?? ""))) throw new Error(`${label} must be an unsigned integer.`);
  const result = BigInt(value);
  if (result <= 0n) throw new Error(`${label} must be positive.`);
  return result;
}

function formatRatioBps(value) {
  const whole = value / 10_000n;
  const fractional = (value % 10_000n).toString().padStart(4, "0").replace(/0+$/u, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

function bigintJson(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

async function fetchJson(url, label) {
  if (!url) throw new Error(`${label} URL is required.`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } catch (error) {
    throw new Error(`${label} read failed: ${error?.message ?? error}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveSigner(args, provider, {
  env = process.env,
  KmsSignerClass = KmsSigner,
  credentialsProviderBuilder = buildKmsCredentialsProvider,
} = {}) {
  if (!args.expectedSigner) throw new Error("--expected-signer is mandatory.");
  if (args.commit && !args.useKms) throw new Error("--commit requires --use-kms; raw private keys are not accepted.");
  if (!args.useKms) {
    return { address: getAddress(args.expectedSigner), signer: null, backend: "expected-signer (dry-run only)" };
  }
  const keyId = String(env.KMS_KEY_ID ?? "").trim();
  const region = String(env.AWS_REGION ?? "").trim();
  if (!keyId || !region) throw new Error("--use-kms requires KMS_KEY_ID and AWS_REGION.");
  const credentialsProvider = credentialsProviderBuilder({
    profile: PROFILE_BLOCKCHAIN_SIGNER,
    env,
  });
  const signer = new KmsSignerClass({ keyId, region, provider, credentialsProvider });
  return {
    address: assertExpectedSigner(await signer.getAddress(), args.expectedSigner),
    signer,
    backend: "aws-kms",
  };
}

async function findLaneRequestId(provider, venueAddress, requestId, fromBlock, toBlock) {
  const event = venueInterface.getEvent("LaneRequestStaged");
  const logs = [];
  // Production RPCs cap eth_getLogs ranges differently. Chunking is part of
  // the status truth path; an endpoint limit must never look like “unstaged”.
  for (let start = fromBlock; start <= toBlock; start += 2_000) {
    logs.push(...await provider.getLogs({
      address: venueAddress,
      topics: [event.topicHash, requestId],
      fromBlock: start,
      toBlock: Math.min(toBlock, start + 1_999),
    }));
  }
  if (logs.length > 1) throw new Error(`Found ${logs.length} LaneRequestStaged events for one pool request; refusing ambiguity.`);
  if (logs.length === 0) return ZERO32;
  return normalizeBytes32(venueInterface.parseLog(logs[0]).args.laneRequestId, "LaneRequestStaged laneRequestId");
}

async function readState({ provider, pool, venue, venueAddress, venueFromBlock, lane, wrapper, requestId, deploymentId = 0n, recallId = 0n, balanceReader, targets }) {
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("Could not read the Asset Hub chain head.");
  const discoveredLaneRequestId = await findLaneRequestId(provider, venueAddress, requestId, venueFromBlock, block.number);
  const [
    poolOperator,
    venueAdapter,
    bufferAssets,
    totalAssets,
    principal,
    deployment,
    recall,
    activeVenueRecallId,
    activeRequestId,
    activeRecallRequestId,
    reservedDeployAssets,
    venueRequest,
    laneAgentAccountCore,
    laneWrapper,
    laneTotalAssets,
    laneTotalShares,
    lanePending,
    wrapperPaused,
    wrapperOperator,
    farFloat,
    farPosition,
    venuePostage,
  ] = await Promise.all([
    pool.operator(), pool.venueAdapter(), pool.bufferAssets(), pool.totalAssets(), pool.venuePrincipalCostBasis(),
    pool.venueDeployments(deploymentId), pool.venueRecalls(recallId), pool.activeVenueRecallId(),
    venue.activeDeployRequestId(), venue.activeRecallRequestId(), venue.reservedDeployAssets(),
    venue.getRequest(requestId), lane.agentAccountCore(), lane.xcmWrapper(),
    lane.totalAssets(), lane.totalShares(), lane.pendingDepositAssets(), wrapper.dispatchPaused(), wrapper.operator(),
    balanceReader.read(targets.float), balanceReader.read(targets.position), balanceReader.read(targets.venuePostage),
  ]);
  const actualLaneRequestId = discoveredLaneRequestId;
  let wrapperRecord = null;
  let wrapperParameters = null;
  let wrapperBitmap = null;
  let adapterRequest = null;
  if (actualLaneRequestId !== ZERO32) {
    [wrapperRecord, wrapperParameters, wrapperBitmap, adapterRequest] = await Promise.all([
      wrapper.getRequest(actualLaneRequestId), wrapper.getRequestParameters(actualLaneRequestId),
      wrapper.requestDispatchBitmap(actualLaneRequestId), lane.getAdapterRequest(actualLaneRequestId),
    ]);
  }
  return {
    block: { number: block.number, hash: block.hash, timestamp: block.timestamp },
    pool: { operator: getAddress(poolOperator), venueAdapter: getAddress(venueAdapter), bufferAssets, totalAssets, venuePrincipalCostBasis: principal, deployment, recall, activeVenueRecallId },
    venue: { activeDeployRequestId: activeRequestId, activeRecallRequestId, reservedDeployAssets, request: venueRequest, laneRequestId: actualLaneRequestId, postage: venuePostage },
    lane: { agentAccountCore: getAddress(laneAgentAccountCore), wrapper: getAddress(laneWrapper), totalAssets: laneTotalAssets, totalShares: laneTotalShares, pendingDepositAssets: lanePending, adapterRequest },
    wrapper: { dispatchPaused: wrapperPaused, operator: getAddress(wrapperOperator), request: wrapperRecord, parameters: wrapperParameters, bitmap: wrapperBitmap },
    farSide: { floatAsset22: farFloat, aUsdc: farPosition },
  };
}

export async function captureParQuote(endpoint, sellAmount, { assetIn = 22, assetOut = 1003, quoteAccount: suppliedAccount, quoteAccountBalance: suppliedBalance } = {}) {
  const { ApiPromise, WsProvider } = await import("@polkadot/api");
  const api = await ApiPromise.create({ provider: new WsProvider(endpoint, 5_000), noInitWarn: true, throwOnConnect: true });
  try {
    // DryRunApi accepts a signed origin without requiring its key. Discover a
    // public account with enough asset-22 at this exact head so the quote is
    // for the full staged sell, not a scaled sample. This is read-only and the
    // returned balance is evidence; no transaction can be produced for it.
    let startKey;
    let quoteAccount = suppliedAccount;
    let quoteAccountBalance = suppliedBalance === undefined ? undefined : BigInt(suppliedBalance);
    if (quoteAccount && (quoteAccountBalance ?? 0n) < sellAmount) {
      throw new Error(`Supplied asset-${assetIn} quote account cannot support the exact ${sellAmount} read-only quote.`);
    }
    for (let page = 0; page < 10 && !quoteAccount; page += 1) {
      const entries = await api.query.tokens.accounts.entriesPaged({ args: [], pageSize: 1_000, startKey });
      if (entries.length === 0) break;
      for (const [key, value] of entries) {
        if (Number(key.args[1].toString()) !== assetIn) continue;
        const free = BigInt(value.free.toString());
        if (free < sellAmount) continue;
        quoteAccount = key.args[0].toHex();
        quoteAccountBalance = free;
        break;
      }
      startKey = entries.at(-1)[0].toHex();
    }
    if (!quoteAccount) throw new Error(`No public asset-${assetIn} account can support an exact ${sellAmount} read-only quote.`);
    const call = api.tx.router.sell(assetIn, assetOut, sellAmount, 1n, [{ pool: "Aave", assetIn, assetOut }]);
    const [header, timestamp, result] = await Promise.all([
      api.rpc.chain.getHeader(), api.query.timestamp.now(),
      api.call.dryRunApi.dryRunCall({ system: { signed: quoteAccount } }, call, 5),
    ]);
    const quote = assetIn === 1003 && assetOut === 22
      ? extractAaveUnwindQuote(result.toHuman(), sellAmount)
      : extractAaveQuote(result.toHuman(), sellAmount);
    if (assetIn === 1003 && assetOut === 22) assertParAaveUnwindQuote(quote, sellAmount);
    else assertParAaveQuote(quote, sellAmount);
    return { liveState: true, endpoint, blockNumber: header.number.toNumber(), blockHash: header.hash.toHex(), timestamp: timestamp.toString(), quoteAccount, quoteAccountBalanceRaw: quoteAccountBalance, routerCall: call.method.toHex(), quote };
  } finally {
    await api.disconnect();
  }
}

function extractForwardedXcms(json = {}) {
  const groups = json?.ok?.forwardedXcms ?? json?.Ok?.forwardedXcms ?? [];
  const output = [];
  for (const [destination, messages] of groups) {
    const paraId = Number(destination?.v5?.interior?.x1?.[0]?.parachain ?? destination?.V5?.interior?.X1?.[0]?.Parachain);
    for (const message of messages ?? []) output.push({ paraId, destination, message });
  }
  return output;
}

function assertDryRunCallComplete(json, label) {
  const result = json?.ok?.executionResult ?? json?.Ok?.executionResult;
  if (!result?.ok && !result?.Ok) throw new Error(`${label} dry-run did not succeed: ${JSON.stringify(result ?? null)}.`);
}

function assertDryRunXcmComplete(json, label) {
  const result = json?.ok?.executionResult ?? json?.Ok?.executionResult;
  if (!result?.complete && !result?.Complete) throw new Error(`${label} dry-run did not complete: ${JSON.stringify(result ?? null)}.`);
}

function normalizeRuntimeEvents(human = {}) {
  return (human?.Ok?.emittedEvents ?? human?.ok?.emittedEvents ?? []).map((event) => ({
    section: String(event.section ?? ""),
    method: String(event.method ?? ""),
    data: { ...(event.data ?? {}) },
  }));
}

// DryRunApi.dryRunXcm records Broadcast.Swapped with operationStack [{Router}]
// only — the Xcm(topic) entry that live execution carries is absent in dry-run
// context (measured live 2026-08-14 against the leg-C wire). Request binding in
// the dry-run therefore comes from execution scope (the API executes exactly
// one wire, ours) plus assertWireCarriesTopic on those wire bytes; the live
// waitForAaveSwap scan keeps the operationStack topic binding, where it exists
// and other traffic makes it necessary.
export function assertWireCarriesTopic(wire, requestId) {
  const normalized = normalizeBytes32(requestId, "wire topic requestId");
  if (!String(wire).toLowerCase().endsWith(`2c${normalized.slice(2)}`)) {
    throw new Error("Recall wire does not terminate with SetTopic(laneRequestId); refusing unbound dry-run proof.");
  }
  return true;
}

export function assertAaveSwapEvent(events, { assetIn, assetOut, expectedInput }) {
  const matches = [];
  for (const event of events) {
    if (event.section.toLowerCase() !== "broadcast" || !/^Swapped/u.test(event.method)) continue;
    const input = event.data?.inputs?.find((entry) => rawAmount(entry.asset) === BigInt(assetIn));
    const output = event.data?.outputs?.find((entry) => rawAmount(entry.asset) === BigInt(assetOut));
    const inputRaw = rawAmount(input?.amount ?? -1);
    const outputRaw = rawAmount(output?.amount ?? -1);
    if (
      event.data?.fillerType !== "AAVE"
      || inputRaw !== outputRaw
      || inputRaw < BigInt(expectedInput)
      || inputRaw - BigInt(expectedInput) > unwindAccrualCeiling(expectedInput)
    ) throw new Error(`Stateful recall dry-run emitted a malformed AAVE ${assetIn}→${assetOut} swap.`);
    matches.push({
      event: event.method,
      fillerType: "AAVE",
      assetIn,
      assetOut,
      amountInRaw: inputRaw,
      amountOutRaw: outputRaw,
      exitAccrualRaw: inputRaw - BigInt(expectedInput),
    });
  }
  if (matches.length !== 1) {
    throw new Error(`Stateful recall dry-run scope carried ${matches.length} request-bound Broadcast.Swapped AAVE ${assetIn}→${assetOut} swaps; expected exactly one.`);
  }
  return matches[0];
}

async function dryRunStageAndFunding({ args, signerAddress, venueAddress, wrapperAddress, stageData, laneRequestId, convertedAccountId32 }) {
  const { ApiPromise, WsProvider } = await import("@polkadot/api");
  const [assetHub, hydration] = await Promise.all([
    ApiPromise.create({ provider: new WsProvider(args.assetHubWs, 5_000), noInitWarn: true, throwOnConnect: true }),
    ApiPromise.create({ provider: new WsProvider(args.hydrationWs, 5_000), noInitWarn: true, throwOnConnect: true }),
  ]);
  try {
    const operatorAccountId32 = (await assetHub.call.reviveApi.accountId(signerAddress)).toHex();
    const dispatchData = new Interface(XCM_WRAPPER_ABI).encodeFunctionData("dispatchLeg", [laneRequestId, 0, 0n]);
    const batch = assetHub.tx.utility.batchAll([
      assetHub.tx.revive.call(venueAddress, 0n, HIGH_WEIGHT, HIGH_STORAGE_DEPOSIT, stageData),
      assetHub.tx.revive.call(wrapperAddress, 0n, HIGH_WEIGHT, HIGH_STORAGE_DEPOSIT, dispatchData),
    ]);
    const [assetHubHeader, assetHubTimestamp, hubResult] = await Promise.all([
      assetHub.rpc.chain.getHeader(), assetHub.query.timestamp.now(),
      assetHub.call.dryRunApi.dryRunCall({ system: { signed: operatorAccountId32 } }, batch, 5),
    ]);
    assertDryRunCallComplete(hubResult.toJSON(), "Stateful stage + funding");
    const forwarded = extractForwardedXcms(hubResult.toJSON()).filter((entry) => entry.paraId === 2034);
    if (forwarded.length !== 1) throw new Error(`Stateful funding dry-run forwarded ${forwarded.length} messages to Hydration; expected exactly one.`);
    // FIND #20: DepositFunding is local execute. Asset Hub's runtime builds the
    // forwarded reserve frame; these returned bytes are consumed unchanged.
    const exactWire = assetHub.createType("XcmVersionedXcm", forwarded[0].message).toHex();
    const hydrationResult = await hydration.call.dryRunApi.dryRunXcm(
      { V5: { parents: 1, interior: { X1: [{ Parachain: 1000 }] } } },
      exactWire,
    );
    assertDryRunXcmComplete(hydrationResult.toJSON(), "Runtime-transformed funding frame");
    const hydrationEvents = normalizeRuntimeEvents(hydrationResult.toHuman());
    const deposit = assertConvertedAccountDeposit(hydration, hydrationEvents, convertedAccountId32);
    return {
      liveState: true,
      capturedAt: new Date().toISOString(),
      assetHub: { endpoint: args.assetHubWs, blockNumber: assetHubHeader.number.toNumber(), blockHash: assetHubHeader.hash.toHex(), timestamp: assetHubTimestamp.toString(), call: batch.method.toHex(), execution: "Complete" },
      hydration: { endpoint: args.hydrationWs, wireMessage: exactWire, origin: { parents: 1, interior: "X1(Parachain(1000))" }, execution: "Complete", deposit },
      wireFrame: { frameSource: "runtime_transformed_local_execute", forwardedWireMessage: exactWire, consumedUnchanged: true },
    };
  } finally {
    await Promise.allSettled([assetHub.disconnect(), hydration.disconnect()]);
  }
}

async function dryRunStageAndRecallSell({ args, signerAddress, venueAddress, wrapperAddress, stageData, laneRequestId, shares, feeAmount }) {
  const { ApiPromise, WsProvider } = await import("@polkadot/api");
  const [assetHub, hydration] = await Promise.all([
    ApiPromise.create({ provider: new WsProvider(args.assetHubWs, 5_000), noInitWarn: true, throwOnConnect: true }),
    ApiPromise.create({ provider: new WsProvider(args.hydrationWs, 5_000), noInitWarn: true, throwOnConnect: true }),
  ]);
  try {
    const operatorAccountId32 = (await assetHub.call.reviveApi.accountId(signerAddress)).toHex();
    const dispatchData = new Interface(XCM_WRAPPER_ABI).encodeFunctionData("dispatchLeg", [laneRequestId, 2, feeAmount]);
    const batch = assetHub.tx.utility.batchAll([
      assetHub.tx.revive.call(venueAddress, 0n, HIGH_WEIGHT, HIGH_STORAGE_DEPOSIT, stageData),
      assetHub.tx.revive.call(wrapperAddress, 0n, HIGH_WEIGHT, HIGH_STORAGE_DEPOSIT, dispatchData),
    ]);
    const [assetHubHeader, assetHubTimestamp, hubResult] = await Promise.all([
      assetHub.rpc.chain.getHeader(), assetHub.query.timestamp.now(),
      assetHub.call.dryRunApi.dryRunCall({ system: { signed: operatorAccountId32 } }, batch, 5),
    ]);
    assertDryRunCallComplete(hubResult.toJSON(), "Stateful stage recall + withdraw-sell");
    const forwarded = extractForwardedXcms(hubResult.toJSON()).filter((entry) => entry.paraId === 2034);
    if (forwarded.length !== 1) throw new Error(`Stateful recall dry-run forwarded ${forwarded.length} messages to Hydration; expected exactly one.`);
    // This is a send leg. The runtime-returned bytes are the actual wire frame;
    // execute those exact bytes rather than fabricating a sibling frame. The
    // post-stage JIT runtime additionally applies the pinned FIND #16/#17 send
    // frame binder before any real dispatch.
    const exactWire = assetHub.createType("XcmVersionedXcm", forwarded[0].message).toHex();
    const hydrationResult = await hydration.call.dryRunApi.dryRunXcm(
      { V5: { parents: 1, interior: { X1: [{ Parachain: 1000 }] } } },
      exactWire,
    );
    assertDryRunXcmComplete(hydrationResult.toJSON(), "Stateful recall withdraw-sell wire");
    assertWireCarriesTopic(exactWire, laneRequestId);
    const swap = assertAaveSwapEvent(normalizeRuntimeEvents(hydrationResult.toHuman()), {
      assetIn: 1003,
      assetOut: 22,
      expectedInput: shares,
    });
    return {
      liveState: true,
      capturedAt: new Date().toISOString(),
      assetHub: { endpoint: args.assetHubWs, blockNumber: assetHubHeader.number.toNumber(), blockHash: assetHubHeader.hash.toHex(), timestamp: assetHubTimestamp.toString(), call: batch.method.toHex(), execution: "Complete" },
      hydration: { endpoint: args.hydrationWs, wireMessage: exactWire, origin: { parents: 1, interior: "X1(Parachain(1000))" }, execution: "Complete", swap },
      wireFrame: { frameSource: "runtime_forwarded_stateful_send", forwardedWireMessage: exactWire, consumedUnchanged: true },
      feeAmount,
    };
  } finally {
    await Promise.allSettled([assetHub.disconnect(), hydration.disconnect()]);
  }
}

class PoolLaneRecallRuntime extends BankXcmV22Runtime {
  // The base dispatcher's withdraw-sell fee law is operating-lane semantics:
  // it sweeps the ENTIRE remote float as the leg's fee budget (there, the
  // float is deposit-leg dust bounded by the ceiling). The pool lane's
  // converted-account float is COMMINGLED capital — operating float plus pool
  // float — never a fee kitty; sweeping it both over-pays fees and trips the
  // float<=ceiling assert. Price the leg like deposit_sell instead: fresh
  // remote quote ×2, capped by the staged ceiling, configurable guarded floor,
  // affordability against the live float. dispatch() consults the
  // DISPATCHER's resolveFee,
  // so the override must wrap the created dispatcher — a method on this class
  // is never reached (the #1128 dead-override lesson).
  constructor(options) {
    const { feeFloorRatioBps = DEFAULT_RECALL_FEE_FLOOR_RATIO_BPS, ...runtimeOptions } = options;
    super(runtimeOptions);
    this.feeFloorRatioBps = assertRecallFeeFloorRatioBps(feeFloorRatioBps);
  }

  createDispatcher() {
    const dispatcher = super.createDispatcher();
    const base = dispatcher.resolveFee.bind(dispatcher);
    const runtime = this;
    dispatcher.resolveFee = async (input) => {
      if (Number(input.legIndex) !== 2) return base(input);
      const maximum = positiveBigInt(input.live.parameters.maxFeePerLeg, "maxFeePerLeg");
      const quote = await runtime.quoteRemoteFee({ requestId: input.requestId, leg: input.legIndex });
      if (quote?.liveState !== true) throw new Error("Recall withdraw-sell fee quote is not marked liveState:true.");
      const available = await runtime.readRemoteOperatingFloat({ requestId: input.requestId });
      if (available?.liveState !== true) throw new Error("Remote asset-22 balance is not marked liveState:true.");
      const selected = selectRecallDispatchFee({
        quote: quote.amount,
        maximum,
        available: available.assets,
        floorBps: runtime.feeFloorRatioBps,
      });
      return {
        ...selected,
        remoteAsOf: quote.asOf,
        remoteRef: quote.remoteRef,
      };
    };
    return dispatcher;
  }
}

// Withdraw legs occupy bitmap bits 2 (withdraw_sell) and 3 (withdraw_home).
// Maps an already-staged request's dispatch bitmap to the legs still owed.
export function pendingWithdrawLegs(bitmap) {
  const value = BigInt(bitmap);
  if (value === 0n) return ["withdraw_sell", "withdraw_home"];
  if (value === 4n) return ["withdraw_home"];
  if (value === 12n) return [];
  throw new Error(`Staged recall carries unexpected dispatch bitmap ${value}; refusing to guess the pending legs.`);
}

const DEPLOY_PARAMETER_FIELDS = Object.freeze([
  "sellAmount",
  "minimumOutput",
  "maxFeePerLeg",
  "dispatchDeadline",
]);

export function assertMatchingStagedDeploy({ stagedParameters, stagedNonce, expectedParameters }) {
  for (const field of DEPLOY_PARAMETER_FIELDS) {
    const staged = BigInt(stagedParameters?.[field] ?? -1);
    const expected = BigInt(expectedParameters?.[field] ?? -2);
    if (staged !== expected) {
      throw new Error(`Staged deploy ${field} mismatch: on-chain ${staged}, invocation ${expected}.`);
    }
  }
  const staged = BigInt(stagedNonce ?? -1);
  const expected = BigInt(expectedParameters?.nonce ?? -2);
  if (staged !== expected) {
    throw new Error(`Staged deploy nonce mismatch: on-chain ${staged}, invocation ${expected}.`);
  }
  return true;
}

function assertStagedDeployBinding({ record, laneAddress, venueAddress, requestedAssets, nonce }) {
  if (
    String(record?.context?.strategyId).toLowerCase() !== EXPECTED_STRATEGY_ID
    || Number(record?.context?.kind) !== 0
    || getAddress(record?.queuedBy) !== getAddress(laneAddress)
    || getAddress(record?.context?.account) !== getAddress(venueAddress)
    || BigInt(record?.context?.assets ?? -1) !== BigInt(requestedAssets)
    || BigInt(record?.context?.nonce ?? -1) !== BigInt(nonce)
    || Number(record?.status) !== 1
  ) {
    throw new Error("Staged wrapper request is not a pending deploy bound to the dedicated pool lane, venue adapter, exact assets, and nonce.");
  }
  return true;
}

// Deposit legs occupy bitmap bits 0 (deposit_funding) and 1 (deposit_sell).
// Any other shape contradicts the wrapper's enforced ordering and is refused
// rather than interpreted as a new ceremony state.
export function depositLegPlan(bitmap) {
  const value = BigInt(bitmap);
  if (value !== 0n && value !== 1n && value !== 3n) {
    throw new Error(`Staged deploy carries unexpected dispatch bitmap ${value}; refusing to guess the pending legs.`);
  }
  return [
    { leg: "deposit_funding", bit: 0, status: (value & 1n) !== 0n ? "skipped" : "pending" },
    { leg: "deposit_sell", bit: 1, status: (value & 2n) !== 0n ? "skipped" : "pending" },
  ];
}

export async function runDepositLegPlan({ bitmap, dispatchFunding, dispatchSell }) {
  const callbacks = { deposit_funding: dispatchFunding, deposit_sell: dispatchSell };
  const results = {};
  for (const entry of depositLegPlan(bitmap)) {
    if (entry.status === "skipped") {
      results[entry.leg] = {
        status: "skipped",
        reason: `wrapper bitmap bit ${entry.bit} is already set`,
        bit: entry.bit,
      };
      continue;
    }
    const dispatch = callbacks[entry.leg];
    if (typeof dispatch !== "function") throw new Error(`Missing ${entry.leg} dispatch callback.`);
    results[entry.leg] = { status: "dispatched", value: await dispatch() };
  }
  return results;
}

function makeRuntime({ provider, signer, wrapperAddress, laneAddress, convertedAccountId32, args, recall = false }) {
  const balanceReader = new VenueBalanceReader();
  const targets = {
    float: { ledger: "substrate_tokens", endpoint: args.hydrationWs, account: convertedAccountId32, assetId: 22 },
    position: { ledger: "erc20", endpoint: args.hydrationEvmRpc, chainId: EXPECTED_HYDRATION_CHAIN_ID, account: convertedAccountId32, accountTransform: "hydration_truncate20", contract: EXPECTED_AUSDC },
  };
  const ephemeralWatch = {
    async requireArmedWatch(requestId, { wrapperAddress: expectedWrapper } = {}) {
      const [position, float] = await Promise.all([balanceReader.read(targets.position), balanceReader.read(targets.float)]);
      return {
        requestId,
        wrapperAddress: expectedWrapper,
        status: "pending",
        registrationSource: "ceremony_prebroadcast_chain_read",
        baselineRaw: position.raw.toString(),
        floatBaselineRaw: float.raw.toString(),
        readAt: position.asOf,
      };
    },
    async getStatus() { return { enabled: true, running: true, chainEventWatchEnabled: true }; },
  };
  const gateway = {
    hasXcmWrapper: () => true,
    provider,
    signer,
    config: { xcmWrapperAddress: wrapperAddress },
  };
  const Runtime = recall ? PoolLaneRecallRuntime : BankXcmV22Runtime;
  const runtime = new Runtime({
    gateway,
    balanceObserver: ephemeralWatch,
    balanceReader,
    bankLaneFeed: { targets },
    adapterAddress: laneAddress,
    assetHubSubstrateEndpoint: args.assetHubWs,
    hydrationSubstrateEndpoint: args.hydrationWs,
    ...(recall ? { feeFloorRatioBps: args.feeFloorRatioBps } : {}),
  });
  return { runtime, dispatcher: runtime.createDispatcher(), balanceReader, targets };
}

async function persistEvidence(args, evidence) {
  console.log(JSON.stringify(evidence, bigintJson, 2));
  if (args.evidenceOut) {
    await writeFile(resolve(args.evidenceOut), `${JSON.stringify(evidence, bigintJson, 2)}\n`, { flag: "wx" });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage());
  if (!['status', 'cancel', 'stage-dispatch', 'stage-recall'].includes(args.command)) throw new Error(`${usage()}\n\nA subcommand is required.`);
  assertRecallFeeFloorRatioBps(args.feeFloorRatioBps);
  if (args.profile !== "mainnet") throw new Error("--profile mainnet is mandatory.");
  if (!args.requestId) throw new Error("--request-id is mandatory.");
  const isRecall = args.command === "stage-recall" || Boolean(args.recallId);
  if (args.command === "stage-dispatch" && !args.deploymentId) throw new Error("stage-dispatch requires --deployment-id.");
  if (args.command === "stage-recall" && !args.recallId) throw new Error("stage-recall requires --recall-id.");
  if ((args.command === "status" || args.command === "cancel") && Boolean(args.deploymentId) === Boolean(args.recallId)) {
    throw new Error(`${args.command} requires exactly one of --deployment-id or --recall-id.`);
  }
  if (!args.expectedSigner) throw new Error("--expected-signer is mandatory.");
  if (args.command === "status" && args.commit) throw new Error("status is read-only and refuses --commit.");
  if (args.commit && !args.useKms) throw new Error("--commit requires --use-kms; raw private keys are not accepted.");
  if (!args.assetHubWs || !args.hydrationWs) throw new Error("Asset Hub and Hydration Substrate endpoints are mandatory.");

  const requestId = normalizeBytes32(args.requestId, "--request-id");
  const deploymentId = args.deploymentId ? positiveBigInt(args.deploymentId, "--deployment-id") : 0n;
  const recallId = args.recallId ? positiveBigInt(args.recallId, "--recall-id") : 0n;
  const manifest = await readDeploymentManifest("mainnet");
  const { poolAddress } = resolvePoolTarget({
    requestedPool: args.pool,
    manifestPool: manifest.contracts.depositPool,
  });
  const { adapterAddress: venueAddress, laneAddress: manifestLane, adapterDeploymentBlock } = resolvePoolVenuePair(manifest, poolAddress);
  const operatingLane = getAddress(manifest.contracts.hydrationUsdcAdapter);
  const wrapperAddress = getAddress(manifest.contracts.xcmWrapper);
  assertExpectedSigner(args.expectedSigner, manifest.verifier);

  const rpc = await createCeremonyRpcContext({ manifest, phase: `pool-venue-${args.command}`, write: args.commit });
  const identity = await resolveSigner(args, rpc.provider);
  const pool = new Contract(poolAddress, POOL_ABI, rpc.provider);
  const adapterBindingBlock = await rpc.provider.getBlockNumber();
  assertPoolVenueAdapter({
    poolAddress,
    venueAdapter: await pool.venueAdapter({ blockTag: adapterBindingBlock }),
    expectedAdapter: venueAddress,
  });
  const venue = new Contract(venueAddress, VENUE_ABI, rpc.provider);
  const [adapterPool, adapterLane] = await Promise.all([
    venue.pool({ blockTag: adapterBindingBlock }),
    venue.lane({ blockTag: adapterBindingBlock }),
  ]);
  const { laneAddress } = resolveVenueBindings({ poolAddress, adapterPool, adapterLane });
  if (laneAddress !== manifestLane) throw new Error(`Pool ${poolAddress} adapter lane ${laneAddress} != manifest ${manifestLane}.`);
  console.log(`VENUE PAIRING: pool ${poolAddress} -> adapter ${venueAddress} -> lane ${laneAddress} (block ${adapterBindingBlock})`);
  if (laneAddress === operatingLane) throw new Error("Chain-bound pool lane aliases the operating adapter; refusing.");
  const lane = new Contract(laneAddress, LANE_ABI, rpc.provider);
  const wrapper = new Contract(wrapperAddress, XCM_WRAPPER_ABI, rpc.provider);
  const balanceReader = new VenueBalanceReader();
  const convertedAccountId32 = String(manifest.bankXcmV2Deployment?.convertedAccountId32 ?? "").toLowerCase();
  const targets = {
    float: { ledger: "substrate_tokens", endpoint: args.hydrationWs, account: convertedAccountId32, assetId: 22 },
    position: { ledger: "erc20", endpoint: args.hydrationEvmRpc, chainId: EXPECTED_HYDRATION_CHAIN_ID, account: convertedAccountId32, accountTransform: "hydration_truncate20", contract: EXPECTED_AUSDC },
    venuePostage: { ledger: "substrate_system", endpoint: args.assetHubWs, account: `${venueAddress.toLowerCase()}${"ee".repeat(12)}` },
  };
  try {
    const observability = await fetchJson(args.observabilityUrl, "deposit-pool observability");
    const stateArgs = {
      provider: rpc.provider,
      pool,
      venue,
      venueAddress,
      venueFromBlock: adapterDeploymentBlock,
      lane,
      wrapper,
      requestId,
      deploymentId,
      recallId,
      balanceReader,
      targets,
    };
    const state = await readState(stateArgs);
    assertExpectedSigner(state.pool.operator, identity.address);
    assertExpectedSigner(state.wrapper.operator, identity.address);
    if (state.pool.venueAdapter !== venueAddress || state.lane.agentAccountCore !== venueAddress || state.lane.wrapper !== wrapperAddress) {
      throw new Error("Pool→venue→dedicated lane→wrapper bindings do not match the manifest.");
    }
    if (String(await lane.asset()).toLowerCase() !== String(manifest.contracts.token).toLowerCase()) throw new Error("Dedicated pool lane asset does not match manifest USDC.");
    const deployment = state.pool.deployment;
    const recall = state.pool.recall;
    if (isRecall) {
      assertRecallRequestBinding({
        requested: requestId,
        activeRequestId: state.venue.activeRecallRequestId,
        activeRecallId: state.pool.activeVenueRecallId,
        recallId,
        recall,
        venueRequest: state.venue.request,
      });
    } else {
      assertRequestBinding({ requested: requestId, activeRequestId: state.venue.activeDeployRequestId, deployment, venueRequest: state.venue.request });
    }
    assertObservability(observability, { poolAddress, chainTimestamp: BigInt(state.block.timestamp) });
    const common = {
      schemaVersion: 1,
      kind: "averray.poolVenueDispatchEvidence",
      capturedAt: new Date().toISOString(),
      mode: args.commit ? "commit" : "dry-run",
      command: args.command,
      profile: args.profile,
      requestId,
      deploymentId,
      recallId: isRecall ? recallId : null,
      chainId: rpc.chainId,
      rpc: rpc.selectedUrl,
      addresses: { pool: poolAddress, venueAdapter: venueAddress, poolLane: laneAddress, wrapper: wrapperAddress, operatingLaneExcluded: operatingLane, convertedAccountId32 },
      signer: identity.address,
      signerBackend: identity.backend,
      observability: { url: args.observabilityUrl, block: observability.block, reconciled: observability.reconciled, flowsStatus: observability.flows?.status },
      state,
    };

    if (args.command === "status") {
      await persistEvidence(args, common);
      console.log("\nSTATUS ONLY — no signature requested and no transaction broadcast.");
      return common;
    }

    // Both staging commands own state-aware resume handling. Cancellation is
    // the only command that must remain strictly unstaged.
    if (args.command === "cancel") assertUnstaged({ laneRequestId: state.venue.laneRequestId });
    if (args.command === "cancel") {
      const transactions = buildCancelPlan({ venueAddress, poolAddress, requestId, deploymentId, recallId, kind: isRecall ? "recall" : "deploy" });
      await venue.getFunction("cancelUnstaged").staticCall(requestId, { from: identity.address });
      // State-aware batch semantics are proven by contract tests; the second
      // call cannot be eth_call'ed until cancellation has changed the request.
      const plan = {
        ...common,
        transactions,
        preflight: {
          cancelUnstaged: "success",
          poolSideAfterCancel: isRecall
            ? "deferred to pool-venue-ceremony settle --recall-id"
            : "contract-tested stateful settleVenueDeployment sequence",
        },
      };
      if (!args.commit) {
        await persistEvidence(args, plan);
        console.log(`\nDRY RUN ONLY — ${isRecall ? "recall cancel" : "deploy cancel/settle"} bytes emitted; no signature requested.`);
        return plan;
      }
      const before = state.pool;
      const signedVenue = venue.connect(identity.signer);
      const cancelTx = await signedVenue.cancelUnstaged(requestId);
      const cancelReceipt = await cancelTx.wait();
      if (!cancelReceipt || cancelReceipt.status !== 1) throw new Error("cancelUnstaged transaction failed.");
      if (isRecall) {
        const after = await readState(stateArgs);
        if (Number(after.venue.request.status) !== 3 || after.venue.request.claimed) {
          throw new Error("Recall cancel postcondition failed: venue request is not terminal Failed and unclaimed.");
        }
        const evidence = {
          ...plan,
          mode: "commit",
          receipts: [{ name: "cancelUnstaged", hash: cancelTx.hash, blockNumber: cancelReceipt.blockNumber, gasUsed: cancelReceipt.gasUsed }],
          postState: after,
          postconditions: { recallAdapterRequestFailed: true, poolSideSettlementDeferredToCeremony: true },
        };
        await persistEvidence(args, evidence);
        return evidence;
      }
      const signedPool = pool.connect(identity.signer);
      const settleTx = await signedPool.settleVenueDeployment(deploymentId);
      const settleReceipt = await settleTx.wait();
      if (!settleReceipt || settleReceipt.status !== 1) throw new Error("settleVenueDeployment transaction failed after cancellation.");
      const after = await readState(stateArgs);
      const tranche = BigInt(state.venue.request.requestedAssets);
      if (BigInt(after.pool.bufferAssets) - BigInt(before.bufferAssets) !== tranche) throw new Error("Cancel postcondition failed: pool buffer did not regain the exact tranche.");
      if (BigInt(before.venuePrincipalCostBasis) - BigInt(after.pool.venuePrincipalCostBasis) !== tranche) throw new Error("Cancel postcondition failed: principal cost basis did not fall by the exact tranche.");
      if (BigInt(after.pool.totalAssets) !== BigInt(before.totalAssets)) throw new Error("Cancel postcondition failed: totalAssets changed.");
      const evidence = { ...plan, mode: "commit", receipts: [{ name: "cancelUnstaged", hash: cancelTx.hash, blockNumber: cancelReceipt.blockNumber, gasUsed: cancelReceipt.gasUsed }, { name: "settleVenueDeployment", hash: settleTx.hash, blockNumber: settleReceipt.blockNumber, gasUsed: settleReceipt.gasUsed }], postState: after, postconditions: { bufferRestoredRaw: tranche, principalReductionRaw: tranche, totalAssetsUnchanged: true } };
      await persistEvidence(args, evidence);
      return evidence;
    }

    if (args.command === "stage-recall") {
      const initialMargin = assertDispatchMargin({ nowSeconds: state.block.timestamp, returnBy: state.venue.request.returnBy });
      if (state.wrapper.dispatchPaused) throw new Error("Configured wrapper is administratively paused; run cancel if the six-hour margin cannot be preserved.");
      const postageRaw = assertVenuePostage(state.venue.postage);
      const maximum = assertFeeCeiling(args.maxFeePerLeg);
      const nonce = args.laneNonce ? positiveBigInt(args.laneNonce, "--lane-nonce") : 1n;

      // A prior commit may have staged the recall and then failed before any
      // leg dispatched (cancelUnstaged is gone once a laneRequestId exists, so
      // the only honest path is forward). Detect that state and resume: verify
      // the staged record is exactly ours, then drive the legs still owed.
      const stagedLaneRequestId = normalizeBytes32(state.venue.laneRequestId ?? ZERO32, "staged laneRequestId");
      const isResume = stagedLaneRequestId !== ZERO32;
      let resumeRecord = null;
      let resumeState = null;
      if (isResume) {
        resumeRecord = await wrapper.getRequest(stagedLaneRequestId);
        if (
          String(resumeRecord.context.strategyId).toLowerCase() !== EXPECTED_STRATEGY_ID
          || Number(resumeRecord.context.kind) !== 1
          || getAddress(resumeRecord.queuedBy) !== laneAddress
          || getAddress(resumeRecord.context.account) !== venueAddress
          || BigInt(resumeRecord.context.shares) <= 0n
        ) throw new Error("Staged recall lane request is not bound to the dedicated pool lane and venue adapter.");
        if (Number(resumeRecord.status) !== 1) throw new Error("Staged recall lane request is not Pending; run status and read the wrapper record before resuming.");
        const reverse = normalizeBytes32(await venue.poolRequestForLaneRequest(stagedLaneRequestId), "reverse lane mapping");
        if (reverse !== requestId) throw new Error("Staged lane request does not map back to this recall adapter request.");
        const resumeBitmap = BigInt(await wrapper.requestDispatchBitmap(stagedLaneRequestId));
        pendingWithdrawLegs(resumeBitmap);
        if (resumeBitmap === 12n) {
          throw new Error("Staged recall has both legs dispatched (bitmap 12) but is unsettled; settle-only resume is not implemented — assess the lane settlement by hand.");
        }
        resumeState = { bitmap: resumeBitmap, sellDone: resumeBitmap === 4n };
      }

      const buildRecallPlan = async (liveState, phase) => {
        const derived = deriveRecallParameters({
          requestedAssets: liveState.venue.request.requestedAssets,
          venueAssets: liveState.lane.totalAssets,
          venueShares: liveState.lane.totalShares,
          maxFeePerLeg: maximum,
          returnBy: liveState.venue.request.returnBy,
          nonce,
        });
        const quote = await captureParQuote(args.hydrationWs, derived.shares, {
          assetIn: 1003,
          assetOut: 22,
          quoteAccount: convertedAccountId32,
          quoteAccountBalance: liveState.farSide.aUsdc.raw,
        });
        const stageCall = buildRecallStageCall({ requestId, parameters: derived.lane, requestedAssets: liveState.venue.request.requestedAssets });
        const stageData = stageCall.data;
        const predictedLaneRequestId = deriveLaneRecallRequestId({
          venueAddress,
          asset: manifest.contracts.token,
          shares: derived.shares,
          nonce: derived.lane.nonce,
        });
        const reverse = normalizeBytes32(await venue.poolRequestForLaneRequest(predictedLaneRequestId), "reverse lane mapping");
        assertUnstaged({ laneRequestId: liveState.venue.laneRequestId, reverseMapping: reverse });
        const emptyWrapper = await wrapper.getRequest(predictedLaneRequestId);
        if (String(emptyWrapper.context.account).toLowerCase() !== ZERO_ADDRESS) throw new Error("Predicted recall lane requestId already exists in the wrapper.");
        const dryRun = await dryRunStageAndRecallSell({
          args,
          signerAddress: identity.address,
          venueAddress,
          wrapperAddress,
          stageData,
          laneRequestId: predictedLaneRequestId,
          shares: derived.shares,
          // The stateful preview spends the authorized ceiling. The real send
          // is repriced JIT to min(quote×2, ceiling) with the configured floor.
          feeAmount: maximum,
        });
        return { phase, capturedAt: new Date().toISOString(), derived, quote, stageData, stageDecoded: stageCall.decoded, predictedLaneRequestId, dryRun };
      };

      let prepared = null;
      if (isResume) {
        // The stage is already on-chain; the stateful stage+dispatch preview
        // cannot re-run (staging would revert). A completed sell consumed its
        // aUSDC, so prove that request-bound execution instead of re-quoting
        // the spent position. Pending sells still require the full par quote;
        // each pending leg also retains its JIT dry-run before signature.
        let quote = null;
        let executedUnwindSwap = null;
        if (resumeState.sellDone) {
          const hydrationApi = await balanceReader.getSubstrateApi(args.hydrationWs);
          executedUnwindSwap = {
            resumedHistoricalLeg: true,
            ...await recoverHistoricalRecallSwap(hydrationApi, {
              requestId: stagedLaneRequestId,
              createdAt: resumeRecord.createdAt,
              expectedInput: BigInt(resumeRecord.context.shares),
            }),
          };
        } else {
          quote = await captureParQuote(args.hydrationWs, BigInt(resumeRecord.context.shares), {
            assetIn: 1003,
            assetOut: 22,
            quoteAccount: convertedAccountId32,
            quoteAccountBalance: state.farSide.aUsdc.raw,
          });
        }
        prepared = { phase: "resume", capturedAt: new Date().toISOString(), quote, executedUnwindSwap };
      } else {
        prepared = await buildRecallPlan(state, "dry-run");
      }
      const plan = {
        ...common,
        resumed: isResume,
        timing: { returnBy: state.venue.request.returnBy, marginSeconds: initialMargin, minimumMarginSeconds: MIN_DISPATCH_MARGIN_SECONDS },
        postage: { raw: postageRaw, minimumRaw: MIN_VENUE_POSTAGE_PLANCK, liveState: true },
        staging: isResume ? {
          resumedLaneRequestId: stagedLaneRequestId,
          stagedShares: BigInt(resumeRecord.context.shares),
          wrapperStatus: Number(resumeRecord.status),
          dispatchBitmap: resumeState.bitmap.toString(),
          pendingLegs: pendingWithdrawLegs(resumeState.bitmap),
        } : {
          precomputedShares: prepared.derived.shares,
          parameters: prepared.derived.lane,
          predictedLaneRequestId: prepared.predictedLaneRequestId,
          transaction: { to: venueAddress, data: prepared.stageData, value: "0" },
          decoded: prepared.stageDecoded,
        },
        freshParUnwindQuote: prepared.quote,
        ...(prepared.executedUnwindSwap ? { executedUnwindSwap: prepared.executedUnwindSwap } : {}),
        ...(isResume ? {} : { stagedWithdrawDryRun: prepared.dryRun }),
        guards: {
          dedicatedLaneOnly: true,
          operatingLaneUntouched: operatingLane,
          requestUnstaged: !isResume,
          wrapperRequestUnknown: !isResume,
          resumedFromStagedRequest: isResume,
          exactMinimumOutput: true,
          freshExactAmountAaveParUnwindQuote: !resumeState?.sellDone,
          statefulTwoChainDryRun: !isResume,
          commitTimeShareRecomputeRequired: !isResume,
        },
      };
      if (!args.commit) {
        await persistEvidence(args, plan);
        console.log(isResume
          ? "\nDRY RUN ONLY — recall already staged; commit drives the pending withdraw legs and settlement."
          : "\nDRY RUN ONLY — recall stage bytes emitted; no signature requested. Commit recomputes live shares and repeats the two-chain proof.");
        return plan;
      }

      // Re-read and rebuild immediately before signing. aUSDC rebases, so a
      // smaller ceilDiv result is legitimate; signing stale share bytes is not.
      const commitState = await readState(stateArgs);
      assertRecallRequestBinding({
        requested: requestId,
        activeRequestId: commitState.venue.activeRecallRequestId,
        activeRecallId: commitState.pool.activeVenueRecallId,
        recallId,
        recall: commitState.pool.recall,
        venueRequest: commitState.venue.request,
      });
      const commitMargin = assertDispatchMargin({ nowSeconds: commitState.block.timestamp, returnBy: commitState.venue.request.returnBy });
      assertVenuePostage(commitState.venue.postage);

      const token = new Contract(manifest.contracts.token, ERC20_ABI, rpc.provider);
      const wrapperUsdcBefore = BigInt(await token.balanceOf(wrapperAddress));
      const venueUsdcBefore = BigInt(await token.balanceOf(venueAddress));
      const aUsdcBefore = BigInt(commitState.farSide.aUsdc.raw);
      const floatBefore = BigInt(commitState.farSide.floatAsset22.raw);
      let liveLaneRequestId;
      let stagedShares;
      let stageReceiptEvidence;
      if (isResume) {
        liveLaneRequestId = stagedLaneRequestId;
        stagedShares = BigInt(resumeRecord.context.shares);
        stageReceiptEvidence = { resumed: true, laneRequestId: liveLaneRequestId };
      } else {
        prepared = await buildRecallPlan(commitState, "commit-recomputed");
        const stageTx = await identity.signer.sendTransaction({ to: venueAddress, data: prepared.stageData, value: 0n });
        const stageReceipt = await stageTx.wait();
        if (!stageReceipt || stageReceipt.status !== 1) throw new Error("stageRecall transaction failed.");
        const stagedEvent = stageReceipt.logs
          .map((log) => { try { return venueInterface.parseLog(log); } catch { return null; } })
          .find((event) => event?.name === "LaneRequestStaged" && String(event.args.requestId).toLowerCase() === requestId);
        if (!stagedEvent) throw new Error("stageRecall receipt omitted LaneRequestStaged.");
        liveLaneRequestId = normalizeBytes32(stagedEvent.args.laneRequestId, "LaneRequestStaged laneRequestId");
        stagedShares = BigInt(stagedEvent.args.laneShares);
        if (liveLaneRequestId !== prepared.predictedLaneRequestId || stagedShares !== prepared.derived.shares) {
          throw new Error("stageRecall postcondition differs from the commit-time requestId/share derivation.");
        }
        stageReceiptEvidence = { hash: stageTx.hash, blockNumber: stageReceipt.blockNumber, gasUsed: stageReceipt.gasUsed };
      }
      const stagedWrapperRecord = await wrapper.getRequest(liveLaneRequestId);
      if (
        String(stagedWrapperRecord.context.strategyId).toLowerCase() !== EXPECTED_STRATEGY_ID
        || Number(stagedWrapperRecord.context.kind) !== 1
        || getAddress(stagedWrapperRecord.queuedBy) !== laneAddress
        || getAddress(stagedWrapperRecord.context.account) !== venueAddress
        || BigInt(stagedWrapperRecord.context.shares) !== stagedShares
      ) throw new Error("Staged wrapper withdrawal is not bound to the dedicated pool lane, venue adapter, and exact shares.");

      const services = makeRuntime({ provider: rpc.provider, signer: identity.signer, wrapperAddress, laneAddress, convertedAccountId32, args, recall: true });
      try {
        const hydrationApi = await services.balanceReader.getSubstrateApi(args.hydrationWs);
        const sellAlreadyDone = Boolean(resumeState?.sellDone);
        let sell;
        let swap;
        let afterSellPosition;
        let afterSellFloat;
        let ledgerFloatBefore = floatBefore;
        if (sellAlreadyDone) {
          // The sell leg executed in a previous run (bitmap bit 2 set) and this
          // process has no baselines from before it. Rebuild the ledger from
          // chain history: locate the request-bound swap, then read the float
          // at the swap block's parent as the pre-sell baseline. Every number
          // stays chain-derived; nothing is trusted from memory.
          swap = await recoverHistoricalRecallSwap(hydrationApi, {
            requestId: liveLaneRequestId,
            createdAt: stagedWrapperRecord.createdAt,
            expectedInput: stagedShares,
          });
          sell = { evidence: { resumedHistoricalLeg: true, hydrationBlockNumber: swap.blockNumber } };
          const preSellHash = await hydrationApi.rpc.chain.getBlockHash(swap.blockNumber - 1);
          const preSell = await (await hydrationApi.at(preSellHash)).query.tokens.accounts(convertedAccountId32, 22);
          ledgerFloatBefore = BigInt(preSell.free.toString());
          afterSellPosition = await services.balanceReader.read(services.targets.position);
          afterSellFloat = await services.balanceReader.read(services.targets.float);
          const impliedSellFee = ledgerFloatBefore + BigInt(swap.amountOutRaw) - BigInt(afterSellFloat.raw);
          if (impliedSellFee < 0n || impliedSellFee > assertFeeCeiling(args.maxFeePerLeg)) {
            throw new Error("Historical sell reconstruction does not reconcile: the float moved outside the fee ceiling since the swap.");
          }
        } else {
          const sellScanStart = (await hydrationApi.rpc.chain.getHeader()).number.toNumber();
          sell = await services.dispatcher.dispatch({ requestId: liveLaneRequestId, leg: "withdraw_sell" });
          swap = await waitForAaveSwap(hydrationApi, {
            requestId: liveLaneRequestId,
            fromBlock: sellScanStart,
            expectedInput: stagedShares,
            assetIn: 1003,
            assetOut: 22,
          });
          afterSellPosition = await services.balanceReader.read(services.targets.position);
          afterSellFloat = await services.balanceReader.read(services.targets.float);
          if (aUsdcBefore - BigInt(afterSellPosition.raw) > stagedShares) {
            throw new Error("Observed aUSDC burn exceeded the pool lane's staged shares; operating position may have been touched.");
          }
        }
        // waitForAaveSwap already enforced the unwind law (filler-level par,
        // accrual-bounded above the staged shares); record the realized accrual.
        const liveExitAccrualRaw = BigInt(swap.amountOutRaw) - stagedShares;

        const home = await services.dispatcher.dispatch({ requestId: liveLaneRequestId, leg: "withdraw_home" });
        let wrapperUsdcAfter = wrapperUsdcBefore;
        for (let attempt = 0; attempt < 30 && wrapperUsdcAfter <= wrapperUsdcBefore; attempt += 1) {
          await new Promise((done) => setTimeout(done, 10_000));
          wrapperUsdcAfter = BigInt(await token.balanceOf(wrapperAddress));
        }
        const homeArrival = wrapperUsdcAfter - wrapperUsdcBefore;
        if (homeArrival <= 0n) throw new Error("Withdraw-home completed without an observable USDC arrival at the wrapper image.");
        const afterHomeFloat = await services.balanceReader.read(services.targets.float);
        const feeLedger = reconcilePoolRecall({
          requestedAssets: commitState.venue.request.requestedAssets,
          sharesSold: stagedShares,
          swapOutput: swap.amountOutRaw,
          floatBefore: ledgerFloatBefore,
          floatAfterSell: afterSellFloat.raw,
          floatAfterHome: afterHomeFloat.raw,
          homeArrival,
        });

        const settlementBlock = await rpc.provider.getBlock("latest");
        if (!settlementBlock?.hash) throw new Error("Asset Hub settlement proof omitted the live block hash.");
        const settleData = new Interface(LANE_ABI).encodeFunctionData("settleRequest", [
          liveLaneRequestId,
          2,
          homeArrival,
          stagedShares,
          // Successful adapter settlements require zero in the recovery-only
          // observedRemoteBalanceRaw slot. The actual commingled float remains
          // chain-read evidence below; it is not falsely booked as recoverable.
          0n,
          settlementBlock.hash,
          ZERO32,
        ]);
        await rpc.provider.call({ from: identity.address, to: laneAddress, data: settleData, value: 0n });
        const settleTx = await identity.signer.sendTransaction({ to: laneAddress, data: settleData, value: 0n });
        const settleReceipt = await settleTx.wait();
        if (!settleReceipt || settleReceipt.status !== 1) throw new Error("Dedicated pool-lane recall settlement transaction failed.");
        const [settledWrapper, settledAdapter, venueUsdcAfter] = await Promise.all([
          wrapper.getRequest(liveLaneRequestId),
          lane.getAdapterRequest(liveLaneRequestId),
          token.balanceOf(venueAddress),
        ]);
        if (Number(settledWrapper.status) !== 2 || Number(settledAdapter.status) !== 2 || !settledAdapter.settled) {
          throw new Error("Pool-lane recall settlement did not converge wrapper and adapter to Succeeded.");
        }
        if (BigInt(venueUsdcAfter) - venueUsdcBefore !== homeArrival) {
          throw new Error("Recall settlement did not route the exact observed home arrival to the venue adapter.");
        }
        await pool.getFunction("settleVenueRecall").staticCall(recallId, { from: identity.address });
        const evidence = {
          ...plan,
          mode: "commit",
          timing: { ...plan.timing, commitMarginSeconds: commitMargin },
          commitRecompute: isResume ? {
            resumed: true,
            laneRequestId: liveLaneRequestId,
            stagedShares,
            freshParUnwindQuote: prepared.quote,
          } : {
            dryRunShares: plan.staging.precomputedShares,
            actualShares: stagedShares,
            parameters: prepared.derived.lane,
            decoded: prepared.stageDecoded,
            laneRequestId: liveLaneRequestId,
            freshParUnwindQuote: prepared.quote,
            stagedWithdrawDryRun: prepared.dryRun,
          },
          receipts: {
            stage: stageReceiptEvidence,
            withdrawSell: sell.evidence,
            withdrawHome: home.evidence,
            settlement: { hash: settleTx.hash, blockNumber: settleReceipt.blockNumber, gasUsed: settleReceipt.gasUsed },
          },
          hydrationSwap: swap,
          postState: {
            laneRequestId: liveLaneRequestId,
            wrapperRequest: settledWrapper,
            adapterRequest: settledAdapter,
            wrapperBitmap: await wrapper.requestDispatchBitmap(liveLaneRequestId),
            aUsdcBefore,
            aUsdcAfter: afterSellPosition,
            floatBefore: ledgerFloatBefore,
            floatAfterSell: afterSellFloat,
            floatAfterHome: afterHomeFloat,
            wrapperUsdcBefore,
            wrapperUsdcAfter,
            venueUsdcBefore,
            venueUsdcAfter,
          },
          settlementProof: {
            assetHubBlockNumber: settlementBlock.number,
            assetHubBlockHash: settlementBlock.hash,
            sharesStagedRaw: stagedShares,
            aUsdcBurnedEventRaw: swap.amountInRaw,
            exitAccrualRaw: liveExitAccrualRaw,
            homeSideUsdcArrivalRaw: homeArrival,
            poolSettleVenueRecallRunnable: true,
          },
          feeLedger,
        };
        await persistEvidence(args, evidence);
        return evidence;
      } finally {
        await services.balanceReader.close();
      }
    }

    const margin = assertDispatchMargin({ nowSeconds: state.block.timestamp, returnBy: state.venue.request.returnBy });
    if (state.wrapper.dispatchPaused) throw new Error("Configured wrapper is administratively paused; run cancel if the six-hour margin cannot be preserved.");
    const maxFeePerLeg = assertFeeCeiling(args.maxFeePerLeg);
    const laneNonce = args.laneNonce ? positiveBigInt(args.laneNonce, "--lane-nonce") : 1n;
    const parameters = deriveStagingParameters({ requestedAssets: state.venue.request.requestedAssets, maxFeePerLeg, floatHeadroom: args.floatHeadroom, returnBy: state.venue.request.returnBy, nonce: laneNonce });
    const stageData = venueInterface.encodeFunctionData("stageDeploy", [requestId, parameters]);
    const predictedLaneRequestId = deriveLaneRequestId({
      venueAddress,
      asset: manifest.contracts.token,
      assets: state.venue.request.requestedAssets,
      nonce: parameters.nonce,
    });
    const isResume = state.venue.laneRequestId !== ZERO32;
    let resumeBitmap = 0n;
    if (isResume) {
      assertMatchingStagedDeploy({
        stagedParameters: state.wrapper.parameters,
        stagedNonce: state.wrapper.request?.context?.nonce,
        expectedParameters: parameters,
      });
      assertStagedDeployBinding({
        record: state.wrapper.request,
        laneAddress,
        venueAddress,
        requestedAssets: state.venue.request.requestedAssets,
        nonce: parameters.nonce,
      });
      if (state.venue.laneRequestId !== predictedLaneRequestId) {
        throw new Error(`Staged deploy laneRequestId mismatch: on-chain ${state.venue.laneRequestId}, invocation ${predictedLaneRequestId}.`);
      }
      const reverse = normalizeBytes32(await venue.poolRequestForLaneRequest(state.venue.laneRequestId), "reverse lane mapping");
      if (reverse !== requestId) {
        throw new Error(`Staged deploy reverse mapping mismatch: on-chain ${reverse}, invocation ${requestId}.`);
      }
      resumeBitmap = BigInt(state.wrapper.bitmap ?? -1);
      depositLegPlan(resumeBitmap);
    } else {
      assertUnstaged({ laneRequestId: state.venue.laneRequestId });
      if (normalizeBytes32(await venue.poolRequestForLaneRequest(predictedLaneRequestId), "reverse lane mapping") !== ZERO32) throw new Error("Predicted lane requestId is already bridged to another pool request.");
      const emptyWrapper = await wrapper.getRequest(predictedLaneRequestId);
      if (String(emptyWrapper.context.account).toLowerCase() !== ZERO_ADDRESS) throw new Error("Predicted lane requestId already exists in the wrapper.");
    }
    const quote = await captureParQuote(args.hydrationWs, parameters.sellAmount);
    let stagedFundingDryRun;
    if (isResume) {
      stagedFundingDryRun = {
        status: "skipped",
        reason: "stageDeploy is already committed; every remaining leg retains its own JIT dispatch guards",
      };
    } else {
      try {
        stagedFundingDryRun = await dryRunStageAndFunding({
          args,
          signerAddress: identity.address,
          venueAddress,
          wrapperAddress,
          stageData,
          laneRequestId: predictedLaneRequestId,
          convertedAccountId32,
        });
      } catch (error) {
        let stageDiagnostic = null;
        try {
          await rpc.provider.call({ from: identity.address, to: venueAddress, data: stageData, value: 0n });
          stageDiagnostic = { outcome: "eth_call_success" };
        } catch (stageError) {
          stageDiagnostic = {
            outcome: "eth_call_revert",
            selector: String(stageError?.data ?? stageError?.info?.error?.data ?? "").slice(0, 10) || null,
            message: stageError?.shortMessage ?? stageError?.info?.error?.message ?? stageError?.message,
          };
        }
        await persistEvidence(args, {
          ...common,
          timing: {
            returnBy: state.venue.request.returnBy,
            marginSeconds: margin,
            minimumMarginSeconds: MIN_DISPATCH_MARGIN_SECONDS,
          },
          freshParQuote: quote,
          staging: {
            parameters,
            predictedLaneRequestId,
            transaction: { to: venueAddress, data: stageData, value: "0" },
          },
          stagedFundingDryRun: {
            status: "failed",
            error: error?.message ?? String(error),
            stageDiagnostic,
          },
          action: "Do not sign or broadcast. Repair the named preflight condition, or run cancel before the six-hour margin closes.",
        });
        throw new Error(`${error.message} Stage diagnostic: ${JSON.stringify(stageDiagnostic)}.`);
      }
    }
    const legPlan = depositLegPlan(resumeBitmap);
    const plan = {
      ...common,
      timing: { returnBy: state.venue.request.returnBy, marginSeconds: margin, minimumMarginSeconds: MIN_DISPATCH_MARGIN_SECONDS },
      freshParQuote: quote,
      staging: { status: isResume ? "already_staged_matching" : "pending", parameters, predictedLaneRequestId, transaction: isResume ? null : { to: venueAddress, data: stageData, value: "0" } },
      resume: {
        resumedFromStagedRequest: isResume,
        bitmap: resumeBitmap,
        legs: legPlan,
        skippedLegs: legPlan.filter((entry) => entry.status === "skipped").map((entry) => entry.leg),
        pendingLegs: legPlan.filter((entry) => entry.status === "pending").map((entry) => entry.leg),
      },
      feeLedgerAuthorization: { trancheRaw: state.venue.request.requestedAssets, sellAmountRaw: parameters.sellAmount, retainedFloatAndFundingFeesRaw: BigInt(state.venue.request.requestedAssets) - parameters.sellAmount, maxFeePerLegRaw: parameters.maxFeePerLeg },
      stagedFundingDryRun,
      guards: { dedicatedLaneOnly: true, operatingLaneUntouched: operatingLane, requestUnstaged: !isResume, stagedParametersMatched: isResume, wrapperRequestUnknown: !isResume, freshExactAmountAaveParQuote: true, find20RuntimeTransformedFrame: true },
    };
    if (!args.commit) {
      await persistEvidence(args, plan);
      console.log(isResume
        ? `\nDRY RUN ONLY — matching staged request will resume at ${plan.resume.pendingLegs.join(", ") || "no remaining leg"}; no signature requested.`
        : "\nDRY RUN ONLY — stage bytes emitted; no signature requested. Funding/sell JIT proofs run after staging and before each signature.");
      return plan;
    }

    let stageTx = null;
    let stageReceipt = null;
    if (!isResume) {
      stageTx = await identity.signer.sendTransaction({ to: venueAddress, data: stageData, value: 0n });
      stageReceipt = await stageTx.wait();
      if (!stageReceipt || stageReceipt.status !== 1) throw new Error("stageDeploy transaction failed.");
    }
    const liveLaneRequestId = isResume
      ? state.venue.laneRequestId
      : normalizeBytes32(await venue.poolRequestForLaneRequest(predictedLaneRequestId), "post-stage reverse mapping") === requestId
        ? normalizeBytes32(predictedLaneRequestId, "lane requestId") : ZERO32;
    if (liveLaneRequestId === ZERO32) throw new Error("Postcondition failed: pool↔lane request bridge was not established.");
    const stagedWrapperRecord = await wrapper.getRequest(liveLaneRequestId);
    assertStagedDeployBinding({
      record: stagedWrapperRecord,
      laneAddress,
      venueAddress,
      requestedAssets: state.venue.request.requestedAssets,
      nonce: parameters.nonce,
    });
    const services = makeRuntime({ provider: rpc.provider, signer: identity.signer, wrapperAddress, laneAddress, convertedAccountId32, args });
    try {
      let remote;
      let swap;
      const legResults = await runDepositLegPlan({
        bitmap: resumeBitmap,
        dispatchFunding: async () => {
          const funding = await services.dispatcher.dispatch({ requestId: liveLaneRequestId, leg: "deposit_funding" });
          const fundingDeposit = funding.evidence.dryRun?.fundingDeposits?.[0];
          if (!fundingDeposit || funding.evidence.dryRun?.wireFrames?.[0]?.frameSource !== "runtime_transformed_local_execute") {
            throw new Error("FIND #20 postcondition failed: funding did not use the runtime-transformed local-execute frame.");
          }
          // Wait for the remote reserve transfer to become observable before
          // the exact sell preflight. A bounded wait cannot silently become a
          // daemon.
          for (let attempt = 0; attempt < 30; attempt += 1) {
            remote = await services.balanceReader.read(services.targets.float);
            const poolFundingDelta = remote.raw - BigInt(state.farSide.floatAsset22.raw);
            if (poolFundingDelta >= parameters.sellAmount + parameters.maxFeePerLeg) break;
            await new Promise((done) => setTimeout(done, 10_000));
          }
          const fundingDelta = remote ? remote.raw - BigInt(state.farSide.floatAsset22.raw) : -1n;
          if (!remote || fundingDelta < parameters.sellAmount + parameters.maxFeePerLeg) {
            throw new Error("Funding landed insufficient remote headroom for the staged sell; stopping without another dispatch.");
          }
          return funding;
        },
        dispatchSell: async () => {
          if (!remote) {
            remote = await services.balanceReader.read(services.targets.float);
            if (BigInt(remote.raw) < parameters.sellAmount + parameters.maxFeePerLeg) {
              throw new Error("Completed funding leg left insufficient live remote headroom for the staged sell; refusing resume.");
            }
          }
          const hydrationApi = await services.balanceReader.getSubstrateApi(args.hydrationWs);
          const sellScanStart = (await hydrationApi.rpc.chain.getHeader()).number.toNumber();
          const sell = await services.dispatcher.dispatch({ requestId: liveLaneRequestId, leg: "deposit_sell" });
          swap = await waitForAaveSwap(hydrationApi, {
            requestId: liveLaneRequestId,
            fromBlock: sellScanStart,
            expectedInput: parameters.sellAmount,
          });
          return sell;
        },
      });
      if (!swap) {
        const completed = {
          ...plan,
          mode: "commit",
          receipts: {
            stage: { status: "skipped", reason: "stageDeploy already committed" },
            funding: legResults.deposit_funding,
            sell: legResults.deposit_sell,
          },
          action: "All dispatch legs are already recorded on-chain; no transaction was repeated. Settlement requires the existing request-bound swap observation.",
        };
        await persistEvidence(args, completed);
        return completed;
      }
      const afterPosition = await services.balanceReader.read(services.targets.position);
      const afterFloat = await services.balanceReader.read(services.targets.float);
      const feeLedger = legResults.deposit_funding.status === "skipped"
        ? reconcileResumedPoolSell({
            committed: state.venue.request.requestedAssets,
            floatBeforeSell: remote.raw,
            finalFloat: afterFloat.raw,
            swapInput: swap.amountInRaw,
            deployedAUsdc: swap.amountOutRaw,
          })
        : reconcilePoolTranche({
            committed: state.venue.request.requestedAssets,
            baselineFloat: state.farSide.floatAsset22.raw,
            fundedFloat: remote.raw,
            finalFloat: afterFloat.raw,
            deployedAUsdc: swap.amountOutRaw,
          });
      if (feeLedger.aUsdcMintedRaw < parameters.minimumOutput) throw new Error("Sell postcondition failed: aUSDC delta is below minimumOutput.");
      const observedPositionDelta = afterPosition.raw - BigInt(state.farSide.aUsdc.raw);
      if (observedPositionDelta < feeLedger.aUsdcMintedRaw) throw new Error("aUSDC balance moved below the request-bound swap output.");
      const preSettlementAccrualRaw = observedPositionDelta - feeLedger.aUsdcMintedRaw;
      const hydrationProvider = services.balanceReader.getEvmProvider(
        services.targets.position.endpoint,
        services.targets.position.chainId,
        services.targets.position.rpcUrls,
      );
      const hydrationHead = await hydrationProvider.getBlock("latest");
      if (!hydrationHead?.hash) throw new Error("Hydration settlement proof omitted the live block hash.");
      const settleData = new Interface(LANE_ABI).encodeFunctionData("settleRequest", [
        liveLaneRequestId,
        2,
        observedPositionDelta,
        observedPositionDelta,
        0n,
        hydrationHead.hash,
        ZERO32,
      ]);
      await rpc.provider.call({ from: identity.address, to: laneAddress, data: settleData, value: 0n });
      const settleTx = await identity.signer.sendTransaction({ to: laneAddress, data: settleData, value: 0n });
      const settleReceipt = await settleTx.wait();
      if (!settleReceipt || settleReceipt.status !== 1) throw new Error("Dedicated pool-lane settlement transaction failed.");
      const settledWrapper = await wrapper.getRequest(liveLaneRequestId);
      const settledAdapter = await lane.getAdapterRequest(liveLaneRequestId);
      if (Number(settledWrapper.status) !== 2 || Number(settledAdapter.status) !== 2 || !settledAdapter.settled) {
        throw new Error("Pool-lane settlement did not converge wrapper and adapter to Succeeded.");
      }
      await pool.getFunction("settleVenueDeployment").staticCall(deploymentId, { from: identity.address });
      const evidence = {
        ...plan,
        mode: "commit",
        receipts: {
          stage: isResume
            ? { status: "skipped", reason: "stageDeploy already committed" }
            : { hash: stageTx.hash, blockNumber: stageReceipt.blockNumber, gasUsed: stageReceipt.gasUsed },
          funding: legResults.deposit_funding.status === "skipped"
            ? legResults.deposit_funding
            : legResults.deposit_funding.value.evidence,
          sell: legResults.deposit_sell.status === "skipped"
            ? legResults.deposit_sell
            : legResults.deposit_sell.value.evidence,
          settlement: { hash: settleTx.hash, blockNumber: settleReceipt.blockNumber, gasUsed: settleReceipt.gasUsed },
        },
        hydrationSwap: swap,
        postState: { laneRequestId: liveLaneRequestId, wrapperRequest: settledWrapper, adapterRequest: settledAdapter, wrapperBitmap: await wrapper.requestDispatchBitmap(liveLaneRequestId), farSideAUsdc: afterPosition, farSideFloat: afterFloat },
        settlementProof: { hydrationBlockNumber: hydrationHead.number, hydrationBlockHash: hydrationHead.hash, settledAssetsRaw: observedPositionDelta, settledSharesRaw: observedPositionDelta, preSettlementAccrualRaw, poolSettleVenueDeploymentRunnable: true },
        feeLedger,
      };
      await persistEvidence(args, evidence);
      return evidence;
    } finally {
      await services.balanceReader.close();
    }
  } finally {
    await balanceReader.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`pool-venue-dispatch failed: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
