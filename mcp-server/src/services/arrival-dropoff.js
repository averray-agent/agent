import { ARRIVAL_STAGES } from "./arrival-stage-map.js";

export const NOT_REPORTED = "not reported";
export const DROP_OFF_TOP_CODES = 8;
export const DROP_OFF_ACTORS = Object.freeze(["external", "self", "ambiguous", "unclassified"]);
export const DROP_OFF_DOORS = Object.freeze(["mcp", "http"]);
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_MS = 7 * DAY_MS;

/**
 * Exact `errorsByStage` object served on GET /monitor/arrivals.
 * Schema stays averray.arrivals.v1. The field is additive.
 *
 * This counts error responses by the stage of that request. It does not know
 * whether the visitor stopped. One pre-auth request is one visit for this
 * count: a 429 on GET /jobs followed by a claim still reports
 * browsed `429:rate_limited`. Sessioned visits are not collapsed to a last stage.
 *
 * Absence of `errorsByStage` means not reported. A consumer must not coerce
 * absence, or the string "not reported", to 0.
 *
 * {
 *   absentMeans: "not reported",
 *   measures: "error responses by stage; one pre-auth request = one visit",
 *   collectionSinceMs: number | null,
 *   sinceCutover: DoorBlock | "not reported",
 *   "24h": DoorBlock | "not reported",
 *   "7d": DoorBlock | "not reported"
 * }
 *
 * A window is the string "not reported" until collectionSinceMs covers that
 * whole window, and whenever the arrival state could not be read — including
 * after a successful load, if a later read fails.
 * `sinceCutover` is the measured span since collection started. It is not a
 * 24h or 7d total.
 *
 * Hour buckets that start before the window are excluded, so "24h" never
 * includes the partially overlapping 25th hour. The current partial hour is
 * included.
 *
 * DoorBlock: { mcp: Actors, http: Actors }
 * Actors: { external, self, ambiguous, unclassified }, each a Stages object.
 * `unclassified` is protocol garbage only (-32700 / -32600 before a valid
 * JSON-RPC request). It is never folded into external.
 * Stages: one key per funnel stage, value a CodeCounts object.
 * CodeCounts: { [code]: positive integer }, highest count first, at most 8
 * codes, remainder folded into "other". An empty object means the stage was
 * measured and no error response was counted there. Codes are an allow-list
 * plus "other". HTTP codes are `${status}:${errorCode}`. MCP JSON-RPC codes
 * are the numeric code as a string (`"-32601"`). Tool errors are the
 * application code (`"rate_limited"`). Messages and bodies are never stored.
 */
export const DROP_OFF_FIELD_NOTE =
  "errorsByStage is additive on averray.arrivals.v1; error responses by stage, one pre-auth request = one visit; absence and \"not reported\" are not zero";

const HTTP_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429, 500, 502, 503]);
const APP_CODES = new Set([
  "invalid_request",
  "invalid_submission_shape",
  "not_found",
  "conflict",
  "invalid_configuration",
  "upstream_failure",
  "chain_backend_required",
  "blockchain_revert",
  "insufficient_liquidity",
  "borrow_capacity_exceeded",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "missing_capability",
  "missing_role",
  "invalid_token_kind",
  "missing_subject",
  "token_revoked",
  "internal_error",
  "idempotency_key_payload_mismatch",
  "idempotency_key_in_flight"
]);
const JSONRPC_CODES = new Set([
  -32700, -32600, -32601, -32602, -32603,
  -32000, -32001, -32020, -32022
]);

export function createDropOffSeries() {
  return {
    collectionSinceMs: undefined,
    hours: new Map()
  };
}

export function dropOffActor(actor) {
  if (actor === "self" || actor === "ambiguous") return actor;
  return "external";
}

/** Allow-listed code, or "other". Never returns a message. */
export function dropOffCode(outcome) {
  if (!outcome || outcome.ok === true) return undefined;
  if (outcome.kind === "jsonrpc") {
    const code = Number(outcome.code);
    return JSONRPC_CODES.has(code) ? String(code) : "other";
  }
  if (outcome.kind === "tool") {
    const code = typeof outcome.code === "string" ? outcome.code : "";
    return APP_CODES.has(code) ? code : "other";
  }
  if (outcome.kind === "http") {
    const status = Number(outcome.status);
    if (!HTTP_STATUSES.has(status)) return "other";
    const app = typeof outcome.code === "string" && APP_CODES.has(outcome.code) ? outcome.code : "other";
    return `${status}:${app}`;
  }
  return undefined;
}

export function recordDropOff(series, { nowMs, door, actor, stage, code } = {}) {
  if (!series || !DROP_OFF_DOORS.includes(door)) return;
  if (!DROP_OFF_ACTORS.includes(actor) || !ARRIVAL_STAGES.includes(stage)) return;
  if (typeof code !== "string" || !code || code.length > 80) return;
  if (series.collectionSinceMs === undefined) series.collectionSinceMs = nowMs;
  const startMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const key = `${door}|${actor}|${stage}|${code}`;
  const bucket = series.hours.get(startMs) ?? {};
  bucket[key] = (Number(bucket[key]) || 0) + 1;
  series.hours.set(startMs, bucket);
  pruneDropOff(series, nowMs);
}

