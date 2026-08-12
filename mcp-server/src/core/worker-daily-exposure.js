import { ConfigError } from "./errors.js";
import { isExternalJob } from "./external-job-lifecycle.js";
import { decimalToBaseUnits, formatBaseUnits } from "./platform-service-helpers.js";

export const DEFAULT_WORKER_DAILY_EXPOSURE_BUDGET_RAW = 1_500_000;
export const DAILY_EXPOSURE_BUDGET_REACHED_REASON = "daily_exposure_budget_reached";
export const DAILY_EXPOSURE_UNAVAILABLE_REASON = "daily_exposure_budget_unavailable";

const USDC_DECIMALS = 6;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1_000;

export function loadWorkerDailyExposureConfig(env = process.env) {
  return {
    budgetRaw: nonNegativeIntegerConfig(
      env.WORKER_DAILY_EXPOSURE_BUDGET_RAW,
      DEFAULT_WORKER_DAILY_EXPOSURE_BUDGET_RAW,
      "WORKER_DAILY_EXPOSURE_BUDGET_RAW"
    )
  };
}

// Deliberately a wallet-aware hook even though today's tier-2 allowance is
// flat. Tier 3 can raise this result from pool shares without changing the
// rolling-window ledger or either enforcement surface.
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
  resolveBudget = (wallet) => resolveDailyExposureBudget(wallet, config),
  now = () => new Date()
} = {}) {
  return new WorkerDailyExposurePolicy({
    stateStore,
    workerExposurePolicy,
    resolveBudget,
    now
  });
}

export class WorkerDailyExposurePolicy {
  constructor({ stateStore, workerExposurePolicy, resolveBudget, now = () => new Date() } = {}) {
    if (typeof stateStore?.listSessionsByWallet !== "function") {
      throw new ConfigError("Worker daily exposure requires wallet-session pagination.");
    }
    if (typeof workerExposurePolicy?.exposureForDefinition !== "function"
      || typeof workerExposurePolicy?.exposureForSession !== "function") {
      throw new ConfigError("Worker daily exposure requires the worker exposure calculator.");
    }
    if (typeof resolveBudget !== "function") {
      throw new ConfigError("Worker daily exposure requires a budget resolver.");
    }
    this.stateStore = stateStore;
    this.workerExposurePolicy = workerExposurePolicy;
    this.resolveBudget = resolveBudget;
    this.now = now;
  }

