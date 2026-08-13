import { ConfigError } from "./errors.js";
import { isExternalJob } from "./external-job-lifecycle.js";
import { decimalToBaseUnits, formatBaseUnits } from "./platform-service-helpers.js";
import { loadDepositVestingConfig } from "./deposit-vesting.js";

export const DEFAULT_WORKER_OPEN_EXPOSURE_CAP_USDC = 2.5;
export const DEFAULT_WORKER_VESTED_OPEN_EXPOSURE_UNIT_RAW = 500_000;
export const DEFAULT_WORKER_EXTERNAL_REWARD_CEILING_BASE_RAW = 1_000_000;
export const DEFAULT_WORKER_EXTERNAL_CEILING_PER_VESTED_MILLI = 1_000;
export const WORKER_EXPOSURE_CAP_REACHED_REASON = "worker_open_exposure_cap_reached";
export const WORKER_EXPOSURE_UNAVAILABLE_REASON = "worker_open_exposure_unavailable";
export const EXTERNAL_REWARD_EXCEEDS_CAPITAL_CEILING_REASON = "external_reward_exceeds_capital_ceiling";

const USDC_DECIMALS = 6;
const ACTIVE_CHAIN_STATES = new Set([2, 3, 4, 5]);
const ACTIVE_LOCAL_STATUSES = new Set(["claimed", "submitted", "rejected", "disputed"]);
// These local terminal states cannot regain escrow exposure. Short-circuiting them
// avoids turning a wallet's lifetime history into one RPC read per finished job.
// Rejected is intentionally absent: on chain it remains state 4 while the dispute
// window is open, so its reward is still reserved and must count.
const DEFINITELY_CLOSED_LOCAL_STATUSES = new Set([
  "resolved",
  "closed",
  "expired",
  "timed_out",
  "settled"
]);
const STABLECOIN_USDC_RATES = new Map([
  ["USDC", 1],
  ["USDT", 1],
  ["USDT0", 1]
]);

export function loadWorkerExposureConfig(env = process.env) {
  return {
    capUsdc: positiveUsdcConfig(
      env.WORKER_OPEN_EXPOSURE_CAP_USDC,
      DEFAULT_WORKER_OPEN_EXPOSURE_CAP_USDC,
      "WORKER_OPEN_EXPOSURE_CAP_USDC"
    ),
    vestedOpenExposureUnitRaw: nonNegativeIntegerConfig(
      env.WORKER_VESTED_OPEN_EXPOSURE_UNIT_RAW,
      DEFAULT_WORKER_VESTED_OPEN_EXPOSURE_UNIT_RAW,
      "WORKER_VESTED_OPEN_EXPOSURE_UNIT_RAW"
    ),
    externalRewardCeilingBaseRaw: nonNegativeIntegerConfig(
      env.WORKER_EXTERNAL_REWARD_CEILING_BASE_RAW,
      DEFAULT_WORKER_EXTERNAL_REWARD_CEILING_BASE_RAW,
      "WORKER_EXTERNAL_REWARD_CEILING_BASE_RAW"
    ),
    externalCeilingPerVestedMilli: nonNegativeIntegerConfig(
      env.WORKER_EXTERNAL_CEILING_PER_VESTED_MILLI,
      DEFAULT_WORKER_EXTERNAL_CEILING_PER_VESTED_MILLI,
      "WORKER_EXTERNAL_CEILING_PER_VESTED_MILLI"
    )
  };
}

export function createWorkerExposurePolicy({
  stateStore,
  blockchainGateway,
  gasEstimateUsdc,
  env = process.env,
  config = loadWorkerExposureConfig(env),
  vestingConfig = loadDepositVestingConfig(env),
  resolveVesting = undefined,
  logger = console
} = {}) {
  return new WorkerExposurePolicy({
    stateStore,
    blockchainGateway,
    gasEstimateUsdc,
    capUsdc: config.capUsdc,
    vestedOpenExposureUnitRaw: config.vestedOpenExposureUnitRaw,
    externalRewardCeilingBaseRaw: config.externalRewardCeilingBaseRaw,
    externalCeilingPerVestedMilli: config.externalCeilingPerVestedMilli,
    resolveVesting: resolveVesting ?? (async (wallet) => {
      if (typeof blockchainGateway?.readDepositVesting === "function") {
        return blockchainGateway.readDepositVesting(wallet, {
          vestingHours: vestingConfig.vestingHours
        });
      }
      return { vestedRaw: 0n, tranches: [], available: false, vestingHours: vestingConfig.vestingHours };
    }),
    logger
  });
}

