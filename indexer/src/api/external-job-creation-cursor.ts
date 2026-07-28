const MAX_DATABASE_BIGINT = (1n << 63n) - 1n;

export type ExternalJobCreationCursor = {
  blockNumber: bigint;
  eventId: string;
};

export function encodeExternalJobCreationCursor(cursor: ExternalJobCreationCursor) {
  const blockNumber = normalizeDatabaseBigInt(cursor.blockNumber);
  const eventId = normalizeEventId(cursor.eventId);
  if (blockNumber === undefined || !eventId) {
    throw new Error("Invalid external job creation cursor.");
  }
  return Buffer.from(JSON.stringify({
    blockNumber: blockNumber.toString(),
    eventId
  }), "utf8").toString("base64url");
}

export function decodeExternalJobCreationCursor(
  raw: string | undefined
): ExternalJobCreationCursor | undefined {
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    const blockNumber = normalizeDatabaseBigInt(decoded?.blockNumber);
    const eventId = normalizeEventId(decoded?.eventId);
    return blockNumber === undefined || !eventId
      ? undefined
      : { blockNumber, eventId };
  } catch {
    return undefined;
  }
}

function normalizeDatabaseBigInt(value: unknown) {
  try {
    const normalized = BigInt(String(value));
    return normalized >= 0n && normalized <= MAX_DATABASE_BIGINT
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeEventId(value: unknown) {
  const normalized = String(value ?? "").trim();
  return /^[0-9a-zA-Z:_-]{1,256}$/u.test(normalized) ? normalized : undefined;
}
