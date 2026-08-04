import { ValidationError } from "../core/errors.js";

const V22_LEGS = Object.freeze({
  deposit_funding: 0,
  deposit_sell: 1,
  withdraw_sell: 2,
  withdraw_home: 3
});

/**
 * Bank v2.2's only operator-signing seam.
 *
 * Every input that can perish or drift is obtained inside dispatch(): live
 * request state, remote fee/float, exact-message dry-run, ReviveApi_call
 * measurement, EVM gas estimate, and the chain-event-created observer watch.
 * Callers cannot supply remembered limits or fee figures.
 */
export class BankXcmV22Dispatcher {
  constructor({
    enabled = false,
    expectedWrapper,
    readLiveRequest,
    quoteRemoteFee,
    readRemoteOperatingFloat,
    readFundingTransferFee,
    dryRunMessage,
    simulateReviveCall,
    estimateGas,
    requireArmedWatch,
    recordRemoteOperatingFloat,
    signAndDispatch,
    eventBus = undefined,
    now = () => Date.now()
  } = {}) {
    this.enabled = enabled;
    this.expectedWrapper = normalizeAddress(expectedWrapper, "expectedWrapper");
    this.readLiveRequest = requireCallback(readLiveRequest, "readLiveRequest");
    this.quoteRemoteFee = requireCallback(quoteRemoteFee, "quoteRemoteFee");
    this.readRemoteOperatingFloat = requireCallback(readRemoteOperatingFloat, "readRemoteOperatingFloat");
    this.readFundingTransferFee = requireCallback(readFundingTransferFee, "readFundingTransferFee");
    this.dryRunMessage = requireCallback(dryRunMessage, "dryRunMessage");
    this.simulateReviveCall = requireCallback(simulateReviveCall, "simulateReviveCall");
    this.estimateGas = requireCallback(estimateGas, "estimateGas");
    this.requireArmedWatch = requireCallback(requireArmedWatch, "requireArmedWatch");
    this.recordRemoteOperatingFloat = requireCallback(recordRemoteOperatingFloat, "recordRemoteOperatingFloat");
    this.signAndDispatch = requireCallback(signAndDispatch, "signAndDispatch");
    this.eventBus = eventBus;
    this.now = now;
  }

