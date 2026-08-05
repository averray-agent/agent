import { ValidationError } from "../core/errors.js";

const UINT256_MAX = (1n << 256n) - 1n;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const DEFAULT_RETRY_BASE_MS = 15_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;

export class XcmSettlementWatcherService {
  constructor(
    platformService,
    stateStore,
    eventBus = undefined,
    {
      enabled = false,
      pollIntervalMs = 15_000,
      retryBaseMs = DEFAULT_RETRY_BASE_MS,
      retryMaxMs = DEFAULT_RETRY_MAX_MS,
      expectedWrapper = undefined,
      now = () => Date.now(),
      logger = console
    } = {}
  ) {
    this.platformService = platformService;
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.pollIntervalMs = pollIntervalMs;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    const configuredExpectedWrapper = String(expectedWrapper ?? "").trim();
    this.expectedWrapper = configuredExpectedWrapper
      ? normalizeWrapperAddress(configuredExpectedWrapper)
      : undefined;
    this.now = now;
    this.logger = logger;
    this.running = false;
    this.timer = undefined;
    this.unsubscribe = undefined;
    this.settlementRunPromise = undefined;
    this.settlementRunQueued = false;
  }

  start() {
    if (!this.enabled || this.running) {
      return;
    }
    this.running = true;
    this.unsubscribe = this.eventBus?.subscribe?.({ topics: ["xcm.outcome_observed"] }, () => {
      void this.runPendingSettlements();
    });
    void this.scheduleNextTick();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async getStatus() {
    const pending = await this.stateStore.listPendingXcmObservations?.(50) ?? [];
    return {
      enabled: this.enabled,
      running: this.running,
      settling: Boolean(this.settlementRunPromise),
      pendingCount: pending.length,
      pending: pending.slice(0, 10)
    };
  }

  async observeOutcome(requestId, outcome = {}) {
    const normalizedRequestId = this.requireRequestId(requestId);
    const wrapperAddress = normalizeWrapperAddress(outcome.wrapperAddress ?? this.expectedWrapper);
    if (this.expectedWrapper && wrapperAddress !== this.expectedWrapper) {
      throw new ValidationError("XCM observation belongs to another wrapper generation.");
    }
    const status = normalizeObservationStatus(outcome.status);
    const incoming = {
      requestId: normalizedRequestId,
      wrapperAddress,
      status,
      settledAssets: normalizeObservationAmount(outcome.settledAssets, "settledAssets"),
      settledShares: normalizeObservationAmount(outcome.settledShares, "settledShares"),
      remoteRef: outcome.remoteRef,
      failureCode: normalizeObservationFailureCode(outcome.failureCode, status),
      source: typeof outcome.source === "string" && outcome.source.trim() ? outcome.source.trim() : "observer",
      observedAt: normalizeObservationObservedAt(outcome.observedAt),
      processed: false
    };
    const existing = await this.stateStore.getXcmObservation?.(wrapperAddress, normalizedRequestId);
    if (existing) {
      if (
        this.isEquivalentObservation(existing, incoming) ||
        existing.processed ||
        this.isStaleObservation(existing, incoming)
      ) {
        return existing;
      }
    }
    const observation = await this.stateStore.upsertXcmObservation(incoming);

    this.eventBus?.publish({
      id: `xcm-outcome-observed-${normalizedRequestId}-${Date.now()}`,
      topic: "xcm.outcome_observed",
      correlationId: normalizedRequestId,
      timestamp: new Date().toISOString(),
      data: {
        requestId: normalizedRequestId,
        wrapperAddress: observation.wrapperAddress,
        status: observation.status,
        settledAssets: observation.settledAssets,
        settledAssetsRaw: observation.settledAssets,
        settledShares: observation.settledShares,
        settledSharesRaw: observation.settledShares,
        remoteRef: observation.remoteRef,
        failureCode: observation.failureCode,
        observedAt: observation.observedAt,
        source: observation.source
      }
    });

    if (this.enabled && this.running) {
      void this.runPendingSettlements();
    }

    return observation;
  }

  async runPendingSettlements(limit = 20) {
    if (this.settlementRunPromise) {
      this.settlementRunQueued = true;
      return this.settlementRunPromise;
    }

    this.settlementRunPromise = this.drainPendingSettlements(limit);
    try {
      return await this.settlementRunPromise;
    } finally {
      this.settlementRunPromise = undefined;
      this.settlementRunQueued = false;
    }
  }

  async drainPendingSettlements(limit) {
    const results = [];
    do {
      this.settlementRunQueued = false;
      results.push(...await this.runPendingSettlementBatch(limit));
    } while (this.settlementRunQueued);
    return results;
  }

  async runPendingSettlementBatch(limit) {
    const pending = (await this.stateStore.listPendingXcmObservations?.(limit) ?? [])
      .filter((observation) => this.retryIsDue(observation));
    const results = [];

    for (const observation of pending) {
      try {
        let settlementPreflight;
        if (typeof this.platformService.preflightXcmSettlementOutcome === "function") {
          settlementPreflight = await this.platformService.preflightXcmSettlementOutcome(
            observation.requestId,
            observation
          );
        }
        const finalized = await this.platformService.finalizeXcmRequest(observation.requestId, observation);
        const chainSettlement = chainSettlementProof(finalized, observation);
        await this.stateStore.markXcmObservationProcessed?.(observation.wrapperAddress, observation.requestId, {
          finalizedAt: new Date().toISOString(),
          settledVia: finalized?.settledVia,
          status: finalized?.strategyRequest?.statusLabel ?? finalized?.statusLabel ?? observation.status,
          chainSettlement,
          ...(settlementPreflight ? { settlementPreflight } : {})
        });
        const finalizedWithPreflight = {
          ...finalized,
          ...(settlementPreflight ? { settlementPreflight } : {})
        };
        this.eventBus?.publish({
          id: `xcm-auto-finalized-${observation.requestId}-${Date.now()}`,
          topic: "xcm.request_auto_finalized",
          wallet: finalized?.strategyRequest?.account ?? finalized?.account,
          wallets: [finalized?.strategyRequest?.account ?? finalized?.account].filter(Boolean),
          correlationId: observation.requestId,
          timestamp: new Date().toISOString(),
          data: {
            requestId: observation.requestId,
            wrapperAddress: observation.wrapperAddress,
            status: finalized?.strategyRequest?.statusLabel ?? finalized?.statusLabel ?? observation.status,
            settledAssets: observation.settledAssets,
            settledAssetsRaw: observation.settledAssets,
            settledShares: observation.settledShares,
            settledSharesRaw: observation.settledShares,
            remoteRef: observation.remoteRef,
            failureCode: observation.failureCode,
            source: observation.source,
            settledVia: finalized?.settledVia
          }
        });
        results.push(finalizedWithPreflight);
      } catch (error) {
        const retry = this.retrySchedule(observation);
        await this.stateStore.markXcmObservationFailed?.(
          observation.wrapperAddress,
          observation.requestId,
          error,
          retry
        );
        this.eventBus?.publish({
          id: `xcm-auto-finalize-failed-${observation.requestId}-${Date.now()}`,
          topic: "xcm.request_finalize_failed",
          correlationId: observation.requestId,
          timestamp: new Date().toISOString(),
          data: {
            requestId: observation.requestId,
            wrapperAddress: observation.wrapperAddress,
            message: error?.message ?? "unknown_error",
            nextAttemptAt: retry.nextAttemptAt,
            retryDelayMs: retry.retryDelayMs
          }
        });
        this.logger.warn?.(
          { requestId: observation.requestId, err: error, ...retry },
          "xcm_settlement_watcher.finalize_failed"
        );
      }
    }

    return results;
  }

  retryIsDue(observation) {
    const nextAttemptMs = Date.parse(observation?.nextAttemptAt ?? "");
    return !Number.isFinite(nextAttemptMs) || nextAttemptMs <= this.now();
  }

  retrySchedule(observation) {
    const failedAttempts = Number(observation?.attemptCount ?? 0);
    const exponent = Math.min(Math.max(failedAttempts, 0), 20);
    const retryDelayMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** exponent));
    return {
      retryDelayMs,
      nextAttemptAt: new Date(this.now() + retryDelayMs).toISOString()
    };
  }

  async scheduleNextTick() {
    if (!this.enabled || !this.running) {
      return;
    }
    await this.runPendingSettlements();
    if (!this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.scheduleNextTick();
    }, this.pollIntervalMs);
  }

  requireRequestId(requestId) {
    if (typeof requestId !== "string" || !/^0x[a-fA-F0-9]{64}$/u.test(requestId)) {
      throw new ValidationError("requestId must be a 0x-prefixed 32-byte hex string.");
    }
    return requestId;
  }

  isEquivalentObservation(existing, incoming) {
    return String(existing.status ?? "") === String(incoming.status ?? "")
      && normalizeObservationAmount(existing.settledAssets, "settledAssets")
        === normalizeObservationAmount(incoming.settledAssets, "settledAssets")
      && normalizeObservationAmount(existing.settledShares, "settledShares")
        === normalizeObservationAmount(incoming.settledShares, "settledShares")
      && String(existing.remoteRef ?? "") === String(incoming.remoteRef ?? "")
      && String(existing.failureCode ?? "") === String(incoming.failureCode ?? "");
  }

  isStaleObservation(existing, incoming) {
    const existingObservedAt = Date.parse(existing?.observedAt ?? "");
    const incomingObservedAt = Date.parse(incoming?.observedAt ?? "");
    return Number.isFinite(existingObservedAt) &&
      Number.isFinite(incomingObservedAt) &&
      incomingObservedAt <= existingObservedAt;
  }
}

