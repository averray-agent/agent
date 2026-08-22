import { ConfigError } from "./errors.js";
import { isExternalJob } from "./external-job-lifecycle.js";
import { decimalToBaseUnits, formatBaseUnits } from "./platform-service-helpers.js";

export const DEFAULT_WORKER_DAILY_EXPOSURE_BUDGET_RAW = 1_500_000;
export const DEFAULT_WORKER_LIFETIME_CATALOGUE_CREDIT_RAW = 10_000_000;
export const DEFAULT_WORKER_GRADUATION_SETTLED_JOBS = 10;
export const DAILY_EXPOSURE_BUDGET_REACHED_REASON = "daily_exposure_budget_reached";
export const LIFETIME_CATALOGUE_CREDIT_EXHAUSTED_REASON = "lifetime_catalogue_credit_exhausted";
export const DAILY_EXPOSURE_UNAVAILABLE_REASON = "daily_exposure_budget_unavailable";

const RETIRED_DEPOSIT_ALLOWANCE_ENV = "WORKER_TIER3_ALLOWANCE_PER_DEPOSITED_MILLI";
const USDC_DECIMALS = 6;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1_000;
const D0_ENTRY_VERSION = "worker-catalogue-exposure-v2";

export function loadWorkerDailyExposureConfig(env = process.env) {
  if (env[RETIRED_DEPOSIT_ALLOWANCE_ENV] !== undefined) {
    throw new ConfigError(
      `${RETIRED_DEPOSIT_ALLOWANCE_ENV} was retired by Packet D0; remove it. Deposits never raise catalogue allowance.`,
      { field: RETIRED_DEPOSIT_ALLOWANCE_ENV, packet: "PACKET_D0_VESTING.md" }
    );
  }
  return {
    budgetRaw: nonNegativeIntegerConfig(
      env.WORKER_DAILY_EXPOSURE_BUDGET_RAW,
      DEFAULT_WORKER_DAILY_EXPOSURE_BUDGET_RAW,
      "WORKER_DAILY_EXPOSURE_BUDGET_RAW"
    ),
    lifetimeCreditRaw: nonNegativeIntegerConfig(
      env.WORKER_LIFETIME_CATALOGUE_CREDIT_RAW,
      DEFAULT_WORKER_LIFETIME_CATALOGUE_CREDIT_RAW,
      "WORKER_LIFETIME_CATALOGUE_CREDIT_RAW"
    ),
    graduationSettledJobs: positiveIntegerConfig(
      env.WORKER_GRADUATION_SETTLED_JOBS,
      DEFAULT_WORKER_GRADUATION_SETTLED_JOBS,
      "WORKER_GRADUATION_SETTLED_JOBS"
    )
  };
}

export function resolveDailyExposureBudget(_wallet, {
  budgetRaw = DEFAULT_WORKER_DAILY_EXPOSURE_BUDGET_RAW
} = {}) {
  return nonNegativeRawUnits(budgetRaw, "worker daily exposure budget");
}

export function createWorkerDailyExposurePolicy({
  stateStore,
  workerExposurePolicy,
  env = process.env,
  config = loadWorkerDailyExposureConfig(env),
  now = () => new Date()
} = {}) {
  return new WorkerDailyExposurePolicy({
    stateStore,
    workerExposurePolicy,
    budgetRaw: config.budgetRaw,
    lifetimeCreditRaw: config.lifetimeCreditRaw,
    graduationSettledJobs: config.graduationSettledJobs,
    now
  });
}

export class WorkerDailyExposurePolicy {
  constructor({
    stateStore,
    workerExposurePolicy,
    budgetRaw = DEFAULT_WORKER_DAILY_EXPOSURE_BUDGET_RAW,
    lifetimeCreditRaw = DEFAULT_WORKER_LIFETIME_CATALOGUE_CREDIT_RAW,
    graduationSettledJobs = DEFAULT_WORKER_GRADUATION_SETTLED_JOBS,
    now = () => new Date()
  } = {}) {
    if (typeof stateStore?.listSessionsByWallet !== "function") {
      throw new ConfigError("Worker catalogue exposure requires wallet-session pagination.");
    }
    if (typeof workerExposurePolicy?.exposureForDefinition !== "function"
      || typeof workerExposurePolicy?.exposureForSession !== "function") {
      throw new ConfigError("Worker catalogue exposure requires the worker exposure calculator.");
    }
    this.stateStore = stateStore;
    this.workerExposurePolicy = workerExposurePolicy;
    this.budgetUnits = nonNegativeRawUnits(budgetRaw, "worker daily exposure budget");
    this.lifetimeCreditUnits = nonNegativeRawUnits(
      lifetimeCreditRaw,
      "worker lifetime catalogue credit"
    );
    this.graduationSettledJobs = positiveIntegerConfig(
      graduationSettledJobs,
      DEFAULT_WORKER_GRADUATION_SETTLED_JOBS,
      "worker graduation settled jobs"
    );
    this.now = now;
  }