  async dispatch({ requestId, leg } = {}) {
    if (!this.enabled) throw new ValidationError("Bank v2.2 dispatcher is disabled.");
    const legIndex = normalizeV22Leg(leg);
    const capturedAt = new Date(this.now()).toISOString();
    const live = normalizeLiveRequest(await this.readLiveRequest({ requestId, wrapper: this.expectedWrapper }));
    assertDispatchable(live, { requestId, legIndex, expectedWrapper: this.expectedWrapper });

    const feeEvidence = await this.resolveFee({ requestId, leg, legIndex, live });
    const fundingTransferFeeHeadroomRaw = await this.assertStagingMargin({ requestId, legIndex, live });
    const preview = await this.dryRunMessage({
      requestId,
      leg: legIndex,
      feeAmount: feeEvidence.feeAmount,
      wrapper: this.expectedWrapper
    });
    if (preview?.liveState !== true) {
      throw new ValidationError("Exact-message dry-run is not marked liveState:true; refusing fork-derived evidence.");
    }
    assertDryRunEvidence(preview, expectedV22DryRun(legIndex));

    const simulation = await this.simulateReviveCall({
      requestId,
      leg: legIndex,
      feeAmount: feeEvidence.feeAmount,
      wrapper: this.expectedWrapper,
      calldata: preview.calldata
    });
    if (simulation?.liveState !== true || simulation?.success !== true) {
      throw new ValidationError("Live ReviveApi_call did not succeed; refusing to sign.");
    }
    const weightLimit = doubleWeight(simulation.weightUsed);
    const storageDepositLimit = nonNegativeBigInt(simulation.storageDepositUsed, "storageDepositUsed") * 2n;

    const gasEstimate = positiveBigInt(await this.estimateGas({
      requestId,
      leg: legIndex,
      feeAmount: feeEvidence.feeAmount,
      wrapper: this.expectedWrapper,
      calldata: preview.calldata
    }), "eth_estimateGas");
    const gasLimit = gasEstimate * 2n;
    const watch = await this.requireArmedWatch(requestId, { wrapperAddress: this.expectedWrapper });

    let floatReceipt;
    if (legIndex === V22_LEGS.withdraw_sell) {
      floatReceipt = await this.recordRemoteOperatingFloat({
        assets: feeEvidence.feeAmount,
        asOf: feeEvidence.remoteAsOf,
        remoteRef: feeEvidence.remoteRef,
        requestId
      });
      if (!receiptSucceeded(floatReceipt)) {
        throw new ValidationError("Remote operating-float evidence did not confirm; refusing withdraw sell.");
      }
    }

    // The evidence write above is itself a state transition. Re-read every
    // dispatch-binding field immediately before signing.
    const finalLive = normalizeLiveRequest(await this.readLiveRequest({ requestId, wrapper: this.expectedWrapper }));
    assertDispatchable(finalLive, { requestId, legIndex, expectedWrapper: this.expectedWrapper });
    assertSameDispatchPlan(live, finalLive);

    const result = await this.signAndDispatch({
      requestId,
      leg: legIndex,
      feeAmount: feeEvidence.feeAmount,
      wrapper: this.expectedWrapper,
      calldata: preview.calldata,
      weightLimit,
      storageDepositLimit,
      gasLimit
    });
    if (!receiptSucceeded(result) || result?.gasUsed === undefined) {
      throw new ValidationError("Bank v2.2 dispatch receipt is unsuccessful or missing gasUsed.");
    }
    if (BigInt(result.gasUsed) > gasLimit) {
      throw new ValidationError("Bank v2.2 dispatch gasUsed exceeds the authorized gas limit.");
    }

    const evidence = {
      version: "bank-xcm-v2.2-dispatch/v1",
      liveState: true,
      capturedAt,
      requestId,
      wrapper: this.expectedWrapper,
      leg,
      legIndex,
      feeAmount: feeEvidence.feeAmount.toString(),
      feeSource: feeEvidence.feeSource,
      remoteAsOf: feeEvidence.remoteAsOf,
      remoteRef: feeEvidence.remoteRef,
      fundingTransferFeeHeadroomRaw: fundingTransferFeeHeadroomRaw?.toString(),
      observerWatch: summarizeWatch(watch),
      dryRun: preview,
      revive: {
        weightUsed: stringifyWeight(simulation.weightUsed),
        weightLimit: stringifyWeight(weightLimit),
        storageDepositUsed: String(simulation.storageDepositUsed),
        storageDepositLimit: storageDepositLimit.toString()
      },
      evm: {
        gasEstimate: gasEstimate.toString(),
        gasLimit: gasLimit.toString(),
        gasUsed: String(result.gasUsed)
      },
      txHash: result.txHash ?? result.hash,
      blockNumber: result.blockNumber
    };
    this.publish("bank.v22_leg_dispatched", requestId, evidence);
    return { result, evidence };
  }

  async resolveFee({ requestId, legIndex, live }) {
    const maximum = positiveBigInt(live.parameters.maxFeePerLeg, "maxFeePerLeg");
    if (legIndex === V22_LEGS.deposit_sell) {
      const quoteEvidence = normalizeLiveAmount(
        await this.quoteRemoteFee({ requestId, leg: legIndex }),
        "remoteFeeQuote"
      );
      const quote = positiveBigInt(quoteEvidence.amount, "remoteFeeQuote");
      const feeAmount = quote * 2n;
      assertAtMost(feeAmount, maximum, "fresh remote fee ×2 exceeds staged maxFeePerLeg");
      return {
        feeAmount,
        feeSource: "fresh_remote_quote_x2",
        remoteAsOf: quoteEvidence.asOf,
        remoteRef: quoteEvidence.remoteRef
      };
    }
    if (legIndex === V22_LEGS.withdraw_sell) {
      const observed = await this.readRemoteOperatingFloat({ requestId });
      if (observed?.liveState !== true) {
        throw new ValidationError("Remote operating-float read is not marked liveState:true.");
      }
      const feeAmount = positiveBigInt(observed.assets, "remoteOperatingFloat");
      assertAtMost(feeAmount, maximum, "fresh remote operating float exceeds staged maxFeePerLeg");
      if (!observed.asOf || !observed.remoteRef) {
        throw new ValidationError("Remote operating-float evidence requires asOf and remoteRef.");
      }
      return {
        feeAmount,
        feeSource: "fresh_remote_operating_float",
        remoteAsOf: observed.asOf,
        remoteRef: observed.remoteRef
      };
    }
    return { feeAmount: 0n, feeSource: "dispatch_independent" };
  }

