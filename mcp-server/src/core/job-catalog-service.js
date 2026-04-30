import {
  ConflictError,
  NotFoundError,
  ValidationError
} from "./errors.js";
import { isBuiltinJobSchemaRef, schemaRefToJobSchemaPath } from "./job-schema-registry.js";

const DEFAULT_AGENT_PROFILE = {
  capabilities: ["claim_job", "submit_work", "allocate_idle_funds"],
  supportedProtocols: ["mcp", "http"],
  preferredCategories: ["coding"],
  preferredRiskLevel: "low",
  verifierCompatibility: ["benchmark", "deterministic", "human_fallback", "github_pr"],
  minLiquidReserve: 0,
  autoUnwindStrategies: false
};

const VALID_TIERS = new Set(["starter", "pro", "elite"]);
const VALID_VERIFIER_MODES = new Set(["benchmark", "deterministic", "human_fallback", "github_pr"]);
const VALID_JOB_TYPES = new Set(["work", "curation", "review", "publish", "verification"]);
const VALID_AGENT_ROLES = new Set(["worker", "curator", "reviewer", "publisher", "verifier", "arbitrator"]);
const VALID_JOB_LIFECYCLE_STATUSES = new Set(["open", "paused", "archived"]);
const DEFAULT_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export const ROLE_REQUIREMENTS = {
  worker: { skill: 0 },
  curator: { skill: 50 },
  reviewer: { skill: 100 },
  publisher: { skill: 200 },
  verifier: { skill: 300 },
  arbitrator: { skill: 500 }
};