  progressionConfig() {
    return {
      rolling24hRaw: this.budgetUnits.toString(),
      rolling24hUsdc: usdcAmount(this.budgetUnits),
      lifetimeCreditRaw: this.lifetimeCreditUnits.toString(),
      lifetimeCreditUsdc: usdcAmount(this.lifetimeCreditUnits),
      graduationSettledJobs: this.graduationSettledJobs
    };
  }

  async evaluate({ wallet, job, claimEconomics, workerExposure } = {}) {
    if (isExternalJob(job)) {
      return {
        eligible: true,
        applies: false,
        status: "not_applicable",
        reason: "external_job_has_no_catalogue_allowance"
      };
    }

    try {
      const evaluatedAt = asDate(this.now(), "catalogue exposure clock");
      const sessions = await collectAllWalletSessions(this.stateStore, wallet);
      const candidate = workerExposure?.candidate
        ? exposureFromPublicComponents(workerExposure.candidate, "candidate exposure")
        : this.workerExposurePolicy.exposureForDefinition(job, claimEconomics);
      const settledApprovedCatalogueJobs = countSettledApprovedCatalogueJobs(sessions);
      const established = settledApprovedCatalogueJobs >= this.graduationSettledJobs;
      return established
        ? this.evaluateEstablished({ sessions, candidate, evaluatedAt, settledApprovedCatalogueJobs })
        : this.evaluateLifetime({ sessions, candidate, evaluatedAt, settledApprovedCatalogueJobs });
    } catch (error) {
      return {
        eligible: false,
        applies: true,
        status: "unknown",
        reason: DAILY_EXPOSURE_UNAVAILABLE_REASON,
        message: "Catalogue exposure eligibility could not be proven. Retry after durable session reads recover.",
        error: error?.message ?? String(error)
      };
    }
  }

  evaluateLifetime({ sessions, candidate, evaluatedAt, settledApprovedCatalogueJobs }) {
    const usedUnits = lifetimeExposure(sessions);
    const projectedUnits = usedUnits + candidate.totalUnits;
    const eligible = this.lifetimeCreditUnits > 0n && projectedUnits <= this.lifetimeCreditUnits;
    const remainingUnits = this.lifetimeCreditUnits > usedUnits
      ? this.lifetimeCreditUnits - usedUnits
      : 0n;
    const projectedRemainingUnits = this.lifetimeCreditUnits > projectedUnits
      ? this.lifetimeCreditUnits - projectedUnits
      : 0n;
    const catalogueAccess = {
      mode: "lifetime_credit",
      established: false,
      settledApprovedCatalogueJobs,
      graduationSettledJobs: this.graduationSettledJobs,
      lifetimeCreditRaw: this.lifetimeCreditUnits.toString(),
      lifetimeUsedRaw: usedUnits.toString(),
      lifetimeRemainingRaw: remainingUnits.toString(),
      lifetimeCredit: usdcAmount(this.lifetimeCreditUnits),
      lifetimeUsed: usdcAmount(usedUnits),
      lifetimeRemaining: usdcAmount(remainingUnits),
      externalWorkAffected: false,
      graduationRule: `${this.graduationSettledJobs} settled and approved catalogue jobs unlock the rolling daily base.`
    };
    return {
      eligible,
      applies: true,
      status: eligible ? "within_lifetime_credit" : "exceeded",
      reason: eligible
        ? "lifetime_catalogue_credit_available"
        : LIFETIME_CATALOGUE_CREDIT_EXHAUSTED_REASON,
      evaluatedAt: evaluatedAt.toISOString(),
      candidateExposureRaw: candidate.totalUnits.toString(),
      projectedLifetimeExposureRaw: projectedUnits.toString(),
      candidateExposure: usdcAmount(candidate.totalUnits),
      projectedLifetimeExposure: usdcAmount(projectedUnits),
      projectedLifetimeRemaining: usdcAmount(projectedRemainingUnits),
      candidate: publicComponents(candidate),
      catalogueAccess,
      entry: {
        version: D0_ENTRY_VERSION,
        accessMode: "lifetime_credit",
        candidate: publicComponents(candidate)
      },
      message: eligible
        ? "The claim fits within this wallet's finite lifetime catalogue credit before graduation."
        : `This wallet's finite lifetime catalogue credit is exhausted. Graduation requires ${this.graduationSettledJobs} settled and approved catalogue jobs; ${settledApprovedCatalogueJobs} are recorded. External poster-funded work is not gated by this lifetime credit.`
    };
  }

