#!/usr/bin/env node

/**
 * Leg B of the retired HYDRATION_USDC_V1 recall.
 *
 * Dry-run is the default. Commit mode is KMS-only and drives the already
 * multisig-staged request through withdraw_sell -> observed Hydration swap ->
 * withdraw_home -> observed Hub arrival -> adapter settlement. A dispatched
 * leg is never retried: bitmap/checkpoint state selects observation or the
 * next undispatched leg.
 */

import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Interface, getAddress } from "ethers";

import { KmsSigner } from "../../mcp-server/src/blockchain/kms-signer.js";
import { XCM_WRAPPER_ABI } from "../../mcp-server/src/blockchain/abis.js";
import { BankXcmV22Runtime } from "../../mcp-server/src/services/bank-xcm-v22-runtime.js";
import { VenueBalanceReader } from "../../mcp-server/src/services/venue-balance-reader.js";
import { createCeremonyRpcContext } from "./ceremony-rpc.mjs";
import {
  assertParAaveUnwindQuote,
  captureParQuote,
  reconcilePoolRecall,
  selectRecallDispatchFee,
  waitForAaveSwap,
} from "./pool-venue-dispatch.mjs";
import { assertExpectedSigner } from "./pool-venue-ceremony.mjs";
import {
  V1_RECALL,
  ZERO32,
  assertBookPreflight,
  assertPoolLaneUntouched,
  normalizeBytes32,
  positiveBigInt,
  stringify,
} from "./v1-lane-recall-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;

const POLICY_ABI = Object.freeze([
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function strategySettler(address) view returns (bool)",
]);
const ADAPTER_ABI = Object.freeze([
  "function asset() view returns (address)",
  "function strategyId() view returns (bytes32)",
  "function xcmWrapper() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function pendingWithdrawalShares() view returns (uint256)",
  "function getAdapterRequest(bytes32) view returns ((uint8 kind,uint8 status,address account,address requester,address recipient,uint256 requestedAssets,uint256 requestedShares,uint256 settledAssets,uint256 settledShares,bytes32 remoteRef,bytes32 failureCode,bool settled))",
  "function settleRequest(bytes32 requestId,uint8 status,uint256 settledAssets,uint256 settledShares,uint256 observedRemoteBalanceRaw,bytes32 remoteRef,bytes32 failureCode)",
]);
const POOL_LANE_ABI = Object.freeze([
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function pendingWithdrawalShares() view returns (uint256)",
]);
const TOKEN_ABI = Object.freeze(["function balanceOf(address) view returns (uint256)"]);
const AAC_ABI = Object.freeze([
  "function positions(address,address) view returns (uint256 liquid,uint256 reserved,uint256 strategyAllocated,uint256 collateralLocked,uint256 jobStakeLocked,uint256 debtOutstanding)",
]);

export function parseArgs(argv) {
  const args = {
    profile: undefined,
    requestId: undefined,
    expectedSigner: undefined,
    assetHubWs: process.env.BANK_XCM_ASSET_HUB_SUBSTRATE_RPC_URL ?? V1_RECALL.assetHubSubstrateRpc,
    hydrationWs: process.env.BANK_XCM_HYDRATION_SUBSTRATE_RPC_URL ?? V1_RECALL.hydrationSubstrateRpc,
    hydrationEvmRpc: process.env.BANK_XCM_HYDRATION_EVM_RPC_URL ?? V1_RECALL.hydrationEvmRpc,
    hydrationFromBlock: undefined,
    evidenceOut: undefined,
    commit: false,
    useKms: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
      return value;
    };
    if (flag === "--profile") args.profile = next();
    else if (flag === "--request-id") args.requestId = next();
    else if (flag === "--expected-signer") args.expectedSigner = next();
    else if (flag === "--asset-hub-ws") args.assetHubWs = next();
    else if (flag === "--hydration-ws") args.hydrationWs = next();
    else if (flag === "--hydration-evm-rpc") args.hydrationEvmRpc = next();
    else if (flag === "--hydration-from-block") args.hydrationFromBlock = next();
    else if (flag === "--quote-account") args.quoteAccount = next();
    else if (flag === "--evidence-out") args.evidenceOut = next();
    else if (flag === "--commit") args.commit = true;
    else if (flag === "--dry-run") args.commit = false;
    else if (flag === "--use-kms") args.useKms = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/ops/v1-lane-recall.mjs --profile mainnet --request-id 0x... --expected-signer 0x... [--evidence-out FILE]",
    "  node scripts/ops/v1-lane-recall.mjs --profile mainnet --request-id 0x... --expected-signer 0x... --evidence-out FILE --commit --use-kms",
    "",
    "Dry-run is default. Commit requires KMS; raw keys are not accepted.",
  ].join("\n");
}