function normalizeWrapperAddress(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/u.test(normalized)) {
    throw new ValidationError("XCM observation wrapperAddress must be a 20-byte address.");
  }
  return normalized;
}

function chainSettlementProof(finalized, observation) {
  const request = finalized?.strategyRequest ?? finalized?.adapterRequest ?? finalized;
  const status = String(request?.statusLabel ?? finalized?.statusLabel ?? "").toLowerCase();
  const settledAssetsRaw = String(request?.settledAssetsRaw ?? finalized?.settledAssetsRaw ?? "");
  const settledSharesRaw = String(request?.settledSharesRaw ?? finalized?.settledSharesRaw ?? "");
  if (status !== observation.status
    || settledAssetsRaw !== observation.settledAssets
    || settledSharesRaw !== observation.settledShares) {
    throw new ValidationError("Chain settlement result does not match the observed XCM outcome.");
  }
  return {
    wrapperAddress: observation.wrapperAddress,
    requestId: observation.requestId,
    status,
    settledAssetsRaw,
    settledSharesRaw,
    confirmedAt: new Date().toISOString()
  };
}

function normalizeObservationStatus(status) {
  const normalized = typeof status === "number"
    ? ["unknown", "pending", "succeeded", "failed", "cancelled"][status] ?? "unknown"
    : String(status ?? "").trim().toLowerCase();
  if (!TERMINAL_STATUSES.has(normalized)) {
    throw new ValidationError("XCM observations must use a terminal status.");
  }
  return normalized;
}