export class WorkerExposurePolicy {
  constructor({
    stateStore,
    blockchainGateway,
    gasEstimateUsdc,
    capUsdc = DEFAULT_WORKER_OPEN_EXPOSURE_CAP_USDC,
    vestedOpenExposureUnitRaw = DEFAULT_WORKER_VESTED_OPEN_EXPOSURE_UNIT_RAW,
    externalRewardCeilingBaseRaw = DEFAULT_WORKER_EXTERNAL_REWARD_CEILING_BASE_RAW,
    externalCeilingPerVestedMilli = DEFAULT_WORKER_EXTERNAL_CEILING_PER_VESTED_MILLI,
    resolveVesting = undefined,
    logger = console
  } = {}) {
    if (typeof stateStore?.listSessionsByWallet !== "function") {
      throw new ConfigError("Worker exposure requires wallet-session pagination.");
    }
    this.stateStore = stateStore;
    this.blockchainGateway = blockchainGateway;
    this.capUnits = usdcUnits(capUsdc, "worker open exposure cap");
    this.vestedOpenExposureUnit = nonNegativeRawUnits(
      vestedOpenExposureUnitRaw,
      "vested open exposure unit"
    );
    this.externalRewardCeilingBase = nonNegativeRawUnits(
      externalRewardCeilingBaseRaw,
      "external reward ceiling base"
    );
    this.externalCeilingPerVestedMilli = nonNegativeRawUnits(
      externalCeilingPerVestedMilli,
      "external ceiling per vested milli"
    );
    this.gasEstimateUnits = usdcUnits(gasEstimateUsdc, "brokered gas estimate");
    this.resolveVesting = resolveVesting ?? (async (wallet) => {
      if (typeof blockchainGateway?.readDepositVesting === "function") {
        return blockchainGateway.readDepositVesting(wallet);
      }
      return { vestedRaw: 0n, tranches: [], available: false };
    });
    this.logger = logger;
  }

  async evaluate({ wallet, job, claimEconomics } = {}) {
    if (isExternalJob(job)) {
      const capacity = await this.capacityForWallet(wallet);
      const rate = rewardUsdcRate(job);
      const rewardUnits = usdcUnits(Number(job?.rewardAmount) * rate, "external reward ceiling candidate");
      const ceilingUnits = BigInt(capacity.externalRewardCeilingRaw);
      const eligible = rewardUnits <= ceilingUnits;
      return {
        eligible,
        applies: true,
        status: eligible ? "within_capital_ceiling" : "exceeded",
        reason: eligible
          ? "external_reward_within_capital_ceiling"
          : EXTERNAL_REWARD_EXCEEDS_CAPITAL_CEILING_REASON,
        consumesOperatorExposure: false,
        rewardRaw: rewardUnits.toString(),
        rewardUsdc: usdcAmount(rewardUnits),
        vestedAssetsRaw: capacity.vestedAssetsRaw,
        vestedAssetsUsdc: capacity.vestedAssetsUsdc,
        externalRewardCeilingRaw: capacity.externalRewardCeilingRaw,
        externalRewardCeilingUsdc: capacity.externalRewardCeilingUsdc,
        vestingHours: capacity.vestingHours,
        vestingAvailable: capacity.vestingAvailable,
        message: eligible
          ? "The external poster-funded reward fits within this wallet's capital-backed per-job ceiling."
          : `This external reward exceeds the wallet's ${capacity.externalRewardCeilingUsdc} USDC capital-backed ceiling. Depositing principal and letting it vest for ${capacity.vestingHours} hours raises the ceiling.`
      };
    }

    let candidate;
    let current;
    let capacity;
    try {
      candidate = this.exposureForDefinition(job, claimEconomics);
      [current, capacity] = await Promise.all([
        this.currentExposure(wallet),
        this.capacityForWallet(wallet)
      ]);
    } catch (error) {
      return {
        eligible: false,
        applies: true,
        status: "unknown",
        reason: WORKER_EXPOSURE_UNAVAILABLE_REASON,
        capUsdc: usdcAmount(this.capUnits),
        message: "Open wallet exposure could not be proven. Retry after the session and chain reads recover.",
        error: error?.message ?? String(error)
      };
    }

    const capUnits = BigInt(capacity.openExposureCapRaw);
    const projectedUnits = current.totalUnits + candidate.totalUnits;
    const eligible = projectedUnits <= capUnits;
    return {
      eligible,
      applies: true,
      status: eligible ? "within_cap" : "exceeded",
      reason: eligible ? "worker_open_exposure_within_cap" : WORKER_EXPOSURE_CAP_REACHED_REASON,
      capRaw: capUnits.toString(),
      capUsdc: usdcAmount(capUnits),
      baseOpenExposureCapUsdc: capacity.baseOpenExposureCapUsdc,
      openExposureRaiseRaw: capacity.openExposureRaiseRaw,
      openExposureRaiseUsdc: capacity.openExposureRaiseUsdc,
      vestedAssetsRaw: capacity.vestedAssetsRaw,
      vestedAssetsUsdc: capacity.vestedAssetsUsdc,
      externalRewardCeilingRaw: capacity.externalRewardCeilingRaw,
      externalRewardCeilingUsdc: capacity.externalRewardCeilingUsdc,
      vestingHours: capacity.vestingHours,
      vestingAvailable: capacity.vestingAvailable,
      currentExposureUsdc: usdcAmount(current.totalUnits),
      candidateExposureUsdc: usdcAmount(candidate.totalUnits),
      projectedExposureUsdc: usdcAmount(projectedUnits),
      headroomUsdc: usdcAmount(capUnits > projectedUnits ? capUnits - projectedUnits : 0n),
      currentOpenSessionCount: current.sessionCount,
      candidate: publicComponents(candidate),
      components: current.components,
      message: eligible
        ? "The claim fits within this wallet's open operator exposure allowance."
        : "This claim would exceed the wallet's open USDC exposure allowance. Finish existing work before claiming another job."
    };
  }

