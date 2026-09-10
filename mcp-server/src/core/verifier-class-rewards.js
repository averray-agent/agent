import { AppError, ConfigError } from "./errors.js";
import { isIngestedCatalogJob } from "./catalog-verifier-integrity.js";
import { decimalToBaseUnits } from "./platform-service-helpers.js";

export const DEFAULT_VERIFIER_CLASS_REWARDS = Object.freeze({
  benchmark: 0.10,
  github_pr: 1.00,
  deterministic: 1.00,
  witness: 1.00
});
export const VERIFIER_CLASS_REWARD_REFUSED = "verifier_class_reward_out_of_bounds";

export function loadVerifierClassRewards(env = process.env) {
  let values = DEFAULT_VERIFIER_CLASS_REWARDS;
  if (env.VERIFIER_CLASS_REWARD_USDC_JSON?.trim()) {
    try { values = JSON.parse(env.VERIFIER_CLASS_REWARD_USDC_JSON); }
    catch { throw new ConfigError("VERIFIER_CLASS_REWARD_USDC_JSON must be valid JSON."); }
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new ConfigError("VERIFIER_CLASS_REWARD_USDC_JSON must be an object keyed by verifierMode.");
  }
  const table = {};
  for (const [mode, amount] of Object.entries(values)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(mode) || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      throw new ConfigError(`Invalid verifier-class reward for ${mode}.`);
    }
    try { decimalToBaseUnits(amount, 6, `verifier class ${mode}`); }
    catch { throw new ConfigError(`Verifier-class reward for ${mode} must have at most six decimals.`); }
    table[mode] = amount;
  }
  for (const mode of Object.keys(DEFAULT_VERIFIER_CLASS_REWARDS)) {
    if (!Object.hasOwn(table, mode)) throw new ConfigError(`VERIFIER_CLASS_REWARD_USDC_JSON is missing ${mode}.`);
  }
  return Object.freeze(table);
}

export function verifierClassReward(mode, table = loadVerifierClassRewards()) {
  if (!Object.hasOwn(table, mode)) throw new ConfigError(`No reward is configured for verifier class ${mode}.`);
  return table[mode];
}

export function assertIngestedVerifierClassReward(job, table = loadVerifierClassRewards()) {
  if (!isIngestedCatalogJob(job)) return job;
  const mode = job.verifierMode ?? job.verifierConfig?.handler;
  const bound = verifierClassReward(mode, table);
  const direction = mode === "benchmark" ? "ceiling" : "floor";
  let amountRaw;
  try { amountRaw = decimalToBaseUnits(job.rewardAmount, 6, "ingested reward"); } catch { /* Refused below. */ }
  const boundRaw = decimalToBaseUnits(bound, 6, "class bound");
  if (amountRaw === undefined || amountRaw <= 0n
    || (mode === "benchmark" ? amountRaw > boundRaw : amountRaw < boundRaw)) {
    throw new AppError(`Job ${job.id} violates the ${mode} reward ${direction} of ${bound} USDC.`, {
      code: VERIFIER_CLASS_REWARD_REFUSED, statusCode: 409,
      details: { verifierMode: mode, rewardAmount: job.rewardAmount, bound, direction }
    });
  }
  return job;
}
