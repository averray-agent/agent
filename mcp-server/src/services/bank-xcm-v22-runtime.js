import { Contract, Interface, getAddress } from "ethers";

import { ConfigError, ValidationError } from "../core/errors.js";
import { XCM_WRAPPER_ABI } from "../blockchain/abis.js";
import { BankXcmV22Dispatcher } from "./bank-xcm-flow.js";
import { normalizeVenueBalanceTarget } from "./venue-balance-reader.js";

const REQUEST_ID_RE = /^0x[a-fA-F0-9]{64}$/u;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const HIGH_WEIGHT = Object.freeze({ refTime: 100_000_000_000n, proofSize: 3_000_000n });
const HIGH_STORAGE_DEPOSIT = 5_000_000_000n;
const MIN_STORAGE_DEPOSIT = 1_000_000_000n;
const ASSET_HUB_PARA_ID = 1000;
const HYDRATION_PARA_ID = 2034;

const ADAPTER_V22_ABI = Object.freeze([
  "function recordRemoteOperatingFloat(uint256 assets,uint64 asOf,bytes32 remoteRef)",
]);

/**
 * Concrete production adapter for BankXcmV22Dispatcher.
 *
 * The protocol object owns the refusal ordering. This class supplies only
 * chain-derived inputs and the existing KMS-backed gateway signer; callers
 * cannot inject a fee, message, weight, storage cap, gas limit, or signer.
 */
export class BankXcmV22Runtime {
  constructor({
    gateway,
    balanceObserver,
    balanceReader,
    bankLaneFeed,
    adapterAddress,
    assetHubSubstrateEndpoint,
    hydrationSubstrateEndpoint,
    eventBus = undefined,
    logger = console,
    now = () => Date.now(),
    wrapperContract = undefined,
    adapterContract = undefined,
    wrapperInterface = undefined,
  } = {}) {
    if (!gateway?.hasXcmWrapper?.() || !gateway?.provider || !gateway?.signer) {
      throw new ConfigError("Enabled Bank v2.2 runtime requires a configured wrapper and blockchain signer.");
    }
    if (!balanceObserver || !balanceReader || !bankLaneFeed?.targets?.position || !bankLaneFeed?.targets?.float) {
      throw new ConfigError("Enabled Bank v2.2 runtime requires the observer and manifest-derived Bank lane targets.");
    }
    this.gateway = gateway;
    this.balanceObserver = balanceObserver;
    this.balanceReader = balanceReader;
    this.bankLaneFeed = bankLaneFeed;
    this.wrapperAddress = getAddress(gateway.config.xcmWrapperAddress);
    this.adapterAddress = requireAddress(adapterAddress, "HYDRATION_USDC_ADAPTER_ADDRESS");
    this.assetHubSubstrateEndpoint = requireText(
      assetHubSubstrateEndpoint,
      "BANK_XCM_ASSET_HUB_SUBSTRATE_RPC_URL"
    );
    this.hydrationSubstrateEndpoint = requireText(
      hydrationSubstrateEndpoint,
      "BANK_XCM_HYDRATION_SUBSTRATE_RPC_URL"
    );
    this.positionTarget = normalizeVenueBalanceTarget(bankLaneFeed.targets.position);
    this.floatTarget = normalizeVenueBalanceTarget(bankLaneFeed.targets.float);
    this.eventBus = eventBus;
    this.logger = logger;
    this.now = now;
    this.wrapper = wrapperContract ?? new Contract(this.wrapperAddress, XCM_WRAPPER_ABI, gateway.provider);
    this.wrapperInterface = wrapperInterface ?? new Interface(XCM_WRAPPER_ABI);
    this.adapter = adapterContract ?? new Contract(this.adapterAddress, ADAPTER_V22_ABI, gateway.signer);
    this.substrateEventWatchRunning = false;
    this.substrateEventIngestionError = undefined;
    this.substrateEventUnsubscribe = undefined;
    this.substrateEventTail = Promise.resolve();
  }

