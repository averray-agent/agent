export const MIN_WAIVER_ELIGIBLE_CLAIMABLE_JOBS = 2;
export const ONBOARDING_SUBSIDY_LOW_HEADROOM_RATIO = 0.2;

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
    const subsidy = await service.getOnboardingSubsidyStatus?.();

    return {
      status,
      reason,
      waiverEligibleClaimableJobs,
      minimumWaiverEligibleClaimableJobs: minimum,
      asOf: now.toISOString(),
      source: "job_catalog",
      readable: true,
      ...(subsidy ? { subsidy } : {})
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
  if (!onboarding) {
    return [];
  }
  const warnings = [];
  const count = onboarding.waiverEligibleClaimableJobs;
  const minimum = onboarding.minimumWaiverEligibleClaimableJobs;
  if (onboarding.status !== "ready") {
    warnings.push({
      code: onboarding.reason,
      severity: "warning",
      message: count === null
        ? "Waiver-eligible onboarding inventory could not be verified."
        : `Only ${count} waiver-eligible claimable onboarding job(s) are available; minimum is ${minimum}.`
    });
  }
  const subsidyHeadroomUsdc = onboarding.subsidy?.headroomUsdc;
  const subsidyDailyBudgetUsdc = onboarding.subsidy?.dailyBudgetUsdc;
  if (Number.isFinite(subsidyHeadroomUsdc) && subsidyHeadroomUsdc <= 0) {
    warnings.push({
      code: "onboarding_subsidy_exhausted",
      severity: "warning",
      message: "The free onboarding tier is fully allocated for today; the self-funded claim path remains available."
    });
  } else if (
    Number.isFinite(subsidyHeadroomUsdc)
    && Number.isFinite(subsidyDailyBudgetUsdc)
    && subsidyDailyBudgetUsdc > 0
    && subsidyHeadroomUsdc <= subsidyDailyBudgetUsdc * ONBOARDING_SUBSIDY_LOW_HEADROOM_RATIO
  ) {
    warnings.push({
      code: "onboarding_subsidy_headroom_low",
      severity: "warning",
      message: `Only ${subsidyHeadroomUsdc} USDC of the ${subsidyDailyBudgetUsdc} USDC daily onboarding subsidy remains; consider raising the budget before tier-0 claims are blocked.`
    });
  }
  return warnings;
}