const DEFAULT_ROLE_BY_JOB_TYPE = {
  work: "worker",
  curation: "curator",
  review: "reviewer",
  publish: "publisher",
  verification: "verifier"
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
  }

  listJobs({ includePaused = false, includeArchived = false, includeStale = false, now = new Date() } = {}) {
    return this.jobs
      .filter((job) => this.isVisibleJob(job, { includePaused, includeArchived, includeStale, now }))
      .map((job) => this.withLifecycle(job, now));
  }

  listJobsByParentSession(parentSessionId) {
    return this.jobs
      .filter((job) => job.parentSessionId === parentSessionId)
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
    return job;
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
          derivativeCount: derivatives.length,
          paused: Boolean(template.runtime?.paused),
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

  getPublicJobDefinition(jobId) {
    const job = this.requireJob(jobId);
    if (!this.isVisibleJob(job)) {
      throw new NotFoundError(`Unknown job: ${jobId}`, "job_not_found");
    }
    return this.withLifecycle(job);
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
    return {
      ...job,
      ...(publicDetails ? { publicDetails } : {}),
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
    const id = this.normalizeId(input?.id);
    const category = String(input?.category ?? "").trim().toLowerCase();
    const tier = String(input?.tier ?? "").trim().toLowerCase();
    const verifierMode = String(input?.verifierMode ?? "").trim().toLowerCase();
    const rewardAmount = Number(input?.rewardAmount ?? 0);
    const claimTtlSeconds = Number(input?.claimTtlSeconds ?? 3600);
    const retryLimit = Number(input?.retryLimit ?? 1);
    const rewardAsset = String(input?.rewardAsset ?? "DOT").trim().toUpperCase();
    const jobType = normalizeJobType(input?.jobType);
    const requiredRole = normalizeAgentRole(input?.requiredRole ?? DEFAULT_ROLE_BY_JOB_TYPE[jobType]);

    if (!id) {
      throw new ValidationError("Job id is required.");
    }
    if (!category) {
      throw new ValidationError("Category is required.");
    }
    if (!VALID_TIERS.has(tier)) {
      throw new ValidationError(`Invalid tier: ${tier}`);
    }
    if (!VALID_VERIFIER_MODES.has(verifierMode)) {
      throw new ValidationError(`Invalid verifier mode: ${verifierMode}`);
    }
    if (!jobType) {
      throw new ValidationError(`Invalid job type: ${input?.jobType}`);
    }
    if (!requiredRole) {
      throw new ValidationError(`Invalid required role: ${input?.requiredRole}`);
    }
    if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
      throw new ValidationError("Reward amount must be greater than zero.");
    }
    if (!Number.isInteger(claimTtlSeconds) || claimTtlSeconds < 60) {
      throw new ValidationError("Claim TTL must be at least 60 seconds.");
    }
    if (!Number.isInteger(retryLimit) || retryLimit < 0) {
      throw new ValidationError("Retry limit must be zero or higher.");
    }

    const inputSchemaRef = String(input?.inputSchemaRef ?? `schema://jobs/${category}-input`).trim();
    const outputSchemaRef = String(input?.outputSchemaRef ?? `schema://jobs/${category}-output`).trim();
    this.validateSchemaRef(inputSchemaRef, "inputSchemaRef");
    this.validateSchemaRef(outputSchemaRef, "outputSchemaRef");

    // Optional sub-job lineage. When an agent spawns a sub-job from inside
    // its own session, include `parentSessionId` so the indexer + profile
    // surfaces can reconstruct who hired whom. We validate the shape but
    // do not enforce that it points to a real session — state-store
    // consistency is surfaced by the dashboard, not the contract.
    const parentSessionId = typeof input?.parentSessionId === "string"
      ? input.parentSessionId.trim()
      : "";

    // Optional recurring-job schedule. v1 just normalises + validates the
    // schedule field; the actual scheduler worker is a follow-up (see
    // docs/patterns/recurring-jobs.md). A recurring template is a job
    // record with `recurring: true` and a cron-style `schedule.cron`
    // expression; each firing mints a derivative job with its own id.
    const recurring = Boolean(input?.recurring);
    const schedule = normaliseSchedule(input?.schedule, recurring);
    const title = normaliseTextField(input?.title);
    const description = normaliseTextField(input?.description);
    const acceptanceCriteria = normaliseStringList(input?.acceptanceCriteria);
    const agentInstructions = normaliseStringList(input?.agentInstructions);
    const estimatedDifficulty = normaliseTextField(input?.estimatedDifficulty);
    const source = normalisePlainObject(input?.source, "source");
    const verification = normalisePlainObject(input?.verification, "verification");
    const lifecycle = normaliseLifecycle(input?.lifecycle, { disableStale: recurring });

    return {
      id,
      category,
      tier,
      jobType,
      requiredRole,
      rewardAsset,
      rewardAmount,
      verifierMode,
      verifierConfig: this.buildVerifierConfig(verifierMode, input),
      inputSchemaRef,
      outputSchemaRef,
      claimTtlSeconds,
      retryLimit,
      requiresSponsoredGas: Boolean(input?.requiresSponsoredGas),
      lifecycle,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(source ? { source } : {}),
      ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}),
      ...(estimatedDifficulty ? { estimatedDifficulty } : {}),
      ...(agentInstructions.length ? { agentInstructions } : {}),
      ...(verification ? { verification } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(recurring ? { recurring: true } : {}),
      ...(schedule ? { schedule } : {})
    };
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
      lifecycle: normaliseLifecycle({
        ...(template.lifecycle ?? {}),
        status: "open",
        createdAt: firedAt.toISOString(),
        updatedAt: firedAt.toISOString(),
        staleAt: new Date(firedAt.getTime() + DEFAULT_STALE_AFTER_MS).toISOString()
      })
    };
    delete derivative.schedule;
    this.jobs.unshift(derivative);
    this.updateRecurringTemplateRuntime(templateId, {
      lastFiredAt: firedAt.toISOString(),
      lastResult: {
        status: "fired",
        at: firedAt.toISOString(),
        derivativeId
      }
    });
    return derivative;
  }

  buildVerifierConfig(verifierMode, input) {
    const verifierTerms = Array.isArray(input?.verifierTerms)
      ? input.verifierTerms.map((value) => String(value).trim()).filter(Boolean)
      : [];

    if (verifierMode === "benchmark") {
      const minimumMatches = Number(input?.verifierMinimumMatches ?? Math.min(verifierTerms.length || 1, 2));
      if (!verifierTerms.length) {
        throw new ValidationError("Benchmark jobs need at least one verifier keyword.");
      }
      if (!Number.isInteger(minimumMatches) || minimumMatches < 1) {
        throw new ValidationError("Benchmark minimum matches must be at least 1.");
      }
      return {
        version: 1,
        handler: "benchmark",
        requiredKeywords: verifierTerms,
        minimumMatches: Math.min(minimumMatches, verifierTerms.length)
      };
    }

    if (verifierMode === "deterministic") {
      const matchMode = String(input?.verifierMatchMode ?? "contains_all").trim();
      if (!verifierTerms.length) {
        throw new ValidationError("Deterministic jobs need at least one expected output.");
      }
      if (!["exact", "contains_all"].includes(matchMode)) {
        throw new ValidationError(`Invalid deterministic match mode: ${matchMode}`);
      }
      return {
        version: 1,
        handler: "deterministic",
        expectedOutputs: verifierTerms,
        matchMode
      };
    }

    if (verifierMode === "github_pr") {
      const minimumScore = Number(input?.verifierMinimumScore ?? input?.minimumScore ?? 60);
      if (!Number.isInteger(minimumScore) || minimumScore < 1 || minimumScore > 100) {
        throw new ValidationError("GitHub PR verifier minimum score must be an integer from 1 to 100.");
      }
      return {
        version: 1,
        handler: "github_pr",
        minimumScore,
        requireIssueReference: input?.requireIssueReference !== false,
        requireTestEvidence: input?.requireTestEvidence !== false,
        acceptMergedAsApproved: input?.acceptMergedAsApproved !== false
      };
    }

    return {
      version: 1,
      handler: "human_fallback",
      escalationMessage: String(input?.escalationMessage ?? "Escalate to human reviewer.").trim(),
      autoApprove: Boolean(input?.autoApprove)
    };
  }

  normalizeId(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  validateSchemaRef(value, field) {
    if (!/^schema:\/\/jobs\/[a-z0-9-]+$/u.test(value)) {
      throw new ValidationError(`${field} must be a schema://jobs/<name> ref.`);
    }
    // Built-in schemas are first-class and used for structured submission
    // validation. Unknown refs are still allowed so custom/off-platform schema
    // contracts remain usable, but callers won't get structured validation
    // unless the schema is registered here.
    if (isBuiltinJobSchemaRef(value)) {
      return;
    }
  }
}

