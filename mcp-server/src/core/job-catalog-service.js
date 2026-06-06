import {
  ConflictError,
  NotFoundError,
  ValidationError
} from "./errors.js";
import {
  getJobSchema,
  getRegisteredJobSchemaRegistration,
  isBuiltinJobSchemaRef,
  isRegisteredJobSchemaRef,
  schemaRefToJobSchemaPath
} from "./job-schema-registry.js";
import {
  DEFAULT_STALE_AFTER_MS,
  VALID_AGENT_ROLES,
  VALID_JOB_LIFECYCLE_STATUSES,
  VALID_TIERS,
  effectiveJobType,
  effectiveRequiredRole,
  normaliseLifecycle,
  normalisePlainObject,
  normalizeIsoTimestamp,
  normalizeJobId,
  normalizeJobInput as normalizeCatalogJobInput
} from "./job-catalog-normalization.js";
import { buildVerificationContract } from "./verifier-contract.js";

const DEFAULT_AGENT_PROFILE = {
  capabilities: ["claim_job", "submit_work", "allocate_idle_funds"],
  supportedProtocols: ["mcp", "http"],
  preferredCategories: ["coding"],
  preferredRiskLevel: "low",
  verifierCompatibility: ["benchmark", "deterministic", "human_fallback", "github_pr"],
  minLiquidReserve: 0,
  autoUnwindStrategies: false
};

export const ROLE_REQUIREMENTS = {
  worker: { skill: 0 },
  curator: { skill: 50 },
  reviewer: { skill: 100 },
  publisher: { skill: 200 },
  verifier: { skill: 300 },
  arbitrator: { skill: 500 }
};

/**
 * Single source of truth for which reputation scores a wallet needs to
 * unlock each job tier. `isEligible`, `summarizeTierGate`, and the
 * public `/jobs/tiers` endpoint all read from this map so the numbers
 * can't drift. v1 only gates on `skill`; future revisions can add
 * `reliability`/`economic` minimums without changing call sites.
 */
export const TIER_REQUIREMENTS = {
  starter: { skill: 0 },
  pro: { skill: 100 },
  elite: { skill: 200 }
};

const TIER_ORDER = ["starter", "pro", "elite"];

export function tierRequirements(tier) {
  return TIER_REQUIREMENTS[tier] ?? TIER_REQUIREMENTS.starter;
}

/**
 * Inspect whether `reputation` satisfies the minimums recorded for `tier`.
 * Returns a plain-data summary the HTTP layer can serialise directly.
 * `missing` is emitted sparse (only keys the wallet hasn't met) so the UI
 * can render "need 25 more skill" without post-processing.
 */
export function summarizeTierGate(tier, reputation) {
  const normalised = VALID_TIERS.has(tier) ? tier : "starter";
  const requires = { ...tierRequirements(normalised) };
  const has = {
    skill: Number.isInteger(reputation?.skill) ? reputation.skill : 0,
    reliability: Number.isInteger(reputation?.reliability) ? reputation.reliability : 0,
    economic: Number.isInteger(reputation?.economic) ? reputation.economic : 0
  };
  const missing = {};
  for (const [key, required] of Object.entries(requires)) {
    const current = has[key] ?? 0;
    if (current < required) {
      missing[key] = required - current;
    }
  }
  const unlocked = Object.keys(missing).length === 0;
  return { tier: normalised, unlocked, requires, has, missing };
}

/**
 * Given the current reputation, find the next tier the wallet has NOT
 * yet unlocked and return what it would take to reach it. Returns null
 * when the wallet is already at the highest tier.
 */
export function nextLockedTier(reputation) {
  for (const tier of TIER_ORDER) {
    const summary = summarizeTierGate(tier, reputation);
    if (!summary.unlocked) {
      return summary;
    }
  }
  return null;
}

export function roleRequirements(role) {
  return ROLE_REQUIREMENTS[role] ?? ROLE_REQUIREMENTS.worker;
}

export function summarizeRoleGate(role, reputation) {
  const normalised = VALID_AGENT_ROLES.has(role) ? role : "worker";
  const requires = { ...roleRequirements(normalised) };
  const has = {
    skill: Number.isInteger(reputation?.skill) ? reputation.skill : 0,
    reliability: Number.isInteger(reputation?.reliability) ? reputation.reliability : 0,
    economic: Number.isInteger(reputation?.economic) ? reputation.economic : 0
  };
  const missing = {};
  for (const [key, required] of Object.entries(requires)) {
    const current = has[key] ?? 0;
    if (current < required) {
      missing[key] = required - current;
    }
  }
  const unlocked = Object.keys(missing).length === 0;
  return { role: normalised, unlocked, requires, has, missing };
}

