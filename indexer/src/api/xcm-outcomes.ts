import { and, asc, eq, gt, inArray, or } from "drizzle-orm";

import { db } from "ponder:api";
import schema from "ponder:schema";

import {
  decodeCursor,
  encodeCursor,
  toObservedAtIso,
  type OutcomeCursor as Cursor
} from "./xcm-outcome-cursor";

const TERMINAL_STATUSES = [2, 3, 4] as const;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export { decodeCursor, encodeCursor, toObservedAtIso, type Cursor };

export function normalizeLimit(rawLimit: string | undefined) {
  const parsed = Number(rawLimit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.trunc(parsed), MAX_LIMIT);
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
