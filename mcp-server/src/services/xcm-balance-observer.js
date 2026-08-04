import { id } from "ethers";

import { ValidationError } from "../core/errors.js";
import { normalizeVenueBalanceTarget } from "./venue-balance-reader.js";

const REQUEST_ID_RE = /^0x[a-fA-F0-9]{64}$/u;
const FAILURE_BALANCE_TIMEOUT = id("BALANCE_OBSERVATION_TIMEOUT");

/**
 * Converts venue balance deltas into terminal XcmWrapper observations.
 * XCM execution status is deliberately not an input: destination state is
 * the truth boundary.
 */
export class XcmBalanceObserverService {
  constructor(
    stateStore,
    balanceReader,
    terminalSink,
    eventBus = undefined,
    {
      enabled = false,
      pollIntervalMs = 15_000,
      defaultTimeoutMs = 15 * 60_000,
      bankLaneFeed = undefined,
      chainEventWatchConfig = undefined,
      now = () => Date.now(),
      logger = console
    } = {}
  ) {
    this.stateStore = stateStore;
    this.balanceReader = balanceReader;
    this.terminalSink = terminalSink;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.pollIntervalMs = pollIntervalMs;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.bankLaneFeed = bankLaneFeed;
    this.chainEventWatchConfig = chainEventWatchConfig
      ? normalizeChainEventWatchConfig(chainEventWatchConfig)
      : undefined;
    this.now = now;
    this.logger = logger;
    this.running = false;
    this.timer = undefined;
    this.pollPromise = undefined;
    this.unsubscribeChainEvents = undefined;
    this.chainEventTail = Promise.resolve();
    this.chainEventIngestionError = undefined;
  }

  start() {
    if ((!this.enabled && !this.bankLaneFeed?.enabled) || this.running) return;
    this.running = true;
    if (this.enabled && this.chainEventWatchConfig) {
      this.unsubscribeChainEvents = this.eventBus?.subscribe?.(
        { topics: ["xcm.request_queued", "xcm.request_leg_dispatched"] },
        (event) => this.enqueueChainEvent(event)
      );
      if (!this.unsubscribeChainEvents) {
        this.chainEventIngestionError = "xcm_request_event_subscription_unavailable";
        this.logger.error?.({}, "xcm_balance_observer.chain_event_subscription_unavailable");
      }
    }
    void this.schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribeChainEvents?.();
    this.unsubscribeChainEvents = undefined;
  }

  enqueueChainEvent(event) {
    const next = this.chainEventTail.then(async () => {
      return this.ingestChainEvent(event);
    });
    this.chainEventTail = next.catch((error) => {
      this.chainEventIngestionError = error?.message ?? String(error);
      this.logger.error?.(
        { eventId: event?.id, requestId: event?.data?.requestId, error: this.chainEventIngestionError },
        "xcm_balance_observer.chain_event_ingestion_failed"
      );
      this.eventBus?.publish?.({
        id: `xcm-watch-ingestion-failed-${event?.id ?? this.now()}`,
        topic: "xcm.balance_watch_ingestion_failed",
        correlationId: event?.data?.requestId,
        timestamp: new Date(this.now()).toISOString(),
        data: {
          sourceEventId: event?.id,
          requestId: event?.data?.requestId,
          error: this.chainEventIngestionError
        }
      });
    });
    return next;
  }

  async flushChainEventIngestion() {
    await this.chainEventTail;
  }

