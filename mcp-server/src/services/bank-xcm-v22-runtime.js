import { Contract, Interface, getAddress, getBytes, hexlify } from "ethers";

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
const NATIVE_DOT_DELIVERY_ASSET = Object.freeze({
  V5: Object.freeze({ parents: 1, interior: "Here" }),
});
// Historical Asset Hub delivery was roughly 0.01-0.03 DOT per leg. Refuse
// anything outside a five-times envelope so an asset-location or denomination
// mistake cannot flow onward as a plausible quote.
const MIN_NATIVE_DELIVERY_FEE_PLANCK = 20_000_000n;
const MAX_NATIVE_DELIVERY_FEE_PLANCK = 1_500_000_000n;
const EVENT_WATCH_CONNECT_TIMEOUT_MS = 30_000;
const EVENT_WATCH_RETRY_BASE_MS = 5_000;
const EVENT_WATCH_RETRY_MAX_MS = 60_000;

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
    eventWatchConnectTimeoutMs = EVENT_WATCH_CONNECT_TIMEOUT_MS,
    eventWatchRetryBaseMs = EVENT_WATCH_RETRY_BASE_MS,
    eventWatchRetryMaxMs = EVENT_WATCH_RETRY_MAX_MS,
    eventWatchSleep = sleep,
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
    this.eventWatchConnectTimeoutMs = positiveInteger(
      eventWatchConnectTimeoutMs,
      "eventWatchConnectTimeoutMs"
    );
    this.eventWatchRetryBaseMs = positiveInteger(eventWatchRetryBaseMs, "eventWatchRetryBaseMs");
    this.eventWatchRetryMaxMs = positiveInteger(eventWatchRetryMaxMs, "eventWatchRetryMaxMs");
    if (this.eventWatchRetryMaxMs < this.eventWatchRetryBaseMs) {
      throw new ConfigError("eventWatchRetryMaxMs must be at least eventWatchRetryBaseMs.");
    }
    if (typeof eventWatchSleep !== "function") {
      throw new ConfigError("eventWatchSleep must be a function.");
    }
    this.eventWatchSleep = eventWatchSleep;
    this.substrateEventWatchRunning = false;
    this.substrateEventIngestionError = undefined;
    this.substrateEventUnsubscribe = undefined;
    this.substrateEventTail = Promise.resolve();
    this.substrateEventStartPromise = undefined;
  }

  start() {
    if (this.substrateEventWatchRunning) return Promise.resolve();
    if (this.substrateEventStartPromise) return this.substrateEventStartPromise;
    if (!this.eventBus?.publish) {
      this.substrateEventIngestionError = "Bank v2.2 Substrate event watch requires the event bus.";
      return Promise.reject(new ConfigError(this.substrateEventIngestionError));
    }
    this.substrateEventStartPromise = this.startSubstrateEventWatchWithRetry()
      .finally(() => {
        this.substrateEventStartPromise = undefined;
      });
    return this.substrateEventStartPromise;
  }

  async startSubstrateEventWatchWithRetry() {
    let attempt = 0;
    while (!this.substrateEventWatchRunning) {
      attempt += 1;
      try {
        const api = await withTimeout(
          this.getAssetHubApi(),
          this.eventWatchConnectTimeoutMs,
          "Asset Hub Substrate API connection"
        );
        this.substrateEventUnsubscribe = await withTimeout(
          api.query.system.events((records) => {
            this.enqueueSubstrateEvents(api, records);
          }),
          this.eventWatchConnectTimeoutMs,
          "Asset Hub system.events subscription"
        );
        this.substrateEventWatchRunning = true;
        this.substrateEventIngestionError = undefined;
        this.logger.info?.(
          { attempt, endpoint: this.assetHubSubstrateEndpoint },
          "bank_xcm_v22_runtime.substrate_event_watch_started"
        );
      } catch (error) {
        this.substrateEventWatchRunning = false;
        this.substrateEventIngestionError = error?.message ?? String(error);
        this.balanceReader.resetSubstrateApi?.(this.assetHubSubstrateEndpoint);
        const retryInMs = Math.min(
          this.eventWatchRetryBaseMs * (2 ** Math.min(attempt - 1, 30)),
          this.eventWatchRetryMaxMs
        );
        this.logger.error?.(
          {
            error: this.substrateEventIngestionError,
            attempt,
            retryInMs,
            endpoint: this.assetHubSubstrateEndpoint,
          },
          "bank_xcm_v22_runtime.substrate_event_watch_start_failed"
        );
        await this.eventWatchSleep(retryInMs);
      }
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
      quoteHomeExecutionFee: (input) => this.quoteHomeExecutionFee(input),
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

  /**
   * Price the downstream Asset Hub execution budget and the upstream
   * Hydration delivery in one live session. The provisional one-raw nested
   * budget only obtains the wrapper-built message; the selected fee is spliced
   * into fresh bytes later and the standing three-hop dry-run must still prove
   * the final Asset Hub deposit before signing.
   */
  async quoteHomeExecutionFee({ requestId, leg } = {}) {
    if (Number(leg) !== 3) {
      throw new ValidationError("Home execution fee quote is only valid for withdraw_home.");
    }
    const preview = await this.previewLeg(requestId, leg, 1n);
    const [assetHub, hydration] = await Promise.all([
      this.getAssetHubApi(),
      this.getHydrationApi(),
    ]);
    const wireMessage = composeOnWire(preview.message, this.wrapperAddress);
    const [
      assetHubHeader,
      assetHubTimestamp,
      hydrationHeader,
      hydrationTimestamp,
      hydrationWeight,
      hydrationDryRun,
    ] = await Promise.all([
      assetHub.rpc.chain.getHeader(),
      assetHub.query.timestamp.now(),
      hydration.rpc.chain.getHeader(),
      hydration.query.timestamp.now(),
      hydration.call.xcmPaymentApi.queryXcmWeight(wireMessage),
      hydration.call.dryRunApi.dryRunXcm(
        siblingOrigin(ASSET_HUB_PARA_ID),
        wireMessage
      ),
    ]);
    if (!hydrationWeight?.isOk) {
      throw new ValidationError("Hydration could not weigh the exact withdraw-home message.");
    }
    const hydrationFeeAssetId = extractWithdrawAssetId(hydration, preview.message);
    const hydrationFee = await hydration.call.xcmPaymentApi.queryWeightToAssetFee(
      hydrationWeight.asOk,
      { V5: hydrationFeeAssetId }
    );
    if (!hydrationFee?.isOk) {
      throw new ValidationError("Hydration could not quote the exact withdraw-home delivery.");
    }
    const upstreamFee = positiveBigInt(
      hydrationFee.asOk.toString(),
      "Hydration withdraw-home fee"
    );
    const grossAmount = extractWithdrawFungibleAmount(hydration, preview.message);
    if (upstreamFee >= grossAmount) {
      throw new ValidationError("Hydration withdraw-home fee consumes the full staged amount.");
    }
    const computedArrival = grossAmount - upstreamFee;

    const hydrationJson = hydrationDryRun.toJSON();
    assertDryRunXcmComplete(hydrationJson, "Hydration home quote message");
    assertConvertedAccountWithdrawal(
      hydration,
      normalizeRuntimeEvents(hydrationDryRun.toHuman()),
      this.floatTarget.account,
      "Hydration home quote message"
    );
    const homeward = extractForwardedXcms(hydrationJson)
      .filter((entry) => entry.paraId === ASSET_HUB_PARA_ID);
    if (homeward.length !== 1) {
      throw new ValidationError("Home fee quote must forward exactly one message to Asset Hub.");
    }
    const exactHome = homeward[0];
    const quotedArrival = extractArrivingFungibleAmount(assetHub, exactHome.message);
    if (quotedArrival !== computedArrival) {
      throw new ValidationError(
        "Hydration quoted arrival does not reconcile to gross amount minus the fresh upstream fee."
      );
    }

    const assetHubWeight = await assetHub.call.xcmPaymentApi.queryXcmWeight(exactHome.message);
    if (!assetHubWeight?.isOk) {
      throw new ValidationError("Asset Hub could not weigh the exact forwarded home message.");
    }
    const assetHubFeeAssetId = extractBuyExecutionFeeAssetId(exactHome.message);
    const assetHubFee = await assetHub.call.xcmPaymentApi.queryWeightToAssetFee(
      assetHubWeight.asOk,
      { V5: assetHubFeeAssetId }
    );
    if (!assetHubFee?.isOk) {
      throw new ValidationError("Asset Hub could not quote the exact forwarded home execution.");
    }
    const homeExecutionFee = positiveBigInt(
      assetHubFee.asOk.toString(),
      "Asset Hub home execution fee"
    );
    return {
      liveState: true,
      amount: homeExecutionFee.toString(),
      quotedArrival: quotedArrival.toString(),
      upstreamFee: upstreamFee.toString(),
      grossAmount: grossAmount.toString(),
      asOf: timestampSeconds(assetHubTimestamp),
      remoteRef: assetHubHeader.hash.toHex(),
      quoteSession: {
        hydration: {
          asOf: timestampSeconds(hydrationTimestamp),
          blockNumber: hydrationHeader.number.toNumber(),
          blockHash: hydrationHeader.hash.toHex(),
          endpoint: this.hydrationSubstrateEndpoint,
          upstreamFeeRaw: upstreamFee.toString(),
          quotedArrivalRaw: quotedArrival.toString(),
        },
        assetHub: {
          asOf: timestampSeconds(assetHubTimestamp),
          blockNumber: assetHubHeader.number.toNumber(),
          blockHash: assetHubHeader.hash.toHex(),
          endpoint: this.assetHubSubstrateEndpoint,
          homeExecutionQuoteRaw: homeExecutionFee.toString(),
        },
      },
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
    const encoded = this.encodeDispatch(requestId, 0, 0n);
    const assetHub = await this.getAssetHubApi();
    const hydration = await this.getHydrationApi();
    const operatorAccount = (await assetHub.call.reviveApi.accountId(
      await this.gateway.signer.getAddress()
    )).toHex();
    const runtimeCall = assetHub.tx.revive.call(
      this.wrapperAddress,
      0n,
      HIGH_WEIGHT,
      HIGH_STORAGE_DEPOSIT,
      encoded
    );
    const [assetHubHeader, assetHubTimestamp, assetHubDryRun] = await Promise.all([
      assetHub.rpc.chain.getHeader(),
      assetHub.query.timestamp.now(),
      assetHub.call.dryRunApi.dryRunCall({ system: { signed: operatorAccount } }, runtimeCall, 5),
    ]);
    const hubJson = assetHubDryRun.toJSON();
    assertDryRunCallComplete(hubJson, "Asset Hub funding wrapper call");
    const forwarded = extractForwardedXcms(hubJson).filter((entry) => entry.paraId === HYDRATION_PARA_ID);
    if (forwarded.length !== 1) {
      throw new ValidationError("Funding dry-run must forward exactly one message to Hydration.");
    }
    const exact = forwarded[0];
    const [hydrationHeader, hydrationTimestamp, deliveryFees, weight] = await Promise.all([
      hydration.rpc.chain.getHeader(),
      hydration.query.timestamp.now(),
      assetHub.call.xcmPaymentApi.queryDeliveryFees(
        exact.destination,
        exact.message,
        NATIVE_DOT_DELIVERY_ASSET
      ),
      hydration.call.xcmPaymentApi.queryXcmWeight(exact.message),
    ]);
    if (!deliveryFees?.isOk) {
      throw new ValidationError("Asset Hub could not quote the exact forwarded message in native DOT.");
    }
    const nativeDeliveryFeePlanck = extractNativeDotDeliveryFee(
      deliveryFees.asOk?.toJSON?.() ?? deliveryFees.asOk
    );
    assertNativeDeliveryFeePlausible(nativeDeliveryFeePlanck);
    if (!weight?.isOk) {
      throw new ValidationError("Hydration could not weigh the exact forwarded funding message.");
    }
    const remoteFeeAssetId = extractBuyExecutionFeeAssetId(exact.message);
    const remoteFee = await hydration.call.xcmPaymentApi.queryWeightToAssetFee(
      weight.asOk,
      { V5: remoteFeeAssetId }
    );
    if (!remoteFee?.isOk) {
      throw new ValidationError("Hydration could not quote funding execution in the transferred USDC asset.");
    }
    const fundingTransferFeeHeadroomRaw = BigInt(remoteFee.asOk.toString());
    if (fundingTransferFeeHeadroomRaw <= 0n) {
      throw new ValidationError("Hydration funding execution fee must be positive USDC raw units.");
    }
    return {
      liveState: true,
      // This is deliberately USDC-denominated staging headroom. The native
      // delivery quote is a separate liveness/plausibility datum below.
      amount: fundingTransferFeeHeadroomRaw.toString(),
      asOf: timestampSeconds(hydrationTimestamp),
      remoteRef: hydrationHeader.hash.toHex(),
      blockNumber: hydrationHeader.number.toNumber(),
      endpoint: this.hydrationSubstrateEndpoint,
      nativeDeliveryFeePlanck: nativeDeliveryFeePlanck.toString(),
      nativeDeliveryFeeAsset: "DOT",
      nativeDeliveryFeeLocation: "parents=1/interior=Here",
      deliveryAsOf: timestampSeconds(assetHubTimestamp),
      deliveryRef: assetHubHeader.hash.toHex(),
      deliveryBlockNumber: assetHubHeader.number.toNumber(),
      deliveryEndpoint: this.assetHubSubstrateEndpoint,
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
    const wireFrames = [];
    const fundingDeposits = [];
    const homeDeposits = [];

    for (const item of forwarded.filter((entry) => entry.paraId === HYDRATION_PARA_ID)) {
      const rawWrapperMessage = assetHub.createType("XcmVersionedXcm", preview.message).toHex();
      const forwardedWireMessage = assetHub.createType("XcmVersionedXcm", item.message).toHex();
      const wireFrame = resolveForwardedWireFrame({
        leg,
        rawWrapperMessage,
        forwardedWireMessage,
        wrapperAddress: this.wrapperAddress,
      });
      const wireMessage = wireFrame.composedOnWireMessage;
      const hydrationDryRun = await hydration.call.dryRunApi.dryRunXcm(
        siblingOrigin(ASSET_HUB_PARA_ID),
        wireMessage
      );
      const hydrationJson = hydrationDryRun.toJSON();
      assertDryRunXcmComplete(hydrationJson, "Hydration exact message");
      const hydrationEvents = normalizeRuntimeEvents(hydrationDryRun.toHuman());
      events.push(...hydrationEvents);
      if (Number(leg) === 0) {
        fundingDeposits.push(assertConvertedAccountDeposit(
          hydration,
          hydrationEvents,
          this.floatTarget.account
        ));
      }
      if (Number(leg) === 3) {
        assertConvertedAccountWithdrawal(
          hydration,
          hydrationEvents,
          this.floatTarget.account,
          "Hydration withdraw-home exact message"
        );
      }
      const homeward = extractForwardedXcms(hydrationJson);
      if (Number(leg) === 3 && homeward.filter((entry) => entry.paraId === ASSET_HUB_PARA_ID).length !== 1) {
        throw new ValidationError("Withdraw-home dry-run must forward exactly one message to Asset Hub.");
      }
      forwardedParaIds.push(...homeward.map((entry) => entry.paraId).filter(Number.isInteger));
      wireFrames.push({
        origin: siblingOrigin(ASSET_HUB_PARA_ID),
        ...wireFrame,
      });
      for (const home of homeward.filter((entry) => entry.paraId === ASSET_HUB_PARA_ID)) {
        const homeDryRun = await assetHub.call.dryRunApi.dryRunXcm(
          siblingOrigin(HYDRATION_PARA_ID),
          home.message
        );
        assertDryRunXcmComplete(homeDryRun.toJSON(), "Asset Hub home message");
        const homeEvents = normalizeRuntimeEvents(homeDryRun.toHuman());
        events.push(...homeEvents);
        homeDeposits.push(assertAssetHubHomeDeposit(assetHub, homeEvents, this.wrapperAddress));
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
      wireFrames,
      fundingDeposits,
      homeDeposits,
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

function positiveInteger(raw, label) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive integer.`);
  }
  return value;
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * Compose the transport frame Asset Hub puts on the wire for a contract-origin
 * XCM send. `polkadotXcm.Sent` records the contract image as a separate origin
 * and the wrapper-built payload without the prefix; Hydration receives the
 * V5 payload with DescendOrigin prepended. Keep this byte-level and pure so a
 * live Sent vector can pin the exact framing independently of runtime codecs.
 */
export function composeOnWire(rawWrapperMessage, wrapperAddress) {
  const raw = getBytes(rawWrapperMessage);
  if (raw.length < 3 || raw[0] !== 5) {
    throw new ValidationError("Bank XCM wire composition requires a non-empty V5 message.");
  }
  const compactCount = raw[1];
  if ((compactCount & 0x03) !== 0) {
    throw new ValidationError("Bank XCM wire composition requires a canonical one-byte instruction count.");
  }
  const instructionCount = compactCount >>> 2;
  if (instructionCount <= 0 || instructionCount >= 63) {
    throw new ValidationError("Bank XCM wire composition instruction count is outside the supported V5 range.");
  }
  if (raw[2] === 0x0b) {
    throw new ValidationError("Bank XCM wire message is already framed with DescendOrigin.");
  }
  const wrapper = getBytes(getAddress(wrapperAddress));
  const accountId32 = new Uint8Array(32);
  accountId32.set(wrapper);
  accountId32.fill(0xee, wrapper.length);
  const descendOrigin = Uint8Array.from([
    0x0b, // Instruction::DescendOrigin
    0x01, // Junctions::X1
    0x01, // Junction::AccountId32
    0x01, // Some(NetworkId)
    0x02, // NetworkId::Polkadot
    ...accountId32,
  ]);
  return hexlify(Uint8Array.from([
    0x05,
    (instructionCount + 1) << 2,
    ...descendOrigin,
    ...raw.slice(2),
  ]));
}

/**
 * Bind the wrapper preview to the message Asset Hub says it will put on the
 * wire. DryRunApi.dryRun_call reports forwarded_xcms after transport framing,
 * so framing that value again would create a second DescendOrigin. Recompute
 * the expected frame from the contract preview, require byte equality, and
 * simulate the runtime-returned wire bytes unchanged.
 */
export function bindForwardedWireFrame(rawWrapperMessage, forwardedWireMessage, wrapperAddress) {
  const raw = hexlify(getBytes(rawWrapperMessage));
  const forwarded = hexlify(getBytes(forwardedWireMessage));
  const expected = composeOnWire(raw, wrapperAddress);
  if (forwarded.toLowerCase() !== expected.toLowerCase()) {
    throw new ValidationError("Bank XCM forwarded wire message does not match the wrapper preview frame.");
  }
  return {
    rawWrapperMessage: raw,
    composedOnWireMessage: forwarded,
  };
}

/**
 * DepositFunding executes DepositReserveAsset locally. Asset Hub's executor
 * constructs the forwarded reserve message, so the runtime-returned bytes are
 * the wire truth and are consumed unchanged. The other three legs call
 * IXcm.send; only those verbatim-send paths are bound to DescendOrigin + the
 * wrapper preview by the live find-16/17 transport proof.
 */
export function resolveForwardedWireFrame({
  leg,
  rawWrapperMessage,
  forwardedWireMessage,
  wrapperAddress,
} = {}) {
  const legIndex = Number(leg);
  if (!Number.isInteger(legIndex) || legIndex < 0 || legIndex > 3) {
    throw new ValidationError("Bank XCM wire-frame resolution requires a v2.2 leg index.");
  }
  if (legIndex === 0) {
    return {
      rawWrapperMessage: hexlify(getBytes(rawWrapperMessage)),
      composedOnWireMessage: hexlify(getBytes(forwardedWireMessage)),
      frameSource: "runtime_transformed_local_execute",
    };
  }
  return {
    ...bindForwardedWireFrame(rawWrapperMessage, forwardedWireMessage, wrapperAddress),
    frameSource: "composed_send_frame",
  };
}

export function assertConvertedAccountDeposit(api, events, expectedAccountId32) {
  const expected = String(expectedAccountId32).toLowerCase();
  for (const event of events) {
    if (String(event.section).toLowerCase() !== "tokens"
      || String(event.method).toLowerCase() !== "deposited") continue;
    const assetId = Number(String(event?.data?.currencyId ?? event?.data?.assetId ?? "").replaceAll(",", ""));
    const who = event?.data?.who;
    const amount = String(event?.data?.amount ?? event?.data?.balance ?? "").replaceAll(",", "");
    if (assetId !== 22 || !who || !/^\d+$/u.test(amount) || BigInt(amount) <= 0n) continue;
    try {
      if (api.createType("AccountId32", who).toHex().toLowerCase() !== expected) continue;
    } catch {
      continue;
    }
    return { assetId, who, amountRaw: amount };
  }
  throw new ValidationError("Hydration funding dry-run did not deposit asset 22 to the configured converted account.");
}

function assertConvertedAccountWithdrawal(api, events, expectedAccountId32, label) {
  const expected = String(expectedAccountId32).toLowerCase();
  const matched = events.some((event) => {
    if (!/^(tokens|currencies)$/iu.test(String(event.section)) || !/^withdrawn$/iu.test(String(event.method))) return false;
    const who = event?.data?.who;
    if (!who) return false;
    try {
      return api.createType("AccountId32", who).toHex().toLowerCase() === expected;
    } catch {
      return false;
    }
  });
  if (!matched) {
    throw new ValidationError(`${label} did not withdraw from the configured converted account.`);
  }
}

function assertAssetHubHomeDeposit(api, events, wrapperAddress) {
  const expectedAccount = `${getAddress(wrapperAddress).toLowerCase()}${"ee".repeat(12)}`;
  for (const event of events) {
    if (String(event.section).toLowerCase() !== "assets" || String(event.method).toLowerCase() !== "deposited") continue;
    const assetId = Number(String(event?.data?.assetId ?? event?.data?.id ?? "").replaceAll(",", ""));
    const who = event?.data?.who;
    const amount = String(event?.data?.amount ?? event?.data?.balance ?? "").replaceAll(",", "");
    if (assetId !== 1337 || !who || !/^\d+$/u.test(amount)) continue;
    try {
      if (api.createType("AccountId32", who).toHex().toLowerCase() !== expectedAccount) continue;
    } catch {
      continue;
    }
    return { assetId, who, amountRaw: amount };
  }
  throw new ValidationError("Asset Hub home dry-run did not deposit asset 1337 to the wrapper image.");
}

function extractForwardedXcms(json = {}) {
  const groups = json?.ok?.forwardedXcms ?? json?.Ok?.forwardedXcms ?? [];
  const output = [];
  for (const [destination, messages] of groups) {
    const paraId = Number(
      destination?.v5?.interior?.x1?.[0]?.parachain
      ?? destination?.V5?.interior?.X1?.[0]?.Parachain
    );
    for (const message of messages ?? []) output.push({ paraId, destination, message });
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

function extractWithdrawFungibleAmount(api, message) {
  const decoded = api.createType("XcmVersionedXcm", message).toJSON();
  const instructions = decoded?.v5 ?? decoded?.V5;
  const withdraw = instructions?.find((instruction) => instruction.withdrawAsset ?? instruction.WithdrawAsset);
  const assets = withdraw?.withdrawAsset ?? withdraw?.WithdrawAsset;
  return extractFungibleAmount(assets, "WithdrawAsset");
}

function extractArrivingFungibleAmount(api, message) {
  const decoded = api.createType("XcmVersionedXcm", message).toJSON();
  const instructions = decoded?.v5 ?? decoded?.V5;
  const arrival = instructions?.find((instruction) => (
    instruction.reserveAssetDeposited
    ?? instruction.ReserveAssetDeposited
    ?? instruction.receiveTeleportedAsset
    ?? instruction.ReceiveTeleportedAsset
    ?? instruction.withdrawAsset
    ?? instruction.WithdrawAsset
  ));
  const assets = arrival?.reserveAssetDeposited
    ?? arrival?.ReserveAssetDeposited
    ?? arrival?.receiveTeleportedAsset
    ?? arrival?.ReceiveTeleportedAsset
    ?? arrival?.withdrawAsset
    ?? arrival?.WithdrawAsset;
  return extractFungibleAmount(assets, "reserve arrival");
}

function extractFungibleAmount(assets, label) {
  const raw = assets?.[0]?.fun?.fungible ?? assets?.[0]?.fun?.Fungible;
  if (!/^\d+$/u.test(String(raw))) {
    throw new ValidationError(`Exact Bank XCM message has no fungible ${label} amount.`);
  }
  const amount = BigInt(raw);
  if (amount <= 0n) throw new ValidationError(`Exact Bank XCM ${label} amount must be positive.`);
  return amount;
}

function positiveBigInt(raw, label) {
  try {
    const value = BigInt(raw);
    if (value <= 0n) throw new Error();
    return value;
  } catch {
    throw new ValidationError(`${label} must be a positive integer.`);
  }
}

function extractNativeDotDeliveryFee(raw) {
  const assets = raw?.v5 ?? raw?.V5;
  if (!Array.isArray(assets) || assets.length !== 1) {
    throw new ValidationError("Native delivery quote must contain exactly one DOT asset.");
  }
  const asset = assets[0];
  const id = asset?.id;
  const interior = id?.interior;
  const isHere = interior === "Here"
    || interior?.here === null
    || interior?.Here === null;
  const fungible = asset?.fun?.fungible ?? asset?.fun?.Fungible;
  if (Number(id?.parents) !== 1 || !isHere || !/^\d+$/u.test(String(fungible))) {
    throw new ValidationError("Native delivery quote did not return relay-chain DOT (parents=1, Here).");
  }
  const amount = BigInt(fungible);
  if (amount <= 0n) throw new ValidationError("Native DOT delivery fee must be positive.");
  return amount;
}

function assertNativeDeliveryFeePlausible(amount) {
  if (amount < MIN_NATIVE_DELIVERY_FEE_PLANCK || amount > MAX_NATIVE_DELIVERY_FEE_PLANCK) {
    throw new ValidationError(
      `Native DOT delivery fee ${amount} Planck is outside the 0.002-0.15 DOT plausibility band.`
    );
  }
}

function extractBuyExecutionFeeAssetId(message) {
  const instructions = message?.v5 ?? message?.V5;
  const buy = instructions?.find((instruction) => instruction.buyExecution ?? instruction.BuyExecution);
  const fees = buy?.buyExecution?.fees ?? buy?.BuyExecution?.fees ?? buy?.BuyExecution?.Fees;
  const id = fees?.id ?? fees?.Id;
  if (!id) throw new ValidationError("Forwarded funding message has no BuyExecution fee asset.");
  return id;
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