  async start() {
    if (this.substrateEventWatchRunning) return;
    if (!this.eventBus?.publish) {
      this.substrateEventIngestionError = "Bank v2.2 Substrate event watch requires the event bus.";
      throw new ConfigError(this.substrateEventIngestionError);
    }
    try {
      const api = await this.getAssetHubApi();
      this.substrateEventUnsubscribe = await api.query.system.events((records) => {
        this.enqueueSubstrateEvents(api, records);
      });
      this.substrateEventWatchRunning = true;
      this.substrateEventIngestionError = undefined;
    } catch (error) {
      this.substrateEventWatchRunning = false;
      this.substrateEventIngestionError = error?.message ?? String(error);
      this.logger.error?.(
        { error: this.substrateEventIngestionError },
        "bank_xcm_v22_runtime.substrate_event_watch_start_failed"
      );
      throw error;
    }
  }

  enqueueSubstrateEvents(api, records) {
    const next = this.substrateEventTail.then(async () => {
      const blockHash = records?.createdAtHash?.toHex?.();
      if (!blockHash) {
        throw new ValidationError("Asset Hub system.events subscription omitted its authoritative block hash.");
      }
      const events = await this.readRequestQueuedEventsAtHash(api, blockHash, records);
      for (const event of events) this.eventBus.publish(event);
    });
    this.substrateEventTail = next.catch((error) => {
      this.substrateEventIngestionError = error?.message ?? String(error);
      this.logger.error?.(
        { error: this.substrateEventIngestionError },
        "bank_xcm_v22_runtime.substrate_event_ingestion_failed"
      );
    });
    return this.substrateEventTail;
  }

  async flushSubstrateEventIngestion() {
    await this.substrateEventTail;
  }

  createDispatcher() {
    return new BankXcmV22Dispatcher({
      enabled: true,
      expectedWrapper: this.wrapperAddress,
      readLiveRequest: (input) => this.readLiveRequest(input),
      quoteRemoteFee: (input) => this.quoteRemoteFee(input),
      readRemoteOperatingFloat: (input) => this.readRemoteOperatingFloat(input),
      readFundingTransferFee: (input) => this.readFundingTransferFee(input),
      dryRunMessage: (input) => this.dryRunMessage(input),
      simulateReviveCall: (input) => this.simulateReviveCall(input),
      estimateGas: (input) => this.estimateGas(input),
      requireArmedWatch: (requestId, options) => this.balanceObserver.requireArmedWatch(requestId, options),
      recordRemoteOperatingFloat: (input) => this.recordRemoteOperatingFloat(input),
      signAndDispatch: (input) => this.signAndDispatch(input),
      eventBus: this.eventBus,
      now: this.now,
    });
  }

  async getStatus() {
    const observer = await this.balanceObserver.getStatus();
    return {
      enabled: true,
      wrapper: this.wrapperAddress.toLowerCase(),
      adapter: this.adapterAddress.toLowerCase(),
      observerEnabled: observer.enabled === true,
      observerRunning: observer.running === true,
      chainEventWatchEnabled: observer.chainEventWatchEnabled === true,
      chainEventIngestionError: observer.chainEventIngestionError,
      substrateEventWatchRunning: this.substrateEventWatchRunning,
      substrateEventIngestionError: this.substrateEventIngestionError,
      readyForStaging: observer.enabled === true
        && observer.running === true
        && observer.chainEventWatchEnabled === true
        && !observer.chainEventIngestionError
        && this.substrateEventWatchRunning
        && !this.substrateEventIngestionError,
    };
  }

