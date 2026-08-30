import {
  NON_FAILABLE_VERIFIER_CODE
} from "../core/catalog-verifier-integrity.js";

const INGEST_REFUSED_SPEC_HASH_MISMATCH = "ingest_refused_spec_hash_mismatch";
const LANE_POSTING_REFUSALS = new Set([
  "lane_budget_exhausted",
  "lane_backlog_saturated",
  "lane_paused"
]);

export async function upsertScheduledIngestedJob(platformService, job, { prefund = false, now = new Date() } = {}) {
  const liveJob = await readLiveJobForPosting(platformService, job.id);
  const compatibleDefinitions = legacyCatalogueDefinitions(job);
  const liveJobOption = liveJob === undefined ? {} : { liveJob };
  const action = async () => {
    if (prefund && typeof platformService.createIngestedJob === "function") {
      return platformService.createIngestedJob(job, { now, ...liveJobOption, compatibleDefinitions });
    }
    if (typeof platformService.upsertIngestedJob === "function") {
      return platformService.upsertIngestedJob(job, { now, ...liveJobOption, compatibleDefinitions });
    }
    return platformService.createJob(job);
  };
  // A live chain record is hydration, not a new posting. In particular, this
  // preserves pre-D3 open jobs without charging them to the new lane ledger.
  if (Number(liveJob?.state ?? 0) !== 0) return action();
  return platformService.catalogueLaneDiscipline?.post
    ? platformService.catalogueLaneDiscipline.post(job, action, { now })
    : action();
}

export function recordIngestVerifierRefusal(summary, job, error) {
  if (error?.code !== NON_FAILABLE_VERIFIER_CODE) return false;
  summary.skipped.push({
    id: job.id,
    reason: NON_FAILABLE_VERIFIER_CODE,
    verifierMode: job?.verifierMode ?? null,
    sourceType: job?.source?.type ?? null
  });
  return true;
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

export function recordLanePostingRefusal(summary, job, error) {
  if (!LANE_POSTING_REFUSALS.has(error?.code)) return false;
  const refusal = {
    id: job.id,
    reason: error.code,
    lane: error?.details?.lane ?? job?.lane ?? null,
    resumeAt: error?.details?.resumeAt ?? null,
    retryWhen: error?.details?.retryWhen ?? null
  };
  summary.skipped.push(refusal);
  return true;
}

export function legacyCatalogueDefinitions(job) {
  if (!job?.lane) return [];
  const withoutLane = { ...job };
  delete withoutLane.lane;
  const definitions = [withoutLane];
  const priorLivenessReward = {
    open_data_dataset: 0.25,
    openapi_spec: 0.3,
    standards_spec: 0.3
  }[job?.source?.type];
  if (priorLivenessReward !== undefined && Number(job.rewardAmount) !== priorLivenessReward) {
    definitions.push({ ...withoutLane, rewardAmount: priorLivenessReward });
  }
  return definitions;
}

async function readLiveJobForPosting(platformService, jobId) {
  const gateway = platformService?.blockchainGateway;
  if (!gateway?.isEnabled?.() || typeof gateway?.getJob !== "function") return undefined;
  // Let the existing upsert path own transient RPC failure handling. Undefined
  // causes it to perform its normal read inside the reserved posting action.
  try {
    return await gateway.getJob(jobId);
  } catch {
    return undefined;
  }
}
