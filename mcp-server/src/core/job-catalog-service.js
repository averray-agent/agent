import {
  ConflictError,
  NotFoundError,
  ValidationError
} from "./errors.js";

const DEFAULT_AGENT_PROFILE = {
  capabilities: ["claim_job", "submit_work", "allocate_idle_funds"],
  supportedProtocols: ["mcp", "a2a", "http"],
  preferredCategories: ["coding"],
  preferredRiskLevel: "low",
  verifierCompatibility: ["benchmark", "deterministic", "human_fallback"],
  minLiquidReserve: 0,
  autoUnwindStrategies: false
};

const VALID_TIERS = new Set(["starter", "pro", "elite"]);
const VALID_VERIFIER_MODES = new Set(["benchmark", "deterministic", "human_fallback"]);

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

export class JobCatalogService {
  constructor(jobs, profiles, getAccountSummary, getReputation, getDefaultClaimStakeBps) {
    this.jobs = jobs;
    this.profiles = profiles;
    this.getAccountSummary = getAccountSummary;
    this.getReputation = getReputation;
    this.getDefaultClaimStakeBps = getDefaultClaimStakeBps;
  }

  listJobs() {
    return [...this.jobs];
  }

  createJob(input) {
    const job = this.normalizeJobInput(input);
    if (this.jobs.some((candidate) => candidate.id === job.id)) {
      throw new ConflictError(`Job already exists: ${job.id}`, "job_exists");
    }

    this.jobs.unshift(job);
    return job;
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
          lastFiredAt: latest?.firedAt,
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

  async recommendJobs(wallet) {
    const profile = this.requireProfile(wallet);
    const account = await this.getAccountSummary(wallet);
    const reputation = await this.getReputation(wallet);
    const claimStakeBps = await this.getDefaultClaimStakeBps();

    return Promise.all(this.jobs.map(async (job) => {
      const netReward = await this.estimateNetReward(wallet, job.id);
      const tierGate = summarizeTierGate(job.tier, reputation);
      const eligible = this.isEligible(job, profile, reputation);
      const liquid = account.liquid[job.rewardAsset] ?? 0;
      const claimStake = Math.max((job.rewardAmount * claimStakeBps) / 10_000, 0);
      const fitScore = this.computeFitScore(job, profile, reputation, liquid, claimStake);

      return {
        jobId: job.id,
        fitScore,
        netReward,
        eligible,
        tier: job.tier,
        tierGate,
        explanation: buildRecommendationExplanation({ job, eligible, tierGate, profile })
      };
    })).then((recommendations) => recommendations.sort((left, right) => right.fitScore - left.fitScore));
  }

  getJobDefinition(jobId) {
    return this.requireJob(jobId);
  }

  async preflightJob(wallet, jobId) {
    const job = this.requireJob(jobId);
    const profile = this.requireProfile(wallet);
    const reputation = await this.getReputation(wallet);
    const account = await this.getAccountSummary(wallet);
    const liquid = account.liquid[job.rewardAsset] ?? 0;
    const claimStakeBps = await this.getDefaultClaimStakeBps();
    const claimStake = Math.max((job.rewardAmount * claimStakeBps) / 10_000, 0);
    const eligible = this.isEligible(job, profile, reputation);
    const tierGate = summarizeTierGate(job.tier, reputation);

    return {
      wallet,
      jobId,
      eligible,
      netReward: await this.estimateNetReward(wallet, jobId),
      availableLiquidity: liquid,
      claimStake,
      claimStakeBps,
      strategyUnwindNeeded: liquid < claimStake,
      requiredOutputSchema: job.outputSchemaRef,
      verifierMode: job.verifierMode,
      verifierConfig: job.verifierConfig,
      tier: job.tier,
      tierGate,
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

    return {
      jobId,
      wallet,
      tier: job.tier,
      tierGate,
      preferredCategory: profile.preferredCategories.includes(job.category),
      supportsVerifier: profile.verifierCompatibility.includes(job.verifierMode),
      reputationTier: reputation.tier,
      verifierHandler: job.verifierConfig.handler,
      eligible: this.isEligible(job, profile, reputation)
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

  isEligible(job, profile, reputation) {
    if (!profile.verifierCompatibility.includes(job.verifierMode)) return false;
    return summarizeTierGate(job.tier, reputation).unlocked;
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
    if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
      throw new ValidationError("Reward amount must be greater than zero.");
    }
    if (!Number.isInteger(claimTtlSeconds) || claimTtlSeconds < 60) {
      throw new ValidationError("Claim TTL must be at least 60 seconds.");
    }
    if (!Number.isInteger(retryLimit) || retryLimit < 0) {
      throw new ValidationError("Retry limit must be zero or higher.");
    }

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

    return {
      id,
      category,
      tier,
      rewardAsset,
      rewardAmount,
      verifierMode,
      verifierConfig: this.buildVerifierConfig(verifierMode, input),
      inputSchemaRef: String(input?.inputSchemaRef ?? `schema://jobs/${category}-input`).trim(),
      outputSchemaRef: String(input?.outputSchemaRef ?? `schema://jobs/${category}-output`).trim(),
      claimTtlSeconds,
      retryLimit,
      requiresSponsoredGas: Boolean(input?.requiresSponsoredGas),
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
    const template = this.requireJob(templateId);
    if (!template.recurring) {
      throw new ValidationError(`${templateId} is not a recurring template`);
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
      firedAt: firedAt.toISOString()
    };
    delete derivative.schedule;
    this.jobs.unshift(derivative);
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
        handler: "deterministic",
        expectedOutputs: verifierTerms,
        matchMode
      };
    }

    return {
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
function buildRecommendationExplanation({ job, eligible, tierGate, profile }) {
  if (eligible) {
    return `Eligible via ${job.category} preferences and ${job.verifierMode} verifier support.`;
  }
  if (!tierGate.unlocked) {
    const gaps = Object.entries(tierGate.missing)
      .map(([key, gap]) => `${gap} more ${key}`)
      .join(", ");
    return `${job.tier} tier locked — earn ${gaps} to unlock this job.`;
  }
  if (!profile.verifierCompatibility.includes(job.verifierMode)) {
    return `Verifier mode ${job.verifierMode} not in this wallet's capability list.`;
  }
  return "Missing eligibility, liquidity, or reputation requirements for this tier.";
}