  async readLiveRequest({ requestId, wrapper } = {}) {
    const normalizedId = normalizeRequestId(requestId);
    if (getAddress(wrapper) !== this.wrapperAddress) {
      throw new ValidationError("Bank request read targeted another wrapper generation.");
    }
    const blockNumber = await this.gateway.provider.getBlockNumber();
    const blockTag = { blockTag: blockNumber };
    const [record, parameters, bitmap, dispatchPaused, operator, signerAddress] = await Promise.all([
      this.wrapper.getRequest(normalizedId, blockTag),
      this.wrapper.getRequestParameters(normalizedId, blockTag),
      this.wrapper.requestDispatchBitmap(normalizedId, blockTag),
      this.wrapper.dispatchPaused(blockTag),
      this.wrapper.operator(blockTag),
      this.gateway.signer.getAddress(),
    ]);
    if (!record?.context?.account || sameAddress(record.context.account, ZERO_ADDRESS)) {
      throw new ValidationError(`Unknown Bank request ${normalizedId}.`);
    }
    return {
      liveState: true,
      capturedAt: new Date(this.now()).toISOString(),
      blockNumber,
      wrapper: this.wrapperAddress,
      requestId: normalizedId,
      kind: Number(record.context.kind),
      status: Number(record.status),
      dispatchPaused: Boolean(dispatchPaused),
      operatorMatches: sameAddress(operator, signerAddress),
      bitmap: Number(bitmap),
      assets: record.context.assets.toString(),
      parameters: {
        sellAmount: parameters.sellAmount.toString(),
        minimumOutput: parameters.minimumOutput.toString(),
        maxFeePerLeg: parameters.maxFeePerLeg.toString(),
        dispatchDeadline: parameters.dispatchDeadline.toString(),
      },
    };
  }

  async quoteRemoteFee({ requestId, leg } = {}) {
    const preview = await this.previewLeg(requestId, leg, 1n);
    const api = await this.getHydrationApi();
    const [header, timestamp, weight] = await Promise.all([
      api.rpc.chain.getHeader(),
      api.query.timestamp.now(),
      api.call.xcmPaymentApi.queryXcmWeight(preview.message),
    ]);
    if (!weight?.isOk) throw new ValidationError("Hydration could not weigh the exact Bank XCM message.");
    const feeAssetId = extractWithdrawAssetId(api, preview.message);
    const fee = await api.call.xcmPaymentApi.queryWeightToAssetFee(weight.asOk, { V5: feeAssetId });
    if (!fee?.isOk) throw new ValidationError("Hydration could not quote the exact Bank XCM fee asset.");
    return {
      liveState: true,
      amount: fee.asOk.toString(),
      asOf: timestampSeconds(timestamp),
      remoteRef: header.hash.toHex(),
      blockNumber: header.number.toNumber(),
      endpoint: this.hydrationSubstrateEndpoint,
    };
  }

  async readRemoteOperatingFloat() {
    const reading = await this.readStampedBalance(this.floatTarget);
    return {
      liveState: true,
      assets: reading.raw.toString(),
      asOf: reading.timestampSeconds,
      remoteRef: reading.blockHash,
      blockNumber: reading.blockNumber,
      endpoint: this.floatTarget.endpoint,
    };
  }

  async readFundingTransferFee({ requestId } = {}) {
    const preview = await this.previewLeg(requestId, 0, 0n);
    const api = await this.getAssetHubApi();
    const [header, timestamp, fees] = await Promise.all([
      api.rpc.chain.getHeader(),
      api.query.timestamp.now(),
      api.call.xcmPaymentApi.queryDeliveryFees(preview.destination, preview.message),
    ]);
    if (!fees?.isOk) throw new ValidationError("Asset Hub could not quote the funding delivery fee.");
    const amount = extractSingleFungibleAmount(fees.asOk?.toJSON?.() ?? fees.asOk);
    return {
      liveState: true,
      amount: amount.toString(),
      asOf: timestampSeconds(timestamp),
      remoteRef: header.hash.toHex(),
      blockNumber: header.number.toNumber(),
      endpoint: this.assetHubSubstrateEndpoint,
    };
  }