export function pendingV1RecallActions(bitmap) {
  const value = BigInt(bitmap);
  if (value === 0n) return ["dispatch_withdraw_sell", "observe_swap", "dispatch_withdraw_home", "observe_arrival", "settle"];
  if (value === 4n) return ["observe_swap", "dispatch_withdraw_home", "observe_arrival", "settle"];
  if (value === 12n) return ["observe_swap", "observe_arrival", "settle"];
  throw new Error(`Unexpected v1 withdrawal bitmap ${value}; refusing to guess or retry.`);
}

export function findCommitOpeningCheckpoint(entries) {
  return entries.findLast((entry) => entry?.phase === "preflight" && entry?.mode === "commit") ?? null;
}

class V1RecallRuntime extends BankXcmV22Runtime {
  createDispatcher() {
    const dispatcher = super.createDispatcher();
    const base = dispatcher.resolveFee.bind(dispatcher);
    const runtime = this;
    dispatcher.resolveFee = async (input) => {
      if (Number(input.legIndex) !== 2) return base(input);
      const maximum = positiveBigInt(input.live.parameters.maxFeePerLeg, "maxFeePerLeg");
      const quote = await runtime.quoteRemoteFee({ requestId: input.requestId, leg: input.legIndex });
      if (quote?.liveState !== true) throw new Error("Withdraw-sell fee quote is not a live chain reading.");
      const available = await runtime.readRemoteOperatingFloat({ requestId: input.requestId });
      if (available?.liveState !== true) throw new Error("Remote asset-22 float is not a live chain reading.");
      const selected = selectRecallDispatchFee({ quote: quote.amount, maximum, available: available.assets });
      return { ...selected, remoteAsOf: quote.asOf, remoteRef: quote.remoteRef };
    };
    return dispatcher;
  }
}

