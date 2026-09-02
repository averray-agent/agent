import { ValidationError } from "./errors.js";

export function normalizeUnsignedRawAmount(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new ValidationError("raw amount must be a non-negative integer.");
    }
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError("raw amount must be an exact non-negative integer.");
    }
    return String(value);
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!/^\d+$/u.test(normalized)) {
      throw new ValidationError("raw amount must be a non-negative integer string.");
    }
    return BigInt(normalized).toString();
  }
  throw new ValidationError("raw amount must be a non-negative integer.");
}

export function addRawAmount(current, delta) {
  const normalizedDelta = normalizeUnsignedRawAmount(delta);
  if (normalizedDelta === undefined) {
    return current;
  }
  const normalizedCurrent = normalizeUnsignedRawAmount(current);
  return ((normalizedCurrent === undefined ? 0n : BigInt(normalizedCurrent)) + BigInt(normalizedDelta)).toString();
}

export function subtractRawAmount(current, delta) {
  const normalizedCurrent = normalizeUnsignedRawAmount(current);
  if (normalizedCurrent === undefined) {
    return current;
  }
  const normalizedDelta = normalizeUnsignedRawAmount(delta);
  if (normalizedDelta === undefined) {
    return normalizedCurrent;
  }
  const next = BigInt(normalizedCurrent) - BigInt(normalizedDelta);
  return next > 0n ? next.toString() : "0";
}

export function normalizeRequestId(requestId) {
  if (typeof requestId !== "string" || !requestId.trim()) {
    return undefined;
  }
  return requestId.trim().toLowerCase();
}

export function normalizeRequestIds(requestIds) {
  if (!Array.isArray(requestIds)) {
    return [];
  }
  return requestIds.map(normalizeRequestId).filter(Boolean);
}

export function hasRequestId(requestIds, requestId) {
  const normalized = normalizeRequestId(requestId);
  return Boolean(normalized && normalizeRequestIds(requestIds).includes(normalized));
}

export function addRequestId(requestIds, requestId) {
  const normalized = normalizeRequestId(requestId);
  if (!normalized) {
    return normalizeRequestIds(requestIds);
  }
  return [...new Set([...normalizeRequestIds(requestIds), normalized])];
}

export function removeRequestId(requestIds, requestId) {
  const normalized = normalizeRequestId(requestId);
  if (!normalized) {
    return normalizeRequestIds(requestIds);
  }
  return normalizeRequestIds(requestIds).filter((existing) => existing !== normalized);
}

export function applyRawDeallocation(entry, assetsReturnedRaw) {
  const normalizedAssetsReturnedRaw = normalizeUnsignedRawAmount(assetsReturnedRaw);
  const normalizedPrincipalRaw = normalizeUnsignedRawAmount(entry.principalRaw);
  if (normalizedAssetsReturnedRaw === undefined || normalizedPrincipalRaw === undefined) {
    return {};
  }

  const assetsReturned = BigInt(normalizedAssetsReturnedRaw);
  const principalBefore = BigInt(normalizedPrincipalRaw);
  const markValueBefore = BigInt(normalizeUnsignedRawAmount(entry.markValueRaw ?? entry.principalRaw) ?? "0");
  const denominator = maxBigInt(markValueBefore, assetsReturned, 0n);
  const principalReleased = denominator > 0n
    ? minBigInt(principalBefore, (principalBefore * assetsReturned) / denominator)
    : minBigInt(principalBefore, assetsReturned);
  const realizedYieldDeltaRaw = assetsReturned - principalReleased;

  entry.principalRaw = (principalBefore > principalReleased ? principalBefore - principalReleased : 0n).toString();
  entry.realizedYieldRaw = addSignedRawAmount(entry.realizedYieldRaw, realizedYieldDeltaRaw);
  entry.markValueRaw = (markValueBefore > assetsReturned ? markValueBefore - assetsReturned : 0n).toString();

  return {
    realizedYieldDeltaRaw: realizedYieldDeltaRaw.toString()
  };
}

function normalizeSignedRawAmount(value) {
  if (value === undefined || value === null || value === "") {
    return 0n;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ValidationError("signed raw amount must be an exact integer.");
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!/^-?\d+$/u.test(normalized)) {
      throw new ValidationError("signed raw amount must be an integer string.");
    }
    return BigInt(normalized);
  }
  throw new ValidationError("signed raw amount must be an integer.");
}

function addSignedRawAmount(current, delta) {
  return (normalizeSignedRawAmount(current) + normalizeSignedRawAmount(delta)).toString();
}

function maxBigInt(...values) {
  return values.reduce((max, value) => (value > max ? value : max), values[0] ?? 0n);
}

function minBigInt(...values) {
  return values.reduce((min, value) => (value < min ? value : min), values[0] ?? 0n);
}