  async assertStagingMargin({ requestId, legIndex, live }) {
    if (live.kind !== "deposit") return undefined;
    const headroomEvidence = normalizeLiveAmount(
      await this.readFundingTransferFee({ requestId, leg: legIndex }),
      "fundingTransferFeeHeadroomRaw"
    );
    const headroom = nonNegativeBigInt(headroomEvidence.amount, "fundingTransferFeeHeadroomRaw");
    const required = BigInt(live.parameters.sellAmount) + BigInt(live.parameters.maxFeePerLeg) + headroom;
    if (BigInt(live.assets) < required) {
      throw new ValidationError(
        `Deposit staging margin is insufficient: assets must cover sellAmount + maxFeePerLeg + funding transfer fee headroom (${headroom}).`
      );
    }
    return headroom;
  }

  publish(topic, requestId, data) {
    this.eventBus?.publish?.({
      id: `${topic}-${requestId}-${this.now()}`,
      topic,
      correlationId: requestId,
      timestamp: new Date(this.now()).toISOString(),
      data
    });
  }
}

/**
 * The only path allowed to cross from a prepared bank message to a signing
 * callback. A caller cannot obtain `dispatch` without first presenting a
 * successful dry-run whose emitted/forwarded evidence satisfies the leg's
 * declared expectation.
 */
export class XcmDryRunDispatchGuard {
  constructor({ dryRun, eventBus = undefined, now = () => Date.now() } = {}) {
    if (typeof dryRun !== "function") throw new ValidationError("bank XCM dryRun callback is required.");
    this.dryRun = dryRun;
    this.eventBus = eventBus;
    this.now = now;
  }

  async dispatch({ requestId, leg, payload, expected }, signAndDispatch) {
    if (typeof signAndDispatch !== "function") {
      throw new ValidationError("bank XCM signing callback is required.");
    }
    const evidence = await this.dryRun({ requestId, leg, payload });
    assertDryRunEvidence(evidence, expected);
    this.publish("bank.xcm_dry_run_passed", requestId, leg, evidence);
    const result = await signAndDispatch(payload, evidence);
    this.publish("bank.xcm_message_dispatched", requestId, leg, {
      txHash: result?.txHash ?? result?.hash,
      blockNumber: result?.blockNumber
    });
    return { evidence, result };
  }

  publish(topic, requestId, leg, data) {
    this.eventBus?.publish?.({
      id: `${topic}-${requestId}-${leg}-${this.now()}`,
      topic,
      correlationId: requestId,
      timestamp: new Date(this.now()).toISOString(),
      data: { requestId, leg, ...data }
    });
  }
}

/**
 * Trusted backend orchestration for one two-message bank request.
 *
 * Message 1 is queued through the existing AgentAccountCore → adapter →
 * XcmWrapper path. Message 2 is a backend-signer follow-up. Each signature is
 * separately gated on the exact message's dry-run; a failure leaves the
 * already-queued request Pending until the balance observer records Failed.
 */
export class BankXcmFlowCoordinator {
  constructor({
    enabled = false,
    hasWrapper = () => false,
    balanceObserver,
    dryRunGuard,
    eventBus = undefined,
    now = () => Date.now()
  } = {}) {
    this.enabled = enabled;
    this.hasWrapper = hasWrapper;
    this.balanceObserver = balanceObserver;
    this.dryRunGuard = dryRunGuard;
    this.eventBus = eventBus;
    this.now = now;
  }

  isAvailable() {
    return this.enabled && this.hasWrapper() === true;
  }

  async execute({
    requestId,
    intent,
    messages,
    observation,
    queueRequest,
    dispatchFollowUp,
    waitForFollowUpReady = undefined
  } = {}) {
    if (!this.isAvailable()) {
      throw new ValidationError(
        "Bank XCM flow is unavailable until BANK_XCM_FLOW_ENABLED=1 and XCM_WRAPPER_ADDRESS is configured."
      );
    }
    if (!Array.isArray(messages) || messages.length !== 2) {
      throw new ValidationError("Bank XCM flow requires exactly two messages.");
    }
    if (typeof queueRequest !== "function" || typeof dispatchFollowUp !== "function") {
      throw new ValidationError("Bank XCM flow requires queue and follow-up dispatch callbacks.");
    }

    const watch = await this.balanceObserver.requireArmedWatch(requestId);
    this.publish("bank.allocation_intent_recorded", requestId, {
      intent,
      watch: summarizeWatch(watch)
    });

    const first = await this.dryRunGuard.dispatch(
      { requestId, leg: messages[0].label ?? "message_1", payload: messages[0].payload, expected: messages[0].expected },
      (payload, evidence) => queueRequest({ requestId, intent, payload, evidence })
    );
    await this.balanceObserver.setRequestPhase?.(requestId, "leg1-dispatched");

    if (typeof waitForFollowUpReady === "function") {
      await waitForFollowUpReady({ requestId, intent, first, watch });
    }

    const second = await this.dryRunGuard.dispatch(
      { requestId, leg: messages[1].label ?? "message_2", payload: messages[1].payload, expected: messages[1].expected },
      (payload, evidence) => dispatchFollowUp({ requestId, intent, payload, evidence })
    );
    await this.balanceObserver.setRequestPhase?.(requestId, "leg2-dispatched");

    this.publish("bank.xcm_two_message_dispatch_complete", requestId, {
      intent,
      firstTxHash: first.result?.txHash ?? first.result?.hash,
      secondTxHash: second.result?.txHash ?? second.result?.hash
    });
    return { requestId, status: "pending_observation", watch, first, second };
  }

