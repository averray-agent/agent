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

type NativePapiSourceConfig = {
  hubWs: string;
  bifrostWs: string;
  startBlock?: number;
  confirmations?: number;
};

export type NativeXcmEvidence = {
  requestId: string;
  status: string;
  settledAssets?: unknown;
  settledShares?: unknown;
  remoteRef?: unknown;
  failureCode?: unknown;
  observedAt?: unknown;
  source?: unknown;
  hub?: Record<string, unknown>;
  bifrost?: Record<string, unknown>;
  correlation?: Record<string, unknown>;
  decision?: Record<string, unknown>;
};

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

export function encodeNativePapiCursor({
  hubBlock,
  bifrostBlock
}: {
  hubBlock: number;
  bifrostBlock: number;
}) {
  if (!Number.isInteger(hubBlock) || hubBlock < 0 || !Number.isInteger(bifrostBlock) || bifrostBlock < 0) {
    throw new Error("Native PAPI cursor blocks must be non-negative integers.");
  }
  return Buffer.from(JSON.stringify({ hubBlock, bifrostBlock }), "utf8").toString("base64url");
}

export function decodeNativePapiCursor(cursor: string | undefined, fallbackStartBlock = 0) {
  if (!cursor) {
    return {
      hubBlock: fallbackStartBlock,
      bifrostBlock: fallbackStartBlock
    };
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      hubBlock?: unknown;
      bifrostBlock?: unknown;
    };
    const hubBlock = Number(decoded.hubBlock);
    const bifrostBlock = Number(decoded.bifrostBlock);
    if (
      Number.isInteger(hubBlock) &&
      hubBlock >= 0 &&
      Number.isInteger(bifrostBlock) &&
      bifrostBlock >= 0
    ) {
      return { hubBlock, bifrostBlock };
    }
  } catch {}
  return {
    hubBlock: fallbackStartBlock,
    bifrostBlock: fallbackStartBlock
  };
}

export function normalizeNativeXcmEvidence(evidence: NativeXcmEvidence): PublishedOutcome {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("Native XCM evidence must be an object.");
  }
  validateNativeCorrelationGate(evidence);
  return normalizeFeedItem({
    requestId: evidence.requestId,
    status: evidence.status,
    settledAssets: evidence.settledAssets ?? evidence.decision?.settledAssets ?? 0,
    settledShares: evidence.settledShares ?? evidence.decision?.settledShares ?? 0,
    remoteRef: evidence.remoteRef ?? evidence.decision?.remoteRef,
    failureCode: evidence.failureCode ?? evidence.decision?.failureCode,
    observedAt: evidence.observedAt ?? evidence.decision?.observedAt,
    source: typeof evidence.source === "string" && evidence.source.trim()
      ? evidence.source.trim()
      : "native_papi_observer"
  }, "native_papi_observer");
}

export function validateNativeCorrelationGate(evidence: NativeXcmEvidence) {
  const requestId = String(evidence.requestId ?? "");
  if (!/^0x[a-fA-F0-9]{64}$/u.test(requestId)) {
    throw new Error("Native XCM evidence requestId must be a 0x-prefixed 32-byte hex string.");
  }

  const correlation = evidence.correlation ?? {};
  const method = String(correlation.method ?? "").trim().toLowerCase();
  const confidence = String(correlation.confidence ?? "staging").trim().toLowerCase();
  if (!["request_id_in_message", "remote_ref", "ledger_join"].includes(method)) {
    throw new Error("Native XCM evidence correlation.method must be request_id_in_message, remote_ref, or ledger_join.");
  }
  if (!["staging", "production_candidate", "production"].includes(confidence)) {
    throw new Error("Native XCM evidence correlation.confidence must be staging, production_candidate, or production.");
  }

  if (method === "request_id_in_message") {
    assertTopicMatchesRequest(evidence.hub, requestId, "hub");
    if (confidence !== "staging") {
      assertTopicMatchesRequest(evidence.bifrost, requestId, "bifrost");
    }
    return;
  }

  if (method === "remote_ref") {
    normalizeOptionalHex32(evidence.remoteRef ?? evidence.decision?.remoteRef);
    if (!normalizeOptionalHex32(evidence.remoteRef ?? evidence.decision?.remoteRef)) {
      throw new Error("Native XCM remote_ref correlation requires remoteRef.");
    }
    return;
  }

  if (confidence !== "staging") {
    throw new Error("Native XCM ledger_join correlation is staging-only and cannot be production_candidate or production.");
  }
}

