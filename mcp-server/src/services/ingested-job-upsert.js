const INGEST_REFUSED_SPEC_HASH_MISMATCH = "ingest_refused_spec_hash_mismatch";

export async function upsertScheduledIngestedJob(platformService, job, { prefund = false } = {}) {
  if (prefund && typeof platformService.createIngestedJob === "function") {
    return platformService.createIngestedJob(job);
  }
  if (typeof platformService.upsertIngestedJob === "function") {
    return platformService.upsertIngestedJob(job);
  }
  return platformService.createJob(job);
}

export function recordIngestSpecHashRefusal(summary, job, error) {
  if (error?.code !== INGEST_REFUSED_SPEC_HASH_MISMATCH) return false;
  summary.ingestRefusedSpecHashMismatchCount =
    Number(summary.ingestRefusedSpecHashMismatchCount ?? 0) + 1;
  summary.skipped.push({
    id: job.id,
    reason: INGEST_REFUSED_SPEC_HASH_MISMATCH,
    committedSpecHash: error?.details?.committedSpecHash ?? null,
    candidateSpecHash: error?.details?.candidateSpecHash ?? null
  });
  return true;
}
