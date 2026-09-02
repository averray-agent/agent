const MAX_DATABASE_BIGINT = (1n << 63n) - 1n;
const MAX_JS_TIMESTAMP_SECONDS = 8_640_000_000_000n;

export type OutcomeCursorMode = "indexed" | "external";

export type OutcomeCursor =
  | {
    mode: "indexed";
    blockNumber: bigint;
    requestId: string;
  }
  | {
    mode: "external";
    observedAt: string;
    requestId: string;
  };

export function decodeCursor(rawCursor: string | undefined): OutcomeCursor | undefined {
  if (!rawCursor) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return undefined;
    }

    const requestId = normalizeRequestId(decoded.requestId);
    if (!requestId) {
      return undefined;
    }

    if (decoded.mode === "indexed") {
      return decodeIndexedCursor(decoded, requestId);
    }
    if (decoded.mode === "external") {
      return decodeExternalCursor(decoded, requestId);
    }
    if (decoded.mode !== undefined) {
      return undefined;
    }

    const hasBlockNumber = decoded.blockNumber !== undefined;
    const hasObservedAt = decoded.observedAt !== undefined;
    if (hasBlockNumber === hasObservedAt) {
      return undefined;
    }
    return hasBlockNumber
      ? decodeIndexedCursor(decoded, requestId)
      : decodeExternalCursor(decoded, requestId);
  } catch {
    return undefined;
  }
}

export function encodeCursor(cursor: OutcomeCursor) {
  const payload = cursor.mode === "indexed"
    ? {
      mode: "indexed",
      blockNumber: normalizeDatabaseBigInt(cursor.blockNumber)?.toString(),
      requestId: normalizeRequestId(cursor.requestId)
    }
    : {
      mode: "external",
      observedAt: normalizeObservedAtIso(cursor.observedAt),
      requestId: normalizeRequestId(cursor.requestId)
    };
  if (!payload.requestId || ("blockNumber" in payload && !payload.blockNumber) || ("observedAt" in payload && !payload.observedAt)) {
    throw new Error("Invalid XCM outcome cursor.");
  }
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function cursorForSource<Mode extends OutcomeCursorMode>(
  cursor: OutcomeCursor | undefined,
  mode: Mode
): Extract<OutcomeCursor, { mode: Mode }> | undefined {
  return cursor?.mode === mode
    ? cursor as Extract<OutcomeCursor, { mode: Mode }>
    : undefined;
}

export function toObservedAtIso(timestampSeconds: bigint) {
  const normalized = normalizeDatabaseBigInt(timestampSeconds);
  if (normalized === undefined || normalized > MAX_JS_TIMESTAMP_SECONDS) {
    return undefined;
  }
  return new Date(Number(normalized) * 1000).toISOString();
}

export function normalizeObservedAtIso(value: unknown) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function decodeIndexedCursor(decoded: Record<string, unknown>, requestId: string) {
  const blockNumber = normalizeDatabaseBigInt(decoded.blockNumber);
  return blockNumber === undefined
    ? undefined
    : {
      mode: "indexed" as const,
      blockNumber,
      requestId
    };
}

function decodeExternalCursor(decoded: Record<string, unknown>, requestId: string) {
  const observedAt = normalizeObservedAtIso(decoded.observedAt);
  return observedAt === undefined
    ? undefined
    : {
      mode: "external" as const,
      observedAt,
      requestId
    };
}

function normalizeRequestId(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^0x[a-fA-F0-9]{64}$/u.test(normalized) ? normalized : undefined;
}

function normalizeDatabaseBigInt(value: unknown) {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      return undefined;
    }
    parsed = BigInt(value);
  } else if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    parsed = BigInt(value.trim());
  } else {
    return undefined;
  }
  return parsed >= 0n && parsed <= MAX_DATABASE_BIGINT ? parsed : undefined;
}