export class JobCatalogService {
  constructor(
    jobs,
    profiles,
    getAccountSummary,
    getReputation,
    getDefaultClaimStakeBps,
    getClaimEconomics = undefined
  ) {
    this.jobs = jobs;
    this.profiles = profiles;
    this.getAccountSummary = getAccountSummary;
    this.getReputation = getReputation;
    this.getDefaultClaimStakeBps = getDefaultClaimStakeBps;
    this.getClaimEconomics = getClaimEconomics;
    this.parentSessionIndex = new Map();
    for (const job of this.jobs) {
      this.indexJob(job);
    }
  }

  listJobs({ includePaused = false, includeArchived = false, includeStale = false, now = new Date() } = {}) {
    return this.jobs
      .filter((job) => this.isVisibleJob(job, { includePaused, includeArchived, includeStale, now }))
      .map((job) => this.withLifecycle(job, now));
  }

  listJobsByParentSession(parentSessionId) {
    const indexedIds = this.parentSessionIndex.get(String(parentSessionId ?? "")) ?? new Set();
    return [...indexedIds]
      .map((jobId) => this.jobs.find((job) => job.id === jobId))
      .filter(Boolean)
      .map((job) => this.withLifecycle(job));
  }

  getRecurringTemplate(templateId) {
    const template = this.requireJob(templateId);
    if (!template.recurring) {
      throw new ValidationError(`${templateId} is not a recurring template`);
    }
    return template;
  }

  createJob(input) {
    const job = this.normalizeJobInput(input);
    if (this.jobs.some((candidate) => candidate.id === job.id)) {
      throw new ConflictError(`Job already exists: ${job.id}`, "job_exists");
    }

    this.jobs.unshift(job);
    this.indexJob(job);
    return job;
  }

  removeJob(jobId) {
    const idx = this.jobs.findIndex((job) => job.id === jobId);
    if (idx === -1) {
      return false;
    }
    const [removed] = this.jobs.splice(idx, 1);
    if (removed?.parentSessionId) {
      const indexed = this.parentSessionIndex.get(String(removed.parentSessionId));
      indexed?.delete(removed.id);
    }
    return true;
  }

  indexJob(job) {
    if (!job?.parentSessionId) {
      return;
    }
    const parentSessionId = String(job.parentSessionId);
    const indexed = this.parentSessionIndex.get(parentSessionId) ?? new Set();
    indexed.add(job.id);
    this.parentSessionIndex.set(parentSessionId, indexed);
  }

  getJobLifecycleSummary(now = new Date()) {
    const summary = {
      total: this.jobs.length,
      open: 0,
      claimable: 0,
      stale: 0,
      paused: 0,
      archived: 0
    };
    for (const job of this.jobs) {
      const lifecycle = this.buildLifecycle(job, now);
      if (lifecycle.status === "open") summary.open += 1;
      if (lifecycle.status === "paused") summary.paused += 1;
      if (lifecycle.status === "archived") summary.archived += 1;
      if (lifecycle.state === "stale") summary.stale += 1;
      if (this.isClaimableJob(job, now)) summary.claimable += 1;
    }
    return summary;
  }

  updateJobLifecycle(jobId, patch = {}, updatedAt = new Date()) {
    const job = this.requireJob(jobId);
    const current = this.buildLifecycle(job, updatedAt);
    const action = typeof patch?.action === "string" ? patch.action.trim().toLowerCase() : "";
    const requestedStatus = typeof patch?.status === "string"
      ? patch.status.trim().toLowerCase()
      : undefined;
    const status = this.resolveLifecycleStatus({ action, requestedStatus, currentStatus: current.status });
    const timestamp = updatedAt.toISOString();
    const lifecycle = {
      ...current,
      status,
      updatedAt: timestamp
    };

    if (typeof patch?.reason === "string" && patch.reason.trim()) {
      lifecycle.reason = patch.reason.trim().slice(0, 500);
    }
    if (typeof patch?.staleAt === "string" && patch.staleAt.trim()) {
      lifecycle.staleAt = normalizeIsoTimestamp(patch.staleAt, "staleAt");
    }
    if (action === "mark_stale") {
      lifecycle.staleAt = timestamp;
      lifecycle.staleReason = lifecycle.reason;
    }
    if (status === "paused" && current.status !== "paused") {
      lifecycle.pausedAt = timestamp;
    }
    if (status === "archived" && current.status !== "archived") {
      lifecycle.archivedAt = timestamp;
    }
    if (status === "open" && current.status !== "open") {
      lifecycle.reopenedAt = timestamp;
      lifecycle.staleAt = new Date(updatedAt.getTime() + DEFAULT_STALE_AFTER_MS).toISOString();
      delete lifecycle.pausedAt;
      delete lifecycle.archivedAt;
      delete lifecycle.staleReason;
    }

    delete lifecycle.state;
    job.lifecycle = lifecycle;
    return this.withLifecycle(job, updatedAt);
  }

