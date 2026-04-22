type UpstreamFetchContext = {
  cursor?: string;
  limit: number;
};

export type PublishedOutcome = {
  requestId: string;
  status: string;
  settledAssets: string;
  settledShares: string;
  remoteRef: string | null;
  failureCode: string | null;
  observedAt: string;
  source: string;
};

export type SourcePayload = {
  items: PublishedOutcome[];
  nextCursor?: string;
};

type FeedItem = {
  requestId?: unknown;
  status?: unknown;
  settledAssets?: unknown;
  settledShares?: unknown;
  remoteRef?: unknown;
  failureCode?: unknown;
  observedAt?: unknown;
  source?: unknown;
};

type FetchLike = typeof fetch;

export interface XcmUpstreamSourceAdapter {
  type: string;
  describe(): Record<string, unknown>;
  fetchBatch(context: UpstreamFetchContext): Promise<SourcePayload>;
}

function normalizeAmount(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("XCM upstream amounts must be finite non-negative numbers.");
  }
  return String(Math.trunc(parsed));
}

function normalizeOptionalHex32(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const normalized = String(value).trim();
  if (!/^0x[a-fA-F0-9]{64}$/u.test(normalized)) {
    throw new Error("XCM upstream references must be 0x-prefixed 32-byte hex strings.");
  }
  return normalized;
}

function normalizeObservedAt(value: unknown) {
  const observedAt = value ? new Date(value as string | number | Date) : new Date();
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error("XCM upstream observedAt must be ISO-8601 when provided.");
  }
  return observedAt.toISOString();
}

function normalizeStatus(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!["succeeded", "failed", "cancelled"].includes(normalized)) {
    throw new Error("XCM upstream items must use a terminal status.");
  }
  return normalized;
}

function normalizeFeedItem(item: unknown, fallbackSource = "external_xcm_source"): PublishedOutcome {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("XCM upstream items must be objects.");
  }
  const sourceItem = item as FeedItem;
  const requestId = String(sourceItem.requestId ?? "");
  if (!/^0x[a-fA-F0-9]{64}$/u.test(requestId)) {
    throw new Error("XCM upstream requestId must be a 0x-prefixed 32-byte hex string.");
  }
  return {
    requestId,
    status: normalizeStatus(sourceItem.status),
    settledAssets: normalizeAmount(sourceItem.settledAssets),
    settledShares: normalizeAmount(sourceItem.settledShares),
    remoteRef: normalizeOptionalHex32(sourceItem.remoteRef),
    failureCode: normalizeOptionalHex32(sourceItem.failureCode),
    observedAt: normalizeObservedAt(sourceItem.observedAt),
    source: typeof sourceItem.source === "string" && sourceItem.source.trim()
      ? sourceItem.source.trim()
      : fallbackSource
  };
}

export class HttpFeedSourceAdapter implements XcmUpstreamSourceAdapter {
  type = "feed";
  url: string;
  authToken?: string;
  fetchImpl: FetchLike;

  constructor({ url, authToken, fetchImpl = fetch }: { url: string; authToken?: string; fetchImpl?: FetchLike }) {
    this.url = url;
    this.authToken = authToken;
    this.fetchImpl = fetchImpl;
  }

  describe() {
    return {
      type: this.type,
      url: this.url
    };
  }

  async fetchBatch({ cursor, limit }: UpstreamFetchContext): Promise<SourcePayload> {
    const url = new URL(this.url);
    url.searchParams.set("limit", String(limit));
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
      throw new Error(`XCM feed source returned HTTP ${response.status}.`);
    }
    const payload = await response.json() as { items?: unknown[]; nextCursor?: unknown };
    if (!Array.isArray(payload?.items)) {
      throw new Error("XCM feed source payload must include an items array.");
    }
    return {
      items: payload.items.map((item) => normalizeFeedItem(item, "external_xcm_source")),
      nextCursor: typeof payload.nextCursor === "string" && payload.nextCursor.trim()
        ? payload.nextCursor.trim()
        : undefined
    };
  }
}

type SubscanXcmRecord = Record<string, unknown>;

/**
 * Initial real-source adapter for Subscan's official XCM API.
 *
 * Notes:
 * - Auth and endpoint names come from Subscan's official docs.
 * - Exact field names inside `data.list` are inferred from Subscan's common
 *   list conventions because the paid-plan payload could not be live-validated
 *   from this environment. Parsing is intentionally defensive.
 */
