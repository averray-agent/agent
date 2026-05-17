import { ExternalServiceError, ValidationError } from "../core/errors.js";

const DEFAULT_SCOPE = "xcm-observation-relay";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const UINT256_MAX = (1n << 256n) - 1n;

export class XcmObservationRelayService {
  constructor(
    platformService,
    stateStore,
    eventBus = undefined,
    {
      enabled = false,
      feedUrl = undefined,
      authToken = undefined,
      pollIntervalMs = 30_000,
      batchSize = 25,
      logger = console,
      fetchImpl = fetch,
      stateScope = DEFAULT_SCOPE
    } = {}
  ) {
    this.platformService = platformService;
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    this.enabled = enabled && Boolean(feedUrl);
    this.feedUrl = feedUrl;
    this.authToken = authToken;
    this.pollIntervalMs = pollIntervalMs;
    this.batchSize = batchSize;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.stateScope = stateScope;
    this.running = false;
    this.timer = undefined;
    this.syncing = false;
  }

  start() {
    if (!this.enabled || this.running) {
      return;
    }
    this.running = true;
    void this.scheduleNextTick();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async getStatus() {
    const state = await this.stateStore.getServiceState?.(this.stateScope) ?? {};
    return {
      enabled: this.enabled,
      running: this.running,
      syncing: this.syncing,
      feedUrl: this.feedUrl,
      batchSize: this.batchSize,
      pollIntervalMs: this.pollIntervalMs,
      cursor: state.cursor,
      lastObservedCount: Number(state.lastObservedCount ?? 0),
      lastSyncedAt: state.lastSyncedAt,
      lastError: state.lastError,
      updatedAt: state.updatedAt
    };
  }

  async pollOnce() {
    if (!this.enabled) {
      return { observedCount: 0, skipped: true, reason: "disabled" };
    }
    if (this.syncing) {
      return { observedCount: 0, skipped: true, reason: "in_flight" };
    }

    this.syncing = true;
    try {
      const state = await this.stateStore.getServiceState?.(this.stateScope) ?? {};
      const payload = await this.fetchFeed(state.cursor);
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const nextCursor = this.normalizeNextCursor(payload?.nextCursor, items.length);
      let observedCount = 0;

      for (const item of items) {
        const normalized = this.normalizeOutcomeItem(item);
        await this.platformService.observeXcmOutcome(normalized.requestId, normalized);
        this.eventBus?.publish({
          id: `xcm-observer-relayed-${normalized.requestId}-${Date.now()}`,
          topic: "xcm.outcome_relayed",
          correlationId: normalized.requestId,
          timestamp: new Date().toISOString(),
          data: {
            requestId: normalized.requestId,
            status: normalized.status,
            settledAssets: normalized.settledAssets,
            settledAssetsRaw: normalized.settledAssets,
            settledShares: normalized.settledShares,
            settledSharesRaw: normalized.settledShares,
            remoteRef: normalized.remoteRef,
            failureCode: normalized.failureCode,
            observedAt: normalized.observedAt,
            source: normalized.source
          }
        });
        observedCount += 1;
      }

      const nextState = await this.stateStore.upsertServiceState?.(this.stateScope, {
        cursor: nextCursor ?? state.cursor,
        lastObservedCount: observedCount,
        lastSyncedAt: new Date().toISOString(),
        lastError: undefined
      }) ?? {};

      this.eventBus?.publish({
        id: `xcm-observer-synced-${Date.now()}`,
        topic: "xcm.observer_synced",
        timestamp: new Date().toISOString(),
        data: {
          observedCount,
          cursor: nextState.cursor
        }
      });

      return {
        observedCount,
        cursor: nextState.cursor
      };
    } catch (error) {
      await this.stateStore.upsertServiceState?.(this.stateScope, {
        lastError: error?.message ?? "xcm_observer_failed"
      });
      this.eventBus?.publish({
        id: `xcm-observer-failed-${Date.now()}`,
        topic: "xcm.observer_failed",
        timestamp: new Date().toISOString(),
        data: {
          message: error?.message ?? "xcm_observer_failed"
        }
      });
      this.logger.warn?.({ err: error }, "xcm_observation_relay.sync_failed");
      throw error;
    } finally {
      this.syncing = false;
    }
  }

  async scheduleNextTick() {
    if (!this.enabled || !this.running) {
      return;
    }
    try {
      await this.pollOnce();
    } catch {}
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

  async fetchFeed(cursor = undefined) {
    if (!this.feedUrl) {
      throw new ValidationError("XCM observation relay requires XCM_OBSERVER_FEED_URL.");
    }
    const url = new URL(this.feedUrl);
    url.searchParams.set("limit", String(this.batchSize));
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {})
      }
    });

    if (!response.ok) {
      throw new ExternalServiceError(
        `XCM observer feed returned HTTP ${response.status}.`,
        "xcm_observer_unavailable",
        {
          status: response.status,
          url: url.toString()
        }
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ExternalServiceError(
        `XCM observer feed returned invalid JSON: ${error?.message ?? "unknown_error"}`,
        "xcm_observer_invalid_json"
      );
    }

    if (!payload || typeof payload !== "object") {
      throw new ExternalServiceError("XCM observer feed returned an invalid payload.", "xcm_observer_invalid_payload");
    }
    if (!Array.isArray(payload.items)) {
      throw new ExternalServiceError("XCM observer feed payload must include an items array.", "xcm_observer_invalid_payload");
    }
    return payload;
  }

  normalizeOutcomeItem(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ValidationError("XCM observer items must be objects.");
    }
    const requestId = this.requireRequestId(item.requestId);
    const status = this.normalizeStatus(item.status);
    return {
      requestId,
      status,
      settledAssets: this.normalizeUint256(item.settledAssets, "settledAssets"),
      settledShares: this.normalizeUint256(item.settledShares, "settledShares"),
      remoteRef: this.normalizeOptionalHex32(item.remoteRef),
      failureCode: this.normalizeFailureCode(item.failureCode, status),
      source: typeof item.source === "string" && item.source.trim() ? item.source.trim() : "xcm_relay_feed",
      observedAt: this.normalizeObservedAt(item.observedAt)
    };
  }

  normalizeStatus(status) {
    let normalized;
    if (typeof status === "number") {
      normalized = ["unknown", "pending", "succeeded", "failed", "cancelled"][status] ?? "unknown";
    } else {
      normalized = String(status ?? "").trim().toLowerCase();
    }
    if (!TERMINAL_STATUSES.has(normalized)) {
      throw new ValidationError("XCM observer items must use a terminal status.");
    }
    return normalized;
  }

  normalizeNextCursor(value, itemCount) {
    const nextCursor = typeof value === "string" && value.trim() ? value.trim() : undefined;
    if (itemCount > 0 && !nextCursor) {
      throw new ValidationError("XCM observer feed returned items without nextCursor; non-empty XCM batches must advance the cursor.");
    }
    return nextCursor;
  }

  normalizeFailureCode(value, status) {
    const failureCode = this.normalizeOptionalHex32(value);
    if (status === "failed" && !failureCode) {
      throw new ValidationError("XCM observer failed items must include failureCode.");
    }
    return failureCode;
  }

  normalizeUint256(value, label) {
    if (value === undefined || value === null || value === "") {
      return "0";
    }

    let parsed;
    if (typeof value === "bigint") {
      parsed = value;
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new ValidationError(`XCM observer ${label} must be an exact non-negative uint256.`);
      }
      parsed = BigInt(value);
    } else if (typeof value === "string") {
      const normalized = value.trim();
      if (!/^\d+$/u.test(normalized)) {
        throw new ValidationError(`XCM observer ${label} must be an exact non-negative uint256.`);
      }
      parsed = BigInt(normalized);
    } else {
      throw new ValidationError(`XCM observer ${label} must be an exact non-negative uint256.`);
    }

    if (parsed < 0n || parsed > UINT256_MAX) {
      throw new ValidationError(`XCM observer ${label} must fit uint256.`);
    }
    return parsed.toString();
  }

  normalizeOptionalHex32(value) {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    const normalized = String(value).trim();
    if (!/^0x[a-fA-F0-9]{64}$/u.test(normalized)) {
      throw new ValidationError("Optional XCM observer references must be 0x-prefixed 32-byte hex strings.");
    }
    return normalized;
  }

  normalizeObservedAt(value) {
    if (value === undefined || value === null || value === "") {
      return new Date().toISOString();
    }
    const observedAt = new Date(value);
    if (Number.isNaN(observedAt.getTime())) {
      throw new ValidationError("observedAt must be ISO-8601 when provided.");
    }
    return observedAt.toISOString();
  }

  requireRequestId(requestId) {
    if (typeof requestId !== "string" || !/^0x[a-fA-F0-9]{64}$/u.test(requestId)) {
      throw new ValidationError("requestId must be a 0x-prefixed 32-byte hex string.");
    }
    return requestId;
  }
}
