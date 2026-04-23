import { sql } from "drizzle-orm";

import { db } from "ponder:api";

import {
  createXcmUpstreamSourceAdapter,
  type PublishedOutcome,
  type XcmUpstreamSourceAdapter
} from "./xcm-upstream-source";

const DEFAULT_SCOPE = "xcm-outcome-publisher";

type PublisherState = {
  cursor?: string;
  lastSyncedAt?: string;
  lastObservedCount?: number;
  lastError?: string;
};

type PublisherOptions = {
  enabled?: boolean;
  sourceType?: string;
  sourceUrl?: string;
  authToken?: string;
  apiHost?: string;
  apiKey?: string;
  nativeHubWs?: string;
  nativeBifrostWs?: string;
  nativeStartBlock?: number;
  nativeConfirmations?: number;
  pollIntervalMs?: number;
  batchSize?: number;
  scope?: string;
  fetchImpl?: typeof fetch;
  logger?: { warn?: (...args: any[]) => void };
};

function rowsOf(result: any) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

export class XcmOutcomePublisherService {
  enabled: boolean;
  sourceType: string;
  sourceUrl?: string;
  authToken?: string;
  apiHost?: string;
  pollIntervalMs: number;
  batchSize: number;
  scope: string;
  fetchImpl: typeof fetch;
  logger: { warn?: (...args: any[]) => void };
  running: boolean;
  syncing: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  initPromise: Promise<void> | undefined;
  sourceAdapter: XcmUpstreamSourceAdapter | undefined;