  getRecurringTemplateStatus() {
    const templates = this.jobs.filter((job) => job.recurring);
    const entries = templates
      .map((template) => {
        const derivatives = this.jobs
          .filter((job) => job.templateId === template.id)
          .sort((left, right) => String(right.firedAt ?? "").localeCompare(String(left.firedAt ?? "")));
        const latest = derivatives[0];
        return {
          templateId: template.id,
          category: template.category,
          tier: template.tier,
          rewardAmount: template.rewardAmount,
          rewardAsset: template.rewardAsset,
          verifierMode: template.verifierMode,
          schedule: template.schedule,
          recurringPolicy: template.recurringPolicy,
          reserve: this.buildRecurringReserveStatus(template, derivatives),
          derivativeCount: derivatives.length,
          paused: Boolean(template.runtime?.paused),
          exhausted: Boolean(template.runtime?.exhausted),
          lastFiredAt: template.runtime?.lastFiredAt ?? latest?.firedAt,
          nextFireAt: template.runtime?.nextFireAt,
          lastResult: template.runtime?.lastResult,
          lastDerivativeId: latest?.id,
          latestRun: latest
            ? {
                id: latest.id,
                firedAt: latest.firedAt,
                category: latest.category,
                tier: latest.tier,
                verifierMode: latest.verifierMode
              }
            : undefined
        };
      })
      .sort((left, right) => left.templateId.localeCompare(right.templateId));

    return {
      count: entries.length,
      templates: entries
    };
  }

  updateRecurringTemplateRuntime(templateId, patch = {}) {
    const template = this.getRecurringTemplate(templateId);
    const nextRuntime = {
      ...(template.runtime ?? {}),
      ...patch
    };
    for (const [key, value] of Object.entries(nextRuntime)) {
      if (value === undefined) {
        delete nextRuntime[key];
      }
    }
    template.runtime = nextRuntime;
    return { ...template.runtime };
  }

  buildRecurringReserveStatus(template, derivatives = undefined) {
    const reserveAmount = Number(template?.recurringPolicy?.reserveAmount);
    if (!Number.isFinite(reserveAmount)) {
      return {
        mode: "unbounded",
        rewardAsset: template.rewardAsset,
        rewardAmount: template.rewardAmount
      };
    }

    const runCount = Array.isArray(derivatives)
      ? derivatives.length
      : this.jobs.filter((job) => job.templateId === template.id).length;
    const rewardAmount = Math.max(Number(template.rewardAmount ?? 0), 0);
    const consumedAmount = Math.max(runCount * rewardAmount, 0);
    const remainingAmount = Math.max(reserveAmount - consumedAmount, 0);
    const remainingRuns = rewardAmount > 0 ? Math.floor(remainingAmount / rewardAmount) : 0;

    return {
      mode: "finite",
      rewardAsset: template.rewardAsset,
      rewardAmount,
      reserveAmount,
      consumedAmount,
      remainingAmount,
      remainingRuns,
      exhausted: remainingAmount < rewardAmount
    };
  }

  pauseRecurringTemplate(templateId, pausedAt = new Date()) {
    return this.updateRecurringTemplateRuntime(templateId, {
      paused: true,
      pausedAt: pausedAt.toISOString()
    });
  }

  resumeRecurringTemplate(templateId, resumedAt = new Date()) {
    return this.updateRecurringTemplateRuntime(templateId, {
      paused: false,
      pausedAt: undefined,
      resumedAt: resumedAt.toISOString()
    });
  }

