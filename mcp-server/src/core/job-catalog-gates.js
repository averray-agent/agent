import {
  VALID_AGENT_ROLES,
  VALID_TIERS
} from "./job-catalog-normalization.js";

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

export const TIER_ORDER = ["starter", "pro", "elite"];

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
  const has = reputationSnapshot(reputation);
  const missing = missingRequirements(requires, has);
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
  const has = reputationSnapshot(reputation);
  const missing = missingRequirements(requires, has);
  const unlocked = Object.keys(missing).length === 0;
  return { role: normalised, unlocked, requires, has, missing };
}

function reputationSnapshot(reputation) {
  return {
    skill: Number.isInteger(reputation?.skill) ? reputation.skill : 0,
    reliability: Number.isInteger(reputation?.reliability) ? reputation.reliability : 0,
    economic: Number.isInteger(reputation?.economic) ? reputation.economic : 0
  };
}

function missingRequirements(requires, has) {
  const missing = {};
  for (const [key, required] of Object.entries(requires)) {
    const current = has[key] ?? 0;
    if (current < required) {
      missing[key] = required - current;
    }
  }
  return missing;
}