  constructor({
    enabled = false,
    sourceType = "feed",
    sourceUrl = undefined,
    authToken = undefined,
    apiHost = undefined,
    apiKey = undefined,
    nativeHubWs = undefined,
    nativeBifrostWs = undefined,
    nativeStartBlock = undefined,
    nativeConfirmations = undefined,
    pollIntervalMs = 30_000,
    batchSize = 25,
    scope = DEFAULT_SCOPE,
    fetchImpl = fetch,
    logger = console
  }: PublisherOptions = {}) {
    this.enabled = enabled;
    this.sourceType = sourceType;
    this.sourceUrl = sourceUrl;
    this.authToken = authToken;
    this.apiHost = apiHost;
    this.pollIntervalMs = pollIntervalMs;
    this.batchSize = batchSize;
    this.scope = scope;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.running = false;
    this.syncing = false;
    this.timer = undefined;
    this.initPromise = undefined;
    this.sourceAdapter = this.enabled
      ? createXcmUpstreamSourceAdapter({
        type: this.sourceType,
        url: this.sourceUrl,
        authToken: this.authToken,
        apiHost: this.apiHost,
        apiKey,
        nativeHubWs,
        nativeBifrostWs,
        nativeStartBlock,
        nativeConfirmations,
        fetchImpl: this.fetchImpl
      })
      : undefined;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = this.ensureTables();
    }
    await this.initPromise;
    return this;
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
    await this.init();
    const state = await this.getState();
    const count = await this.getPublishedOutcomeCount();
    return {
      enabled: this.enabled,
      running: this.running,
      syncing: this.syncing,
      source: this.sourceAdapter?.describe() ?? {
        type: this.sourceType,
        url: this.sourceUrl
      },
      batchSize: this.batchSize,
      pollIntervalMs: this.pollIntervalMs,
      cursor: state.cursor,
      lastObservedCount: Number(state.lastObservedCount ?? 0),
      lastSyncedAt: state.lastSyncedAt,
      lastError: state.lastError,
      publishedCount: count
    };
  }

  async hasPublishedOutcomes() {
    await this.init();
    return (await this.getPublishedOutcomeCount()) > 0;
  }

  async listPublishedOutcomes({ cursor, limit }: { cursor?: { mode: "external"; observedAt: string; requestId: string } | { mode: "indexed"; blockNumber: bigint; requestId: string }; limit: number }) {
    await this.init();
    const where = cursor?.mode === "external"
      ? sql`
        WHERE observed_at > ${cursor.observedAt}
        OR (observed_at = ${cursor.observedAt} AND request_id > ${cursor.requestId})
      `
      : sql``;
    const result = await db.execute(sql`
      SELECT
        request_id,
        status,
        settled_assets::text AS settled_assets,
        settled_shares::text AS settled_shares,
        remote_ref,
        failure_code,
        observed_at,
        source
      FROM xcm_external_outcomes
      ${where}
      ORDER BY observed_at ASC, request_id ASC
      LIMIT ${limit + 1}
    `);
    const rows = rowsOf(result);
    const page = rows.slice(0, limit) as Array<{
      request_id: string;
      status: string;
      settled_assets: string;
      settled_shares: string;
      remote_ref: string | null;
      failure_code: string | null;
      observed_at: string | Date;
      source: string;
    }>;
    const nextCursor = rows.length > limit
      ? {
        mode: "external",
        observedAt: new Date(page[page.length - 1]!.observed_at).toISOString(),
        requestId: String(page[page.length - 1]!.request_id)
      }
      : undefined;
    return {
      items: page.map((row) => ({
        requestId: String(row.request_id),
        status: String(row.status),
        settledAssets: String(row.settled_assets),
        settledShares: String(row.settled_shares),
        remoteRef: row.remote_ref ? String(row.remote_ref) : undefined,
        failureCode: row.failure_code ? String(row.failure_code) : undefined,
        observedAt: new Date(row.observed_at).toISOString(),
        source: String(row.source)
      })),
      nextCursor
    };
  }

  async pollOnce() {
    if (!this.enabled) {
      return { observedCount: 0, skipped: true, reason: "disabled" };
    }
    if (this.syncing) {
      return { observedCount: 0, skipped: true, reason: "in_flight" };
    }

    await this.init();
    this.syncing = true;
    try {
      const state = await this.getState();
      if (!this.sourceAdapter) {
        throw new Error("XCM outcome publisher source adapter is not configured.");
      }
      const payload = await this.sourceAdapter.fetchBatch({
        cursor: state.cursor,
        limit: this.batchSize
      });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      let observedCount = 0;

      for (const outcome of items) {
        await this.upsertOutcome(outcome);
        observedCount += 1;
      }

      await this.setState({
        cursor: typeof payload?.nextCursor === "string" && payload.nextCursor.trim()
          ? payload.nextCursor.trim()
          : state.cursor,
        lastObservedCount: observedCount,
        lastSyncedAt: new Date().toISOString(),
        lastError: undefined
      });

      return {
        observedCount,
        cursor: typeof payload?.nextCursor === "string" && payload.nextCursor.trim()
          ? payload.nextCursor.trim()
          : state.cursor
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "xcm_outcome_publisher_failed";
      await this.setState({
        lastError: message
      });
      this.logger.warn?.({ err: error }, "xcm_outcome_publisher.sync_failed");
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

  async ensureTables() {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS xcm_external_outcomes (
        request_id text PRIMARY KEY,
        status text NOT NULL,
        settled_assets numeric NOT NULL DEFAULT 0,
        settled_shares numeric NOT NULL DEFAULT 0,
        remote_ref text,
        failure_code text,
        observed_at timestamptz NOT NULL,
        source text NOT NULL,
        ingested_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS xcm_external_outcomes_order_idx
      ON xcm_external_outcomes (observed_at, request_id)
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS xcm_external_observer_state (
        scope text PRIMARY KEY,
        cursor text,
        last_synced_at timestamptz,
        last_observed_count integer NOT NULL DEFAULT 0,
        last_error text
      )
    `);
  }

  async getState(): Promise<PublisherState> {
    const result = await db.execute(sql`
      SELECT
        cursor,
        last_synced_at,
        last_observed_count,
        last_error
      FROM xcm_external_observer_state
      WHERE scope = ${this.scope}
      LIMIT 1
    `);
    const row = rowsOf(result)[0];
    return {
      cursor: row?.cursor ? String(row.cursor) : undefined,
      lastSyncedAt: row?.last_synced_at ? new Date(row.last_synced_at).toISOString() : undefined,
      lastObservedCount: row?.last_observed_count ? Number(row.last_observed_count) : 0,
      lastError: row?.last_error ? String(row.last_error) : undefined
    };
  }

  async setState({
    cursor = undefined,
    lastSyncedAt = undefined,
    lastObservedCount = undefined,
    lastError = undefined
  }: PublisherState) {
    await db.execute(sql`
      INSERT INTO xcm_external_observer_state (
        scope,
        cursor,
        last_synced_at,
        last_observed_count,
        last_error
      ) VALUES (
        ${this.scope},
        ${cursor ?? null},
        ${lastSyncedAt ?? null},
        ${lastObservedCount ?? 0},
        ${lastError ?? null}
      )
      ON CONFLICT (scope) DO UPDATE SET
        cursor = COALESCE(EXCLUDED.cursor, xcm_external_observer_state.cursor),
        last_synced_at = COALESCE(EXCLUDED.last_synced_at, xcm_external_observer_state.last_synced_at),
        last_observed_count = COALESCE(EXCLUDED.last_observed_count, xcm_external_observer_state.last_observed_count),
        last_error = EXCLUDED.last_error
    `);
  }

  async upsertOutcome(outcome: PublishedOutcome) {
    await db.execute(sql`
      INSERT INTO xcm_external_outcomes (
        request_id,
        status,
        settled_assets,
        settled_shares,
        remote_ref,
        failure_code,
        observed_at,
        source
      ) VALUES (
        ${outcome.requestId},
        ${outcome.status},
        ${outcome.settledAssets},
        ${outcome.settledShares},
        ${outcome.remoteRef},
        ${outcome.failureCode},
        ${outcome.observedAt},
        ${outcome.source}
      )
      ON CONFLICT (request_id) DO UPDATE SET
        status = EXCLUDED.status,
        settled_assets = EXCLUDED.settled_assets,
        settled_shares = EXCLUDED.settled_shares,
        remote_ref = EXCLUDED.remote_ref,
        failure_code = EXCLUDED.failure_code,
        observed_at = EXCLUDED.observed_at,
        source = EXCLUDED.source,
        ingested_at = now()
    `);
  }

  async getPublishedOutcomeCount() {
    const result = await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM xcm_external_outcomes
    `);
    return Number(rowsOf(result)[0]?.count ?? 0);
  }
}