  async recommendJobs(wallet) {
    const profile = this.requireProfile(wallet);
    const account = await this.getAccountSummary(wallet);
    const reputation = await this.getReputation(wallet);
    const claimStakeBps = await this.getDefaultClaimStakeBps();

    return Promise.all(this.listJobs().map(async (job) => {
      const netReward = await this.estimateNetReward(wallet, job.id);
      const tierGate = summarizeTierGate(job.tier, reputation);
      const jobType = effectiveJobType(job);
      const requiredRole = effectiveRequiredRole(job);
      const roleGate = summarizeRoleGate(requiredRole, reputation);
      const eligible = this.isClaimableJob(job) && this.isEligible(job, profile, reputation);
      const liquid = account.liquid[job.rewardAsset] ?? 0;
      const claimEconomics = await this.resolveClaimEconomics(wallet, job, claimStakeBps);
      const fitScore = this.computeFitScore(job, profile, reputation, liquid, claimEconomics.totalClaimLock);

      return {
        jobId: job.id,
        fitScore,
        netReward,
        eligible,
        tier: job.tier,
        tierGate,
        jobType,
        requiredRole,
        roleGate,
        explanation: buildRecommendationExplanation({ job, eligible, tierGate, roleGate, profile })
      };
    })).then((recommendations) => recommendations.sort((left, right) => right.fitScore - left.fitScore));
  }

  getJobDefinition(jobId) {
    return this.withLifecycle(this.requireJob(jobId));
  }

  getPublicJobDefinition(jobId, visibility = {}) {
    const job = this.requireJob(jobId);
    const { now = new Date(), ...visibilityOptions } = visibility;
    if (!this.isVisibleJob(job, { ...visibilityOptions, now })) {
      throw new NotFoundError(`Unknown job: ${jobId}`, "job_not_found");
    }
    return this.withLifecycle(job, now);
  }

  getClaimableJobDefinition(jobId) {
    const job = this.requireJob(jobId);
    if (!this.isClaimableJob(job)) {
      const lifecycle = this.buildLifecycle(job);
      throw new ConflictError(
        `Job ${jobId} is not claimable (${lifecycle.state}).`,
        "job_not_claimable",
        { lifecycle }
      );
    }
    return this.withLifecycle(job);
  }

  async preflightJob(wallet, jobId) {
    const job = this.requireJob(jobId);
    const profile = this.requireProfile(wallet);
    const reputation = await this.getReputation(wallet);
    const account = await this.getAccountSummary(wallet);
    const liquid = account.liquid[job.rewardAsset] ?? 0;
    const claimStakeBps = await this.getDefaultClaimStakeBps();
    const claimEconomics = await this.resolveClaimEconomics(wallet, job, claimStakeBps);
    const lifecycle = this.buildLifecycle(job);
    const eligible = this.isClaimableJob(job) && this.isEligible(job, profile, reputation);
    const tierGate = summarizeTierGate(job.tier, reputation);
    const jobType = effectiveJobType(job);
    const requiredRole = effectiveRequiredRole(job);
    const roleGate = summarizeRoleGate(requiredRole, reputation);

    return {
      wallet,
      jobId,
      eligible,
      netReward: await this.estimateNetReward(wallet, jobId),
      availableLiquidity: liquid,
      claimStake: claimEconomics.claimStake,
      claimStakeBps: claimEconomics.claimStakeBps,
      claimFee: claimEconomics.claimFee,
      claimFeeBps: claimEconomics.claimFeeBps,
      claimEconomicsWaived: claimEconomics.claimEconomicsWaived,
      claimNumber: claimEconomics.claimNumber,
      totalClaimLock: claimEconomics.totalClaimLock,
      strategyUnwindNeeded: liquid < claimEconomics.totalClaimLock,
      requiredOutputSchema: job.outputSchemaRef,
      submissionContract: buildSubmissionContract(job),
      verificationContract: buildVerificationContract(job),
      verifierMode: job.verifierMode,
      verifierConfig: job.verifierConfig,
      tier: job.tier,
      lifecycle,
      tierGate,
      jobType,
      requiredRole,
      roleGate,
      failureStates: [
        "verifier_timeout",
        "submission_rejected",
        "dispute_opened",
        "insufficient_liquidity",
        "paused_system"
      ]
    };
  }

