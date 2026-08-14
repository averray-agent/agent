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
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { KmsSigner } from "../../mcp-server/src/blockchain/kms-signer.js";
import { XCM_WRAPPER_ABI } from "../../mcp-server/src/blockchain/abis.js";
import {
  BankXcmV22Runtime,
  assertConvertedAccountDeposit,
} from "../../mcp-server/src/services/bank-xcm-v22-runtime.js";
import { VenueBalanceReader } from "../../mcp-server/src/services/venue-balance-reader.js";
import { createCeremonyRpcContext } from "./ceremony-rpc.mjs";
import { assertExpectedSigner, assertObservability } from "./pool-venue-ceremony.mjs";
import { extractAaveQuote } from "./capture-bank-xcm-v22-staging-quote.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export const MIN_DISPATCH_MARGIN_SECONDS = 6 * 60 * 60;
export const MAX_FEE_PER_LEG_RAW = 40_000n;
export const DEFAULT_FLOAT_HEADROOM_RAW = 50_000n;
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
  "function reservedDeployAssets() view returns (uint256)",
  "function poolRequestForLaneRequest(bytes32) view returns (bytes32)",
  "function getRequest(bytes32) view returns ((uint8 kind,uint8 status,uint256 requestedAssets,uint256 settledAssets,uint64 returnBy,bool claimed))",
  "function stageDeploy(bytes32,(uint256 sellAmount,uint256 minimumOutput,uint256 maxFeePerLeg,uint64 dispatchDeadline,uint64 nonce)) returns (bytes32)",
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
  "function settleVenueDeployment(uint256 deploymentId) returns (uint8 status,uint256 settledAssets)",
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
  const args = {
    command: argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined,
    profile: undefined,
    requestId: undefined,
    deploymentId: undefined,
    maxFeePerLeg: MAX_FEE_PER_LEG_RAW.toString(),
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
    else if (flag === "--request-id") args.requestId = next();
    else if (flag === "--deployment-id") args.deploymentId = next();
    else if (flag === "--max-fee-per-leg") args.maxFeePerLeg = next();
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

export function deriveLaneRequestId({ venueAddress, asset, assets, nonce }) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint8", "address", "address", "address", "uint256", "uint256", "uint64"],
    [EXPECTED_STRATEGY_ID, 0, getAddress(venueAddress), getAddress(asset), getAddress(venueAddress), BigInt(assets), 0n, BigInt(nonce)],
  ));
}

export function assertParAaveQuote(quote, expectedAmount) {
  const amount = positiveBigInt(expectedAmount, "exact quote amount");
  if (quote?.fillerType !== "AAVE" || BigInt(quote?.assetIn ?? -1) !== 22n || BigInt(quote?.assetOut ?? -1) !== 1003n) {
    throw new Error("Fresh staging quote did not use the AAVE 22→1003 route.");
  }
  if (BigInt(quote.amountInRaw) !== amount || BigInt(quote.amountOutRaw) !== amount) {
    throw new Error("Fresh exact-amount AAVE route quote was not exactly 1:1.");
  }
  return true;
}