  evaluateEstablished({ sessions, candidate, evaluatedAt, settledApprovedCatalogueJobs }) {
    const current = rollingExposure(sessions, evaluatedAt, this.workerExposurePolicy);
    const projectedUnits = current.totalUnits + candidate.totalUnits;
    const eligible = this.budgetUnits > 0n && projectedUnits <= this.budgetUnits;
    const remainingUnits = this.budgetUnits > current.totalUnits
      ? this.budgetUnits - current.totalUnits
      : 0n;
    const projectedRemainingUnits = this.budgetUnits > projectedUnits
      ? this.budgetUnits - projectedUnits
      : 0n;
    const retryAfter = eligible || !current.oldestClaimedAt
      ? undefined
      : new Date(current.oldestClaimedAt.getTime() + ROLLING_WINDOW_MS).toISOString();
    const retryAfterSeconds = retryAfter
      ? Math.max(0, Math.ceil((Date.parse(retryAfter) - evaluatedAt.getTime()) / 1_000))
      : undefined;
    const dailyAllowance = {
      base: usdcAmount(this.budgetUnits),
      total: usdcAmount(this.budgetUnits)
    };
    return compact({
      eligible,
      applies: true,
      status: eligible ? "within_budget" : "exceeded",
      reason: eligible ? "daily_exposure_within_budget" : DAILY_EXPOSURE_BUDGET_REACHED_REASON,
      windowSeconds: ROLLING_WINDOW_MS / 1_000,
      dailyExposureBudgetRaw: this.budgetUnits.toString(),
      dailyExposureUsedRaw: current.totalUnits.toString(),
      dailyExposureRemainingRaw: remainingUnits.toString(),
      candidateExposureRaw: candidate.totalUnits.toString(),
      projectedDailyExposureRaw: projectedUnits.toString(),
      dailyExposureBudget: usdcAmount(this.budgetUnits),
      dailyAllowance,
      dailyExposureUsed: usdcAmount(current.totalUnits),
      dailyExposureRemaining: usdcAmount(remainingUnits),
      candidateExposure: usdcAmount(candidate.totalUnits),
      projectedDailyExposure: usdcAmount(projectedUnits),
      projectedDailyExposureRemaining: usdcAmount(projectedRemainingUnits),
      currentWindowClaimCount: current.sessionCount,
      candidate: publicComponents(candidate),
      catalogueAccess: {
        mode: "rolling_daily",
        established: true,
        settledApprovedCatalogueJobs,
        graduationSettledJobs: this.graduationSettledJobs,
        externalWorkAffected: false
      },
      retryAfter,
      retryAfterSeconds,
      entry: {
        version: D0_ENTRY_VERSION,
        accessMode: "rolling_daily",
        candidate: publicComponents(candidate)
      },
      message: eligible
        ? "The claim fits within this established wallet's deposit-blind rolling 24-hour catalogue allowance."
        : "This claim would exceed the established wallet's deposit-blind rolling 24-hour catalogue allowance. Retry after earlier claim spend ages out."
    });
  }
}

function countSettledApprovedCatalogueJobs(sessions) {
  return sessions.filter((session) => (
    !isExternalJob(session?.jobSnapshot?.definition)
    && session?.status === "resolved"
    && session?.verificationSummary?.outcome === "approved"
  )).length;
}