  async explainEligibility(wallet, jobId) {
    const job = this.requireJob(jobId);
    const profile = this.requireProfile(wallet);
    const reputation = await this.getReputation(wallet);
    const tierGate = summarizeTierGate(job.tier, reputation);
    const jobType = effectiveJobType(job);
    const requiredRole = effectiveRequiredRole(job);
    const roleGate = summarizeRoleGate(requiredRole, reputation);
    const lifecycle = this.buildLifecycle(job);

    return {
      jobId,
      wallet,
      tier: job.tier,
      lifecycle,
      tierGate,
      jobType,
      requiredRole,
      roleGate,
      preferredCategory: profile.preferredCategories.includes(job.category),
      supportsVerifier: profile.verifierCompatibility.includes(job.verifierMode),
      reputationTier: reputation.tier,
      verifierHandler: job.verifierConfig.handler,
      eligible: this.isClaimableJob(job) && this.isEligible(job, profile, reputation)
    };
  }

  /**
   * Snapshot of the tier ladder a given wallet sees right now. Used by
   * the public `/jobs/tiers` endpoint so agents can introspect the gate
   * requirements without having to guess from individual preflight
   * responses. `currentTier` echoes the reputation-derived tier; each
   * ladder rung carries its `requires` + `has` + `missing` so the caller
   * can draw a "what you'd unlock" bar.
   */
  async tierLadder(wallet) {
    const reputation = await this.getReputation(wallet);
    const summaries = TIER_ORDER.map((tier) => summarizeTierGate(tier, reputation));
    const next = summaries.find((summary) => !summary.unlocked);
    return {
      wallet,
      reputation: {
        skill: Number.isInteger(reputation?.skill) ? reputation.skill : 0,
        reliability: Number.isInteger(reputation?.reliability) ? reputation.reliability : 0,
        economic: Number.isInteger(reputation?.economic) ? reputation.economic : 0,
        tier: reputation?.tier ?? "starter"
      },
      tiers: summaries,
      nextLocked: next ?? null
    };
  }

  async estimateNetReward(wallet, jobId) {
    const job = this.requireJob(jobId);
    const profile = this.requireProfile(wallet);
    const gasPenalty = job.requiresSponsoredGas ? 0 : 0.5;
    const riskPenalty = profile.preferredRiskLevel === "low" && job.tier === "elite" ? 5 : 0;
    return Math.max(job.rewardAmount - gasPenalty - riskPenalty, 0);
  }