function normalizeObservationAmount(value, label) {
  if (value === undefined || value === null || value === "") {
    return "0";
  }

  let parsed;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`${label} must be an exact non-negative uint256.`);
    }
    parsed = BigInt(value);
  } else if (typeof value === "string") {
    const normalized = value.trim();
    if (!/^\d+$/u.test(normalized)) {
      throw new ValidationError(`${label} must be an exact non-negative uint256.`);
    }
    parsed = BigInt(normalized);
  } else {
    throw new ValidationError(`${label} must be an exact non-negative uint256.`);
  }

  if (parsed < 0n || parsed > UINT256_MAX) {
    throw new ValidationError(`${label} must fit uint256.`);
  }
  return parsed.toString();
}

function normalizeObservationFailureCode(value, status) {
  const failureCode = typeof value === "string" && value.trim() ? value.trim() : undefined;
  if (status === "failed" && !failureCode) {
    throw new ValidationError("XCM failed observations must include failureCode.");
  }
  if (value !== undefined && value !== null && value !== "" && typeof value !== "string") {
    throw new ValidationError("failureCode must be a non-empty string when provided.");
  }
  return failureCode;
}

function normalizeObservationObservedAt(value) {
  if (value === undefined || value === null || value === "") {
    return new Date().toISOString();
  }
  const observedAt = new Date(value);
  if (Number.isNaN(observedAt.getTime())) {
    throw new ValidationError("observedAt must be ISO-8601 when provided.");
  }
  return observedAt.toISOString();
}