  async registerFromChainEvent(event = {}) {
    if (!this.chainEventWatchConfig) {
      throw new ValidationError("Chain-event watch configuration is unavailable.");
    }
    if (event.topic !== "xcm.request_queued") {
      throw new ValidationError("Only xcm.request_queued can arm a balance watch.");
    }
    const wrapperAddress = normalizeEvmAddress(event.data?.wrapperAddress, "wrapperAddress");
    if (wrapperAddress !== this.chainEventWatchConfig.expectedWrapper) {
      throw new ValidationError("RequestQueued event came from an unexpected wrapper generation.");
    }
    const kind = Number(event.data?.kind);
    if (kind !== 0 && kind !== 1) throw new ValidationError("RequestQueued kind must be Deposit(0) or Withdraw(1).");
    const plan = this.buildChainEventPlan(kind);
    return this.register({
      requestId: event.data?.requestId,
      target: plan.target,
      direction: "increase",
      settlement: plan.settlement,
      kind: kind === 0 ? "deposit" : "withdraw",
      phase: "staged-on-chain",
      requestedAssetsRaw: event.data?.assetsRaw ?? event.data?.assets ?? 0,
      requestedSharesRaw: event.data?.sharesRaw ?? event.data?.shares ?? 0,
      startedAt: event.timestamp,
      deadlineAt: deadlineFromChainEvent(event),
      registrationSource: "chain_event",
      wrapperAddress,
      sourceEventId: event.id,
      stagingTxHash: event.txHash,
      stagingBlockNumber: event.blockNumber
    });
  }

  async registerBackfillFromChainEvent(event = {}, baseline = {}) {
    if (!this.chainEventWatchConfig) {
      throw new ValidationError("Chain-event watch configuration is unavailable.");
    }
    if (event.topic !== "xcm.request_queued") {
      throw new ValidationError("Only xcm.request_queued can backfill a balance watch.");
    }
    const wrapperAddress = normalizeEvmAddress(event.data?.wrapperAddress, "wrapperAddress");
    if (wrapperAddress !== this.chainEventWatchConfig.expectedWrapper) {
      throw new ValidationError("Backfilled RequestQueued event came from an unexpected wrapper generation.");
    }
    const kind = Number(event.data?.kind);
    if (kind !== 0 && kind !== 1) throw new ValidationError("RequestQueued kind must be Deposit(0) or Withdraw(1).");
    const plan = this.buildChainEventPlan(kind);
    return this.register({
      requestId: event.data?.requestId,
      target: plan.target,
      direction: "increase",
      settlement: plan.settlement,
      kind: kind === 0 ? "deposit" : "withdraw",
      phase: "staged-on-chain-backfill",
      requestedAssetsRaw: event.data?.assetsRaw ?? event.data?.assets ?? 0,
      requestedSharesRaw: event.data?.sharesRaw ?? event.data?.shares ?? 0,
      startedAt: event.timestamp,
      deadlineAt: deadlineFromChainEvent(event),
      registrationSource: "chain_event_backfill",
      wrapperAddress,
      sourceEventId: event.id,
      stagingTxHash: event.txHash,
      stagingBlockNumber: event.blockNumber,
      baselineRaw: baseline.raw,
      baselineAsOf: baseline.asOf,
      baselineBlockNumber: normalizePositiveInteger(baseline.blockNumber, "baseline.blockNumber"),
      baselineBlockHash: normalizeBlockHash(baseline.blockHash, "baseline.blockHash")
    });
  }

  buildChainEventPlan(kind) {
    return kind === 0
      ? {
          target: this.chainEventWatchConfig.depositTarget,
          // The observed aUSDC delta is the capital that actually reached the
          // venue. Funding margin and transport fees are not strategy assets.
          settlement: { assets: "delta", shares: "delta" }
        }
      : {
          target: this.chainEventWatchConfig.withdrawTarget,
          settlement: { assets: "delta", shares: "requested_shares" }
        };
  }

  async ingestChainEvent(event = {}) {
    if (event.topic === "xcm.request_queued") return this.registerFromChainEvent(event);
    if (event.topic === "xcm.request_leg_dispatched") return this.recordDispatchFromChainEvent(event);
    throw new ValidationError("Unsupported XCM observer chain event.");
  }