  publish(topic, requestId, data) {
    this.eventBus?.publish?.({
      id: `${topic}-${requestId}-${this.now()}`,
      topic,
      correlationId: requestId,
      timestamp: new Date(this.now()).toISOString(),
      data: { requestId, ...data }
    });
  }
}

export function assertDryRunEvidence(evidence = {}, expected = {}) {
  if (evidence.ok !== true || evidence.executionSucceeded !== true) {
    throw new ValidationError("Exact XCM dry-run did not complete successfully; refusing to sign.");
  }
  if (expected.forwardedParaId !== undefined) {
    const destinations = (evidence.forwardedParaIds ?? []).map(Number);
    if (!destinations.includes(Number(expected.forwardedParaId))) {
      throw new ValidationError(
        `Exact XCM dry-run did not forward a message to Sibling(${expected.forwardedParaId}); refusing to sign.`
      );
    }
  }
  if (expected.event) {
    const match = (evidence.events ?? []).some((event) => eventMatches(event, expected.event));
    if (!match) {
      const label = [expected.event.section, expected.event.method].filter(Boolean).join(".");
      throw new ValidationError(`Exact XCM dry-run did not emit expected ${label || "event"}; refusing to sign.`);
    }
  }
  return true;
}

function eventMatches(event = {}, expected = {}) {
  if (expected.section && String(event.section).toLowerCase() !== String(expected.section).toLowerCase()) return false;
  if (expected.method && String(event.method).toLowerCase() !== String(expected.method).toLowerCase()) return false;
  for (const [key, value] of Object.entries(expected.fields ?? {})) {
    if (String(event.data?.[key] ?? "").toLowerCase() !== String(value).toLowerCase()) return false;
  }
  return true;
}

function summarizeWatch(watch) {
  return {
    requestId: watch.requestId,
    target: watch.target,
    direction: watch.direction,
    baselineRaw: watch.baselineRaw,
    deadlineAt: watch.deadlineAt
  };
}

function requireCallback(value, label) {
  if (typeof value !== "function") throw new ValidationError(`Bank v2.2 ${label} callback is required.`);
  return value;
}

function normalizeV22Leg(raw) {
  const key = String(raw ?? "").trim().toLowerCase();
  if (!(key in V22_LEGS)) throw new ValidationError(`Unsupported Bank v2.2 leg: ${raw}.`);
  return V22_LEGS[key];
}

function expectedV22DryRun(legIndex) {
  if (legIndex === V22_LEGS.deposit_funding) {
    return {
      forwardedParaId: 2034,
      event: { section: "Tokens", method: "Deposited" }
    };
  }
  if (legIndex === V22_LEGS.deposit_sell) {
    return {
      event: {
        section: "Broadcast",
        method: "Swapped",
        fields: { fillerType: "AAVE", assetIn: 22, assetOut: 1003 }
      }
    };
  }
  if (legIndex === V22_LEGS.withdraw_sell) {
    return {
      event: {
        section: "Broadcast",
        method: "Swapped",
        fields: { fillerType: "AAVE", assetIn: 1003, assetOut: 22 }
      }
    };
  }
  return {
    forwardedParaId: 1000,
    event: { section: "Assets", method: "Deposited" }
  };
}

function normalizeAddress(raw, label) {
  const value = String(raw ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/u.test(value)) throw new ValidationError(`${label} must be an EVM address.`);
  return value;
}

