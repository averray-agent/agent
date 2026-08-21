import { ConflictError } from "./errors.js";
import { isExternalJob } from "./external-job-lifecycle.js";
import { assertJobSnapshotIntegrity, buildJobSnapshot } from "./job-snapshot.js";

export const JOB_DEFINITION_CHAIN_MISMATCH_REASON = "job_definition_chain_mismatch";
export const JOB_DEFINITION_CHAIN_READ_UNAVAILABLE_REASON = "job_definition_chain_read_unavailable";

export async function captureClaimJobSnapshot({ job, claimEconomics, stateStore }) {
  if (!isExternalJob(job)) {
    return buildJobSnapshot(job, { claimEconomics });
  }
  const draft = await stateStore?.getExternalJobDraftByJobId?.(job.id);
  if (!draft?.definition) {
    throw new ConflictError(
      `External job ${job.id} is missing the original definition needed to pin its on-chain terms.`,
      "job_snapshot_capture_failed",
      { jobId: job.id, integrityFailure: true }
    );
  }
  return buildJobSnapshot(job, { specDefinition: draft.definition, claimEconomics });
}

export async function inspectClaimJobDefinitionIntegrity({
  job,
  claimEconomics,
  stateStore,
  blockchainGateway
}) {
  const snapshot = await captureClaimJobSnapshot({ job, claimEconomics, stateStore });
  const chainJobId = blockchainGateway?.isEnabled?.() && typeof blockchainGateway.toJobId === "function"
    ? blockchainGateway.toJobId(job.id)
    : job.id;
  const probe = { jobId: job.id, chainJobId, jobSnapshot: snapshot };
  const chainEnabled = blockchainGateway?.isEnabled?.() === true;

  if (!chainEnabled) {
    await assertJobSnapshotIntegrity(probe, blockchainGateway);
    return {
      snapshot,
      decision: {
        eligible: true,
        applies: false,
        status: "not_applicable",
        reason: "chain_backend_disabled",
        specHash: snapshot.specHash
      }
    };
  }

  if (typeof blockchainGateway.getJob !== "function") {
    return unavailableDecision(snapshot, "job_snapshot_chain_read_unavailable");
  }

  let liveJob;
  try {
    liveJob = await blockchainGateway.getJob(chainJobId);
  } catch (error) {
    return unavailableDecision(snapshot, "job_snapshot_chain_read_failed", error);
  }

  if (Number(liveJob?.state ?? 0) === 0) {
    return {
      snapshot,
      liveJob,
      decision: {
        eligible: true,
        applies: false,
        status: "uncommitted",
        reason: "job_definition_not_committed",
        specHash: snapshot.specHash,
        message: "This job is served fail-open pending its chain commitment. If claimed now, the resulting receipt will carry chain_unavailable_fail_open."
      }
    };
  }

  try {
    await assertJobSnapshotIntegrity(probe, blockchainGateway, { liveJob });
    return {
      snapshot,
      liveJob,
      decision: {
        eligible: true,
        applies: true,
        status: "matching",
        reason: "job_definition_chain_match",
        specHash: snapshot.specHash
      }
    };
  } catch (error) {
    const mismatch = error?.code === "job_snapshot_on_chain_spec_hash_mismatch";
    const integrityDetails = { ...(error?.details ?? {}) };
    delete integrityDetails.sessionId;
    return {
      snapshot,
      decision: {
        eligible: false,
        applies: true,
        status: mismatch ? "mismatch" : "invalid",
        reason: mismatch ? JOB_DEFINITION_CHAIN_MISMATCH_REASON : "job_definition_integrity_invalid",
        integrityFailure: true,
        operatorHandlingRequired: true,
        jobId: job.id,
        specHash: snapshot.specHash,
        sourceCode: error?.code,
        ...integrityDetails,
        message: mismatch
          ? "The served job definition does not reproduce its on-chain commitment. Choose another job while the operator repairs this listing."
          : "The served job definition could not pass its claim-time integrity check. Choose another job while the operator repairs this listing."
      }
    };
  }
}

function unavailableDecision(snapshot, sourceCode, error = undefined) {
  return {
    snapshot,
    decision: {
      eligible: true,
      applies: true,
      status: "unavailable",
      reason: JOB_DEFINITION_CHAIN_READ_UNAVAILABLE_REASON,
      failOpen: true,
      sourceCode,
      specHash: snapshot.specHash,
      ...(error ? { cause: error?.message ?? String(error) } : {}),
      message: "The chain commitment could not be read at claim time. Claim remains available; settlement will re-check the pinned terms."
    }
  };
}

export function requireClaimJobDefinitionIntegrity(inspection) {
  if (inspection?.decision?.eligible === true) return inspection;
  const decision = inspection?.decision ?? {};
  throw new ConflictError(
    decision.message ?? "The served job definition failed its claim-time integrity check.",
    decision.reason ?? "job_definition_integrity_invalid",
    decision
  );
}