  async recordDispatchFromChainEvent(event = {}) {
    const requestId = normalizeRequestId(event.data?.requestId);
    const watch = await this.stateStore.getXcmBalanceWatch?.(requestId);
    if (!watch || watch.status !== "pending") {
      throw new ValidationError(`Dispatch event ${event.id ?? "unknown"} has no pending staged watch.`);
    }
    const wrapperAddress = normalizeEvmAddress(event.data?.wrapperAddress, "wrapperAddress");
    if (watch.wrapperAddress !== wrapperAddress
      || wrapperAddress !== this.chainEventWatchConfig?.expectedWrapper) {
      throw new ValidationError("Dispatch event belongs to another wrapper generation.");
    }
    const leg = Number(event.data?.leg);
    if (!Number.isInteger(leg) || leg < 0 || leg > 3) {
      throw new ValidationError("Dispatch event leg must be in the v2.2 four-leg range.");
    }
    const updated = await this.stateStore.upsertXcmBalanceWatch({
      ...watch,
      phase: `leg-${leg}-dispatched-on-chain`,
      dispatchBitmap: Number(watch.dispatchBitmap ?? 0) | (1 << leg),
      lastDispatchEventId: event.id,
      lastDispatchTxHash: event.txHash,
      lastDispatchBlockNumber: event.blockNumber,
      lastDispatchMessageHash: normalizeOptionalText(event.data?.messageHash),
      lastDispatchFeeAmountRaw: normalizeRaw(event.data?.feeAmount ?? 0, "feeAmount").toString()
    });
    this.publish("xcm.balance_watch_dispatch_observed", updated);
    return updated;
  }

  async register(input = {}) {
    const requestId = normalizeRequestId(input.requestId);
    if (input.registrationSource === "chain_event_backfill"
      && (input.baselineRaw === undefined
        || input.baselineBlockNumber === undefined
        || input.baselineBlockHash === undefined)) {
      throw new ValidationError("Chain-event backfill requires a chain-height-bound baseline value, block number, and block hash.");
    }
    const existing = await this.stateStore.getXcmBalanceWatch?.(requestId);
    if (existing) {
      assertEquivalentRegistration(existing, input);
      return existing;
    }

    const target = normalizeVenueBalanceTarget(input.target);
    const reading = input.baselineRaw === undefined
      ? await this.balanceReader.read(target)
      : {
          raw: normalizeRaw(input.baselineRaw, "baselineRaw"),
          asOf: input.baselineAsOf === undefined
            ? new Date(this.now()).toISOString()
            : normalizeRequiredTimestamp(input.baselineAsOf, "baselineAsOf")
        };
    const startedAtMs = normalizeTime(input.startedAt, this.now());
    const deadlineAtMs = input.deadlineAt === undefined
      ? startedAtMs + normalizePositiveInteger(input.timeoutMs ?? this.defaultTimeoutMs, "timeoutMs")
      : normalizeTime(input.deadlineAt, this.now());
    if (deadlineAtMs <= startedAtMs) {
      throw new ValidationError("balance watch deadlineAt must be after startedAt.");
    }
    const watch = await this.stateStore.upsertXcmBalanceWatch({
      requestId,
      status: "pending",
      target,
      direction: normalizeDirection(input.direction),
      baselineRaw: reading.raw.toString(),
      currentRaw: reading.raw.toString(),
      deltaRaw: "0",
      settlement: normalizeSettlementMapping(input.settlement),
      kind: normalizeRequestKind(input.kind, input.direction),
      phase: normalizeRequestPhase(input.phase ?? "registered"),
      requestedAssetsRaw: normalizeRaw(input.requestedAssetsRaw ?? 0, "requestedAssetsRaw").toString(),
      requestedSharesRaw: normalizeRaw(input.requestedSharesRaw ?? 0, "requestedSharesRaw").toString(),
      startedAt: new Date(startedAtMs).toISOString(),
      deadlineAt: new Date(deadlineAtMs).toISOString(),
      lastReadAt: reading.asOf,
      baselineBlockNumber: input.baselineBlockNumber ?? undefined,
      baselineBlockHash: input.baselineBlockHash === undefined
        ? undefined
        : normalizeBlockHash(input.baselineBlockHash, "baselineBlockHash"),
      attemptCount: 0,
      registrationSource: normalizeRegistrationSource(input.registrationSource),
      wrapperAddress: input.wrapperAddress === undefined
        ? undefined
        : normalizeEvmAddress(input.wrapperAddress, "wrapperAddress"),
      sourceEventId: normalizeOptionalText(input.sourceEventId),
      stagingTxHash: normalizeOptionalText(input.stagingTxHash),
      stagingBlockNumber: input.stagingBlockNumber ?? undefined
    });
    this.publish("xcm.balance_watch_started", watch);
    return watch;
  }

