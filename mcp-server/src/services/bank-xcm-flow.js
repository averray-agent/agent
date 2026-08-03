import { ValidationError } from "../core/errors.js";

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

    const watch = await this.balanceObserver.register({
      requestId,
      ...observation,
      kind: intent?.kind,
      phase: "registered"
    });
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
