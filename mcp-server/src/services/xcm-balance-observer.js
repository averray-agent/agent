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
    this.now = now;
    this.logger = logger;
    this.running = false;
    this.timer = undefined;
    this.pollPromise = undefined;
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    void this.schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async register(input = {}) {
    const requestId = normalizeRequestId(input.requestId);
    const existing = await this.stateStore.getXcmBalanceWatch?.(requestId);
    if (existing) {
      assertEquivalentRegistration(existing, input);
      return existing;
    }

    const target = normalizeVenueBalanceTarget(input.target);
    const reading = input.baselineRaw === undefined
      ? await this.balanceReader.read(target)
      : { raw: normalizeRaw(input.baselineRaw, "baselineRaw"), asOf: new Date(this.now()).toISOString() };
    const startedAtMs = normalizeTime(input.startedAt, this.now());
    const timeoutMs = normalizePositiveInteger(input.timeoutMs ?? this.defaultTimeoutMs, "timeoutMs");
    const watch = await this.stateStore.upsertXcmBalanceWatch({
      requestId,
      status: "pending",
      target,
      direction: normalizeDirection(input.direction),
      baselineRaw: reading.raw.toString(),
      currentRaw: reading.raw.toString(),
      deltaRaw: "0",
      settlement: normalizeSettlementMapping(input.settlement),
      requestedAssetsRaw: normalizeRaw(input.requestedAssetsRaw ?? 0, "requestedAssetsRaw").toString(),
      requestedSharesRaw: normalizeRaw(input.requestedSharesRaw ?? 0, "requestedSharesRaw").toString(),
      startedAt: new Date(startedAtMs).toISOString(),
      deadlineAt: new Date(startedAtMs + timeoutMs).toISOString(),
      lastReadAt: reading.asOf,
      attemptCount: 0
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
    const pending = await this.stateStore.listPendingXcmBalanceWatches?.(limit) ?? [];
    const results = [];
    for (const watch of pending) {
      results.push(await this.pollWatch(watch));
    }
    return results;
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
      outcome,
      completedAt: outcome.observedAt
    });
    this.publish("xcm.balance_watch_timed_out", terminal);
    return terminal;
  }

  async getStatus() {
    const pending = await this.stateStore.listPendingXcmBalanceWatches?.(100) ?? [];
    const nowMs = this.now();
    const oldestStartedMs = pending.reduce((oldest, item) => {
      const value = Date.parse(item.startedAt ?? "");
      return Number.isFinite(value) ? Math.min(oldest, value) : oldest;
    }, Number.POSITIVE_INFINITY);
    return {
      enabled: this.enabled,
      running: this.running,
      polling: Boolean(this.pollPromise),
      pendingCount: pending.length,
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
        lastError: item.lastError
      }))
    };
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
        status: watch.status
      }
    });
  }

  async schedule() {
    if (!this.enabled || !this.running) return;
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
    || (incoming.baselineRaw !== undefined
      && String(existing.baselineRaw) !== normalizeRaw(incoming.baselineRaw, "baselineRaw").toString())
  ) {
    throw new ValidationError(`XCM balance watch ${existing.requestId} already exists with different bounds.`);
  }
}

export { FAILURE_BALANCE_TIMEOUT };
