import { ConfigError } from "./errors.js";
import { isExternalJob } from "./external-job-lifecycle.js";
import { decimalToBaseUnits, formatBaseUnits } from "./platform-service-helpers.js";

export const DEFAULT_WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW = 25_000_000;
export const CATALOGUE_DAILY_BUDGET_EXHAUSTED_REASON = "catalogue_daily_budget_exhausted";
export const CATALOGUE_DAILY_BUDGET_UNAVAILABLE_REASON = "catalogue_daily_budget_unavailable";

const USDC_DECIMALS = 6;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1_000;

export function loadCatalogueDailyBudgetConfig(env = process.env) {
  return {
    budgetRaw: nonNegativeIntegerConfig(
      env.WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW,
      DEFAULT_WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW,
      "WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW"
    )
  };
}

export function createCatalogueDailyBudget({
  stateStore,
  env = process.env,
  config = loadCatalogueDailyBudgetConfig(env),
  now = () => new Date()
} = {}) {
  return new CatalogueDailyBudget({ stateStore, budgetRaw: config.budgetRaw, now });
}

export class CatalogueDailyBudget {
  constructor({
    stateStore,
    budgetRaw = DEFAULT_WORKER_CATALOGUE_GLOBAL_DAILY_BUDGET_RAW,
    now = () => new Date()
  } = {}) {
    if (typeof stateStore?.listRecentSessions !== "function") {
      throw new ConfigError("The catalogue daily budget requires global session pagination.");
    }
    if (typeof stateStore?.acquireClaimLock !== "function"
      || typeof stateStore?.releaseClaimLock !== "function") {
      throw new ConfigError("The catalogue daily budget requires a durable global claim lock.");
    }
    this.stateStore = stateStore;
    this.budgetUnits = nonNegativeRawUnits(budgetRaw, "catalogue global daily budget");
    this.now = now;
  }

  async getStatus() {
    const evaluatedAt = asDate(this.now(), "catalogue daily budget clock");
    const current = await this.currentExposure(evaluatedAt);
    return publicStatus({ budgetUnits: this.budgetUnits, current, evaluatedAt });
  }

  async evaluate({ job, workerExposure } = {}) {
    if (isExternalJob(job)) {
      return {
        eligible: true,
        applies: false,
        status: "not_applicable",
        reason: "external_job_has_no_catalogue_budget"
      };
    }

    try {
      const evaluatedAt = asDate(this.now(), "catalogue daily budget clock");
      const current = await this.currentExposure(evaluatedAt);
      const candidate = exposureFromPublicComponents(
        workerExposure?.candidate,
        "candidate catalogue exposure"
      );
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

      return compact({
        eligible,
        applies: true,
        status: eligible ? "within_budget" : "exceeded",
        reason: eligible ? "catalogue_daily_budget_within_budget" : CATALOGUE_DAILY_BUDGET_EXHAUSTED_REASON,
        windowSeconds: ROLLING_WINDOW_MS / 1_000,
        catalogueDailyBudgetRaw: this.budgetUnits.toString(),
        catalogueDailyBudgetUsedRaw: current.totalUnits.toString(),
        catalogueDailyBudgetRemainingRaw: remainingUnits.toString(),
        candidateExposureRaw: candidate.totalUnits.toString(),
        projectedCatalogueExposureRaw: projectedUnits.toString(),
        catalogueDailyBudget: usdcAmount(this.budgetUnits),
        catalogueDailyBudgetUsed: usdcAmount(current.totalUnits),
        catalogueDailyBudgetRemaining: usdcAmount(remainingUnits),
        candidateExposure: usdcAmount(candidate.totalUnits),
        projectedCatalogueExposure: usdcAmount(projectedUnits),
        projectedCatalogueBudgetRemaining: usdcAmount(projectedRemainingUnits),
        currentWindowClaimCount: current.sessionCount,
        candidate: publicComponents(candidate),
        retryAfter,
        retryAfterSeconds,
        entry: {
          version: "catalogue-daily-budget-v1",
          candidate: publicComponents(candidate)
        },
        message: eligible
          ? "The claim fits within the operator-wide rolling 24-hour catalogue exposure budget."
          : "The operator-wide rolling 24-hour catalogue exposure budget is exhausted. Retry after earlier catalogue exposure ages out. External poster-funded work does not use this budget."
      });
    } catch (error) {
      return {
        eligible: false,
        applies: true,
        status: "unknown",
        reason: CATALOGUE_DAILY_BUDGET_UNAVAILABLE_REASON,
        message: "The operator-wide catalogue exposure budget could not be proven. Retry after durable session reads recover.",
        error: error?.message ?? String(error)
      };
    }
  }

  async currentExposure(now = asDate(this.now(), "catalogue daily budget clock")) {
    const cutoffMs = now.getTime() - ROLLING_WINDOW_MS;
    const sessions = await collectRecentSessions(this.stateStore);
    let totalUnits = 0n;
    let oldestClaimedAt;
    let sessionCount = 0;

    for (const session of sessions) {
      if (isExternalJob(session?.jobSnapshot?.definition)) continue;
      if (session?.catalogueDailyBudget?.version !== "catalogue-daily-budget-v1") continue;
      const claimedAt = claimTimestamp(session);
      if (!claimedAt || claimedAt.getTime() <= cutoffMs) continue;
      const exposure = exposureFromPublicComponents(
        session.catalogueDailyBudget.candidate,
        `session ${session.sessionId} catalogue exposure`
      );
      totalUnits += exposure.totalUnits;
      sessionCount += 1;
      if (!oldestClaimedAt || claimedAt < oldestClaimedAt) oldestClaimedAt = claimedAt;
    }
    return { totalUnits, sessionCount, oldestClaimedAt };
  }
}

async function collectRecentSessions(stateStore, { pageSize = 64, maxSessions = 10_000 } = {}) {
  const sessions = [];
  for (let offset = 0; offset < maxSessions; offset += pageSize) {
    const page = await stateStore.listRecentSessions(pageSize, offset);
    if (!Array.isArray(page) || page.length === 0) break;
    sessions.push(...page);
    if (page.length < pageSize) break;
  }
  if (sessions.length >= maxSessions) {
    throw new Error(`Global session history exceeded the ${maxSessions} catalogue-budget read cap`);
  }
  return sessions;
}

function publicStatus({ budgetUnits, current, evaluatedAt }) {
  const remainingUnits = budgetUnits > current.totalUnits ? budgetUnits - current.totalUnits : 0n;
  return {
    status: "ok",
    windowSeconds: ROLLING_WINDOW_MS / 1_000,
    evaluatedAt: evaluatedAt.toISOString(),
    totalRaw: budgetUnits.toString(),
    usedRaw: current.totalUnits.toString(),
    remainingRaw: remainingUnits.toString(),
    total: usdcAmount(budgetUnits),
    used: usdcAmount(current.totalUnits),
    remaining: usdcAmount(remainingUnits),
    claimCount: current.sessionCount,
    ...(current.oldestClaimedAt
      ? { nextReleaseAt: new Date(current.oldestClaimedAt.getTime() + ROLLING_WINDOW_MS).toISOString() }
      : {})
  };
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
