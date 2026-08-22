export function publicReputationTier(reputation = {}) {
  const skill = Number(reputation.skill ?? 0);
  if (skill >= 300) return "master";
  if (reputation.tier === "elite" || skill >= 200) return "expert";
  if (reputation.tier === "pro" || skill >= 100) return "journeyman";
  return "apprentice";
}

export function buildPublicReputation(reputation = {}) {
  return {
    ...reputation,
    jobEligibilityTier: reputation.tier ?? "starter",
    tier: publicReputationTier(reputation)
  };
}
