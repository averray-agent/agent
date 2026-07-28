import { and, asc, eq, gt, inArray, lte, or, sql } from "ponder";
import { db } from "ponder:api";
import schema from "ponder:schema";

import {
  decodeExternalJobCreationCursor,
  encodeExternalJobCreationCursor,
  type ExternalJobCreationCursor
} from "./external-job-creation-cursor";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function normalizeExternalJobCreationLimit(raw: string | undefined) {
  const parsed = Number(raw ?? DEFAULT_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(parsed), MAX_LIMIT);
}

export async function listFinalizedExternalJobCreations({
  cursor,
  limit
}: {
  cursor?: ExternalJobCreationCursor;
  limit: number;
}) {
  const finalizedHead = await readFinalizedHead();
  const cursorCondition = cursor
    ? or(
      gt(schema.jobEvent.blockNumber, cursor.blockNumber),
      and(
        eq(schema.jobEvent.blockNumber, cursor.blockNumber),
        gt(schema.jobEvent.id, cursor.eventId)
      )
    )
    : undefined;
  const finalizedCondition = and(
    eq(schema.jobEvent.kind, "JobCreated"),
    lte(schema.jobEvent.blockNumber, finalizedHead.blockNumber)
  );
  const events = await db
    .select()
    .from(schema.jobEvent)
    .where(cursorCondition ? and(finalizedCondition, cursorCondition) : finalizedCondition)
    .orderBy(asc(schema.jobEvent.blockNumber), asc(schema.jobEvent.id))
    .limit(limit);

  const jobIds = [...new Set(events.map((event) => event.jobId))];
  const jobs = jobIds.length
    ? await db.select().from(schema.job).where(inArray(schema.job.id, jobIds))
    : [];
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const items = events.flatMap((event) => {
    const job = jobsById.get(event.jobId);
    const specHash = event.specHash ?? job?.specHash;
    if (!job || !specHash) {
      return [];
    }
    return [{
      jobId: event.jobId,
      specHash,
      poster: job.poster,
      asset: job.asset,
      reward: job.reward.toString(),
      opsReserve: job.opsReserve.toString(),
      contingencyReserve: job.contingencyReserve.toString(),
      fundedAt: secondsToIso(event.timestamp),
      txHash: event.txHash,
      blockNumber: event.blockNumber.toString(),
      finalized: true,
      source: "ponder_finalized_escrow"
    }];
  });
  const last = events[events.length - 1];

  return {
    items,
    nextCursor: last
      ? encodeExternalJobCreationCursor({
        blockNumber: last.blockNumber,
        eventId: last.id
      })
      : undefined,
    meta: {
      source: "ponder_finalized_checkpoint",
      network: finalizedHead.network,
      finalizedBlockNumber: finalizedHead.blockNumber.toString(),
      finalizedBlockTimestamp: secondsToIso(finalizedHead.blockTimestamp),
      caughtUp: events.length < limit,
      limit
    }
  };
}

async function readFinalizedHead() {
  const result = await db.execute(sql`
    SELECT
      chain_name,
      SUBSTRING(finalized_checkpoint FROM 1 FOR 10) AS finalized_block_timestamp,
      SUBSTRING(finalized_checkpoint FROM 27 FOR 16) AS finalized_block_number
    FROM _ponder_checkpoint
    ORDER BY chain_id
    LIMIT 1
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error("Ponder finalized checkpoint is unavailable.");
  }
  return {
    network: String(row.chain_name),
    blockNumber: BigInt(String(row.finalized_block_number)),
    blockTimestamp: BigInt(String(row.finalized_block_timestamp))
  };
}

function secondsToIso(value: bigint) {
  return new Date(Number(value) * 1000).toISOString();
}

export {
  decodeExternalJobCreationCursor,
  encodeExternalJobCreationCursor
};