export class SubscanXcmSourceAdapter implements XcmUpstreamSourceAdapter {
  type = "subscan_xcm";
  apiHost: string;
  apiKey: string;
  fetchImpl: FetchLike;

  constructor({ apiHost, apiKey, fetchImpl = fetch }: { apiHost: string; apiKey: string; fetchImpl?: FetchLike }) {
    this.apiHost = apiHost.replace(/\/+$/u, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  describe() {
    return {
      type: this.type,
      apiHost: this.apiHost
    };
  }

  async fetchBatch({ cursor, limit }: UpstreamFetchContext): Promise<SourcePayload> {
    const page = this.decodePageCursor(cursor);
    const response = await this.fetchImpl(`${this.apiHost}/api/scan/xcm/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey
      },
      body: JSON.stringify({
        page,
        row: limit,
        order: "asc"
      })
    });
    if (!response.ok) {
      throw new Error(`Subscan XCM source returned HTTP ${response.status}.`);
    }
    const payload = await response.json() as {
      code?: number;
      message?: string;
      data?: {
        list?: unknown[];
        count?: number;
      };
    };
    if (payload?.code && payload.code !== 0) {
      throw new Error(`Subscan XCM source error: ${payload.message ?? `code ${payload.code}`}`);
    }
    const list = Array.isArray(payload?.data?.list) ? payload.data.list : [];
    const items = list
      .map((entry) => this.normalizeSubscanEntry(entry as SubscanXcmRecord))
      .filter((entry): entry is PublishedOutcome => Boolean(entry));
    const nextCursor = list.length >= limit ? this.encodePageCursor(page + 1) : undefined;
    return {
      items,
      nextCursor
    };
  }

  decodePageCursor(cursor: string | undefined) {
    if (!cursor) return 0;
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { page?: number };
      const page = decoded.page;
      return typeof page === "number" && Number.isInteger(page) && page >= 0 ? page : 0;
    } catch {
      return 0;
    }
  }

  encodePageCursor(page: number) {
    return Buffer.from(JSON.stringify({ page }), "utf8").toString("base64url");
  }

  normalizeSubscanEntry(entry: SubscanXcmRecord): PublishedOutcome | undefined {
    const requestId = this.pickString(entry, [
      "msg_hash",
      "message_hash",
      "extrinsic_hash",
      "hash"
    ]);
    if (!requestId || !/^0x[a-fA-F0-9]{64}$/u.test(requestId)) {
      return undefined;
    }

    const rawStatus = this.pickString(entry, ["status", "execution_status", "state"])?.toLowerCase();
    const status = rawStatus?.includes("success")
      ? "succeeded"
      : rawStatus?.includes("fail")
        ? "failed"
        : rawStatus?.includes("cancel")
          ? "cancelled"
          : undefined;
    if (!status) {
      return undefined;
    }

    return {
      requestId,
      status,
      settledAssets: "0",
      settledShares: "0",
      remoteRef: normalizeOptionalHex32(this.pickString(entry, ["remote_ref", "query_id"])),
      failureCode: rawStatus === "failed"
        ? normalizeOptionalHex32(this.pickString(entry, ["error_code", "failure_code"]))
        : null,
      observedAt: normalizeObservedAt(this.pickString(entry, ["block_timestamp", "timestamp", "time"])),
      source: "subscan_xcm_api"
    };
  }

  pickString(entry: SubscanXcmRecord, keys: string[]) {
    for (const key of keys) {
      const value = entry[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
    }
    return undefined;
  }
}

export function createXcmUpstreamSourceAdapter({
  type = "feed",
  url,
  authToken,
  apiHost,
  apiKey,
  fetchImpl
}: {
  type?: string;
  url?: string;
  authToken?: string;
  apiHost?: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
}) {
  if (type === "subscan_xcm") {
    if (!apiHost || !apiKey) {
      throw new Error("Subscan XCM source requires XCM_SUBSCAN_API_HOST and XCM_SUBSCAN_API_KEY.");
    }
    return new SubscanXcmSourceAdapter({
      apiHost,
      apiKey,
      fetchImpl
    });
  }
  if (!url) {
    throw new Error("Feed source requires XCM_EXTERNAL_SOURCE_URL.");
  }
  return new HttpFeedSourceAdapter({
    url,
    authToken,
    fetchImpl
  });
}