  async dryRunMessage({ requestId, leg, feeAmount, calldata } = {}) {
    const preview = await this.previewLeg(requestId, leg, feeAmount);
    const encoded = calldata ?? this.encodeDispatch(requestId, leg, feeAmount);
    const assetHub = await this.getAssetHubApi();
    const hydration = await this.getHydrationApi();
    const operatorAccount = (await assetHub.call.reviveApi.accountId(await this.gateway.signer.getAddress())).toHex();
    const runtimeCall = assetHub.tx.revive.call(
      this.wrapperAddress,
      0n,
      HIGH_WEIGHT,
      HIGH_STORAGE_DEPOSIT,
      encoded
    );
    const [assetHubHeader, assetHubDryRun] = await Promise.all([
      assetHub.rpc.chain.getHeader(),
      assetHub.call.dryRunApi.dryRunCall({ system: { signed: operatorAccount } }, runtimeCall, 5),
    ]);
    const hubJson = assetHubDryRun.toJSON();
    assertDryRunCallComplete(hubJson, "Asset Hub wrapper call");
    const forwarded = extractForwardedXcms(hubJson);
    const forwardedParaIds = forwarded.map((entry) => entry.paraId).filter(Number.isInteger);
    const events = normalizeRuntimeEvents(assetHubDryRun.toHuman());

    for (const item of forwarded.filter((entry) => entry.paraId === HYDRATION_PARA_ID)) {
      const hydrationDryRun = await hydration.call.dryRunApi.dryRunXcm(
        siblingOrigin(ASSET_HUB_PARA_ID),
        item.message
      );
      const hydrationJson = hydrationDryRun.toJSON();
      assertDryRunXcmComplete(hydrationJson, "Hydration exact message");
      events.push(...normalizeRuntimeEvents(hydrationDryRun.toHuman()));
      const homeward = extractForwardedXcms(hydrationJson);
      forwardedParaIds.push(...homeward.map((entry) => entry.paraId).filter(Number.isInteger));
      for (const home of homeward.filter((entry) => entry.paraId === ASSET_HUB_PARA_ID)) {
        const homeDryRun = await assetHub.call.dryRunApi.dryRunXcm(
          siblingOrigin(HYDRATION_PARA_ID),
          home.message
        );
        assertDryRunXcmComplete(homeDryRun.toJSON(), "Asset Hub home message");
        events.push(...normalizeRuntimeEvents(homeDryRun.toHuman()));
      }
    }

    return {
      liveState: true,
      capturedAt: new Date(this.now()).toISOString(),
      ok: true,
      executionSucceeded: true,
      calldata: encoded,
      destination: preview.destination,
      message: preview.message,
      maxWeight: preview.maxWeight,
      forwardedParaIds: [...new Set(forwardedParaIds)],
      events,
      assetHubBlockNumber: assetHubHeader.number.toNumber(),
      assetHubEndpoint: this.assetHubSubstrateEndpoint,
      hydrationEndpoint: this.hydrationSubstrateEndpoint,
    };
  }

  async simulateReviveCall({ calldata } = {}) {
    const api = await this.getAssetHubApi();
    const origin = (await api.call.reviveApi.accountId(await this.gateway.signer.getAddress())).toHex();
    const high = await api.call.reviveApi.call(
      origin,
      this.wrapperAddress,
      0n,
      HIGH_WEIGHT,
      HIGH_STORAGE_DEPOSIT,
      calldata
    );
    const measured = normalizeReviveResult(high.toJSON());
    const weightLimit = {
      refTime: measured.weightUsed.refTime * 2n,
      proofSize: measured.weightUsed.proofSize * 2n,
    };
    const storageDepositLimit = maxBigInt(
      MIN_STORAGE_DEPOSIT,
      measured.storageDepositUsed * 2n
    );
    const exact = await api.call.reviveApi.call(
      origin,
      this.wrapperAddress,
      0n,
      weightLimit,
      storageDepositLimit,
      calldata
    );
    normalizeReviveResult(exact.toJSON());
    return {
      liveState: true,
      success: true,
      weightUsed: {
        refTime: measured.weightUsed.refTime.toString(),
        proofSize: measured.weightUsed.proofSize.toString(),
      },
      storageDepositUsed: measured.storageDepositUsed.toString(),
      exactLimitPass: true,
    };
  }