function normalizeLiveRequest(raw = {}) {
  const parameters = raw.parameters ?? {};
  const kind = normalizeLiveRequestKind(raw.kind);
  return {
    ...raw,
    wrapper: normalizeAddress(raw.wrapper, "live wrapper"),
    requestId: String(raw.requestId ?? "").toLowerCase(),
    kind,
    status: Number(raw.status) === 1
      ? "pending"
      : String(raw.statusLabel ?? raw.status ?? "").toLowerCase(),
    dispatchPaused: Boolean(raw.dispatchPaused),
    operatorMatches: raw.operatorMatches === true,
    bitmap: Number(raw.bitmap ?? 0),
    assets: nonNegativeBigInt(raw.assets ?? raw.requestedAssetsRaw, "request.assets").toString(),
    parameters: {
      sellAmount: nonNegativeBigInt(parameters.sellAmount, "sellAmount").toString(),
      minimumOutput: nonNegativeBigInt(parameters.minimumOutput, "minimumOutput").toString(),
      maxFeePerLeg: positiveBigInt(parameters.maxFeePerLeg, "maxFeePerLeg").toString(),
      dispatchDeadline: nonNegativeBigInt(parameters.dispatchDeadline ?? 0, "dispatchDeadline").toString()
    }
  };
}

function normalizeLiveRequestKind(raw) {
  if (Number(raw) === 0 || String(raw).toLowerCase() === "deposit") return "deposit";
  if (Number(raw) === 1 || String(raw).toLowerCase() === "withdraw") return "withdraw";
  throw new ValidationError("Live request kind must be Deposit(0) or Withdraw(1).");
}

function assertDispatchable(live, { requestId, legIndex, expectedWrapper }) {
  if (live.liveState !== true) {
    throw new ValidationError("Request/config capture is not marked liveState:true.");
  }
  if (live.wrapper !== expectedWrapper || live.requestId !== String(requestId).toLowerCase()) {
    throw new ValidationError("Live request identity does not match the requested wrapper/requestId.");
  }
  if (live.status !== "pending" || live.dispatchPaused || !live.operatorMatches) {
    throw new ValidationError("Live request is not pending, armed, and owned by the current operator.");
  }
  const expectedKind = legIndex < 2 ? "deposit" : "withdraw";
  if (live.kind !== expectedKind) throw new ValidationError(`Dispatch leg does not match ${live.kind} request kind.`);
  if ((live.bitmap & (1 << legIndex)) !== 0) throw new ValidationError("Dispatch leg is already recorded on-chain.");
}

function normalizeLiveAmount(raw, label) {
  if (!raw || raw.liveState !== true) {
    throw new ValidationError(`${label} evidence is not marked liveState:true.`);
  }
  if (!raw.asOf) throw new ValidationError(`${label} evidence requires asOf.`);
  return {
    amount: raw.amount,
    asOf: raw.asOf,
    remoteRef: raw.remoteRef
  };
}

function assertSameDispatchPlan(left, right) {
  const fields = ["wrapper", "requestId", "kind", "status", "dispatchPaused", "operatorMatches", "bitmap", "assets"];
  for (const field of fields) {
    if (left[field] !== right[field]) throw new ValidationError(`Live request ${field} changed before signing.`);
  }
  if (JSON.stringify(left.parameters) !== JSON.stringify(right.parameters)) {
    throw new ValidationError("Live request parameters changed before signing.");
  }
}

function nonNegativeBigInt(raw, label) {
  try {
    const value = BigInt(raw);
    if (value < 0n) throw new Error();
    return value;
  } catch {
    throw new ValidationError(`${label} must be a non-negative integer.`);
  }
}

function positiveBigInt(raw, label) {
  const value = nonNegativeBigInt(raw, label);
  if (value === 0n) throw new ValidationError(`${label} must be positive.`);
  return value;
}

function doublePositive(raw, label) {
  return positiveBigInt(raw, label) * 2n;
}

function doubleWeight(raw = {}) {
  return {
    refTime: doublePositive(raw.refTime, "weightUsed.refTime"),
    proofSize: doublePositive(raw.proofSize, "weightUsed.proofSize")
  };
}

function stringifyWeight(raw) {
  return { refTime: String(raw.refTime), proofSize: String(raw.proofSize) };
}

function assertAtMost(value, maximum, message) {
  if (value > maximum) throw new ValidationError(message);
}

function receiptSucceeded(receipt) {
  return receipt?.status === 1 || receipt?.status === 1n || receipt?.status === true;
}

export { V22_LEGS };