  async capacityForWallet(wallet) {
    let vesting;
    try {
      vesting = await this.resolveVesting(wallet);
    } catch (error) {
      this.logger.warn?.({ wallet, err: error }, "deposit_vesting.read_failed");
      vesting = { vestedRaw: 0n, tranches: [], available: false };
    }
    const vestedUnits = nonNegativeRawUnits(vesting?.vestedRaw ?? 0, "vested deposit assets");
    const vestedWholeUsdc = vestedUnits / 1_000_000n;
    const openRaiseUnits = integerSquareRoot(vestedWholeUsdc) * this.vestedOpenExposureUnit;
    const openCapUnits = this.capUnits + openRaiseUnits;
    const externalRaiseUnits = vestedUnits * this.externalCeilingPerVestedMilli / 1_000n;
    const externalCeilingUnits = this.externalRewardCeilingBase + externalRaiseUnits;
    return {
      vestedAssetsRaw: vestedUnits.toString(),
      vestedAssetsUsdc: usdcAmount(vestedUnits),
      baseOpenExposureCapRaw: this.capUnits.toString(),
      baseOpenExposureCapUsdc: usdcAmount(this.capUnits),
      openExposureRaiseRaw: openRaiseUnits.toString(),
      openExposureRaiseUsdc: usdcAmount(openRaiseUnits),
      openExposureCapRaw: openCapUnits.toString(),
      openExposureCapUsdc: usdcAmount(openCapUnits),
      externalRewardCeilingBaseRaw: this.externalRewardCeilingBase.toString(),
      externalRewardCeilingBaseUsdc: usdcAmount(this.externalRewardCeilingBase),
      externalRewardCeilingRaiseRaw: externalRaiseUnits.toString(),
      externalRewardCeilingRaiseUsdc: usdcAmount(externalRaiseUnits),
      externalRewardCeilingRaw: externalCeilingUnits.toString(),
      externalRewardCeilingUsdc: usdcAmount(externalCeilingUnits),
      vestingHours: Number(vesting?.vestingHours ?? 48),
      vestingAvailable: vesting?.available !== false,
      evaluatedAt: vesting?.evaluatedAt,
      tranches: publicVestingTranches(vesting?.tranches)
    };
  }