function lifetimeExposure(sessions) {
  let totalUnits = 0n;
  for (const session of sessions) {
    if (isExternalJob(session?.jobSnapshot?.definition)) continue;
    if (session?.dailyExposure?.version !== D0_ENTRY_VERSION
      || session?.dailyExposure?.accessMode !== "lifetime_credit") continue;
    totalUnits += exposureFromPublicComponents(
      session.dailyExposure.candidate,
      `session ${session.sessionId} lifetime catalogue exposure`
    ).totalUnits;
  }
  return totalUnits;
}

function rollingExposure(sessions, now, workerExposurePolicy) {
  const cutoffMs = now.getTime() - ROLLING_WINDOW_MS;
  let totalUnits = 0n;
  let oldestClaimedAt;
  let sessionCount = 0;
  for (const session of sessions) {
    if (isExternalJob(session?.jobSnapshot?.definition)) continue;
    const claimedAt = claimTimestamp(session);
    if (!claimedAt || claimedAt.getTime() <= cutoffMs) continue;
    const exposure = session?.dailyExposure?.candidate
      ? exposureFromPublicComponents(session.dailyExposure.candidate, `session ${session.sessionId} daily exposure`)
      : workerExposurePolicy.exposureForSession(session);
    totalUnits += exposure.totalUnits;
    sessionCount += 1;
    if (!oldestClaimedAt || claimedAt < oldestClaimedAt) oldestClaimedAt = claimedAt;
  }
  return { totalUnits, sessionCount, oldestClaimedAt };
}

async function collectAllWalletSessions(stateStore, wallet, { pageSize = 64, maxSessions = 10_000 } = {}) {
  const sessions = [];
  for (let offset = 0; offset < maxSessions; offset += pageSize) {
    const page = await stateStore.listSessionsByWallet(wallet, pageSize, offset);
    if (!Array.isArray(page) || page.length === 0) break;
    sessions.push(...page);
    if (page.length < pageSize) break;
  }
  if (sessions.length >= maxSessions) {
    throw new Error(`Wallet session history exceeded the ${maxSessions} catalogue-exposure read cap`);
  }
  return sessions;
}

function claimTimestamp(session) {
  const claimedTransition = Array.isArray(session?.statusHistory)
    ? session.statusHistory.find((entry) => entry?.to === "claimed" && entry?.at)
    : undefined;
  const value = session?.claimedAt ?? claimedTransition?.at;
  return value ? asDate(value, `session ${session?.sessionId ?? "unknown"} claimedAt`) : undefined;
}

function exposureFromPublicComponents(candidate, field) {
  const rewardUnits = usdcUnits(candidate?.reservedRewardUsdc, `${field} reserved reward`);
  const gasUnits = usdcUnits(candidate?.brokeredGasUsdc, `${field} brokered gas`);
  const totalUnits = usdcUnits(candidate?.totalUsdc, `${field} total`);
  if (rewardUnits + gasUnits !== totalUnits) throw new Error(`${field} has inconsistent components`);
  return { rewardUnits, gasUnits, totalUnits };
}

function publicComponents(exposure) {
  return {
    reservedRewardUsdc: usdcAmount(exposure.rewardUnits),
    brokeredGasUsdc: usdcAmount(exposure.gasUnits),
    totalUsdc: usdcAmount(exposure.totalUnits)
  };
}

function usdcUnits(value, field) {
  try {
    return decimalToBaseUnits(value, USDC_DECIMALS, field);
  } catch (error) {
    throw new ConfigError(`${field} must be a non-negative USDC amount with at most 6 decimals.`, {
      field,
      value,
      reason: error?.message
    });
  }
}

function usdcAmount(units) {
  return Number(formatBaseUnits(units, USDC_DECIMALS));
}

function positiveIntegerConfig(value, fallback, field) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  const number = Number(candidate);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ConfigError(`${field} must be a positive integer.`, { field, value: candidate });
  }
  return number;
}

function nonNegativeIntegerConfig(value, fallback, field) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  const units = nonNegativeRawUnits(candidate, field);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConfigError(`${field} must be a safe non-negative integer.`, { field, value: candidate });
  }
  return Number(units);
}

function nonNegativeRawUnits(value, field) {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "").trim();
  if (!/^\d+$/u.test(text)) {
    throw new ConfigError(`${field} must be a non-negative integer in USDC base units.`, { field, value });
  }
  return BigInt(text);
}

function asDate(value, field) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} is not a valid timestamp`);
  return date;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
