import { ConfigError } from "./errors.js";

export const NON_YIELD_TIER_PERKS_ENABLED_ENV = "NON_YIELD_TIER_PERKS_ENABLED";

const BPS = 10_000n;
const TIER_PERKS = Object.freeze({
  flex: Object.freeze({
    bankShareBps: 500,
    priorityRank: 0,
    priorityAccess: "basic",
    creditQualified: false,
    creditTermsClass: null
  }),
  t7: Object.freeze({
    bankShareBps: 1_000,
    priorityRank: 1,
    priorityAccess: "priority",
    creditQualified: false,
    creditTermsClass: null
  }),
  t30: Object.freeze({
    bankShareBps: 1_500,
    priorityRank: 2,
    priorityAccess: "enhanced_priority",
    creditQualified: true,
    creditTermsClass: "standard"
  }),
  t90: Object.freeze({
    bankShareBps: 2_000,
    priorityRank: 3,
    priorityAccess: "first_look",
    creditQualified: true,
    creditTermsClass: "better_terms"
  })
});

export function loadNonYieldTierPerksConfig(env = process.env) {
  return Object.freeze({
    enabled: parseBoolean(
      env[NON_YIELD_TIER_PERKS_ENABLED_ENV],
      false,
      NON_YIELD_TIER_PERKS_ENABLED_ENV
    )
  });
}

export function createNonYieldTierPerksPolicy({
  getTierState,
  getRewardBankHealth,
  env = process.env,
  config = loadNonYieldTierPerksConfig(env),
  logger = console
} = {}) {
  return new NonYieldTierPerksPolicy({
    getTierState,
    getRewardBankHealth,
    config,
    logger
  });
}

export class NonYieldTierPerksPolicy {
  constructor({ getTierState, getRewardBankHealth, config, logger = console } = {}) {
    this.getTierState = getTierState;
    this.getRewardBankHealth = getRewardBankHealth;
    this.config = config ?? loadNonYieldTierPerksConfig({});
    this.logger = logger;
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  /**
   * Re-read both live inputs for every use. There is deliberately no tier or
   * bank cache here; the shared reward-bank provider owns its bounded chain
   * read cache, while a changed or exited commitment takes effect immediately.
   */
  async forWallet(wallet, { defaultOpenExposureCapRaw = "0" } = {}) {
    if (!this.isEnabled()) return undefined;
    const floorRaw = exactNonNegativeRaw(
      defaultOpenExposureCapRaw,
      "defaultOpenExposureCapRaw"
    );
    const [tierReading, bankReading] = await Promise.all([
      this.#readTier(wallet),
      this.#readBank()
    ]);
    const tier = effectiveTier(tierReading);
    const definition = TIER_PERKS[tier];
    const bankRaw = readableBankRaw(bankReading);
    const proportionalRaw = bankRaw === null
      ? 0n
      : bankRaw * BigInt(definition.bankShareBps) / BPS;
    const resolvedCapRaw = proportionalRaw > floorRaw ? proportionalRaw : floorRaw;

    return {
      schemaVersion: 1,
      tier,
      source: "live_locked_tier_state",
      exposure: {
        bankShareBps: definition.bankShareBps,
        bankReadable: bankRaw !== null,
        rewardBankLiquidRaw: bankRaw?.toString?.() ?? null,
        fixedDefaultFloorRaw: floorRaw.toString(),
        resolvedOpenExposureCapRaw: resolvedCapRaw.toString(),
        basis: bankRaw === null
          ? "fixed_default_floor"
          : "max_fixed_default_or_live_reward_bank_share"
      },
      priorityClaimAccess: {
        access: definition.priorityAccess,
        rank: definition.priorityRank,
        eligibleDuringPriorityWindow: definition.priorityRank > 0
      },
      creditQualification: {
        qualified: definition.creditQualified,
        termsClass: definition.creditTermsClass,
        basis: definition.creditQualified
          ? "active_locked_balance_commitment_plus_settlement_history"
          : "settlement_history_only",
        fundsAtRisk: "operator_underwritten",
        seizurePath: "none"
      },
      qualificationStatement:
        "A locked balance is a qualification signal. No seizure path exists for job or credit default."
    };
  }

  async #readTier(wallet) {
    if (typeof this.getTierState !== "function") {
      return { tier: "flex", perksActive: false, unavailable: true };
    }
    try {
      return await this.getTierState(wallet);
    } catch (error) {
      this.logger.warn?.({ wallet, err: error }, "tier_perks.locked_tier_read_failed");
      return { tier: "flex", perksActive: false, unavailable: true };
    }
  }

  async #readBank() {
    if (typeof this.getRewardBankHealth !== "function") {
      return { readable: false, source: "reward_bank_reader_unavailable" };
    }
    try {
      return await this.getRewardBankHealth();
    } catch (error) {
      this.logger.warn?.({ err: error }, "tier_perks.reward_bank_read_failed");
      return { readable: false, source: "reward_bank_read_failed" };
    }
  }
}

function effectiveTier(reading) {
  if (reading?.perksActive !== true) return "flex";
  const tier = String(reading?.tier ?? "").trim().toLowerCase();
  return Object.hasOwn(TIER_PERKS, tier) ? tier : "flex";
}

function readableBankRaw(reading) {
  if (reading?.readable !== true || reading?.stale === true) return null;
  if (reading?.decimals !== undefined && Number(reading.decimals) !== 6) return null;
  const raw = String(reading?.liquidRaw ?? "").trim();
  return /^\d+$/u.test(raw) ? BigInt(raw) : null;
}

function exactNonNegativeRaw(value, field) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/u.test(raw)) {
    throw new ConfigError(`${field} must be an exact non-negative base-unit integer string.`);
  }
  return BigInt(raw);
}

function parseBoolean(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError(`${name} must be true or false.`);
}