export async function readHydrationTokenBalance(endpoint, account, assetId) {
  const { ApiPromise, WsProvider } = await import("@polkadot/api");
  const api = await ApiPromise.create({ provider: new WsProvider(endpoint, 5_000), noInitWarn: true, throwOnConnect: true });
  try {
    const v = await api.query.tokens.accounts(account, assetId);
    return BigInt(v.free.toString());
  } finally {
    await api.disconnect();
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage());
  if (args.profile !== "mainnet" || !args.requestId || !args.expectedSigner) {
    throw new Error(`${usage()}\n\n--profile mainnet, --request-id, and --expected-signer are mandatory.`);
  }
  if (args.commit && (!args.useKms || !args.evidenceOut)) {
    throw new Error("Commit requires --use-kms and an append-only --evidence-out checkpoint file.");
  }
  const requestId = normalizeBytes32(args.requestId, "--request-id");
  const manifest = JSON.parse(await readFile(resolve(repoRoot, "deployments/mainnet.json"), "utf8"));
  assertManifest(manifest);
  assertExpectedSigner(args.expectedSigner, V1_RECALL.settler);

  const rpc = await createCeremonyRpcContext({ manifest, phase: "v1-lane-recall-leg-b", write: args.commit });
  const identity = await resolveSigner(args, rpc.provider);
  const policy = new Contract(manifest.contracts.treasuryPolicy, POLICY_ABI, rpc.provider);
  const adapter = new Contract(V1_RECALL.adapter, ADAPTER_ABI, rpc.provider);
  const poolLane = new Contract(V1_RECALL.poolLane, POOL_LANE_ABI, rpc.provider);
  const wrapper = new Contract(V1_RECALL.wrapper, XCM_WRAPPER_ABI, rpc.provider);
  const token = new Contract(V1_RECALL.token, TOKEN_ABI, rpc.provider);
  const aac = new Contract(manifest.contracts.agentAccountCore, AAC_ABI, rpc.provider);
  const balanceReader = new VenueBalanceReader();
  const targets = {
    position: {
      ledger: "erc20",
      endpoint: args.hydrationEvmRpc,
      chainId: V1_RECALL.hydrationChainId,
      account: V1_RECALL.convertedAccountId32,
      accountTransform: "hydration_truncate20",
      contract: V1_RECALL.aUsdc,
    },
    float: {
      ledger: "substrate_tokens",
      endpoint: args.hydrationWs,
      account: V1_RECALL.convertedAccountId32,
      assetId: 22,
    },
  };

  try {
    const block = await rpc.provider.getBlock("latest");
    if (!block?.hash) throw new Error("Asset Hub preflight omitted the live block hash.");
    const at = { blockTag: block.number };
    const [
      owner,
      policyPaused,
      settlerRole,
      wrapperPaused,
      wrapperOperator,
      boundAdapter,
      adapterAsset,
      adapterStrategy,
      adapterWrapper,
      totalAssets,
      totalShares,
      pendingWithdrawals,
      adapterRequest,
      wrapperRequest,
      parameters,
      bitmap,
      multisigUsdc,
      wrapperUsdc,
      poolFingerprint,
      farPosition,
      farFloat,
      aacPosition,
    ] = await Promise.all([
      policy.owner(at),
      policy.paused(at),
      policy.strategySettler(identity.address, at),
      wrapper.dispatchPaused(at),
      wrapper.operator(at),
      wrapper.strategyAdapter(V1_RECALL.strategyId, at),
      adapter.asset(at),
      adapter.strategyId(at),
      adapter.xcmWrapper(at),
      adapter.totalAssets(at),
      adapter.totalShares(at),
      adapter.pendingWithdrawalShares(at),
      adapter.getAdapterRequest(requestId, at),
      wrapper.getRequest(requestId, at),
      wrapper.getRequestParameters(requestId, at),
      wrapper.requestDispatchBitmap(requestId, at),
      token.balanceOf(V1_RECALL.owner, at),
      token.balanceOf(V1_RECALL.wrapper, at),
      readPoolFingerprint(poolLane, at),
      balanceReader.read(targets.position),
      balanceReader.read(targets.float),
      aac.positions(V1_RECALL.settler, V1_RECALL.token, at),
    ]);
    const book = assertBookPreflight({
      totalAssets,
      totalShares,
      pendingWithdrawalShares: pendingWithdrawals,
      expectedPendingWithdrawalShares: V1_RECALL.allSharesRaw,
    });
    assertLiveBindings({
      owner,
      policyPaused,
      settlerRole,
      wrapperPaused,
      wrapperOperator,
      boundAdapter,
      adapterAsset,
      adapterStrategy,
      adapterWrapper,
      adapterRequest,
      wrapperRequest,
      parameters,
      bitmap,
      requestId,
      nowSeconds: block.timestamp,
    });
    const actions = pendingV1RecallActions(bitmap);
    const prior = await readCheckpoints(args.evidenceOut, requestId);
    const hydrationApi = await balanceReader.getSubstrateApi(args.hydrationWs);
    const hydrationHead = (await hydrationApi.rpc.chain.getHeader()).number.toNumber();
    const currentSnapshot = {
      assetHubBlockNumber: block.number,
      assetHubBlockHash: block.hash,
      assetHubTimestamp: block.timestamp,
      hydrationBlockNumber: hydrationHead,
      aUsdcRaw: BigInt(farPosition.raw),
      asset22FloatRaw: BigInt(farFloat.raw),
      multisigUsdcRaw: BigInt(multisigUsdc),
      wrapperUsdcRaw: BigInt(wrapperUsdc),
      aacLiquidRaw: BigInt(aacPosition.liquid),
      poolLane: poolFingerprint,
      v1Book: book,
    };
    let opening;
    let quote;
    if (BigInt(bitmap) === 0n) {
      if (BigInt(farPosition.raw) < V1_RECALL.allSharesRaw + BigInt(poolFingerprint.totalAssetsRaw)) {
        throw new Error("Opening Hydration aUSDC cannot cover both the v1 book and the untouched pool lane.");
      }
      // The public-holder scan pages through Hydration's whole tokens.accounts
      // storage and gives up after 10k entries; at this quote size (10.000001
      // aUSDC) virtually the only qualifying holder is our own deployment
      // account, which the pager never reaches. --quote-account names it
      // explicitly; the quote stays read-only either way, and the balance is
      // read live so captureParQuote's own sufficiency guard still applies.
      let quoteAccountBalance;
      if (args.quoteAccount) {
        quoteAccountBalance = await readHydrationTokenBalance(args.hydrationWs, args.quoteAccount, 1003);
      }
      quote = await captureParQuote(args.hydrationWs, V1_RECALL.allSharesRaw, {
        assetIn: 1003,
        assetOut: 22,
        ...(args.quoteAccount ? { quoteAccount: args.quoteAccount, quoteAccountBalance } : {})
      });
      assertParAaveUnwindQuote(quote.quote, V1_RECALL.allSharesRaw);
      opening = currentSnapshot;
    } else {
      const checkpoint = findCommitOpeningCheckpoint(prior);
      if (!checkpoint?.opening || !checkpoint?.freshAaveUnwindQuote) {
        throw new Error("Funds are already in flight but the opening checkpoint is missing; stop and reconstruct before continuing.");
      }
      opening = checkpoint.opening;
      quote = checkpoint.freshAaveUnwindQuote;
      assertPoolLaneUntouched(opening.poolLane, poolFingerprint, "Leg B resume preflight");
    }
    const common = {
      schemaVersion: 1,
      kind: "averray.v1LaneRecallEvidence",
      capturedAt: new Date().toISOString(),
      mode: args.commit ? "commit" : "dry-run",
      phase: "preflight",
      profile: "mainnet",
      requestId,
      addresses: {
        adapter: V1_RECALL.adapter,
        wrapper: V1_RECALL.wrapper,
        owner: getAddress(owner),
        settler: identity.address,
        poolLaneExcluded: V1_RECALL.poolLane,
        convertedAccountId32: V1_RECALL.convertedAccountId32,
        convertedH160: V1_RECALL.convertedH160,
        aUsdc: V1_RECALL.aUsdc,
      },
      signerBackend: identity.backend,
      opening,
      currentSnapshot,
      request: summarizeRequest(wrapperRequest, adapterRequest, parameters, bitmap),
      actions,
      freshAaveUnwindQuote: quote,
      guards: {
        strategySettler: true,
        exactV1Shares: true,
        poolLaneSnapshotPinned: true,
        noBlindRetry: true,
      },
    };

    const services = makeRuntime({
      provider: rpc.provider,
      signer: identity.signer ?? { getAddress: async () => identity.address },
      balanceReader,
      targets,
      args,
    });
    const dispatcher = services.runtime.createDispatcher();
    if (!args.commit) {
      let sellPreflight = null;
      if (BigInt(bitmap) === 0n) {
        const live = await services.runtime.readLiveRequest({ requestId, wrapper: V1_RECALL.wrapper });
        const fee = await dispatcher.resolveFee({ requestId, legIndex: 2, live });
        sellPreflight = await services.runtime.dryRunMessage({ requestId, leg: 2, feeAmount: fee.feeAmount });
      }
      const plan = {
        ...common,
        dryRun: {
          withdrawSell: sellPreflight ?? "already dispatched; observation only",
          withdrawHome: "JIT dry-run after request-bound Hydration observation; never pre-authorized from stale state",
          settlement: "eth_call from the KMS address after exact wrapper arrival is known",
        },
      };
      await recordEvidence(args.evidenceOut, plan);
      console.log(`${stringify(plan)}\n\nDRY RUN ONLY — no signature requested and no transaction broadcast.`);
      return plan;
    }

    const ceremonyOpening = opening;
    assertPoolLaneUntouched(ceremonyOpening.poolLane, poolFingerprint, "Leg B resume preflight");
    await recordEvidence(args.evidenceOut, common);

    let sellReceipt = null;
    let sellScanFrom = args.hydrationFromBlock ? Number(positiveBigInt(args.hydrationFromBlock, "--hydration-from-block")) : null;
    if (BigInt(bitmap) === 0n) {
      sellScanFrom = hydrationHead;
      sellReceipt = await dispatcher.dispatch({ requestId, leg: "withdraw_sell" });
      await recordEvidence(args.evidenceOut, {
        ...common,
        capturedAt: new Date().toISOString(),
        phase: "withdraw_sell_dispatched",
        hydrationScanFromBlock: sellScanFrom,
        receipt: sellReceipt.evidence,
        instruction: "Funds are in flight. Observe this requestId; never dispatch withdraw_sell again.",
      });
    } else {
      sellScanFrom ??= Number(prior.findLast((entry) => entry.phase === "withdraw_sell_dispatched")?.hydrationScanFromBlock ?? 0);
      if (!Number.isSafeInteger(sellScanFrom) || sellScanFrom <= 0) {
        throw new Error("Withdraw-sell is already dispatched. Supply --hydration-from-block or restore its checkpoint; never blind-retry.");
      }
    }

    const swap = await waitForAaveSwap(hydrationApi, {
      requestId,
      fromBlock: sellScanFrom,
      expectedInput: V1_RECALL.allSharesRaw,
      assetIn: 1003,
      assetOut: 22,
    });
    const [afterSellPosition, afterSellFloat, afterSellPool] = await Promise.all([
      balanceReader.read(targets.position),
      balanceReader.read(targets.float),
      readPoolFingerprint(poolLane),
    ]);
    assertPoolLaneUntouched(ceremonyOpening.poolLane, afterSellPool, "withdraw-sell observation");
    const observedAUsdcDecrease = BigInt(ceremonyOpening.aUsdcRaw) - BigInt(afterSellPosition.raw);
    if (observedAUsdcDecrease > V1_RECALL.allSharesRaw) {
      throw new Error("INCIDENT: observed aUSDC decrease exceeds every v1 share; the pool position may have been touched.");
    }

    let homeReceipt = null;
    let wrapperBeforeHome;
    if (BigInt(bitmap) !== 12n) {
      wrapperBeforeHome = BigInt(await token.balanceOf(V1_RECALL.wrapper));
      homeReceipt = await dispatcher.dispatch({ requestId, leg: "withdraw_home" });
      await recordEvidence(args.evidenceOut, {
        ...common,
        capturedAt: new Date().toISOString(),
        phase: "withdraw_home_dispatched",
        wrapperUsdcBeforeRaw: wrapperBeforeHome,
        receipt: homeReceipt.evidence,
        instruction: "Home is in flight. Observe the wrapper arrival; never dispatch withdraw_home again.",
      });
    } else {
      const checkpoint = prior.findLast((entry) => entry.phase === "withdraw_home_dispatched");
      if (checkpoint?.wrapperUsdcBeforeRaw === undefined) {
        throw new Error("Withdraw-home is already dispatched but its wrapper baseline checkpoint is missing; stop and reconstruct, never retry.");
      }
      wrapperBeforeHome = BigInt(checkpoint.wrapperUsdcBeforeRaw);
    }

    let wrapperAfterHome = BigInt(await token.balanceOf(V1_RECALL.wrapper));
    for (let attempt = 0; attempt < 30 && wrapperAfterHome <= wrapperBeforeHome; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10_000));
      wrapperAfterHome = BigInt(await token.balanceOf(V1_RECALL.wrapper));
    }
    const homeArrival = wrapperAfterHome - wrapperBeforeHome;
    if (homeArrival <= 0n || homeArrival > V1_RECALL.recordedBookRaw) {
      throw new Error("Withdraw-home has no positive, adapter-settleable wrapper arrival. Funds remain in flight; do not retry.");
    }
    const [afterHomeFloat, afterHomePool] = await Promise.all([
      balanceReader.read(targets.float),
      readPoolFingerprint(poolLane),
    ]);
    assertPoolLaneUntouched(ceremonyOpening.poolLane, afterHomePool, "withdraw-home observation");
    const ledger = reconcilePoolRecall({
      requestedAssets: V1_RECALL.recordedBookRaw,
      sharesSold: V1_RECALL.allSharesRaw,
      swapOutput: swap.amountOutRaw,
      floatBefore: ceremonyOpening.asset22FloatRaw,
      floatAfterSell: afterSellFloat.raw,
      floatAfterHome: afterHomeFloat.raw,
      homeArrival,
    });

    const settlementBlock = await rpc.provider.getBlock("latest");
    if (!settlementBlock?.hash) throw new Error("Settlement proof omitted the live Asset Hub block hash.");
    const settleData = new Interface(ADAPTER_ABI).encodeFunctionData("settleRequest", [
      requestId,
      2,
      homeArrival,
      V1_RECALL.allSharesRaw,
      0n,
      settlementBlock.hash,
      ZERO32,
    ]);
    await rpc.provider.call({ from: identity.address, to: V1_RECALL.adapter, data: settleData, value: 0n });
    const settleTx = await identity.signer.sendTransaction({ to: V1_RECALL.adapter, data: settleData, value: 0n });
    const settleReceipt = await settleTx.wait();
    if (!settleReceipt || settleReceipt.status !== 1) throw new Error("v1 adapter settlement transaction failed.");

    const [
      finalAssets,
      finalShares,
      finalPending,
      finalAdapterRequest,
      finalWrapperRequest,
      finalMultisigUsdc,
      finalPool,
      finalAacPosition,
    ] = await Promise.all([
      adapter.totalAssets(), adapter.totalShares(), adapter.pendingWithdrawalShares(), adapter.getAdapterRequest(requestId),
      wrapper.getRequest(requestId), token.balanceOf(V1_RECALL.owner), readPoolFingerprint(poolLane),
      aac.positions(V1_RECALL.settler, V1_RECALL.token),
    ]);
    assertPoolLaneUntouched(ceremonyOpening.poolLane, finalPool, "adapter settlement");
    if (BigInt(finalAssets) !== 0n || BigInt(finalShares) !== 0n || BigInt(finalPending) !== 0n) {
      throw new Error("v1 adapter did not close totalAssets, totalShares, and pending withdrawal to zero.");
    }
    if (Number(finalAdapterRequest.status) !== 2 || !finalAdapterRequest.settled || Number(finalWrapperRequest.status) !== 2) {
      throw new Error("Wrapper and v1 adapter did not converge to Succeeded.");
    }
    if (BigInt(finalMultisigUsdc) - BigInt(ceremonyOpening.multisigUsdcRaw) !== homeArrival) {
      throw new Error("Multisig USDC did not rise by the exact settled home arrival.");
    }
    if (BigInt(finalAacPosition.liquid) !== BigInt(ceremonyOpening.aacLiquidRaw)) {
      throw new Error("AAC liquid moved before authorized Leg D; stop and reconcile.");
    }

    const completed = {
      ...common,
      capturedAt: new Date().toISOString(),
      mode: "commit",
      phase: "completed",
      opening: ceremonyOpening,
      receipts: {
        withdrawSell: sellReceipt?.evidence ?? "resumed from prior dispatch checkpoint",
        withdrawHome: homeReceipt?.evidence ?? "resumed from prior dispatch checkpoint",
        settlement: { hash: settleTx.hash, blockNumber: settleReceipt.blockNumber, gasUsed: settleReceipt.gasUsed },
      },
      hydration: {
        swap,
        aUsdcAfterSellRaw: BigInt(afterSellPosition.raw),
        observedAUsdcDecreaseRaw: observedAUsdcDecrease,
        asset22AfterSellRaw: BigInt(afterSellFloat.raw),
        asset22AfterHomeRaw: BigInt(afterHomeFloat.raw),
      },
      settlement: {
        wrapperUsdcBeforeRaw: wrapperBeforeHome,
        wrapperUsdcAfterRaw: wrapperAfterHome,
        homeArrivalRaw: homeArrival,
        multisigUsdcAfterRaw: BigInt(finalMultisigUsdc),
        v1TotalAssetsAfterRaw: BigInt(finalAssets),
        v1TotalSharesAfterRaw: BigInt(finalShares),
      },
      ledger: {
        ...ledger,
        operatorYieldRaw: ledger.exitAccrualRaw,
        operatorYieldDisposition: "remote asset-22 residue; accounted, not depositor yield and not silently booked",
        unexplainedRaw: 0n,
      },
      gates: {
        v1BookClosed: true,
        poolLaneUntouched: true,
        multisigRiseEqualsReleasedAmount: true,
        aacUntouchedUntilLegD: true,
        zeroUnexplainedRaw: true,
      },
    };
    await recordEvidence(args.evidenceOut, completed);
    console.log(stringify(completed));
    return completed;
  } finally {
    await balanceReader.close();
    await rpc.provider.destroy?.();
  }
}