  requireJob(jobId) {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new NotFoundError(`Unknown job: ${jobId}`, "job_not_found");
    }
    return job;
  }

  isVisibleJob(job, { includePaused = false, includeArchived = false, includeStale = false, now = new Date() } = {}) {
    const lifecycle = this.buildLifecycle(job, now);
    if (lifecycle.status === "paused") return includePaused;
    if (lifecycle.status === "archived") return includeArchived;
    if (lifecycle.state === "stale") return includeStale;
    return true;
  }

  isClaimableJob(job, now = new Date()) {
    const lifecycle = this.buildLifecycle(job, now);
    return lifecycle.status === "open" && lifecycle.state === "open";
  }

  withLifecycle(job, now = new Date()) {
    const publicDetails = buildPublicJobDetails(job);
    const submissionContract = buildSubmissionContract(job);
    const schemaContract = buildSchemaContract(job);
    const verificationContract = buildVerificationContract(job);
    return {
      ...job,
      ...(publicDetails ? { publicDetails } : {}),
      ...(submissionContract ? { submissionContract } : {}),
      ...(schemaContract ? { schemaContract } : {}),
      verificationContract,
      lifecycle: this.buildLifecycle(job, now)
    };
  }

  buildLifecycle(job, now = new Date()) {
    const raw = normalisePlainObject(job?.lifecycle, "lifecycle") ?? {};
    const status = VALID_JOB_LIFECYCLE_STATUSES.has(raw.status) ? raw.status : "open";
    const staleAt = typeof raw.staleAt === "string" && raw.staleAt.trim()
      ? raw.staleAt.trim()
      : undefined;
    const stale = status === "open" && staleAt && Date.parse(staleAt) <= now.getTime();
    return {
      status,
      state: stale ? "stale" : status,
      ...(typeof raw.createdAt === "string" ? { createdAt: raw.createdAt } : {}),
      ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
      ...(staleAt ? { staleAt } : {}),
      ...(typeof raw.pausedAt === "string" ? { pausedAt: raw.pausedAt } : {}),
      ...(typeof raw.archivedAt === "string" ? { archivedAt: raw.archivedAt } : {}),
      ...(typeof raw.reopenedAt === "string" ? { reopenedAt: raw.reopenedAt } : {}),
      ...(typeof raw.reason === "string" && raw.reason.trim() ? { reason: raw.reason.trim() } : {}),
      ...(typeof raw.staleReason === "string" && raw.staleReason.trim() ? { staleReason: raw.staleReason.trim() } : {})
    };
  }

  resolveLifecycleStatus({ action, requestedStatus, currentStatus }) {
    if (requestedStatus !== undefined) {
      if (!VALID_JOB_LIFECYCLE_STATUSES.has(requestedStatus)) {
        throw new ValidationError(`Invalid job lifecycle status: ${requestedStatus}`);
      }
      return requestedStatus;
    }
    if (!action) {
      return currentStatus;
    }
    if (action === "pause") return "paused";
    if (action === "archive") return "archived";
    if (action === "reopen" || action === "mark_stale") return "open";
    throw new ValidationError(`Invalid job lifecycle action: ${action}`);
  }

  requireProfile(wallet) {
    const existing = this.profiles.get(wallet);
    if (existing) {
      return existing;
    }
    const profile = {
      wallet,
      ...DEFAULT_AGENT_PROFILE
    };
    this.profiles.set(wallet, profile);
    return profile;
  }

  computeFitScore(job, profile, reputation, liquid, claimStake) {
    let score = 0;
    if (profile.preferredCategories.includes(job.category)) score += 30;
    if (profile.verifierCompatibility.includes(job.verifierMode)) score += 30;
    if ((job.tier === "starter" && reputation.tier === "starter") || reputation.tier === "elite") score += 20;
    if (liquid >= claimStake || claimStake === 0) score += 20;
    return score;
  }

  async resolveClaimEconomics(wallet, job, claimStakeBps) {
    if (typeof this.getClaimEconomics === "function") {
      return this.getClaimEconomics(wallet, job);
    }
    const claimStake = Math.max((job.rewardAmount * claimStakeBps) / 10_000, 0);
    return {
      claimStake,
      claimStakeBps,
      claimFee: 0,
      claimFeeBps: 0,
      claimEconomicsWaived: false,
      claimNumber: undefined,
      totalClaimLock: claimStake
    };
  }

  isEligible(job, profile, reputation) {
    if (!profile.verifierCompatibility.includes(job.verifierMode)) return false;
    return summarizeTierGate(job.tier, reputation).unlocked && summarizeRoleGate(effectiveRequiredRole(job), reputation).unlocked;
  }

  normalizeJobInput(input) {
    return normalizeCatalogJobInput(input);
  }

  /**
   * Instantiate a new derivative job from a recurring template. Returns
   * the derivative job record (already inserted into the catalog) so
   * the HTTP layer can echo it to the caller. The derivative's id is
   * deterministic from the template id + ISO timestamp so dashboards
   * can group a template's runs together. The template itself is
   * preserved in the catalog so future fires continue from the same
   * source record.
   */
  fireRecurringJob(templateId, { firedAt = new Date() } = {}) {
    const template = this.getRecurringTemplate(templateId);
    const reserve = this.buildRecurringReserveStatus(template);
    if (reserve.exhausted) {
      this.updateRecurringTemplateRuntime(templateId, {
        exhausted: true,
        nextFireAt: undefined,
        lastResult: {
          status: "reserve_exhausted",
          at: firedAt.toISOString(),
          message: `Recurring reserve exhausted for ${templateId}`,
          reserve
        }
      });
      throw new ConflictError(
        `Recurring reserve exhausted for ${templateId}`,
        "recurring_reserve_exhausted",
        { templateId, reserve }
      );
    }
    const stamp = firedAt.toISOString().replace(/[:.]/g, "-").replace("Z", "").slice(0, 19);
    const derivativeId = this.normalizeId(`${templateId}-run-${stamp}`);
    if (this.jobs.some((candidate) => candidate.id === derivativeId)) {
      throw new ConflictError(`Derivative already exists: ${derivativeId}`, "recurring_job_collision");
    }
    const derivative = {
      ...template,
      id: derivativeId,
      recurring: false,
      templateId,
      firedAt: firedAt.toISOString(),
      ...(template.recurringPolicy?.funding
        ? {
            funding: {
              source: "recurring_template_reserve",
              templateId,
              wallet: template.recurringPolicy.funding.wallet,
              asset: template.recurringPolicy.funding.asset ?? template.rewardAsset,
              amount: template.rewardAmount,
              reservedAt: template.recurringPolicy.funding.reservedAt,
              templateKey: template.recurringPolicy.funding.templateKey
            }
          }
        : {}),
      lifecycle: normaliseLifecycle({
        ...(template.lifecycle ?? {}),
        status: "open",
        createdAt: firedAt.toISOString(),
        updatedAt: firedAt.toISOString(),
        staleAt: new Date(firedAt.getTime() + DEFAULT_STALE_AFTER_MS).toISOString()
      })
    };
    delete derivative.schedule;
    delete derivative.recurringPolicy;
    this.jobs.unshift(derivative);
    const nextReserve = this.buildRecurringReserveStatus(template);
    this.updateRecurringTemplateRuntime(templateId, {
      lastFiredAt: firedAt.toISOString(),
      nextFireAt: nextReserve.exhausted ? undefined : template.runtime?.nextFireAt,
      reserve: nextReserve,
      exhausted: Boolean(nextReserve.exhausted),
      lastResult: {
        status: "fired",
        at: firedAt.toISOString(),
        derivativeId,
        reserve: nextReserve
      }
    });
    return derivative;
  }

  normalizeId(value) {
    return normalizeJobId(value);
  }
}

