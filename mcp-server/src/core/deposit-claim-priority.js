import { ConfigError, ConflictError } from "./errors.js";
import { isExternalJob } from "./external-job-lifecycle.js";
import { decimalToBaseUnits, formatBaseUnits } from "./platform-service-helpers.js";

export const DEPOSIT_CLAIM_PRIORITY_ENABLED_ENV = "DEPOSIT_CLAIM_PRIORITY_ENABLED";
export const PRIORITY_WINDOW_SECONDS_ENV = "PRIORITY_WINDOW_SECONDS";
export const PRIORITY_DEPOSIT_THRESHOLD_ENV = "PRIORITY_DEPOSIT_THRESHOLD";
export const PRIORITY_WINDOW_ACTIVE_REASON = "priority_window_active";
export const DEFAULT_PRIORITY_WINDOW_SECONDS = 300;
export const MAX_PRIORITY_WINDOW_SECONDS = 1_800;
export const DEFAULT_PRIORITY_DEPOSIT_THRESHOLD_USDC = "1.0";

const USDC_DECIMALS = 6;

export function loadDepositClaimPriorityConfig(env = process.env, { logger = console } = {}) {
  const enabled = parseBoolean(
    env[DEPOSIT_CLAIM_PRIORITY_ENABLED_ENV],
    false,
    DEPOSIT_CLAIM_PRIORITY_ENABLED_ENV
  );
  const requestedWindowSeconds = positiveInteger(
    env[PRIORITY_WINDOW_SECONDS_ENV],
    DEFAULT_PRIORITY_WINDOW_SECONDS,
    PRIORITY_WINDOW_SECONDS_ENV
  );
  const windowSeconds = Math.min(requestedWindowSeconds, MAX_PRIORITY_WINDOW_SECONDS);
  if (requestedWindowSeconds > MAX_PRIORITY_WINDOW_SECONDS) {
    logger.warn?.(
      {
        configuredSeconds: requestedWindowSeconds,
        effectiveSeconds: windowSeconds,
        ceilingSeconds: MAX_PRIORITY_WINDOW_SECONDS
      },
      "deposit_claim_priority.window_clamped"
    );
  }

  const thresholdInput = String(
    env[PRIORITY_DEPOSIT_THRESHOLD_ENV] ?? DEFAULT_PRIORITY_DEPOSIT_THRESHOLD_USDC
  ).trim();
  let thresholdRaw;
  try {
    thresholdRaw = decimalToBaseUnits(
      thresholdInput,
      USDC_DECIMALS,
      PRIORITY_DEPOSIT_THRESHOLD_ENV
    );
  } catch (error) {
    throw new ConfigError(error?.message ?? `${PRIORITY_DEPOSIT_THRESHOLD_ENV} is invalid.`);
  }
  if (thresholdRaw <= 0n) {
    throw new ConfigError(`${PRIORITY_DEPOSIT_THRESHOLD_ENV} must be greater than zero.`);
  }

  return Object.freeze({
    enabled,
    windowSeconds,
    thresholdRaw,
    thresholdUsdc: formatBaseUnits(thresholdRaw, USDC_DECIMALS)
  });
}

export function createDepositClaimPriorityPolicy({
  workerExposurePolicy,
  env = process.env,
  config = undefined,
  now = () => new Date(),
  logger = console
} = {}) {
  const resolvedConfig = config ?? loadDepositClaimPriorityConfig(env, { logger });
  if (resolvedConfig.enabled && typeof workerExposurePolicy?.capacityForWallet !== "function") {
    throw new ConfigError(
      "Deposit claim priority requires the existing vested-deposit capacity reader."
    );
  }
  return new DepositClaimPriorityPolicy({
    workerExposurePolicy,
    config: resolvedConfig,
    now,
    logger
  });
}

export class DepositClaimPriorityPolicy {
  constructor({ workerExposurePolicy, config, now = () => new Date(), logger = console } = {}) {
    this.workerExposurePolicy = workerExposurePolicy;
    this.config = config ?? loadDepositClaimPriorityConfig({}, { logger });
    this.now = now;
    this.logger = logger;
  }

  listingFor(job) {
    const listedAt = resolveListedAt(job);
    if (!this.#isWindowed(job) || !listedAt) {
      return { listedAt };
    }
    const openAt = new Date(
      Date.parse(listedAt) + this.config.windowSeconds * 1_000
    ).toISOString();
    return {
      listedAt,
      priorityWindow: {
        openAt,
        qualifiesWith: this.#qualifiesWith()
      }
    };
  }

