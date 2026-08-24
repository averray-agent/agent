import { ExternalServiceError, ValidationError } from "../core/errors.js";

const DEFAULT_STATE_SCOPE = "external-posting-watcher";
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LAG_BUDGET_SECONDS = 600;

export function resolveExternalPostingWatcherConfig(env = process.env) {
  return {
    feedUrl: resolveFeedUrl(
      env.EXTERNAL_POSTING_WATCHER_FEED_URL,
      env.INDEXER_STATUS_URL
    ),
    pollIntervalMs: positiveInteger(
      env.EXTERNAL_POSTING_WATCHER_POLL_MS,
      DEFAULT_POLL_INTERVAL_MS
    ),
    batchSize: positiveInteger(
      env.EXTERNAL_POSTING_WATCHER_BATCH_SIZE,
      DEFAULT_BATCH_SIZE
    ),
    timeoutMs: positiveInteger(
      env.EXTERNAL_POSTING_WATCHER_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ),
    lagBudgetSeconds: positiveInteger(
      env.EXTERNAL_POSTING_WATCHER_LAG_BUDGET_SECONDS
        ?? env.INDEXER_LAG_BUDGET_SECONDS,
      DEFAULT_LAG_BUDGET_SECONDS
    )
  };
}

export class ExternalPostingWatcherService {
  constructor(
    externalPostingService,
    stateStore,
    eventBus = undefined,
    {
      feedUrl = undefined,
      pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
      batchSize = DEFAULT_BATCH_SIZE,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      lagBudgetSeconds = DEFAULT_LAG_BUDGET_SECONDS,
      logger = console,
      fetchImpl = fetch,
      now = () => new Date(),
      stateScope = DEFAULT_STATE_SCOPE
    } = {}
  ) {
    this.externalPostingService = externalPostingService;
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    this.feedUrl = feedUrl;
    this.enabled = Boolean(feedUrl);
    this.pollIntervalMs = pollIntervalMs;
    this.batchSize = batchSize;
    this.timeoutMs = timeoutMs;
    this.lagBudgetSeconds = lagBudgetSeconds;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.stateScope = stateScope;
    this.running = false;
    this.syncing = false;
    this.timer = undefined;
    this.hydrated = false;
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
    const headMs = Date.parse(state.finalizedBlockTimestamp ?? "");
    const lagSeconds = Number.isFinite(headMs)
      ? Math.max(0, Math.floor((this.currentTime().getTime() - headMs) / 1000))
      : null;
    const current = this.enabled
      && state.caughtUp === true
      && lagSeconds !== null
      && lagSeconds <= this.lagBudgetSeconds
      && !state.lastError;
    return {
      enabled: this.enabled,
      running: this.running,
      syncing: this.syncing,
      current,
      feedUrl: this.feedUrl,
      pollIntervalMs: this.pollIntervalMs,
      batchSize: this.batchSize,
      lagBudgetSeconds: this.lagBudgetSeconds,
      lagSeconds,
      caughtUp: state.caughtUp === true,
      finalizedBlockNumber: state.finalizedBlockNumber,
      finalizedBlockTimestamp: state.finalizedBlockTimestamp,
      cursor: state.cursor,
      lastObservedCount: Number(state.lastObservedCount ?? 0),
      lastMatchedCount: Number(state.lastMatchedCount ?? 0),
      lastMismatchCount: Number(state.lastMismatchCount ?? 0),
      lastUnknownCount: Number(state.lastUnknownCount ?? 0),
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
      await this.hydrateConfirmedProjections();
      const state = await this.stateStore.getServiceState?.(this.stateScope) ?? {};
      let firstExternalPostingRecorded = state.firstExternalPostingRecorded === true;
      let firstExternalPosting;
      const payload = await this.fetchFeed(state.cursor);
      const items = Array.isArray(payload.items) ? payload.items : [];
      const nextCursor = normalizeNextCursor(payload.nextCursor, items.length);
      const finalizedHead = normalizeFinalizedHead(payload.meta);
      const counts = {
        observedCount: 0,
        matchedCount: 0,
        mismatchCount: 0,
        unknownCount: 0
      };

      for (const item of items) {
        const observation = normalizeCreationItem(item);
        const result = await this.externalPostingService.reconcileFinalizedCreation(observation);
        counts.observedCount += 1;
        if (result.outcome === "live") {
          counts.matchedCount += 1;
          if (!firstExternalPostingRecorded) {
            firstExternalPostingRecorded = true;
            firstExternalPosting = {
              jobId: observation.jobId,
              poster: String(observation.poster ?? "").toLowerCase(),
              observedAt: this.currentTime().toISOString()
            };
            this.eventBus?.publish?.({
              id: `first-external-posting-${observation.jobId}`,
              topic: "ops.first_external_posting",
              wallet: firstExternalPosting.poster,
              wallets: firstExternalPosting.poster ? [firstExternalPosting.poster] : [],
              jobId: observation.jobId,
              timestamp: firstExternalPosting.observedAt,
              data: {
                txHash: observation.txHash,
                blockNumber: observation.blockNumber
              }
            });
          }
        }
        if (result.outcome === "mismatch") counts.mismatchCount += 1;
        if (result.outcome === "unknown") counts.unknownCount += 1;
      }

      const nextState = await this.stateStore.upsertServiceState?.(this.stateScope, {
        cursor: nextCursor ?? state.cursor,
        lastObservedCount: counts.observedCount,
        lastMatchedCount: counts.matchedCount,
        lastMismatchCount: counts.mismatchCount,
        lastUnknownCount: counts.unknownCount,
        firstExternalPostingRecorded,
        ...(firstExternalPosting ? { firstExternalPosting } : {}),
        caughtUp: finalizedHead.caughtUp,
        finalizedBlockNumber: finalizedHead.blockNumber,
        finalizedBlockTimestamp: finalizedHead.blockTimestamp,
        lastSyncedAt: this.currentTime().toISOString(),
        lastError: undefined
      }) ?? {};

      this.eventBus?.publish?.({
        id: `external-posting-watcher-synced-${Date.now()}`,
        topic: "external_posting.watcher_synced",
        timestamp: this.currentTime().toISOString(),
        data: {
          ...counts,
          cursor: nextState.cursor,
          caughtUp: finalizedHead.caughtUp,
          finalizedBlockNumber: finalizedHead.blockNumber,
          finalizedBlockTimestamp: finalizedHead.blockTimestamp
        }
      });
      return {
        ...counts,
        cursor: nextState.cursor,
        caughtUp: finalizedHead.caughtUp,
        finalizedBlockNumber: finalizedHead.blockNumber,
        finalizedBlockTimestamp: finalizedHead.blockTimestamp
      };
    } catch (error) {
      await this.stateStore.upsertServiceState?.(this.stateScope, {
        lastError: error?.code ?? error?.message ?? "external_posting_watcher_failed"
      });
      this.eventBus?.publish?.({
        id: `external-posting-watcher-failed-${Date.now()}`,
        topic: "external_posting.watcher_failed",
        timestamp: this.currentTime().toISOString(),
        data: {
          message: error?.message ?? "external_posting_watcher_failed"
        }
      });
      this.logger.warn?.({ err: error }, "external_posting_watcher.sync_failed");
      throw error;
    } finally {
      this.syncing = false;
    }
  }