  async estimateGas({ calldata } = {}) {
    return this.gateway.provider.estimateGas({
      from: await this.gateway.signer.getAddress(),
      to: this.wrapperAddress,
      data: calldata,
      value: 0n,
    });
  }

  async recordRemoteOperatingFloat({ assets, asOf, remoteRef }) {
    const tx = await this.adapter.recordRemoteOperatingFloat(assets, asOf, remoteRef);
    const receipt = await tx.wait();
    return receiptSummary(receipt, tx.hash);
  }

  async signAndDispatch({ requestId, leg, feeAmount, calldata, gasLimit }) {
    const expected = this.encodeDispatch(requestId, leg, feeAmount);
    if (expected.toLowerCase() !== String(calldata).toLowerCase()) {
      throw new ValidationError("Bank dispatch calldata changed after the live preflights.");
    }
    const tx = await this.gateway.signer.sendTransaction({
      to: this.wrapperAddress,
      data: expected,
      value: 0n,
      gasLimit,
    });
    const receipt = await tx.wait();
    return receiptSummary(receipt, tx.hash);
  }

  /**
   * Standing import for a RequestQueued event missed while the runtime was off.
   * Multisig-origin revive calls do not surface through eth_getLogs. The event
   * is therefore read from authoritative Asset Hub system.events, and the
   * baseline is captured at an explicit destination-chain block before a watch
   * is persisted.
   */
  async backfillStagedRequestWatch({ requestId, fromBlock, toBlock = undefined } = {}) {
    const normalizedId = normalizeRequestId(requestId);
    const start = positiveBlock(fromBlock, "fromBlock");
    const api = await this.getAssetHubApi();
    const end = toBlock === undefined
      ? (await api.rpc.chain.getHeader()).number.toNumber()
      : positiveBlock(toBlock, "toBlock");
    if (end < start || end - start > 5_000) {
      throw new ValidationError("Bank watch backfill range must be ordered and no wider than 5,000 blocks.");
    }
    const matches = [];
    for (let blockNumber = start; blockNumber <= end; blockNumber += 1) {
      const blockHash = (await api.rpc.chain.getBlockHash(blockNumber)).toHex();
      const at = await api.at(blockHash);
      const records = await at.query.system.events();
      const events = await this.readRequestQueuedEventsAtHash(api, blockHash, records);
      matches.push(...events.filter((event) => event.data.requestId === normalizedId));
    }
    if (matches.length !== 1) {
      throw new ValidationError(`Expected exactly one RequestQueued event for ${normalizedId}; found ${matches.length}.`);
    }
    const event = matches[0];
    const baseline = await this.readStampedBalance(
      Number(event.data.kind) === 0 ? this.positionTarget : this.withdrawTarget()
    );
    return this.balanceObserver.registerBackfillFromChainEvent(event, {
      raw: baseline.raw,
      asOf: baseline.asOf,
      blockNumber: baseline.blockNumber,
      blockHash: baseline.blockHash,
    });
  }

