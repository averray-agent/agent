export const EXTERNAL_JOB_DELISTED_REASON = "external_job_delisted";
export const EXTERNAL_JOB_TRANSITION_REASON = "external_job_transition_in_progress";

// The lifecycle lane spans brokered chain writes, whose confirmation can take
// longer than the short in-memory claim coordination window.
export const EXTERNAL_JOB_LIFECYCLE_LOCK_TTL_SECONDS = 15 * 60;

export function isExternalJob(job) {
  return job?.source === "external"
    || job?.source?.type === "external"
    || job?.sourceType === "external";
}

export function externalJobLifecycleLockId(jobId) {
  return `external-job-lifecycle:${String(jobId ?? "").trim().toLowerCase()}`;
}