export function buildCancelPlan({ venueAddress, poolAddress, requestId, deploymentId }) {
  return [
    { name: "cancelUnstaged", to: getAddress(venueAddress), data: venueInterface.encodeFunctionData("cancelUnstaged", [requestId]), value: "0" },
    { name: "settleVenueDeployment", to: getAddress(poolAddress), data: poolInterface.encodeFunctionData("settleVenueDeployment", [deploymentId]), value: "0" },
  ];
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

function rawAmount(value) {
  return BigInt(String(value ?? "-1").replaceAll(",", ""));
}

async function waitForAaveSwap(api, { requestId, fromBlock, expectedInput, attempts = 30 }) {
  let nextBlock = Number(fromBlock);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const head = (await api.rpc.chain.getHeader()).number.toNumber();
    for (; nextBlock <= head; nextBlock += 1) {
      const blockHash = (await api.rpc.chain.getBlockHash(nextBlock)).toHex();
      const at = await api.at(blockHash);
      const records = (await at.query.system.events()).toHuman();
      for (const record of records) {
        const event = record?.event;
        if (String(event?.section).toLowerCase() !== "broadcast" || !/^Swapped/u.test(String(event?.method))) continue;
        const xcm = (event.data?.operationStack ?? []).find((entry) => Array.isArray(entry?.Xcm))?.Xcm;
        if (String(xcm?.[0] ?? "").toLowerCase() !== requestId.toLowerCase()) continue;
        const input = event.data?.inputs?.find((entry) => rawAmount(entry.asset) === 22n);
        const output = event.data?.outputs?.find((entry) => rawAmount(entry.asset) === 1003n);
        if (event.data?.fillerType !== "AAVE" || rawAmount(input?.amount) !== BigInt(expectedInput) || rawAmount(output?.amount) <= 0n) {
          throw new Error("Request-bound Broadcast.Swapped did not match AAVE 22→1003 exact-input semantics.");
        }
        const timestamp = await at.query.timestamp.now();
        return {
          liveState: true,
          blockNumber: nextBlock,
          blockHash,
          timestamp: timestamp.toString(),
          event: event.method,
          requestId,
          fillerType: "AAVE",
          assetIn: 22,
          assetOut: 1003,
          amountInRaw: rawAmount(input.amount),
          amountOutRaw: rawAmount(output.amount),
        };
      }
    }
    await new Promise((done) => setTimeout(done, 6_000));
  }
  throw new Error(`Timed out without request-bound Broadcast.Swapped evidence for ${requestId}.`);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/ops/pool-venue-dispatch.mjs status --profile mainnet --request-id 0x... --deployment-id 1 --observability-url URL --expected-signer 0x...",
    "  node scripts/ops/pool-venue-dispatch.mjs cancel --profile mainnet --request-id 0x... --deployment-id 1 --observability-url URL --expected-signer 0x... [--commit --use-kms]",
    "  node scripts/ops/pool-venue-dispatch.mjs stage-dispatch --profile mainnet --request-id 0x... --deployment-id 1 --observability-url URL --expected-signer 0x... [--max-fee-per-leg 40000] [--float-headroom 50000] [--commit --use-kms]",
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

async function resolveSigner(args, provider) {
  if (!args.expectedSigner) throw new Error("--expected-signer is mandatory.");
  if (args.commit && !args.useKms) throw new Error("--commit requires --use-kms; raw private keys are not accepted.");
  if (!args.useKms) {
    return { address: getAddress(args.expectedSigner), signer: null, backend: "expected-signer (dry-run only)" };
  }
  const keyId = String(process.env.KMS_KEY_ID ?? "").trim();
  const region = String(process.env.AWS_REGION ?? "").trim();
  if (!keyId || !region) throw new Error("--use-kms requires KMS_KEY_ID and AWS_REGION.");
  const signer = new KmsSigner({ keyId, region, provider });
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

async function readState({ provider, pool, venue, venueAddress, venueFromBlock, lane, wrapper, requestId, deploymentId, balanceReader, targets }) {
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
    activeRequestId,
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
    pool.venueDeployments(deploymentId), venue.activeDeployRequestId(), venue.reservedDeployAssets(),
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
    pool: { operator: getAddress(poolOperator), venueAdapter: getAddress(venueAdapter), bufferAssets, totalAssets, venuePrincipalCostBasis: principal, deployment },
    venue: { activeDeployRequestId: activeRequestId, reservedDeployAssets, request: venueRequest, laneRequestId: actualLaneRequestId, postage: venuePostage },
    lane: { agentAccountCore: getAddress(laneAgentAccountCore), wrapper: getAddress(laneWrapper), totalAssets: laneTotalAssets, totalShares: laneTotalShares, pendingDepositAssets: lanePending, adapterRequest },
    wrapper: { dispatchPaused: wrapperPaused, operator: getAddress(wrapperOperator), request: wrapperRecord, parameters: wrapperParameters, bitmap: wrapperBitmap },
    farSide: { floatAsset22: farFloat, aUsdc: farPosition },
  };
}

async function captureParQuote(endpoint, sellAmount) {
  const { ApiPromise, WsProvider } = await import("@polkadot/api");
  const api = await ApiPromise.create({ provider: new WsProvider(endpoint, 5_000), noInitWarn: true, throwOnConnect: true });
  try {
    // DryRunApi accepts a signed origin without requiring its key. Discover a
    // public account with enough asset-22 at this exact head so the quote is
    // for the full staged sell, not a scaled sample. This is read-only and the
    // returned balance is evidence; no transaction can be produced for it.
    let startKey;
    let quoteAccount;
    let quoteAccountBalance;
    for (let page = 0; page < 10 && !quoteAccount; page += 1) {
      const entries = await api.query.tokens.accounts.entriesPaged({ args: [], pageSize: 1_000, startKey });
      if (entries.length === 0) break;
      for (const [key, value] of entries) {
        if (Number(key.args[1].toString()) !== 22) continue;
        const free = BigInt(value.free.toString());
        if (free < sellAmount) continue;
        quoteAccount = key.args[0].toHex();
        quoteAccountBalance = free;
        break;
      }
      startKey = entries.at(-1)[0].toHex();
    }
    if (!quoteAccount) throw new Error(`No public asset-22 account can support an exact ${sellAmount} read-only quote.`);
    const call = api.tx.router.sell(22, 1003, sellAmount, 1n, [{ pool: "Aave", assetIn: 22, assetOut: 1003 }]);
    const [header, timestamp, result] = await Promise.all([
      api.rpc.chain.getHeader(), api.query.timestamp.now(),
      api.call.dryRunApi.dryRunCall({ system: { signed: quoteAccount } }, call, 5),
    ]);
    const quote = extractAaveQuote(result.toHuman(), sellAmount);
    assertParAaveQuote(quote, sellAmount);
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

function makeRuntime({ provider, signer, wrapperAddress, laneAddress, convertedAccountId32, args }) {
  const balanceReader = new VenueBalanceReader();
  const targets = {
    float: { ledger: "substrate_tokens", endpoint: args.hydrationWs, account: convertedAccountId32, assetId: 22 },
    position: { ledger: "erc20", endpoint: args.hydrationEvmRpc, chainId: EXPECTED_HYDRATION_CHAIN_ID, account: convertedAccountId32, accountTransform: "hydration_truncate20", contract: EXPECTED_AUSDC },
  };
  const ephemeralWatch = {
    async requireArmedWatch(requestId, { wrapperAddress: expectedWrapper } = {}) {
      const baseline = await balanceReader.read(targets.position);
      return {
        requestId,
        wrapperAddress: expectedWrapper,
        status: "pending",
        registrationSource: "ceremony_prebroadcast_chain_read",
        baselineRaw: baseline.raw.toString(),
        readAt: baseline.asOf,
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
  const runtime = new BankXcmV22Runtime({
    gateway,
    balanceObserver: ephemeralWatch,
    balanceReader,
    bankLaneFeed: { targets },
    adapterAddress: laneAddress,
    assetHubSubstrateEndpoint: args.assetHubWs,
    hydrationSubstrateEndpoint: args.hydrationWs,
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
  if (!['status', 'cancel', 'stage-dispatch'].includes(args.command)) throw new Error(`${usage()}\n\nA subcommand is required.`);
  if (args.profile !== "mainnet") throw new Error("--profile mainnet is mandatory.");
  if (!args.requestId || !args.deploymentId) throw new Error("--request-id and --deployment-id are mandatory.");
  if (!args.expectedSigner) throw new Error("--expected-signer is mandatory.");
  if (args.command === "status" && args.commit) throw new Error("status is read-only and refuses --commit.");
  if (args.commit && !args.useKms) throw new Error("--commit requires --use-kms; raw private keys are not accepted.");
  if (!args.assetHubWs || !args.hydrationWs) throw new Error("Asset Hub and Hydration Substrate endpoints are mandatory.");

  const requestId = normalizeBytes32(args.requestId, "--request-id");
  const deploymentId = positiveBigInt(args.deploymentId, "--deployment-id");
  const manifest = JSON.parse(await readFile(resolve(repoRoot, "deployments", "mainnet.json"), "utf8"));
  const poolAddress = getAddress(manifest.contracts.depositPool);
  const venueAddress = getAddress(manifest.contracts.hydrationDepositPoolAdapter);
  const laneAddress = getAddress(manifest.contracts.depositPoolLane);
  const operatingLane = getAddress(manifest.contracts.hydrationUsdcAdapter);
  const wrapperAddress = getAddress(manifest.contracts.xcmWrapper);
  if (laneAddress === operatingLane) throw new Error("Manifest aliases the dedicated pool lane to the operating adapter; refusing.");
  assertExpectedSigner(args.expectedSigner, manifest.verifier);

  const rpc = await createCeremonyRpcContext({ manifest, phase: `pool-venue-${args.command}`, write: args.commit });
  const identity = await resolveSigner(args, rpc.provider);
  const pool = new Contract(poolAddress, POOL_ABI, rpc.provider);
  const venue = new Contract(venueAddress, VENUE_ABI, rpc.provider);
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
      venueFromBlock: Number(manifest.deploymentBlocks.hydrationDepositPoolAdapter),
      lane,
      wrapper,
      requestId,
      deploymentId,
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
    assertRequestBinding({ requested: requestId, activeRequestId: state.venue.activeDeployRequestId, deployment, venueRequest: state.venue.request });
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

    assertUnstaged({ laneRequestId: state.venue.laneRequestId });
    if (args.command === "cancel") {
      const transactions = buildCancelPlan({ venueAddress, poolAddress, requestId, deploymentId });
      await venue.getFunction("cancelUnstaged").staticCall(requestId, { from: identity.address });
      // State-aware batch semantics are proven by contract tests; the second
      // call cannot be eth_call'ed until cancellation has changed the request.
      const plan = { ...common, transactions, preflight: { cancelUnstaged: "success", settleAfterCancel: "contract-tested stateful sequence" } };
      if (!args.commit) {
        await persistEvidence(args, plan);
        console.log("\nDRY RUN ONLY — cancel/settle bytes emitted; no signature requested.");
        return plan;
      }
      const before = state.pool;
      const signedVenue = venue.connect(identity.signer);
      const signedPool = pool.connect(identity.signer);
      const cancelTx = await signedVenue.cancelUnstaged(requestId);
      const cancelReceipt = await cancelTx.wait();
      if (!cancelReceipt || cancelReceipt.status !== 1) throw new Error("cancelUnstaged transaction failed.");
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

    const margin = assertDispatchMargin({ nowSeconds: state.block.timestamp, returnBy: state.venue.request.returnBy });
    if (state.wrapper.dispatchPaused) throw new Error("Configured wrapper is administratively paused; run cancel if the six-hour margin cannot be preserved.");
    const maxFeePerLeg = assertFeeCeiling(args.maxFeePerLeg);
    const laneNonce = args.laneNonce ? positiveBigInt(args.laneNonce, "--lane-nonce") : 1n;
    const parameters = deriveStagingParameters({ requestedAssets: state.venue.request.requestedAssets, maxFeePerLeg, floatHeadroom: args.floatHeadroom, returnBy: state.venue.request.returnBy, nonce: laneNonce });
    const quote = await captureParQuote(args.hydrationWs, parameters.sellAmount);
    const stageData = venueInterface.encodeFunctionData("stageDeploy", [requestId, parameters]);
    const predictedLaneRequestId = deriveLaneRequestId({
      venueAddress,
      asset: manifest.contracts.token,
      assets: state.venue.request.requestedAssets,
      nonce: parameters.nonce,
    });
    if (normalizeBytes32(await venue.poolRequestForLaneRequest(predictedLaneRequestId), "reverse lane mapping") !== ZERO32) throw new Error("Predicted lane requestId is already bridged to another pool request.");
    const emptyWrapper = await wrapper.getRequest(predictedLaneRequestId);
    if (String(emptyWrapper.context.account).toLowerCase() !== ZERO_ADDRESS) throw new Error("Predicted lane requestId already exists in the wrapper.");
    let stagedFundingDryRun;
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
    const plan = {
      ...common,
      timing: { returnBy: state.venue.request.returnBy, marginSeconds: margin, minimumMarginSeconds: MIN_DISPATCH_MARGIN_SECONDS },
      freshParQuote: quote,
      staging: { parameters, predictedLaneRequestId, transaction: { to: venueAddress, data: stageData, value: "0" } },
      feeLedgerAuthorization: { trancheRaw: state.venue.request.requestedAssets, sellAmountRaw: parameters.sellAmount, retainedFloatAndFundingFeesRaw: BigInt(state.venue.request.requestedAssets) - parameters.sellAmount, maxFeePerLegRaw: parameters.maxFeePerLeg },
      stagedFundingDryRun,
      guards: { dedicatedLaneOnly: true, operatingLaneUntouched: operatingLane, requestUnstaged: true, wrapperRequestUnknown: true, freshExactAmountAaveParQuote: true, find20RuntimeTransformedFrame: true },
    };
    if (!args.commit) {
      await persistEvidence(args, plan);
      console.log("\nDRY RUN ONLY — stage bytes emitted; no signature requested. Funding/sell JIT proofs run after staging and before each signature.");
      return plan;
    }

    const stageTx = await identity.signer.sendTransaction({ to: venueAddress, data: stageData, value: 0n });
    const stageReceipt = await stageTx.wait();
    if (!stageReceipt || stageReceipt.status !== 1) throw new Error("stageDeploy transaction failed.");
    const liveLaneRequestId = normalizeBytes32(await venue.poolRequestForLaneRequest(predictedLaneRequestId), "post-stage reverse mapping") === requestId
      ? normalizeBytes32(predictedLaneRequestId, "lane requestId") : ZERO32;
    if (liveLaneRequestId === ZERO32) throw new Error("Postcondition failed: pool↔lane request bridge was not established.");
    const stagedWrapperRecord = await wrapper.getRequest(liveLaneRequestId);
    if (
      String(stagedWrapperRecord.context.strategyId).toLowerCase() !== EXPECTED_STRATEGY_ID
      || getAddress(stagedWrapperRecord.queuedBy) !== laneAddress
      || getAddress(stagedWrapperRecord.context.account) !== venueAddress
    ) {
      throw new Error("Postcondition failed: wrapper request is not bound to the dedicated pool lane and venue adapter.");
    }
    const services = makeRuntime({ provider: rpc.provider, signer: identity.signer, wrapperAddress, laneAddress, convertedAccountId32, args });
    try {
      const funding = await services.dispatcher.dispatch({ requestId: liveLaneRequestId, leg: "deposit_funding" });
      const fundingDeposit = funding.evidence.dryRun?.fundingDeposits?.[0];
      if (!fundingDeposit || funding.evidence.dryRun?.wireFrames?.[0]?.frameSource !== "runtime_transformed_local_execute") {
        throw new Error("FIND #20 postcondition failed: funding did not use the runtime-transformed local-execute frame.");
      }
      // Wait for the remote reserve transfer to become observable before the
      // exact sell preflight. A bounded wait cannot silently become a daemon.
      let remote;
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
      const hydrationApi = await services.balanceReader.getSubstrateApi(args.hydrationWs);
      const sellScanStart = (await hydrationApi.rpc.chain.getHeader()).number.toNumber();
      const sell = await services.dispatcher.dispatch({ requestId: liveLaneRequestId, leg: "deposit_sell" });
      const swap = await waitForAaveSwap(hydrationApi, {
        requestId: liveLaneRequestId,
        fromBlock: sellScanStart,
        expectedInput: parameters.sellAmount,
      });
      const afterPosition = await services.balanceReader.read(services.targets.position);
      const afterFloat = await services.balanceReader.read(services.targets.float);
      const feeLedger = reconcilePoolTranche({
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
        receipts: { stage: { hash: stageTx.hash, blockNumber: stageReceipt.blockNumber, gasUsed: stageReceipt.gasUsed }, funding: funding.evidence, sell: sell.evidence, settlement: { hash: settleTx.hash, blockNumber: settleReceipt.blockNumber, gasUsed: settleReceipt.gasUsed } },
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