  async readRequestQueuedEventsAtHash(api, blockHash, records = undefined) {
    const at = await api.at(blockHash);
    const [header, signedBlock, timestamp, eventRecords] = await Promise.all([
      api.rpc.chain.getHeader(blockHash),
      api.rpc.chain.getBlock(blockHash),
      at.query.timestamp.now(),
      records === undefined ? at.query.system.events() : records,
    ]);
    const decoded = decodeWrapperReviveEvents(
      eventRecords,
      this.wrapperAddress,
      this.wrapperInterface
    );
    const parametersByRequest = new Map(
      decoded
        .filter((entry) => entry.name === "RequestParametersStored")
        .map((entry) => [entry.args.requestId.toLowerCase(), entry])
    );
    const blockNumber = header.number.toNumber();
    const timestampIso = new Date(timestampSeconds(timestamp) * 1_000).toISOString();
    return decoded
      .filter((entry) => entry.name === "RequestQueued")
      .map((entry) => {
        const requestId = entry.args.requestId.toLowerCase();
        const parameters = parametersByRequest.get(requestId);
        if (!parameters || parameters.extrinsicIndex !== entry.extrinsicIndex) {
          throw new ValidationError(
            `RequestQueued ${requestId} has no same-extrinsic RequestParametersStored evidence.`
          );
        }
        const extrinsic = signedBlock.block.extrinsics[entry.extrinsicIndex];
        if (!extrinsic?.hash?.toHex) {
          throw new ValidationError(`RequestQueued ${requestId} has no authoritative extrinsic hash.`);
        }
        return {
          id: `xcm.request_queued-substrate-${blockHash}-${entry.eventIndex}`,
          topic: "xcm.request_queued",
          timestamp: timestampIso,
          txHash: extrinsic.hash.toHex(),
          blockNumber,
          data: {
            requestId,
            wrapperAddress: this.wrapperAddress,
            strategyId: entry.args.strategyId,
            kind: Number(entry.args.kind),
            account: entry.args.account,
            asset: entry.args.asset,
            recipient: entry.args.recipient,
            assetsRaw: entry.args.assets.toString(),
            sharesRaw: entry.args.shares.toString(),
            nonceRaw: entry.args.nonce.toString(),
            dispatchDeadlineRaw: parameters.args.dispatchDeadline.toString(),
          },
        };
      });
  }

  async previewLeg(requestId, leg, feeAmount) {
    const normalizedId = normalizeRequestId(requestId);
    const output = await this.wrapper.previewLegMessage(normalizedId, leg, feeAmount);
    return {
      destination: output.destination ?? output[0],
      message: output.message ?? output[1],
      maxWeight: {
        refTime: (output.maxWeight?.refTime ?? output[2]?.refTime ?? 0n).toString(),
        proofSize: (output.maxWeight?.proofSize ?? output[2]?.proofSize ?? 0n).toString(),
      },
    };
  }

  encodeDispatch(requestId, leg, feeAmount) {
    return this.wrapperInterface.encodeFunctionData("dispatchLeg", [
      normalizeRequestId(requestId),
      leg,
      feeAmount,
    ]);
  }

  withdrawTarget() {
    const usdc = this.gateway.config.supportedAssets?.find(
      (asset) => String(asset.symbol ?? "").toUpperCase() === "USDC"
    );
    if (!usdc?.address) throw new ConfigError("Bank withdraw watch requires configured USDC.");
    return normalizeVenueBalanceTarget({
      ledger: "erc20",
      endpoint: this.gateway.config.rpcUrl,
      chainId: this.gateway.config.chainId,
      account: this.wrapperAddress,
      contract: usdc.address,
    });
  }

  async readStampedBalance(target) {
    const normalized = normalizeVenueBalanceTarget(target);
    if (normalized.ledger === "erc20") {
      const provider = this.balanceReader.getEvmProvider(normalized.endpoint, normalized.chainId);
      const blockNumber = await provider.getBlockNumber();
      const [block, raw] = await Promise.all([
        provider.getBlock(blockNumber),
        new Contract(
          normalized.contract,
          ["function balanceOf(address account) view returns (uint256)"],
          provider
        ).balanceOf(normalized.evmAccount, { blockTag: blockNumber }),
      ]);
      return {
        raw: BigInt(raw),
        asOf: new Date(Number(block.timestamp) * 1_000).toISOString(),
        timestampSeconds: Number(block.timestamp),
        blockNumber,
        blockHash: block.hash,
      };
    }
    const api = await this.balanceReader.getSubstrateApi(normalized.endpoint);
    const header = await api.rpc.chain.getHeader();
    const hash = header.hash.toHex();
    const at = await api.at(hash);
    const [timestamp, record] = await Promise.all([
      at.query.timestamp.now(),
      at.query.tokens.accounts(normalized.account, normalized.assetId),
    ]);
    const json = record.toJSON();
    return {
      raw: BigInt(json?.free ?? 0),
      asOf: new Date(timestampSeconds(timestamp) * 1_000).toISOString(),
      timestampSeconds: timestampSeconds(timestamp),
      blockNumber: header.number.toNumber(),
      blockHash: hash,
    };
  }