  async hydrateConfirmedProjections() {
    if (this.hydrated) {
      return;
    }
    await this.externalPostingService.hydrateConfirmedProjections?.();
    this.hydrated = true;
  }

  async fetchFeed(cursor = undefined) {
    if (!this.feedUrl) {
      throw new ValidationError(
        "External posting watcher requires EXTERNAL_POSTING_WATCHER_FEED_URL or INDEXER_STATUS_URL."
      );
    }
    const url = new URL(this.feedUrl);
    url.searchParams.set("limit", String(this.batchSize));
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      throw new ExternalServiceError(
        `External posting indexer feed returned HTTP ${response.status}.`,
        "external_posting_watcher_unavailable",
        { status: response.status, url: url.toString() }
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ExternalServiceError(
        `External posting indexer feed returned invalid JSON: ${error?.message ?? "unknown_error"}`,
        "external_posting_watcher_invalid_json"
      );
    }
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
      throw new ExternalServiceError(
        "External posting indexer feed must include an items array.",
        "external_posting_watcher_invalid_payload"
      );
    }
    return payload;
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
    this.timer = setTimeout(() => {
      void this.scheduleNextTick();
    }, this.pollIntervalMs);
  }

  currentTime() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new ValidationError("External posting watcher clock returned an invalid date.");
    }
    return date;
  }
}

function resolveFeedUrl(explicit, statusUrl) {
  const configured = String(explicit ?? "").trim();
  if (configured) {
    return configured;
  }
  const status = String(statusUrl ?? "").trim();
  if (!status) {
    return undefined;
  }
  try {
    const url = new URL(status);
    url.pathname = "/escrow/job-creations";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNextCursor(value, itemCount) {
  const cursor = typeof value === "string" && value.trim() ? value.trim() : undefined;
  if (itemCount > 0 && !cursor) {
    throw new ValidationError(
      "External posting indexer feed returned items without an advancing cursor."
    );
  }
  return cursor;
}

function normalizeFinalizedHead(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new ValidationError("External posting indexer feed must include finalized head metadata.");
  }
  const blockNumber = normalizeUint(meta.finalizedBlockNumber, "meta.finalizedBlockNumber");
  const blockTimestamp = normalizeIso(meta.finalizedBlockTimestamp, "meta.finalizedBlockTimestamp");
  if (typeof meta.caughtUp !== "boolean") {
    throw new ValidationError(
      "External posting indexer feed must declare whether the finalized backlog is caught up."
    );
  }
  return { blockNumber, blockTimestamp, caughtUp: meta.caughtUp };
}

function normalizeCreationItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new ValidationError("External posting creation feed items must be objects.");
  }
  if (item.finalized !== true) {
    throw new ValidationError("External posting watcher only accepts finalized creation events.");
  }
  return {
    jobId: normalizeBytes32(item.jobId, "jobId"),
    specHash: normalizeBytes32(item.specHash, "specHash"),
    poster: normalizeAddress(item.poster, "poster"),
    asset: normalizeAddress(item.asset, "asset"),
    reward: normalizeUint(item.reward, "reward"),
    opsReserve: normalizeUint(item.opsReserve, "opsReserve"),
    contingencyReserve: normalizeUint(item.contingencyReserve, "contingencyReserve"),
    fundedAt: normalizeIso(item.fundedAt, "fundedAt"),
    txHash: normalizeBytes32(item.txHash, "txHash"),
    blockNumber: normalizeUint(item.blockNumber, "blockNumber"),
    finalized: true
  };
}

function normalizeBytes32(value, field) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/u.test(normalized)) {
    throw new ValidationError(`${field} must be a 32-byte hex value.`);
  }
  return normalized;
}

function normalizeAddress(value, field) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/u.test(normalized)) {
    throw new ValidationError(`${field} must be a 20-byte address.`);
  }
  return normalized;
}

function normalizeUint(value, field) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new ValidationError(`${field} must be an exact unsigned integer string.`);
  }
  return BigInt(normalized).toString();
}

function normalizeIso(value, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`${field} must be an ISO-8601 timestamp.`);
  }
  return new Date(parsed).toISOString();
}
