import { ConfigError } from "./errors.js";
import { isExternalJob } from "./external-job-lifecycle.js";
import { decimalToBaseUnits, formatBaseUnits } from "./platform-service-helpers.js";

export const DEFAULT_WORKER_DAILY_EXPOSURE_BUDGET_RAW = 1_500_000;
export const DEFAULT_WORKER_TIER3_ALLOWANCE_PER_DEPOSITED_MILLI = 1_000;
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
    ),
    allowancePerDepositedMilli: nonNegativeIntegerConfig(
      env.WORKER_TIER3_ALLOWANCE_PER_DEPOSITED_MILLI,
      DEFAULT_WORKER_TIER3_ALLOWANCE_PER_DEPOSITED_MILLI,
      "WORKER_TIER3_ALLOWANCE_PER_DEPOSITED_MILLI"
    )
  };
}

// One deposited USDC raises the rolling allowance by K/1000 USDC. The
// calculation stays in raw units and rounds down, so custom fractional K
// values can never grant more than their configured ratio.
export function resolveDailyExposureBudget(_wallet, {
  budgetRaw = DEFAULT_WORKER_DAILY_EXPOSURE_BUDGET_RAW,
  depositedAssetsRaw = 0,
  allowancePerDepositedMilli = DEFAULT_WORKER_TIER3_ALLOWANCE_PER_DEPOSITED_MILLI
} = {}) {
  const baseUnits = nonNegativeRawUnits(budgetRaw, "worker daily exposure budget");
  const depositedUnits = nonNegativeRawUnits(depositedAssetsRaw, "deposited pool assets");
  const multiplierMilli = nonNegativeRawUnits(
    allowancePerDepositedMilli,
    "worker tier-3 allowance per deposited milli"
  );
  return baseUnits + ((depositedUnits * multiplierMilli) / 1_000n);
}

export function createWorkerDailyExposurePolicy({
  stateStore,
  workerExposurePolicy,
  blockchainGateway,
  env = process.env,
  config = loadWorkerDailyExposureConfig(env),
  resolveBudget = async (wallet) => {
    let depositedAssetsRaw = 0n;
    try {
      depositedAssetsRaw = typeof blockchainGateway?.readDepositedAssets === "function"
        ? await blockchainGateway.readDepositedAssets(wallet)
        : 0n;
    } catch {
      // Belt-and-suspenders around the gateway's own optional-capability
      // fail-closed behavior: a read failure can delay a raise, never grant it.
      depositedAssetsRaw = 0n;
    }
    const baseRaw = nonNegativeRawUnits(config.budgetRaw, "worker daily exposure budget");
    const depositedRaw = nonNegativeRawUnits(depositedAssetsRaw, "deposited pool assets");
    const totalRaw = resolveDailyExposureBudget(wallet, {
      ...config,
      depositedAssetsRaw: depositedRaw
    });
    return {
      baseRaw,
      depositedAssetsRaw: depositedRaw,
      fromDepositsRaw: totalRaw - baseRaw,
      totalRaw,
      poolAddress: blockchainGateway?.config?.depositPoolAddress
    };
  },
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
      const allowance = await this.resolveAllowance(wallet);
      const budgetUnits = allowance.totalUnits;
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
        dailyAllowance: publicDailyAllowance(allowance),
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
          : dailyExposureRefusalMessage(allowance.poolAddress)
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

  async resolveAllowance(wallet) {
    const resolved = await this.resolveBudget(wallet);
    if (!resolved || typeof resolved !== "object") {
      const totalUnits = nonNegativeRawUnits(resolved, "resolved worker daily exposure budget");
      return {
        baseUnits: totalUnits,
        depositedUnits: 0n,
        fromDepositsUnits: 0n,
        totalUnits,
        poolAddress: undefined
      };
    }
    const baseUnits = nonNegativeRawUnits(resolved.baseRaw, "resolved base daily allowance");
    const depositedUnits = nonNegativeRawUnits(
      resolved.depositedAssetsRaw,
      "resolved deposited pool assets"
    );
    const fromDepositsUnits = nonNegativeRawUnits(
      resolved.fromDepositsRaw,
      "resolved allowance from deposits"
    );
    const totalUnits = nonNegativeRawUnits(resolved.totalRaw, "resolved total daily allowance");
    if (baseUnits + fromDepositsUnits !== totalUnits) {
      throw new Error("Resolved daily allowance components do not sum to the total");
    }
    return {
      baseUnits,
      depositedUnits,
      fromDepositsUnits,
      totalUnits,
      poolAddress: typeof resolved.poolAddress === "string" && resolved.poolAddress
        ? resolved.poolAddress
        : undefined
    };
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

function publicDailyAllowance(allowance) {
  return {
    base: usdcAmount(allowance.baseUnits),
    fromDeposits: usdcAmount(allowance.fromDepositsUnits),
    depositedAssets: usdcAmount(allowance.depositedUnits),
    total: usdcAmount(allowance.totalUnits)
  };
}

function dailyExposureRefusalMessage(poolAddress) {
  const base = "This claim would exceed the wallet's rolling 24-hour operator exposure allowance. Retry after earlier claim spend ages out.";
  return poolAddress
    ? `${base} Deposits into DepositPool ${poolAddress} raise your daily allowance 1:1.`
    : base;
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