  getAssetHubApi() {
    return this.balanceReader.getSubstrateApi(this.assetHubSubstrateEndpoint);
  }

  getHydrationApi() {
    return this.balanceReader.getSubstrateApi(this.hydrationSubstrateEndpoint);
  }
}

export function createBankXcmV22RuntimeServices({
  enabled,
  gateway,
  balanceObserver,
  balanceReader,
  bankLaneFeed,
  eventBus,
  env = process.env,
  logger = console,
  now,
} = {}) {
  if (!enabled) return { runtime: undefined, dispatcher: undefined };
  const runtime = new BankXcmV22Runtime({
    gateway,
    balanceObserver,
    balanceReader,
    bankLaneFeed,
    adapterAddress: env.HYDRATION_USDC_ADAPTER_ADDRESS,
    assetHubSubstrateEndpoint: env.BANK_XCM_ASSET_HUB_SUBSTRATE_RPC_URL,
    hydrationSubstrateEndpoint: env.BANK_XCM_HYDRATION_SUBSTRATE_RPC_URL,
    eventBus,
    logger,
    now,
  });
  return { runtime, dispatcher: runtime.createDispatcher() };
}

function normalizeRequestId(raw) {
  const value = String(raw ?? "").toLowerCase();
  if (!REQUEST_ID_RE.test(value)) throw new ValidationError("requestId must be a 32-byte hex value.");
  return value;
}

function requireAddress(raw, label) {
  try {
    return getAddress(raw);
  } catch {
    throw new ConfigError(`${label} must be a configured EVM address.`);
  }
}

function requireText(raw, label) {
  const value = String(raw ?? "").trim();
  if (!value) throw new ConfigError(`${label} is required when BANK_XCM_FLOW_ENABLED=true.`);
  return value;
}

function positiveBlock(raw, label) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValidationError(`${label} must be a positive block number.`);
  return value;
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function decodeWrapperReviveEvents(records, wrapperAddress, wrapperInterface) {
  const decoded = [];
  for (const [eventIndex, record] of [...records].entries()) {
    if (String(record?.event?.section) !== "revive"
      || String(record?.event?.method) !== "ContractEmitted"
      || record?.phase?.isApplyExtrinsic !== true) continue;
    const [contract, data, topics] = record.event.data;
    if (!sameAddress(contract?.toString?.(), wrapperAddress)) continue;
    let parsed;
    try {
      parsed = wrapperInterface.parseLog({
        data: data?.toHex?.() ?? String(data),
        topics: [...topics].map((topic) => topic?.toHex?.() ?? String(topic)),
      });
    } catch {
      // The wrapper emits events outside the Bank request lifecycle. Unknown
      // topics are not watch evidence and must not poison the subscription.
      continue;
    }
    if (!parsed || (parsed.name !== "RequestQueued" && parsed.name !== "RequestParametersStored")) continue;
    decoded.push({
      name: parsed.name,
      args: parsed.args,
      eventIndex,
      extrinsicIndex: Number(record.phase.asApplyExtrinsic.toString()),
    });
  }
  return decoded;
}

function siblingOrigin(paraId) {
  return { V5: { parents: 1, interior: { X1: [{ Parachain: paraId }] } } };
}

function extractForwardedXcms(json = {}) {
  const groups = json?.ok?.forwardedXcms ?? json?.Ok?.forwardedXcms ?? [];
  const output = [];
  for (const [destination, messages] of groups) {
    const paraId = Number(
      destination?.v5?.interior?.x1?.[0]?.parachain
      ?? destination?.V5?.interior?.X1?.[0]?.Parachain
    );
    for (const message of messages ?? []) output.push({ paraId, message });
  }
  return output;
}

function assertDryRunCallComplete(json, label) {
  const result = json?.ok?.executionResult ?? json?.Ok?.executionResult;
  if (!result?.ok && !result?.Ok) throw new ValidationError(`${label} dry-run did not succeed.`);
}

