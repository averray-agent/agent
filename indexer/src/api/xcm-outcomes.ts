import { and, asc, eq, gt, inArray, or } from "drizzle-orm";

import { db } from "ponder:api";
import schema from "ponder:schema";

const TERMINAL_STATUSES = [2, 3, 4] as const;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export type Cursor =
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

export function normalizeLimit(rawLimit: string | undefined) {
  const parsed = Number(rawLimit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.trunc(parsed), MAX_LIMIT);
}

export function decodeCursor(rawCursor: string | undefined): Cursor | undefined {
  if (!rawCursor) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || !/^0x[a-fA-F0-9]{64}$/u.test(String(decoded.requestId ?? ""))) {
      return undefined;
    }
    if (/^\d+$/u.test(String(decoded.blockNumber ?? ""))) {
      return {
        mode: "indexed",
        blockNumber: BigInt(decoded.blockNumber),
        requestId: String(decoded.requestId)
      };
    }
    if (typeof decoded.observedAt === "string" && !Number.isNaN(new Date(decoded.observedAt).getTime())) {
      return {
        mode: "external",
        observedAt: new Date(decoded.observedAt).toISOString(),
        requestId: String(decoded.requestId)
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function encodeCursor(cursor: Cursor) {
  const payload = cursor.mode === "indexed"
    ? {
      mode: "indexed",
      blockNumber: cursor.blockNumber.toString(),
      requestId: cursor.requestId
    }
    : {
      mode: "external",
      observedAt: cursor.observedAt,
      requestId: cursor.requestId
    };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function toObservedAtIso(timestampSeconds: bigint) {
  return new Date(Number(timestampSeconds) * 1000).toISOString();
}

export async function listTerminalXcmOutcomes({
  cursor,
  limit
}: {
  cursor?: Cursor;
  limit: number;
}) {
  const statusCondition = inArray(schema.xcmRequest.status, [...TERMINAL_STATUSES]);
  const cursorCondition = cursor?.mode === "indexed"
    ? or(
      gt(schema.xcmRequest.updatedAtBlock, cursor.blockNumber),
      and(
        eq(schema.xcmRequest.updatedAtBlock, cursor.blockNumber),
        gt(schema.xcmRequest.id, cursor.requestId)
      )
    )
    : undefined;

  const rows = await db
    .select()
    .from(schema.xcmRequest)
    .where(cursorCondition ? and(statusCondition, cursorCondition) : statusCondition)
    .orderBy(asc(schema.xcmRequest.updatedAtBlock), asc(schema.xcmRequest.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);

  return {
    items: page.map((row) => ({
      requestId: row.id,
      status: row.statusLabel,
      settledAssets: row.settledAssets.toString(),
      settledShares: row.settledShares.toString(),
      remoteRef: row.remoteRef ?? undefined,
      failureCode: row.failureCode ?? undefined,
      observedAt: toObservedAtIso(row.updatedAtTimestamp),
      source: "indexer_terminal_status"
    })),
    nextCursor: rows.length > limit
      ? encodeCursor({
        mode: "indexed",
        blockNumber: page[page.length - 1]!.updatedAtBlock,
        requestId: page[page.length - 1]!.id
      })
      : undefined
  };
}