  async evaluate({ wallet, job, claimEconomics, workerExposure } = {}) {
    if (isExternalJob(job)) {
      return {
        eligible: true,
        applies: false,
        status: "not_applicable",
        reason: "external_job_has_no_operator_exposure"
      };
    }

    try {
      const evaluatedAt = asDate(this.now(), "daily exposure clock");
      const budgetUnits = await this.resolveBudgetUnits(wallet);
      const candidate = workerExposure?.candidate
        ? exposureFromPublicComponents(workerExposure.candidate, "candidate exposure")
        : this.workerExposurePolicy.exposureForDefinition(job, claimEconomics);
      const current = await this.currentExposure(wallet, evaluatedAt);
      const projectedUnits = current.totalUnits + candidate.totalUnits;
      // Zero is the operator kill-switch, including for a hypothetical
      // zero-reward/zero-brokered-gas job.
      const eligible = budgetUnits > 0n && projectedUnits <= budgetUnits;
      const remainingUnits = budgetUnits > current.totalUnits ? budgetUnits - current.totalUnits : 0n;
      const projectedRemainingUnits = budgetUnits > projectedUnits ? budgetUnits - projectedUnits : 0n;
      const retryAfter = eligible || current.oldestClaimedAt === undefined
        ? undefined
        : new Date(current.oldestClaimedAt.getTime() + ROLLING_WINDOW_MS).toISOString();
      const retryAfterSeconds = retryAfter
        ? Math.max(0, Math.ceil((Date.parse(retryAfter) - evaluatedAt.getTime()) / 1_000))
        : undefined;

      return compact({
        eligible,
        applies: true,
        status: eligible ? "within_budget" : "exceeded",
        reason: eligible ? "daily_exposure_within_budget" : DAILY_EXPOSURE_BUDGET_REACHED_REASON,
        windowSeconds: ROLLING_WINDOW_MS / 1_000,
        dailyExposureBudgetRaw: budgetUnits.toString(),
        dailyExposureUsedRaw: current.totalUnits.toString(),
        dailyExposureRemainingRaw: remainingUnits.toString(),
        candidateExposureRaw: candidate.totalUnits.toString(),
        projectedDailyExposureRaw: projectedUnits.toString(),
        dailyExposureBudget: usdcAmount(budgetUnits),
        dailyExposureUsed: usdcAmount(current.totalUnits),
        dailyExposureRemaining: usdcAmount(remainingUnits),
        candidateExposure: usdcAmount(candidate.totalUnits),
        projectedDailyExposure: usdcAmount(projectedUnits),
        projectedDailyExposureRemaining: usdcAmount(projectedRemainingUnits),
        currentWindowClaimCount: current.sessionCount,
        candidate: publicComponents(candidate),
        retryAfter,
        retryAfterSeconds,
        entry: {
          version: "worker-daily-exposure-v1",
          candidate: publicComponents(candidate)
        },
        message: eligible
          ? "The claim fits within this wallet's rolling 24-hour operator exposure allowance."
          : "This claim would exceed the wallet's rolling 24-hour operator exposure allowance. Retry after earlier claim spend ages out."
      });
    } catch (error) {
      return {
        eligible: false,
        applies: true,
        status: "unknown",
        reason: DAILY_EXPOSURE_UNAVAILABLE_REASON,
        message: "Rolling daily exposure could not be proven. Retry after durable session reads recover.",
        error: error?.message ?? String(error)
      };
    }
  }

  async currentExposure(wallet, now = asDate(this.now(), "daily exposure clock")) {
    const cutoffMs = now.getTime() - ROLLING_WINDOW_MS;
    const sessions = await collectAllWalletSessions(this.stateStore, wallet);
    let totalUnits = 0n;
    let oldestClaimedAt;
    let sessionCount = 0;

    for (const session of sessions) {
      if (isExternalJob(session?.jobSnapshot?.definition)) continue;
      const claimedAt = claimTimestamp(session);
      if (!claimedAt || claimedAt.getTime() <= cutoffMs) continue;
      const exposure = session?.dailyExposure?.candidate
        ? exposureFromPublicComponents(session.dailyExposure.candidate, `session ${session.sessionId} daily exposure`)
        : this.workerExposurePolicy.exposureForSession(session);
      totalUnits += exposure.totalUnits;
      sessionCount += 1;
      if (!oldestClaimedAt || claimedAt < oldestClaimedAt) oldestClaimedAt = claimedAt;
    }
    return { totalUnits, sessionCount, oldestClaimedAt };
  }

  async resolveBudgetUnits(wallet) {
    return nonNegativeRawUnits(await this.resolveBudget(wallet), "resolved worker daily exposure budget");
  }
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
    throw new Error(`Wallet session history exceeded the ${maxSessions} daily-exposure read cap`);
  }
  return sessions;
}

function claimTimestamp(session) {
  const claimedTransition = Array.isArray(session?.statusHistory)
    ? session.statusHistory.find((entry) => entry?.to === "claimed" && entry?.at)
    : undefined;
  const value = session?.claimedAt ?? claimedTransition?.at;
  if (!value) return undefined;
  return asDate(value, `session ${session?.sessionId ?? "unknown"} claimedAt`);
}

function exposureFromPublicComponents(candidate, field) {
  const rewardUnits = usdcUnits(candidate?.reservedRewardUsdc, `${field} reserved reward`);
  const gasUnits = usdcUnits(candidate?.brokeredGasUsdc, `${field} brokered gas`);
  const totalUnits = usdcUnits(candidate?.totalUsdc, `${field} total`);
  if (rewardUnits + gasUnits !== totalUnits) {
    throw new Error(`${field} has inconsistent components`);
  }
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