/**
 * Validate an input schedule block and return a canonicalised copy, or
 * undefined when the caller didn't supply one. Requires a 5-field cron
 * string; the scheduler worker (future) reads `schedule.cron`. Other
 * fields (`timezone`, `startAt`, `endAt`) are recorded but not yet
 * enforced — documented as v2 in docs/patterns/recurring-jobs.md.
 */
function normaliseSchedule(raw, recurring) {
  if (!raw && !recurring) return undefined;
  if (!raw) {
    throw new ValidationError("recurring jobs must include a schedule");
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("schedule must be an object");
  }
  const cron = typeof raw.cron === "string" ? raw.cron.trim() : "";
  if (!cron) {
    throw new ValidationError("schedule.cron is required for recurring jobs");
  }
  const parts = cron.split(/\s+/u);
  if (parts.length !== 5) {
    throw new ValidationError(`schedule.cron must have 5 fields; got: "${cron}"`);
  }
  const normalised = { cron };
  if (typeof raw.timezone === "string" && raw.timezone.trim()) {
    normalised.timezone = raw.timezone.trim();
  }
  for (const key of ["startAt", "endAt"]) {
    if (typeof raw[key] === "string" && raw[key].trim()) {
      const parsed = Date.parse(raw[key]);
      if (Number.isNaN(parsed)) {
        throw new ValidationError(`schedule.${key} must be ISO-8601 if provided`);
      }
      normalised[key] = new Date(parsed).toISOString();
    }
  }
  return normalised;
}

/**
 * Produce a human-readable explanation that mentions the tier gate when
 * it's the blocker. Pulled out of `recommendJobs` so the string is easy
 * to tweak without touching the rest of the request flow.
 */
function normalizeJobType(value) {
  const normalised = String(value ?? "work").trim().toLowerCase();
  return VALID_JOB_TYPES.has(normalised) ? normalised : undefined;
}

function normalizeAgentRole(value) {
  const normalised = String(value ?? "worker").trim().toLowerCase();
  return VALID_AGENT_ROLES.has(normalised) ? normalised : undefined;
}

function effectiveJobType(job) {
  return normalizeJobType(job?.jobType) ?? "work";
}

function effectiveRequiredRole(job) {
  return normalizeAgentRole(job?.requiredRole) ?? DEFAULT_ROLE_BY_JOB_TYPE[effectiveJobType(job)] ?? "worker";
}

function normaliseTextField(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normaliseStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function normalisePlainObject(value, field) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object if provided.`);
  }
  return JSON.parse(JSON.stringify(value));
}

function normaliseLifecycle(value, { disableStale = false, now = new Date() } = {}) {
  const raw = normalisePlainObject(value, "lifecycle") ?? {};
  const createdAt = typeof raw.createdAt === "string" && raw.createdAt.trim()
    ? normalizeIsoTimestamp(raw.createdAt, "lifecycle.createdAt")
    : now.toISOString();
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt.trim()
    ? normalizeIsoTimestamp(raw.updatedAt, "lifecycle.updatedAt")
    : createdAt;
  const status = typeof raw.status === "string" && raw.status.trim()
    ? raw.status.trim().toLowerCase()
    : "open";
  if (!VALID_JOB_LIFECYCLE_STATUSES.has(status)) {
    throw new ValidationError(`Invalid job lifecycle status: ${status}`);
  }
  const lifecycle = {
    status,
    createdAt,
    updatedAt
  };
  const defaultStaleAt = disableStale
    ? undefined
    : new Date(Date.parse(createdAt) + DEFAULT_STALE_AFTER_MS).toISOString();
  const staleAt = typeof raw.staleAt === "string" && raw.staleAt.trim()
    ? normalizeIsoTimestamp(raw.staleAt, "lifecycle.staleAt")
    : defaultStaleAt;
  if (staleAt) lifecycle.staleAt = staleAt;

  for (const key of ["pausedAt", "archivedAt", "reopenedAt"]) {
    if (typeof raw[key] === "string" && raw[key].trim()) {
      lifecycle[key] = normalizeIsoTimestamp(raw[key], `lifecycle.${key}`);
    }
  }
  for (const key of ["reason", "staleReason"]) {
    if (typeof raw[key] === "string" && raw[key].trim()) {
      lifecycle[key] = raw[key].trim().slice(0, 500);
    }
  }
  return lifecycle;
}

function normalizeIsoTimestamp(value, field) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ValidationError(`${field} must be ISO-8601 if provided.`);
  }
  return new Date(parsed).toISOString();
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
