import { normalizeAssetSymbol } from "./assets.js";
import { ValidationError } from "./errors.js";
import {
  isBuiltinJobSchemaRef,
  normalizeExternalSchemaRegistrations
} from "./job-schema-registry.js";

export const VALID_TIERS = new Set(["starter", "pro", "elite"]);
export const VALID_VERIFIER_MODES = new Set(["benchmark", "deterministic", "human_fallback", "github_pr"]);
export const VALID_JOB_TYPES = new Set(["work", "curation", "review", "publish", "verification"]);
export const VALID_AGENT_ROLES = new Set(["worker", "curator", "reviewer", "publisher", "verifier", "arbitrator"]);
export const VALID_JOB_LIFECYCLE_STATUSES = new Set(["open", "paused", "archived"]);
export const DEFAULT_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

const DEFAULT_ROLE_BY_JOB_TYPE = {
  work: "worker",
  curation: "curator",
  review: "reviewer",
  publish: "publisher",
  verification: "verifier"
};

export function normalizeJobInput(input) {
  const id = normalizeJobId(input?.id);
  const category = String(input?.category ?? "").trim().toLowerCase();
  const tier = String(input?.tier ?? "").trim().toLowerCase();
  const verifierMode = String(input?.verifierMode ?? "").trim().toLowerCase();
  const rewardAmount = Number(input?.rewardAmount ?? 0);
  const claimTtlSeconds = Number(input?.claimTtlSeconds ?? 3600);
  const retryLimit = Number(input?.retryLimit ?? 1);
  const rewardAsset = normalizeAssetSymbol(input?.rewardAsset);
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
  validateSchemaRef(inputSchemaRef, "inputSchemaRef");
  validateSchemaRef(outputSchemaRef, "outputSchemaRef");
  const schemaTrustPolicy = normaliseSchemaTrustPolicy(input?.schemaTrustPolicy);
  const schemaRegistrations = normalizeExternalSchemaRegistrations(input?.schemaRegistrations, {
    allowedSchemaRefs: [inputSchemaRef, outputSchemaRef],
    trustedIssuers: schemaTrustPolicy?.trustedIssuers ?? []
  });

  const parentSessionId = typeof input?.parentSessionId === "string"
    ? input.parentSessionId.trim()
    : "";
  const recurring = Boolean(input?.recurring);
  const schedule = normaliseSchedule(input?.schedule, recurring);
  const title = normaliseTextField(input?.title);
  const description = normaliseTextField(input?.description);
  const acceptanceCriteria = normaliseStringList(input?.acceptanceCriteria);
  const agentInstructions = normaliseStringList(input?.agentInstructions);
  const estimatedDifficulty = normaliseTextField(input?.estimatedDifficulty);
  const source = normalisePlainObject(input?.source, "source");
  const verification = normalisePlainObject(input?.verification, "verification");
  const delegationPolicy = normaliseDelegationPolicy(input?.delegationPolicy, { rewardAmount, rewardAsset });
  const lineage = normalisePlainObject(input?.lineage, "lineage");
  const lifecycle = normaliseLifecycle(input?.lifecycle, { disableStale: recurring });
  const recurringPolicy = normaliseRecurringPolicy(input?.recurringPolicy, {
    recurring,
    rewardAmount,
    rewardAsset
  });

  return {
    id,
    category,
    tier,
    jobType,
    requiredRole,
    rewardAsset,
    rewardAmount,
    verifierMode,
    verifierConfig: buildVerifierConfig(verifierMode, input),
    inputSchemaRef,
    outputSchemaRef,
    ...(schemaRegistrations.length ? { schemaRegistrations } : {}),
    ...(schemaTrustPolicy ? { schemaTrustPolicy } : {}),
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
    ...(delegationPolicy ? { delegationPolicy } : {}),
    ...(lineage ? { lineage } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(recurring ? { recurring: true } : {}),
    ...(schedule ? { schedule } : {}),
    ...(recurringPolicy ? { recurringPolicy } : {})
  };
}

export function buildVerifierConfig(verifierMode, input) {
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

export function normalizeJobId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function validateSchemaRef(value, field) {
  if (!/^schema:\/\/jobs\/[a-z0-9-]+$/u.test(value)) {
    throw new ValidationError(`${field} must be a schema://jobs/<name> ref.`);
  }
  if (isBuiltinJobSchemaRef(value)) {
    return;
  }
}

export function normaliseSchedule(raw, recurring) {
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

export function normaliseRecurringPolicy(raw, { recurring, rewardAmount, rewardAsset }) {
  if (!raw) {
    return undefined;
  }
  if (!recurring) {
    throw new ValidationError("recurringPolicy is only valid for recurring jobs");
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("recurringPolicy must be an object if provided.");
  }

  const policy = {};
  if (raw.reserveAmount !== undefined && raw.reserveAmount !== null && raw.reserveAmount !== "") {
    const reserveAmount = Number(raw.reserveAmount);
    if (!Number.isFinite(reserveAmount) || reserveAmount <= 0) {
      throw new ValidationError("recurringPolicy.reserveAmount must be greater than zero.");
    }
    if (reserveAmount < rewardAmount) {
      throw new ValidationError("recurringPolicy.reserveAmount must cover at least one run.");
    }
    policy.reserveAmount = reserveAmount;
    policy.reserveAsset = typeof raw.reserveAsset === "string" && raw.reserveAsset.trim()
      ? normalizeAssetSymbol(raw.reserveAsset)
      : rewardAsset;
    if (policy.reserveAsset !== rewardAsset) {
      throw new ValidationError("recurringPolicy.reserveAsset must match rewardAsset.");
    }
  }

  if (raw.maxRuns !== undefined && raw.maxRuns !== null && raw.maxRuns !== "") {
    const maxRuns = Number(raw.maxRuns);
    if (!Number.isInteger(maxRuns) || maxRuns < 1) {
      throw new ValidationError("recurringPolicy.maxRuns must be a positive integer.");
    }
    policy.maxRuns = maxRuns;
    const impliedReserve = maxRuns * rewardAmount;
    if (policy.reserveAmount === undefined) {
      policy.reserveAmount = impliedReserve;
      policy.reserveAsset = rewardAsset;
    } else if (policy.reserveAmount < impliedReserve) {
      throw new ValidationError("recurringPolicy.reserveAmount must cover maxRuns * rewardAmount.");
    }
  }

  return Object.keys(policy).length ? policy : undefined;
}

export function normaliseDelegationPolicy(raw, { rewardAmount, rewardAsset }) {
  if (!raw) {
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("delegationPolicy must be an object if provided.");
  }

  const policy = {};
  if (raw.maxDepth !== undefined && raw.maxDepth !== null && raw.maxDepth !== "") {
    const maxDepth = Number(raw.maxDepth);
    if (!Number.isInteger(maxDepth) || maxDepth < 0) {
      throw new ValidationError("delegationPolicy.maxDepth must be a non-negative integer.");
    }
    policy.maxDepth = maxDepth;
  }
  if (raw.maxSubJobs !== undefined && raw.maxSubJobs !== null && raw.maxSubJobs !== "") {
    const maxSubJobs = Number(raw.maxSubJobs);
    if (!Number.isInteger(maxSubJobs) || maxSubJobs < 1) {
      throw new ValidationError("delegationPolicy.maxSubJobs must be a positive integer.");
    }
    policy.maxSubJobs = maxSubJobs;
  }
  if (raw.budgetAmount !== undefined && raw.budgetAmount !== null && raw.budgetAmount !== "") {
    const budgetAmount = Number(raw.budgetAmount);
    if (!Number.isFinite(budgetAmount) || budgetAmount < 0) {
      throw new ValidationError("delegationPolicy.budgetAmount must be zero or higher.");
    }
    if (budgetAmount > rewardAmount) {
      throw new ValidationError("delegationPolicy.budgetAmount cannot exceed rewardAmount.");
    }
    policy.budgetAmount = budgetAmount;
    policy.budgetAsset = typeof raw.budgetAsset === "string" && raw.budgetAsset.trim()
      ? normalizeAssetSymbol(raw.budgetAsset)
      : rewardAsset;
    if (policy.budgetAsset !== rewardAsset) {
      throw new ValidationError("delegationPolicy.budgetAsset must match rewardAsset.");
    }
  }

  return Object.keys(policy).length ? policy : undefined;
}

export function normalizeJobType(value) {
  const normalised = String(value ?? "work").trim().toLowerCase();
  return VALID_JOB_TYPES.has(normalised) ? normalised : undefined;
}

export function normalizeAgentRole(value) {
  const normalised = String(value ?? "worker").trim().toLowerCase();
  return VALID_AGENT_ROLES.has(normalised) ? normalised : undefined;
}

export function effectiveJobType(job) {
  return normalizeJobType(job?.jobType) ?? "work";
}

export function effectiveRequiredRole(job) {
  return normalizeAgentRole(job?.requiredRole) ?? DEFAULT_ROLE_BY_JOB_TYPE[effectiveJobType(job)] ?? "worker";
}

export function normaliseTextField(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normaliseStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

export function normalisePlainObject(value, field) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object if provided.`);
  }
  return JSON.parse(JSON.stringify(value));
}

export function normaliseSchemaTrustPolicy(value) {
  const raw = normalisePlainObject(value, "schemaTrustPolicy");
  if (!raw) {
    return undefined;
  }
  const trustedIssuers = normaliseStringList(raw.trustedIssuers);
  return trustedIssuers.length ? { trustedIssuers } : undefined;
}

export function normaliseLifecycle(value, { disableStale = false, now = new Date() } = {}) {
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

export function normalizeIsoTimestamp(value, field) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ValidationError(`${field} must be ISO-8601 if provided.`);
  }
  return new Date(parsed).toISOString();
}