  async pollOnce(limit = 50) {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.pollBatch(limit);
    try {
      return await this.pollPromise;
    } finally {
      this.pollPromise = undefined;
    }
  }

  async pollBatch(limit) {
    const tasks = [];
    let watchTaskIndex = -1;
    if (this.enabled) {
      watchTaskIndex = tasks.length;
      tasks.push(this.pollPendingWatches(limit));
    }
    if (this.bankLaneFeed?.enabled) {
      tasks.push(this.bankLaneFeed.pollOnce());
    }
    const results = await Promise.all(tasks);
    return watchTaskIndex < 0 ? [] : results[watchTaskIndex];
  }

  async pollPendingWatches(limit) {
    const pending = await this.stateStore.listPendingXcmBalanceWatches?.(limit) ?? [];
    const results = [];
    for (const watch of pending) {
      const scope = this.classifyWatchScope(watch);
      if (scope === "foreign") continue;
      if (scope === "unknown") {
        results.push(await this.markUnknownScope(watch));
        continue;
      }
      results.push(await this.pollWatch(watch));
    }
    return results;
  }

  classifyWatchScope(watch) {
    if (watch?.registrationSource === "chain_event" || watch?.registrationSource === "chain_event_backfill") {
      return this.classifyChainEventWatchScope(watch);
    }
    return this.bankLaneFeed?.enabled
      && typeof this.bankLaneFeed.classifyRequestWatch === "function"
      ? this.bankLaneFeed.classifyRequestWatch(watch)
      : "current";
  }

  classifyChainEventWatchScope(watch) {
    if (!this.chainEventWatchConfig) return "unknown";
    try {
      if (normalizeEvmAddress(watch.wrapperAddress, "watch.wrapperAddress")
        !== this.chainEventWatchConfig.expectedWrapper) return "foreign";
      const target = normalizeVenueBalanceTarget(watch.target);
      if (sameTarget(target, this.chainEventWatchConfig.depositTarget)
        || sameTarget(target, this.chainEventWatchConfig.withdrawTarget)) return "current";
      return "foreign";
    } catch {
      return "unknown";
    }
  }

  async markUnknownScope(watch) {
    const updated = await this.stateStore.upsertXcmBalanceWatch({
      ...watch,
      phase: "scope-unknown",
      lastTriedAt: new Date(this.now()).toISOString(),
      lastError: "observer_target_scope_unknown"
    });
    this.publish("xcm.balance_watch_scope_unknown", updated);
    return updated;
  }

  async pollWatch(watch) {
    const nowMs = this.now();
    try {
      const reading = await this.balanceReader.read(watch.target);
      const baseline = BigInt(watch.baselineRaw);
      const delta = watch.direction === "increase"
        ? reading.raw - baseline
        : baseline - reading.raw;
      const positiveDelta = delta > 0n ? delta : 0n;
      const updated = await this.stateStore.upsertXcmBalanceWatch({
        ...watch,
        currentRaw: reading.raw.toString(),
        deltaRaw: positiveDelta.toString(),
        lastReadAt: reading.asOf,
        attemptCount: Number(watch.attemptCount ?? 0) + 1,
        phase: positiveDelta > 0n ? "pending-finalize" : watch.phase,
        lastError: undefined
      });
      if (positiveDelta > 0n) {
        return this.succeed(updated, positiveDelta);
      }
      if (nowMs >= Date.parse(watch.deadlineAt)) {
        return this.timeout(updated);
      }
      this.publish("xcm.balance_watch_polled", updated);
      return updated;
    } catch (error) {
      const updated = await this.stateStore.upsertXcmBalanceWatch({
        ...watch,
        attemptCount: Number(watch.attemptCount ?? 0) + 1,
        lastTriedAt: new Date(nowMs).toISOString(),
        lastError: error?.message ?? String(error)
      });
      this.publish("xcm.balance_watch_read_failed", updated);
      if (nowMs >= Date.parse(watch.deadlineAt)) {
        return this.timeout(updated);
      }
      return updated;
    }
  }