async function resolveSigner(args, provider) {
  if (args.commit && !args.useKms) throw new Error("Commit requires --use-kms; raw keys are not accepted.");
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

function makeRuntime({ provider, signer, balanceReader, targets, args }) {
  const observer = {
    async requireArmedWatch(id, { wrapperAddress } = {}) {
      const [position, float] = await Promise.all([balanceReader.read(targets.position), balanceReader.read(targets.float)]);
      return {
        requestId: id,
        wrapperAddress,
        status: "pending",
        registrationSource: "v1_recall_ceremony_chain_read",
        baselineRaw: position.raw.toString(),
        floatBaselineRaw: float.raw.toString(),
        readAt: position.asOf,
      };
    },
    async getStatus() { return { enabled: true, running: true, chainEventWatchEnabled: true }; },
  };
  const runtime = new V1RecallRuntime({
    gateway: {
      hasXcmWrapper: () => true,
      provider,
      signer,
      config: { xcmWrapperAddress: V1_RECALL.wrapper },
    },
    balanceObserver: observer,
    balanceReader,
    bankLaneFeed: { targets },
    adapterAddress: V1_RECALL.adapter,
    assetHubSubstrateEndpoint: args.assetHubWs,
    hydrationSubstrateEndpoint: args.hydrationWs,
  });
  return { runtime };
}

function assertLiveBindings(input) {
  const adapterRequest = input.adapterRequest;
  const wrapperRequest = input.wrapperRequest;
  if (
    input.policyPaused
    || input.wrapperPaused
    || input.settlerRole !== true
    || getAddress(input.owner) !== getAddress(V1_RECALL.owner)
    || getAddress(input.wrapperOperator) !== getAddress(V1_RECALL.settler)
    || getAddress(input.boundAdapter) !== getAddress(V1_RECALL.adapter)
    || getAddress(input.adapterAsset) !== getAddress(V1_RECALL.token)
    || String(input.adapterStrategy).toLowerCase() !== V1_RECALL.strategyId
    || getAddress(input.adapterWrapper) !== getAddress(V1_RECALL.wrapper)
  ) throw new Error("Live role/configuration preflight failed for the ratified v1 lane.");
  if (
    Number(adapterRequest.kind) !== 1
    || Number(adapterRequest.status) !== 1
    || adapterRequest.settled
    || getAddress(adapterRequest.account) !== getAddress(V1_RECALL.owner)
    || getAddress(adapterRequest.requester) !== getAddress(V1_RECALL.owner)
    || getAddress(adapterRequest.recipient) !== getAddress(V1_RECALL.owner)
    || BigInt(adapterRequest.requestedShares) !== V1_RECALL.allSharesRaw
  ) throw new Error("Adapter request is not the pending owner-bound all-shares v1 withdrawal.");
  if (
    Number(wrapperRequest.context.kind) !== 1
    || Number(wrapperRequest.status) !== 1
    || getAddress(wrapperRequest.queuedBy) !== getAddress(V1_RECALL.adapter)
    || getAddress(wrapperRequest.context.account) !== getAddress(V1_RECALL.owner)
    || getAddress(wrapperRequest.context.recipient) !== getAddress(V1_RECALL.owner)
    || BigInt(wrapperRequest.context.shares) !== V1_RECALL.allSharesRaw
    || String(wrapperRequest.context.strategyId).toLowerCase() !== V1_RECALL.strategyId
  ) throw new Error("Wrapper request is not bound to the v1 adapter, treasury owner, and all shares.");
  if (
    BigInt(input.parameters.sellAmount) !== V1_RECALL.allSharesRaw
    || BigInt(input.parameters.minimumOutput) !== V1_RECALL.recordedBookRaw
    || BigInt(input.parameters.maxFeePerLeg) > V1_RECALL.maxFeePerLegRaw
    || (BigInt(input.bitmap) !== 12n && BigInt(input.parameters.dispatchDeadline) <= BigInt(input.nowSeconds))
  ) throw new Error("Staged request parameters are stale or differ from the reviewed recall plan.");
}

async function readPoolFingerprint(poolLane, blockTag = undefined) {
  const overrides = blockTag ?? {};
  const [totalAssets, totalShares, pending] = await Promise.all([
    poolLane.totalAssets(overrides),
    poolLane.totalShares(overrides),
    poolLane.pendingWithdrawalShares(overrides),
  ]);
  return {
    totalAssetsRaw: BigInt(totalAssets),
    totalSharesRaw: BigInt(totalShares),
    pendingWithdrawalSharesRaw: BigInt(pending),
  };
}

function summarizeRequest(wrapperRequest, adapterRequest, parameters, bitmap) {
  return {
    wrapperStatus: Number(wrapperRequest.status),
    adapterStatus: Number(adapterRequest.status),
    account: getAddress(wrapperRequest.context.account),
    recipient: getAddress(wrapperRequest.context.recipient),
    requestedSharesRaw: BigInt(wrapperRequest.context.shares),
    sellAmountRaw: BigInt(parameters.sellAmount),
    minimumOutputRaw: BigInt(parameters.minimumOutput),
    maxFeePerLegRaw: BigInt(parameters.maxFeePerLeg),
    dispatchDeadline: BigInt(parameters.dispatchDeadline),
    dispatchBitmap: BigInt(bitmap),
  };
}

async function recordEvidence(path, evidence) {
  if (!path) return;
  await appendFile(resolve(path), `${stringify(evidence).replaceAll("\n", "")}\n`, { encoding: "utf8", flag: "a" });
}

async function readCheckpoints(path, requestId) {
  if (!path) return [];
  let raw;
  try {
    raw = await readFile(resolve(path), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return raw.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry?.kind === "averray.v1LaneRecallEvidence" && entry?.requestId === requestId);
}

function assertManifest(manifest) {
  const expected = [
    [manifest.contracts?.hydrationUsdcAdapter, V1_RECALL.adapter],
    [manifest.contracts?.xcmWrapper, V1_RECALL.wrapper],
    [manifest.contracts?.depositPoolLane, V1_RECALL.poolLane],
    [manifest.contracts?.token, V1_RECALL.token],
    [manifest.owner, V1_RECALL.owner],
    [manifest.verifier, V1_RECALL.settler],
  ];
  if (expected.some(([actual, wanted]) => getAddress(actual) !== getAddress(wanted))) {
    throw new Error("Manifest addresses no longer match the ratified v1 recall subject.");
  }
  if (String(manifest.bankXcmV2Deployment?.convertedAccountId32).toLowerCase() !== V1_RECALL.convertedAccountId32) {
    throw new Error("Manifest converted account no longer matches the ratified Hydration custody account.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`v1-lane-recall failed: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