  projectListing(job) {
    return { ...job, ...this.listingFor(job) };
  }

  async assessClaim({ wallet, job, now = this.now() } = {}) {
    const listing = this.listingFor(job);
    if (!listing.priorityWindow) {
      return {
        applies: false,
        active: false,
        eligible: true,
        status: "not_windowed",
        ...listing
      };
    }

    const evaluatedAt = asDate(now);
    const listedAtMs = Date.parse(listing.listedAt);
    const openAtMs = Date.parse(listing.priorityWindow.openAt);
    const active = evaluatedAt.getTime() >= listedAtMs && evaluatedAt.getTime() < openAtMs;
    if (!active) {
      return {
        applies: true,
        active: false,
        eligible: true,
        status: "open_to_everyone",
        evaluatedAt: evaluatedAt.toISOString(),
        openAt: listing.priorityWindow.openAt,
        ...listing
      };
    }

    let capacity;
    try {
      capacity = await this.workerExposurePolicy.capacityForWallet(wallet);
    } catch (error) {
      this.logger.warn?.({ wallet, err: error }, "deposit_claim_priority.capacity_read_failed");
      capacity = {
        vestedAssetsRaw: "0",
        vestingAvailable: false,
        credit: { available: false, reason: "priority_capacity_read_failed" }
      };
    }
    const vestedRaw = nonNegativeRaw(capacity?.vestedAssetsRaw);
    const credit = capacity?.credit ?? { available: false, reason: "credit_position_missing" };
    const outstandingCreditRaw = nonNegativeRaw(credit?.outstandingDebtRaw);
    const creditReadSufficient = credit?.available !== false
      || credit?.reason === "credit_pool_not_configured";
    const depositQualified = capacity?.vestingAvailable !== false
      && vestedRaw >= this.config.thresholdRaw;
    const noOutstandingCreditDraw = creditReadSufficient && outstandingCreditRaw === 0n;
    const eligible = depositQualified && noOutstandingCreditDraw;
    const qualification = {
      vestedDepositRaw: vestedRaw.toString(),
      thresholdRaw: this.config.thresholdRaw.toString(),
      thresholdUsdc: this.config.thresholdUsdc,
      vestingAvailable: capacity?.vestingAvailable !== false,
      outstandingCreditRaw: outstandingCreditRaw.toString(),
      creditPositionAvailable: creditReadSufficient,
      depositQualified,
      noOutstandingCreditDraw,
      qualifies: eligible
    };

    return {
      applies: true,
      active: true,
      eligible,
      status: eligible ? "priority_qualified" : "priority_window_active",
      ...(eligible ? {} : { reason: PRIORITY_WINDOW_ACTIVE_REASON }),
      evaluatedAt: evaluatedAt.toISOString(),
      openAt: listing.priorityWindow.openAt,
      ...listing,
      qualification,
      ...(eligible ? {} : {
        message: `Priority window active until ${listing.priorityWindow.openAt}. Qualify with ${listing.priorityWindow.qualifiesWith}, or retry when it opens to everyone.`
      })
    };
  }

  async requireClaim({ wallet, job, now = this.now() } = {}) {
    const decision = await this.assessClaim({ wallet, job, now });
    if (decision.eligible) return decision;
    throw new ConflictError(
      decision.message,
      PRIORITY_WINDOW_ACTIVE_REASON,
      {
        openAt: decision.openAt,
        priorityWindow: decision.priorityWindow,
        qualification: decision.qualification
      }
    );
  }

  #isWindowed(job) {
    return this.config.enabled
      && job?.onboardingWaiverEligible !== true
      && !isExternalJob(job);
  }

  #qualifiesWith() {
    return `≥ ${this.config.thresholdUsdc} USDC vested deposit and no outstanding credit draw`;
  }
}

export function resolveListedAt(job) {
  for (const value of [
    job?.listedAt,
    job?.lifecycle?.createdAt,
    job?.funding?.fundedAt,
    job?.source?.poster?.fundedAt
  ]) {
    const timestamp = Date.parse(String(value ?? ""));
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return null;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseBoolean(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError(`${name} must be true or false.`);
}

function nonNegativeRaw(value) {
  try {
    const parsed = BigInt(value ?? 0);
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ConfigError("Priority window clock is invalid.");
  return date;
}