function assertDryRunXcmComplete(json, label) {
  const execution = json?.ok?.executionResult ?? json?.Ok?.executionResult;
  if (!execution?.complete && !execution?.Complete) {
    throw new ValidationError(`${label} dry-run did not complete.`);
  }
}

function normalizeRuntimeEvents(human = {}) {
  const raw = human?.Ok?.emittedEvents ?? human?.ok?.emittedEvents ?? [];
  return raw.map((event) => {
    const section = String(event.section ?? "");
    const method = /^Swapped/iu.test(String(event.method ?? "")) ? "Swapped" : String(event.method ?? "");
    const data = { ...(event.data ?? {}) };
    if (method === "Swapped") {
      const inputs = Array.isArray(data.inputs) ? data.inputs : [];
      const outputs = Array.isArray(data.outputs) ? data.outputs : [];
      data.assetIn = firstAssetId(inputs);
      data.assetOut = firstAssetId(outputs);
    }
    return { section, method, data };
  });
}

function firstAssetId(entries) {
  const value = entries?.[0]?.asset;
  return value === undefined ? undefined : Number(String(value).replaceAll(",", ""));
}

function extractWithdrawAssetId(api, message) {
  const decoded = api.createType("XcmVersionedXcm", message).toJSON();
  const instructions = decoded?.v5 ?? decoded?.V5;
  const withdraw = instructions?.find((instruction) => instruction.withdrawAsset ?? instruction.WithdrawAsset);
  const assets = withdraw?.withdrawAsset ?? withdraw?.WithdrawAsset;
  const id = assets?.[0]?.id;
  if (!id) throw new ValidationError("Exact Bank XCM message has no withdraw fee asset.");
  return id;
}

function extractSingleFungibleAmount(raw) {
  const values = [];
  walk(raw, (key, value) => {
    if (String(key).toLowerCase() === "fungible" && /^\d+$/u.test(String(value))) {
      values.push(BigInt(value));
    }
  });
  if (values.length !== 1 || values[0] <= 0n) {
    throw new ValidationError("XCM fee quote did not contain exactly one positive fungible amount.");
  }
  return values[0];
}

function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child);
    if (child && typeof child === "object") walk(child, visit);
  }
}

function timestampSeconds(codec) {
  const raw = BigInt(codec?.toString?.() ?? codec ?? 0);
  if (raw <= 0n) throw new ValidationError("Chain timestamp is unavailable.");
  return Number(raw / 1_000n);
}

function normalizeReviveResult(json = {}) {
  const ok = json?.result?.ok;
  const flags = ok ? Number(ok.flags?.bits ?? ok.flags ?? -1) : -1;
  if (!ok || flags !== 0) {
    throw new ValidationError(`Live ReviveApi_call failed: ${JSON.stringify(json?.result?.err ?? ok ?? null)}.`);
  }
  const required = json.weightRequired;
  const storage = json.storageDeposit;
  const storageUsed = storage?.charge ?? (storage?.refund !== undefined ? 0 : undefined);
  if (required?.refTime === undefined || required?.proofSize === undefined || storageUsed === undefined) {
    throw new ValidationError("Live ReviveApi_call omitted weight or storage evidence.");
  }
  const refTime = BigInt(required.refTime);
  const proofSize = BigInt(required.proofSize);
  if (refTime <= 0n || proofSize <= 0n) {
    throw new ValidationError("Live ReviveApi_call returned a non-positive weight component.");
  }
  return {
    weightUsed: { refTime, proofSize },
    storageDepositUsed: BigInt(storageUsed),
  };
}

function receiptSummary(receipt, fallbackHash) {
  return {
    status: Number(receipt?.status),
    txHash: receipt?.hash ?? fallbackHash,
    blockNumber: receipt?.blockNumber,
    gasUsed: receipt?.gasUsed?.toString(),
    effectiveGasPrice: (receipt?.gasPrice ?? receipt?.effectiveGasPrice)?.toString(),
  };
}

function maxBigInt(left, right) {
  return left > right ? left : right;
}