function buildPublicJobDetails(job) {
  if (job?.source?.type !== "wikipedia_article") {
    return undefined;
  }
  const source = job.source;
  const articleUrl = source.articleUrl ?? source.pageUrl;
  const pinnedRevisionUrl = source.pinnedRevisionUrl ?? buildWikipediaPinnedRevisionUrl(source);
  return {
    jobId: job.id,
    source: "wikipedia",
    taskType: source.taskType,
    pageTitle: source.pageTitle,
    lang: source.lang ?? source.language,
    revisionId: source.revisionId,
    articleUrl,
    pinnedRevisionUrl,
    acceptanceCriteria: Array.isArray(job.acceptanceCriteria) ? job.acceptanceCriteria : [],
    outputSchemaRef: job.outputSchemaRef,
    outputSchemaUrl: source.outputSchemaUrl ?? schemaRefToJobSchemaPath(job.outputSchemaRef),
    proposalOnly: source.proposalOnly ?? source.attribution?.directEdit === false,
    attributionPolicy: source.attributionPolicy ?? "Averray proposal only / no direct Wikipedia edit"
  };
}

function buildSubmissionContract(job) {
  const schema = getJobSchema(job?.outputSchemaRef, { registrations: job?.schemaRegistrations });
  if (!schema) {
    return undefined;
  }
  const registration = getRegisteredJobSchemaRegistration(job?.outputSchemaRef, job?.schemaRegistrations);

  return {
    endpoint: "POST /jobs/submit",
    validationEndpoint: "POST /jobs/validate-submission",
    submissionShape: "direct_schema_object",
    structuredSubmissionRequired: true,
    schemaValidates: "payload.submission",
    doNotWrapInOutput: true,
    compatibilityAliases: ["payload.submission.output"],
    outputSchemaRef: job.outputSchemaRef,
    outputSchemaUrl: schemaRefToJobSchemaPath(job.outputSchemaRef, { registrations: job?.schemaRegistrations }),
    ...(registration
      ? {
          registeredSchema: true,
          schemaHash: registration.schemaHash,
          schemaIssuer: registration.issuer,
          trustBoundary: registration.trustBoundary
        }
      : {}),
    submitPayloadExample: {
      sessionId: "<session-id>",
      submission: buildSchemaExample(schema)
    },
    invalidWrappedOutputHint: "Send the schema object directly as payload.submission. Do not wrap it under payload.submission.output."
  };
}