  async succeed(watch, delta) {
    const outcome = {
      status: "succeeded",
      settledAssets: resolveSettlementAmount(watch.settlement.assets, watch, delta),
      settledShares: resolveSettlementAmount(watch.settlement.shares, watch, delta),
      source: `balance_delta:${watch.target.ledger}`,
      observedAt: new Date(this.now()).toISOString()
    };
    await this.terminalSink.observeOutcome(watch.requestId, outcome);
    const terminal = await this.stateStore.upsertXcmBalanceWatch({
      ...watch,
      status: "succeeded",
      phase: "terminal",
      outcome,
      completedAt: outcome.observedAt
    });
    this.publish("xcm.balance_watch_succeeded", terminal);
    return terminal;
  }

  async timeout(watch) {
    const outcome = {
      status: "failed",
      settledAssets: "0",
      settledShares: "0",
      failureCode: FAILURE_BALANCE_TIMEOUT,
      source: `balance_timeout:${watch.target.ledger}`,
      observedAt: new Date(this.now()).toISOString()
    };
    await this.terminalSink.observeOutcome(watch.requestId, outcome);
    const terminal = await this.stateStore.upsertXcmBalanceWatch({
      ...watch,
      status: "failed",
      phase: "terminal",
      outcome,
      completedAt: outcome.observedAt
    });
    this.publish("xcm.balance_watch_timed_out", terminal);
    return terminal;
  }

  async getStatus() {
    const allPending = await this.stateStore.listPendingXcmBalanceWatches?.(100) ?? [];
    const pending = allPending.filter((watch) => this.classifyWatchScope(watch) !== "foreign");
    const nowMs = this.now();
    const oldestStartedMs = pending.reduce((oldest, item) => {
      const value = Date.parse(item.startedAt ?? "");
      return Number.isFinite(value) ? Math.min(oldest, value) : oldest;
    }, Number.POSITIVE_INFINITY);
    return {
      enabled: this.enabled,
      bankLaneFeedEnabled: Boolean(this.bankLaneFeed?.enabled),
      running: this.running,
      polling: Boolean(this.pollPromise),
      pendingCount: pending.length,
      chainEventWatchEnabled: Boolean(this.chainEventWatchConfig),
      chainEventIngestionError: this.chainEventIngestionError,
      readErrorCount: pending.filter((item) => Boolean(item.lastError)).length,
      overdueCount: pending.filter((item) => nowMs >= Date.parse(item.deadlineAt ?? "")).length,
      oldestPendingAgeMs: Number.isFinite(oldestStartedMs) ? Math.max(nowMs - oldestStartedMs, 0) : 0,
      pending: pending.slice(0, 10).map((item) => ({
        requestId: item.requestId,
        ledger: item.target?.ledger,
        account: item.target?.account,
        asset: item.target?.assetId ?? item.target?.contract,
        direction: item.direction,
        deltaRaw: item.deltaRaw,
        startedAt: item.startedAt,
        deadlineAt: item.deadlineAt,
        lastReadAt: item.lastReadAt,
        lastError: item.lastError,
        observationState: item.lastError ? "unknown_stale" : "pending",
        registrationSource: item.registrationSource,
        stagingBlockNumber: item.stagingBlockNumber,
        baselineBlockNumber: item.baselineBlockNumber,
        baselineBlockHash: item.baselineBlockHash
      }))
    };
  }

  async setRequestPhase(requestId, phase) {
    const normalizedId = normalizeRequestId(requestId);
    const watch = await this.stateStore.getXcmBalanceWatch?.(normalizedId);
    if (!watch || watch.status !== "pending") return watch;
    return this.stateStore.upsertXcmBalanceWatch({
      ...watch,
      phase: normalizeRequestPhase(phase)
    });
  }