function assertTopicMatchesRequest(evidence: Record<string, unknown> | undefined, requestId: string, label: string) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error(`Native XCM ${label} evidence is required for request_id_in_message correlation.`);
  }
  const topic = pickEvidenceTopic(evidence);
  if (!topic) {
    throw new Error(`Native XCM ${label} evidence must include messageTopic/topic for request_id_in_message correlation.`);
  }
  if (topic.toLowerCase() !== requestId.toLowerCase()) {
    throw new Error(`Native XCM ${label} message topic must equal requestId.`);
  }
}

function pickEvidenceTopic(evidence: Record<string, unknown>) {
  for (const key of ["messageTopic", "message_topic", "topic", "setTopic", "set_topic"]) {
    const value = evidence[key];
    if (typeof value === "string" && value.trim()) {
      const normalized = value.trim();
      if (!/^0x[a-fA-F0-9]{64}$/u.test(normalized)) {
        throw new Error("Native XCM evidence topic must be a 0x-prefixed 32-byte hex string.");
      }
      return normalized;
    }
  }
  return undefined;
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

export class NativePapiXcmSourceAdapter implements XcmUpstreamSourceAdapter {
  type = "native_papi";
  hubWs: string;
  bifrostWs: string;
  startBlock: number;
  confirmations: number;

  constructor({
    hubWs,
    bifrostWs,
    startBlock = 0,
    confirmations = 2
  }: NativePapiSourceConfig) {
    this.hubWs = hubWs;
    this.bifrostWs = bifrostWs;
    this.startBlock = startBlock;
    this.confirmations = confirmations;
    if (!this.hubWs || !this.bifrostWs) {
      throw new Error("Native PAPI XCM source requires XCM_NATIVE_HUB_WS and XCM_NATIVE_BIFROST_WS.");
    }
    if (!Number.isInteger(this.startBlock) || this.startBlock < 0) {
      throw new Error("XCM_NATIVE_START_BLOCK must be a non-negative integer when provided.");
    }
    if (!Number.isInteger(this.confirmations) || this.confirmations < 0) {
      throw new Error("XCM_NATIVE_CONFIRMATIONS must be a non-negative integer when provided.");
    }
  }

  describe() {
    return {
      type: this.type,
      hubWs: this.hubWs,
      bifrostWs: this.bifrostWs,
      startBlock: this.startBlock,
      confirmations: this.confirmations
    };
  }

  decodeCursor(cursor: string | undefined) {
    return decodeNativePapiCursor(cursor, this.startBlock);
  }

  encodeCursor(cursor: { hubBlock: number; bifrostBlock: number }) {
    return encodeNativePapiCursor(cursor);
  }

  evidenceToOutcome(evidence: NativeXcmEvidence) {
    return normalizeNativeXcmEvidence(evidence);
  }

  async fetchBatch({ cursor }: UpstreamFetchContext): Promise<SourcePayload> {
    this.decodeCursor(cursor);
    throw new Error(
      "Native PAPI XCM source is configured but live chain reads are not implemented yet. Complete the requestId correlation gate in docs/NATIVE_XCM_OBSERVER.md before enabling settlement from native_papi."
    );
  }
}

export function createXcmUpstreamSourceAdapter({
  type = "feed",
  url,
  authToken,
  apiHost,
  apiKey,
  nativeHubWs,
  nativeBifrostWs,
  nativeStartBlock,
  nativeConfirmations,
  fetchImpl
}: {
  type?: string;
  url?: string;
  authToken?: string;
  apiHost?: string;
  apiKey?: string;
  nativeHubWs?: string;
  nativeBifrostWs?: string;
  nativeStartBlock?: number;
  nativeConfirmations?: number;
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
  if (type === "native_papi") {
    if (!nativeHubWs || !nativeBifrostWs) {
      throw new Error("Native PAPI XCM source requires XCM_NATIVE_HUB_WS and XCM_NATIVE_BIFROST_WS.");
    }
    return new NativePapiXcmSourceAdapter({
      hubWs: nativeHubWs,
      bifrostWs: nativeBifrostWs,
      startBlock: nativeStartBlock,
      confirmations: nativeConfirmations
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
