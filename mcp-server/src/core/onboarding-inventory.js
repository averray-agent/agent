export const MIN_WAIVER_ELIGIBLE_CLAIMABLE_JOBS = 2;

export const ONBOARDING_WAIVER_INGESTION_SOURCES = new Set([
  "github_issue",
  "open_data_dataset",
  "openapi_spec",
  "osv_advisory",
  "standards_spec",
  "wikipedia_article"
]);

export function applyIngestionOnboardingWaiverPolicy(job) {
  if (
    job?.tier !== "starter"
    || !ONBOARDING_WAIVER_INGESTION_SOURCES.has(job?.source?.type)
  ) {
    return job;
  }
  return {
    ...job,
    onboardingWaiverEligible: true
  };
}

export function isRealWaiverEligibleJob(job) {
  return job?.tier === "starter"
    && job?.onboardingWaiverEligible === true
    && ONBOARDING_WAIVER_INGESTION_SOURCES.has(job?.source?.type);
}

export async function resolveOnboardingInventoryHealth({
  service,
  rewardBank,
  now = new Date(),
  minimum = MIN_WAIVER_ELIGIBLE_CLAIMABLE_JOBS
} = {}) {
  if (
    typeof service?.listJobs !== "function"
    || typeof service?.attachClaimState !== "function"
  ) {
    return undefined;
  }

  try {
    const catalogJobs = service.listJobs({ now });
    const jobs = await Promise.all(catalogJobs.map((job) => service.attachClaimState(job, {
      rewardBank,
      now
    })));
    const waiverEligibleClaimableJobs = jobs.filter((job) => (
      isRealWaiverEligibleJob(job) && job.claimable === true
    )).length;
    const status = waiverEligibleClaimableJobs >= minimum ? "ready" : "warning";
    const reason = waiverEligibleClaimableJobs === 0
      ? "onboarding_waiver_inventory_empty"
      : waiverEligibleClaimableJobs < minimum
        ? "onboarding_waiver_inventory_below_minimum"
        : "onboarding_waiver_inventory_ready";

    return {
      status,
      reason,
      waiverEligibleClaimableJobs,
      minimumWaiverEligibleClaimableJobs: minimum,
      asOf: now.toISOString(),
      source: "job_catalog",
      readable: true
    };
  } catch (error) {
    return {
      status: "warning",
      reason: "onboarding_waiver_inventory_unverified",
      waiverEligibleClaimableJobs: null,
      minimumWaiverEligibleClaimableJobs: minimum,
      asOf: now.toISOString(),
      source: "job_catalog",
      readable: false,
      error: error?.code ?? error?.message ?? "read_failed"
    };
  }
}

export function buildOnboardingInventoryWarnings(onboarding) {
  if (!onboarding || onboarding.status === "ready") {
    return [];
  }
  const count = onboarding.waiverEligibleClaimableJobs;
  const minimum = onboarding.minimumWaiverEligibleClaimableJobs;
  return [{
    code: onboarding.reason,
    severity: "warning",
    message: count === null
      ? "Waiver-eligible onboarding inventory could not be verified."
      : `Only ${count} waiver-eligible claimable onboarding job(s) are available; minimum is ${minimum}.`
  }];
}