  async requireArmedWatch(requestId, { wrapperAddress = undefined } = {}) {
    const normalizedId = normalizeRequestId(requestId);
    const watch = await this.stateStore.getXcmBalanceWatch?.(normalizedId);
    if (!watch || watch.status !== "pending") {
      throw new ValidationError(`No pending chain-event observer watch exists for ${normalizedId}.`);
    }
    if (!["chain_event", "chain_event_backfill"].includes(watch.registrationSource)) {
      throw new ValidationError(`Observer watch ${normalizedId} was not armed from chain truth.`);
    }
    if (wrapperAddress && watch.wrapperAddress !== normalizeEvmAddress(wrapperAddress, "wrapperAddress")) {
      throw new ValidationError(`Observer watch ${normalizedId} belongs to another wrapper generation.`);
    }
    if (this.classifyWatchScope(watch) !== "current") {
      throw new ValidationError(`Observer watch ${normalizedId} does not target the current Bank lane.`);
    }
    if (!Number.isFinite(Date.parse(watch.deadlineAt ?? "")) || this.now() >= Date.parse(watch.deadlineAt)) {
      throw new ValidationError(`Observer watch ${normalizedId} is overdue and cannot authorize dispatch.`);
    }
    return watch;
  }

  publish(topic, watch) {
    this.eventBus?.publish?.({
      id: `${topic}-${watch.requestId}-${this.now()}`,
      topic,
      correlationId: watch.requestId,
      timestamp: new Date(this.now()).toISOString(),
      data: {
        requestId: watch.requestId,
        ledger: watch.target?.ledger,
        endpoint: watch.target?.endpoint,
        account: watch.target?.account,
        asset: watch.target?.assetId ?? watch.target?.contract,
        direction: watch.direction,
        baselineRaw: watch.baselineRaw,
        currentRaw: watch.currentRaw,
        deltaRaw: watch.deltaRaw,
        startedAt: watch.startedAt,
        deadlineAt: watch.deadlineAt,
        lastReadAt: watch.lastReadAt,
        lastError: watch.lastError,
        status: watch.status,
        registrationSource: watch.registrationSource,
        wrapperAddress: watch.wrapperAddress,
        sourceEventId: watch.sourceEventId,
        baselineBlockNumber: watch.baselineBlockNumber,
        baselineBlockHash: watch.baselineBlockHash
      }
    });
  }

  async schedule() {
    if ((!this.enabled && !this.bankLaneFeed?.enabled) || !this.running) return;
    try {
      await this.pollOnce();
    } catch (error) {
      this.logger.warn?.({ err: error }, "xcm_balance_observer.poll_failed");
    }
    if (!this.running) return;
    this.timer = setTimeout(() => void this.schedule(), this.pollIntervalMs);
  }
}

function normalizeRequestId(raw) {
  if (!REQUEST_ID_RE.test(String(raw ?? ""))) {
    throw new ValidationError("requestId must be a 32-byte hex string.");
  }
  return String(raw).toLowerCase();
}

function normalizeRaw(raw, label) {
  try {
    const value = BigInt(raw);
    if (value < 0n) throw new Error();
    return value;
  } catch {
    throw new ValidationError(`${label} must be a non-negative integer.`);
  }
}

function normalizeDirection(raw) {
  const value = String(raw ?? "").toLowerCase();
  if (value !== "increase" && value !== "decrease") {
    throw new ValidationError('balance watch direction must be "increase" or "decrease".');
  }
  return value;
}

function normalizeRequestKind(raw, direction) {
  const value = String(raw ?? "").trim();
  if (value) return value;
  return String(direction ?? "").toLowerCase() === "decrease" ? "withdraw" : "deposit";
}

function normalizeRequestPhase(raw) {
  const value = String(raw ?? "").trim();
  if (!value) throw new ValidationError("balance watch phase must be a non-empty string.");
  return value;
}

function normalizeSettlementMapping(raw = {}) {
  return {
    assets: normalizeSettlementSource(raw.assets ?? "delta", "settlement.assets"),
    shares: normalizeSettlementSource(raw.shares ?? "delta", "settlement.shares")
  };
}

function normalizeSettlementSource(raw, label) {
  const value = String(raw).toLowerCase();
  if (!["delta", "requested_assets", "requested_shares", "zero"].includes(value)) {
    throw new ValidationError(`${label} has an unsupported source.`);
  }
  return value;
}