  async currentExposure(wallet) {
    const sessions = await collectAllWalletSessions(this.stateStore, wallet);
    let totalUnits = 0n;
    const components = [];
    for (const session of sessions) {
      // External work is funded by its poster and claimed with a worker-signed
      // transaction, so neither reward nor gas is operator exposure.
      if (isExternalJob(session?.jobSnapshot?.definition)) continue;
      if (!await this.isOpenSession(session)) continue;
      const exposure = this.exposureForSession(session);
      totalUnits += exposure.totalUnits;
      components.push({
        sessionId: session.sessionId,
        jobId: session.jobId,
        ...publicComponents(exposure)
      });
    }
    return { totalUnits, sessionCount: components.length, components };
  }

  async isOpenSession(session) {
    if (DEFINITELY_CLOSED_LOCAL_STATUSES.has(String(session?.status ?? ""))) {
      return false;
    }
    if (this.blockchainGateway?.isEnabled?.()) {
      const live = await this.blockchainGateway.getJob(session.jobId);
      return ACTIVE_CHAIN_STATES.has(Number(live?.state));
    }
    return ACTIVE_LOCAL_STATUSES.has(String(session?.status ?? ""));
  }

  exposureForSession(session) {
    if (session?.workerExposure?.candidate) {
      const candidate = session.workerExposure.candidate;
      const rewardUnits = usdcUnits(candidate.reservedRewardUsdc, "stored reserved reward exposure");
      const gasUnits = usdcUnits(candidate.brokeredGasUsdc, "stored brokered gas exposure");
      const totalUnits = usdcUnits(candidate.totalUsdc, "stored total exposure");
      if (rewardUnits + gasUnits !== totalUnits) {
        throw new Error(`Session ${session?.sessionId ?? "unknown"} has inconsistent stored exposure components`);
      }
      return { rewardUnits, gasUnits, totalUnits };
    }
    const definition = session?.jobSnapshot?.definition;
    const claimEconomics = session?.jobSnapshot?.claimEconomics;
    if (!definition || !claimEconomics) {
      throw new Error(`Session ${session?.sessionId ?? "unknown"} has no claim-time exposure inputs`);
    }
    return this.exposureForDefinition(definition, claimEconomics);
  }

  exposureForDefinition(job, claimEconomics) {
    const rate = rewardUsdcRate(job);
    const rewardUnits = usdcUnits(Number(job?.rewardAmount) * rate, "reserved reward exposure");
    const feeRetained = claimEconomics?.claimFeeRetainedOnSuccess === true
      && claimEconomics?.claimEconomicsWaived !== true;
    const gasUnits = feeRetained ? 0n : this.gasEstimateUnits;
    return { rewardUnits, gasUnits, totalUnits: rewardUnits + gasUnits };
  }
}

function rewardUsdcRate(job) {
  const asset = String(job?.rewardAsset ?? "").trim().toUpperCase();
  const rate = STABLECOIN_USDC_RATES.get(asset);
  if (!rate) throw new Error(`No explicit USDC exposure rate exists for ${asset || "unknown asset"}`);
  return rate;
}

function integerSquareRoot(value) {
  const input = BigInt(value);
  if (input < 0n) throw new Error("integer square root requires a non-negative value");
  if (input < 2n) return input;
  let left = 1n;
  let right = input;
  while (left <= right) {
    const middle = (left + right) / 2n;
    const square = middle * middle;
    if (square === input) return middle;
    if (square < input) left = middle + 1n;
    else right = middle - 1n;
  }
  return right;
}

function publicVestingTranches(tranches) {
  if (!Array.isArray(tranches)) return [];
  return tranches.map((tranche) => ({
    depositedRaw: String(tranche?.depositedRaw ?? "0"),
    remainingRaw: String(tranche?.remainingRaw ?? "0"),
    vestedRaw: String(tranche?.vestedRaw ?? "0"),
    depositedAt: tranche?.depositedAt,
    blockNumber: Number(tranche?.blockNumber ?? 0),
    logIndex: Number(tranche?.logIndex ?? 0),
    ...(tranche?.txHash ? { txHash: String(tranche.txHash) } : {})
  }));
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
    throw new Error(`Wallet session history exceeded the ${maxSessions} exposure-read cap`);
  }
  return sessions;
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

function positiveUsdcConfig(value, fallback, field) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  const units = usdcUnits(candidate, field);
  if (units <= 0n) {
    throw new ConfigError(`${field} must be greater than zero.`, { field, value: candidate });
  }
  return Number(candidate);
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