export function pruneDropOff(series, nowMs) {
  const oldest = Math.floor((nowMs - RETENTION_MS) / HOUR_MS) * HOUR_MS;
  for (const startMs of series.hours.keys()) {
    if (startMs < oldest) series.hours.delete(startMs);
  }
}

export function dropOffSnapshot(series, { nowMs, unavailable } = {}) {
  if (unavailable || series?.collectionSinceMs === undefined) {
    return {
      absentMeans: NOT_REPORTED,
      collectionSinceMs: null,
      sinceCutover: NOT_REPORTED,
      "24h": NOT_REPORTED,
      "7d": NOT_REPORTED,
      ...(unavailable ? { unavailable } : {})
    };
  }
  const since = series.collectionSinceMs;
    return {
      absentMeans: NOT_REPORTED,
      measures: "error responses by stage; one pre-auth request = one visit",
      collectionSinceMs: since,
      sinceCutover: sumDropOff(series, since, nowMs, { includePartialLeading: true }),
      "24h": since <= nowMs - DAY_MS ? sumDropOff(series, nowMs - DAY_MS, nowMs) : NOT_REPORTED,
      "7d": since <= nowMs - 7 * DAY_MS ? sumDropOff(series, nowMs - 7 * DAY_MS, nowMs) : NOT_REPORTED
    };
}

export function serializeDropOff(series) {
  return {
    collectionSinceMs: series.collectionSinceMs,
    hours: [...series.hours.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([startMs, counts]) => ({ startMs, counts: { ...counts } }))
  };
}

export function restoreDropOff(series, stored) {
  const since = Number(stored?.collectionSinceMs);
  if (Number.isFinite(since)) series.collectionSinceMs = since;
  series.hours = new Map();
  for (const bucket of Array.isArray(stored?.hours) ? stored.hours : []) {
    const startMs = Number(bucket?.startMs);
    if (!Number.isFinite(startMs)) continue;
    const counts = {};
    for (const [key, raw] of Object.entries(bucket?.counts ?? {})) {
      const count = Number(raw);
      if (!Number.isSafeInteger(count) || count <= 0) continue;
      const [door, actor, stage, code, extra] = key.split("|");
      if (extra !== undefined) continue;
      if (!DROP_OFF_DOORS.includes(door) || !DROP_OFF_ACTORS.includes(actor)) continue;
      if (!ARRIVAL_STAGES.includes(stage) || typeof code !== "string" || !code) continue;
      const safeCode = code === "other" || isKnownCode(code) ? code : "other";
      const safeKey = `${door}|${actor}|${stage}|${safeCode}`;
      counts[safeKey] = (counts[safeKey] ?? 0) + count;
    }
    if (Object.keys(counts).length > 0) series.hours.set(startMs, counts);
  }
}

function isKnownCode(code) {
  if (APP_CODES.has(code)) return true;
  if (JSONRPC_CODES.has(Number(code))) return true;
  const separator = code.indexOf(":");
  if (separator <= 0) return false;
  const status = Number(code.slice(0, separator));
  const app = code.slice(separator + 1);
  return HTTP_STATUSES.has(status) && (app === "other" || APP_CODES.has(app));
}

function sumDropOff(series, startMs, nowMs, { includePartialLeading = false } = {}) {
  const totals = emptyDoors();
  for (const [hourStart, counts] of series.hours) {
    // Named windows drop the hour that starts before the window, so "24h"
    // never covers 25 hour buckets. sinceCutover keeps that leading partial
    // hour: those errors were measured after collection started.
    const leading = includePartialLeading ? hourStart + HOUR_MS <= startMs : hourStart < startMs;
    if (leading || hourStart > nowMs) continue;
    for (const [key, count] of Object.entries(counts)) {
      const [door, actor, stage, code] = key.split("|");
      const target = totals[door]?.[actor]?.[stage];
      if (!target || !Number.isSafeInteger(count) || count <= 0) continue;
      target[code] = (target[code] ?? 0) + count;
    }
  }
  for (const door of DROP_OFF_DOORS) {
    for (const actor of DROP_OFF_ACTORS) {
      for (const stage of ARRIVAL_STAGES) {
        totals[door][actor][stage] = topCodes(totals[door][actor][stage]);
      }
    }
  }
  return totals;
}

function topCodes(counts) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  entries.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const kept = {};
  let other = 0;
  for (const [code, count] of entries) {
    if (code === "other") {
      other += count;
      continue;
    }
    if (Object.keys(kept).length >= DROP_OFF_TOP_CODES) other += count;
    else kept[code] = count;
  }
  if (other > 0) kept.other = (kept.other ?? 0) + other;
  return kept;
}

function emptyDoors() {
  const stages = () => Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, {}]));
  const actors = () => Object.fromEntries(DROP_OFF_ACTORS.map((actor) => [actor, stages()]));
  return Object.fromEntries(DROP_OFF_DOORS.map((door) => [door, actors()]));
}