function resolveSettlementAmount(source, watch, delta) {
  if (source === "delta") return delta.toString();
  if (source === "requested_assets") return String(watch.requestedAssetsRaw ?? "0");
  if (source === "requested_shares") return String(watch.requestedSharesRaw ?? "0");
  return "0";
}

function normalizeTime(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = typeof raw === "number" ? raw : Date.parse(raw);
  if (!Number.isFinite(value)) throw new ValidationError("startedAt must be a valid timestamp.");
  return value;
}

function normalizePositiveInteger(raw, label) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${label} must be a positive integer.`);
  }
  return value;
}

function normalizeRequiredTimestamp(raw, label) {
  const value = Date.parse(String(raw ?? ""));
  if (!Number.isFinite(value)) throw new ValidationError(`${label} must be a valid timestamp.`);
  return new Date(value).toISOString();
}

function normalizeBlockHash(raw, label) {
  const value = String(raw ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{64}$/u.test(value)) throw new ValidationError(`${label} must be a 32-byte block hash.`);
  return value;
}

function deadlineFromChainEvent(event) {
  const raw = event.data?.dispatchDeadlineRaw ?? event.data?.dispatchDeadline;
  if (raw === undefined) return undefined;
  const seconds = normalizeRaw(raw, "dispatchDeadlineRaw");
  if (seconds <= 0n || seconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ValidationError("dispatchDeadlineRaw must be a positive safe unix timestamp.");
  }
  return new Date(Number(seconds) * 1_000).toISOString();
}

function assertEquivalentRegistration(existing, incoming) {
  const target = normalizeVenueBalanceTarget(incoming.target);
  const settlement = normalizeSettlementMapping(incoming.settlement);
  const requestedAssetsRaw = normalizeRaw(incoming.requestedAssetsRaw ?? 0, "requestedAssetsRaw").toString();
  const requestedSharesRaw = normalizeRaw(incoming.requestedSharesRaw ?? 0, "requestedSharesRaw").toString();
  if (
    JSON.stringify(existing.target) !== JSON.stringify(target)
    || existing.direction !== normalizeDirection(incoming.direction)
    || JSON.stringify(existing.settlement) !== JSON.stringify(settlement)
    || String(existing.requestedAssetsRaw ?? "0") !== requestedAssetsRaw
    || String(existing.requestedSharesRaw ?? "0") !== requestedSharesRaw
    || (incoming.wrapperAddress !== undefined
      && existing.wrapperAddress !== normalizeEvmAddress(incoming.wrapperAddress, "wrapperAddress"))
    || (incoming.baselineRaw !== undefined
      && String(existing.baselineRaw) !== normalizeRaw(incoming.baselineRaw, "baselineRaw").toString())
    || (incoming.baselineBlockNumber !== undefined
      && Number(existing.baselineBlockNumber) !== normalizePositiveInteger(incoming.baselineBlockNumber, "baselineBlockNumber"))
    || (incoming.baselineBlockHash !== undefined
      && existing.baselineBlockHash !== normalizeBlockHash(incoming.baselineBlockHash, "baselineBlockHash"))
  ) {
    throw new ValidationError(`XCM balance watch ${existing.requestId} already exists with different bounds.`);
  }
}

function normalizeChainEventWatchConfig(raw = {}) {
  return {
    expectedWrapper: normalizeEvmAddress(raw.expectedWrapper, "chainEventWatchConfig.expectedWrapper"),
    depositTarget: normalizeVenueBalanceTarget(raw.depositTarget),
    withdrawTarget: normalizeVenueBalanceTarget(raw.withdrawTarget)
  };
}

function normalizeEvmAddress(raw, label) {
  const value = String(raw ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/u.test(value)) throw new ValidationError(`${label} must be an EVM address.`);
  return value;
}

function normalizeRegistrationSource(raw) {
  const value = String(raw ?? "manual").trim();
  if (!["manual", "chain_event", "chain_event_backfill"].includes(value)) {
    throw new ValidationError("balance watch registrationSource is unsupported.");
  }
  return value;
}

function normalizeOptionalText(raw) {
  const value = String(raw ?? "").trim();
  return value || undefined;
}

function sameTarget(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export { FAILURE_BALANCE_TIMEOUT };
