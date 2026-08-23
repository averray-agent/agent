import { classifyEscrowGeneration } from "../blockchain/escrow-generation.js";
import { isExternalJob } from "./external-job-lifecycle.js";

export const LEGACY_POSTING_UNCLAIMABLE = "legacy_posting_unclaimable";
export const LEGACY_POSTING_UNCLAIMABLE_MESSAGE =
  "This posting predates the current EscrowCore and cannot use the worker self-paid claim flow. Contact the operator for help with this legacy posting.";
export const EXTERNAL_POSTING_ESCROW_UNVERIFIED = "external_posting_escrow_unverified";

export function resolveExternalEscrowGeneration(blockchainGateway, liveJob) {
  if (typeof blockchainGateway?.classifyEscrowGeneration === "function") {
    return blockchainGateway.classifyEscrowGeneration(liveJob);
  }
  return classifyEscrowGeneration(liveJob, blockchainGateway?.config);
}

export function projectExternalPostingClaimability(job, observation) {
  if (!observation) return job;
  const base = {
    ...job,
    escrowGeneration: observation.escrowGeneration,
    legacyPostingUnclaimable: observation.reason === LEGACY_POSTING_UNCLAIMABLE
  };
  if (!observation.blocksClaim) return base;

  const blocked = {
    claimState: "unclaimable",
    state: "unclaimable",
    effectiveState: "unclaimable",
    claimable: false,
    currentWalletCanClaim: false,
    reason: observation.reason
  };
  return {
    ...base,
    ...blocked,
    claimStatus: {
      ...base.claimStatus,
      ...blocked
    }
  };
}

/**
 * Reconcile every visible, open external catalogue row with the EscrowCore
 * that holds it. The result is serving-only evidence; it never mutates the
 * contract, job definition, or signing path.
 */
export async function sweepExternalPostingClaimability({ jobs, blockchainGateway } = {}) {
  const candidates = (Array.isArray(jobs) ? jobs : []).filter((job) => (
    isExternalJob(job)
    && (job?.lifecycle?.status ?? "open") === "open"
    && (job?.lifecycle?.state ?? "open") === "open"
  ));
  if (!blockchainGateway?.isEnabled?.() || candidates.length === 0) {
    return {
      candidateCount: candidates.length,
      legacyUnclaimableCount: 0,
      observations: new Map()
    };
  }

  const reads = typeof blockchainGateway.getJobs === "function"
    ? await blockchainGateway.getJobs(candidates.map((job) => job.id))
    : typeof blockchainGateway.getJob === "function"
      ? await Promise.allSettled(candidates.map((job) => blockchainGateway.getJob(job.id)))
      : candidates.map(() => ({ status: "rejected", reason: new Error("job reader unavailable") }));
  const observations = new Map();
  let legacyUnclaimableCount = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const job = candidates[index];
    const read = reads[index];
    if (read?.status !== "fulfilled") {
      observations.set(job.id, {
        escrowGeneration: "unknown",
        blocksClaim: true,
        reason: EXTERNAL_POSTING_ESCROW_UNVERIFIED
      });
      continue;
    }
    const liveJob = read.value;
    const escrowGeneration = resolveExternalEscrowGeneration(blockchainGateway, liveJob);
    if (Number(liveJob?.state) !== 1) {
      observations.set(job.id, {
        escrowGeneration,
        blocksClaim: true,
        reason: "external_posting_not_open_on_chain"
      });
      continue;
    }
    if (escrowGeneration === "legacy") {
      legacyUnclaimableCount += 1;
      observations.set(job.id, {
        escrowGeneration,
        blocksClaim: true,
        reason: LEGACY_POSTING_UNCLAIMABLE,
        escrowAddress: liveJob.escrowAddress
      });
      continue;
    }
    if (escrowGeneration !== "current") {
      observations.set(job.id, {
        escrowGeneration,
        blocksClaim: true,
        reason: EXTERNAL_POSTING_ESCROW_UNVERIFIED,
        escrowAddress: liveJob?.escrowAddress
      });
      continue;
    }
    observations.set(job.id, {
      escrowGeneration,
      blocksClaim: false,
      escrowAddress: liveJob.escrowAddress
    });
  }

  return { candidateCount: candidates.length, legacyUnclaimableCount, observations };
}