function buildSchemaContract(job) {
  const inputSchemaKnown = isBuiltinJobSchemaRef(job?.inputSchemaRef);
  const outputSchemaKnown = isBuiltinJobSchemaRef(job?.outputSchemaRef);
  const inputSchemaRegistered = isRegisteredJobSchemaRef(job?.inputSchemaRef, job?.schemaRegistrations);
  const outputSchemaRegistered = isRegisteredJobSchemaRef(job?.outputSchemaRef, job?.schemaRegistrations);
  if (!inputSchemaKnown && !outputSchemaKnown && !inputSchemaRegistered && !outputSchemaRegistered) {
    return undefined;
  }
  const inputRegistration = getRegisteredJobSchemaRegistration(job?.inputSchemaRef, job?.schemaRegistrations);
  const outputRegistration = getRegisteredJobSchemaRegistration(job?.outputSchemaRef, job?.schemaRegistrations);

  return {
    input: {
      schemaRef: job.inputSchemaRef,
      schemaUrl: schemaRefToJobSchemaPath(job.inputSchemaRef, { registrations: job?.schemaRegistrations }),
      knownBuiltin: inputSchemaKnown,
      registered: inputSchemaRegistered,
      ...(inputRegistration ? schemaTrustFields(inputRegistration) : {})
    },
    output: {
      schemaRef: job.outputSchemaRef,
      schemaUrl: schemaRefToJobSchemaPath(job.outputSchemaRef, { registrations: job?.schemaRegistrations }),
      knownBuiltin: outputSchemaKnown,
      registered: outputSchemaRegistered,
      ...(outputRegistration ? schemaTrustFields(outputRegistration) : {}),
      validates: "payload.submission",
      validationEndpoint: "POST /jobs/validate-submission"
    }
  };
}

function schemaTrustFields(registration) {
  return {
    schemaHash: registration.schemaHash,
    issuer: registration.issuer,
    trustBoundary: registration.trustBoundary,
    signatureVerified: registration.signatureVerified === true,
    trusted: registration.trusted === true
  };
}

function buildSchemaExample(schema, fieldName = "value") {
  if (!schema || typeof schema !== "object") {
    return "...";
  }
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum[0];
  }
  if (schema.type === "object") {
    const properties = schema.properties ?? {};
    const keys = schema.required?.length ? schema.required : Object.keys(properties).slice(0, 3);
    return Object.fromEntries(keys.map((key) => [key, buildSchemaExample(properties[key], key)]));
  }
  if (schema.type === "array") {
    const item = buildSchemaExample(schema.items, singularizeFieldName(fieldName));
    return Number.isInteger(schema.minItems) && schema.minItems > 0 ? [item] : [];
  }
  if (schema.type === "integer") {
    return 1;
  }
  if (schema.type === "number") {
    return 1;
  }
  if (schema.type === "boolean") {
    return true;
  }
  if (schema.type === "string") {
    return sampleStringForField(fieldName);
  }
  return "...";
}

function sampleStringForField(fieldName) {
  const normalized = String(fieldName ?? "").toLowerCase();
  if (normalized.includes("url")) return "https://example.com/source";
  if (normalized.includes("revision")) return "123456789";
  if (normalized.includes("page_title") || normalized.includes("pagetitle")) return "Example article";
  if (normalized.includes("risk")) return "low";
  if (normalized.includes("status")) return "complete";
  return "...";
}

function singularizeFieldName(fieldName) {
  return String(fieldName ?? "item").replace(/s$/u, "");
}

function buildWikipediaPinnedRevisionUrl(source) {
  const lang = String(source?.lang ?? source?.language ?? "en").trim() || "en";
  const title = String(source?.pageTitle ?? "").trim();
  const revisionId = String(source?.revisionId ?? "").trim();
  const url = new URL(`https://${lang}.wikipedia.org/w/index.php`);
  if (title) {
    url.searchParams.set("title", title.replace(/\s+/gu, "_"));
  }
  if (revisionId) {
    url.searchParams.set("oldid", revisionId);
  }
  return String(url);
}

function buildRecommendationExplanation({ job, eligible, tierGate, roleGate, profile }) {
  const jobType = effectiveJobType(job);
  const requiredRole = effectiveRequiredRole(job);
  if (eligible) {
    return `Eligible via ${job.category} preferences and ${job.verifierMode} verifier support.`;
  }
  if (!tierGate.unlocked) {
    const gaps = Object.entries(tierGate.missing)
      .map(([key, gap]) => `${gap} more ${key}`)
      .join(", ");
    return `${job.tier} tier locked — earn ${gaps} to unlock this job.`;
  }
  if (roleGate && !roleGate.unlocked) {
    const gaps = Object.entries(roleGate.missing)
      .map(([key, gap]) => `${gap} more ${key}`)
      .join(", ");
    return `${requiredRole} role locked — earn ${gaps} to unlock this ${jobType} job.`;
  }
  if (!profile.verifierCompatibility.includes(job.verifierMode)) {
    return `Verifier mode ${job.verifierMode} not in this wallet's capability list.`;
  }
  return "Missing eligibility, liquidity, or reputation requirements for this tier.";
}
