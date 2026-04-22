import { ValidationError } from "../core/errors.js";

export class XcmSettlementWatcherService {
  constructor(
    platformService,
    stateStore,
    eventBus = undefined,
    { enabled = false, pollIntervalMs = 15_000, logger = console } = {}
  ) {
    this.platformService = platformService;
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    this.enabled = enabled;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;
    this.running = false;
    this.timer = undefined;
    this.unsubscribe = undefined;
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
      pendingCount: pending.length,
      pending: pending.slice(0, 10)
    };
  }

  async observeOutcome(requestId, outcome = {}) {
    const normalizedRequestId = this.requireRequestId(requestId);
    const incoming = {
      requestId: normalizedRequestId,
      status: outcome.status,
      settledAssets: Number(outcome.settledAssets ?? 0),
      settledShares: Number(outcome.settledShares ?? 0),
      remoteRef: outcome.remoteRef,
      failureCode: outcome.failureCode,
      source: typeof outcome.source === "string" && outcome.source.trim() ? outcome.source.trim() : "observer",
      observedAt: outcome.observedAt ?? new Date().toISOString(),
      processed: false
    };
    const existing = await this.stateStore.getXcmObservation?.(normalizedRequestId);
    if (existing && this.isEquivalentObservation(existing, incoming)) {
      return existing;
    }
    const observation = await this.stateStore.upsertXcmObservation(incoming);

    this.eventBus?.publish({
      id: `xcm-outcome-observed-${normalizedRequestId}-${Date.now()}`,
      topic: "xcm.outcome_observed",
      timestamp: new Date().toISOString(),
      data: {
        requestId: normalizedRequestId,
        status: observation.status,
        settledAssets: observation.settledAssets,
        settledShares: observation.settledShares,
        source: observation.source
      }
    });

    if (this.enabled && this.running) {
      void this.runPendingSettlements();
    }

    return observation;
  }

  async runPendingSettlements(limit = 20) {
    const pending = await this.stateStore.listPendingXcmObservations?.(limit) ?? [];
    const results = [];

    for (const observation of pending) {
      try {
        const finalized = await this.platformService.finalizeXcmRequest(observation.requestId, observation);
        await this.stateStore.markXcmObservationProcessed?.(observation.requestId, {
          finalizedAt: new Date().toISOString(),
          settledVia: finalized?.settledVia,
          status: finalized?.strategyRequest?.statusLabel ?? finalized?.statusLabel ?? observation.status
        });
        this.eventBus?.publish({
          id: `xcm-auto-finalized-${observation.requestId}-${Date.now()}`,
          topic: "xcm.request_auto_finalized",
          wallet: finalized?.strategyRequest?.account ?? finalized?.account,
          wallets: [finalized?.strategyRequest?.account ?? finalized?.account].filter(Boolean),
          timestamp: new Date().toISOString(),
          data: {
            requestId: observation.requestId,
            status: finalized?.strategyRequest?.statusLabel ?? finalized?.statusLabel ?? observation.status,
            settledVia: finalized?.settledVia
          }
        });
        results.push(finalized);
      } catch (error) {
        await this.stateStore.markXcmObservationFailed?.(observation.requestId, error);
        this.eventBus?.publish({
          id: `xcm-auto-finalize-failed-${observation.requestId}-${Date.now()}`,
          topic: "xcm.request_finalize_failed",
          timestamp: new Date().toISOString(),
          data: {
            requestId: observation.requestId,
            message: error?.message ?? "unknown_error"
          }
        });
        this.logger.warn?.({ requestId: observation.requestId, err: error }, "xcm_settlement_watcher.finalize_failed");
      }
    }

    return results;
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
      && Number(existing.settledAssets ?? 0) === Number(incoming.settledAssets ?? 0)
      && Number(existing.settledShares ?? 0) === Number(incoming.settledShares ?? 0)
      && String(existing.remoteRef ?? "") === String(incoming.remoteRef ?? "")
      && String(existing.failureCode ?? "") === String(incoming.failureCode ?? "");
  }
}
