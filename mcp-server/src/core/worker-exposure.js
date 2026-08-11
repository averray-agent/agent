import { ConfigError } from "./errors.js";
import { isExternalJob } from "./external-job-lifecycle.js";
import { decimalToBaseUnits, formatBaseUnits } from "./platform-service-helpers.js";

export const DEFAULT_WORKER_OPEN_EXPOSURE_CAP_USDC = 2.5;
export const WORKER_EXPOSURE_CAP_REACHED_REASON = "worker_open_exposure_cap_reached";
export const WORKER_EXPOSURE_UNAVAILABLE_REASON = "worker_open_exposure_unavailable";

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
    )
  };
}

export function createWorkerExposurePolicy({
  stateStore,
  blockchainGateway,
  gasEstimateUsdc,
  env = process.env,
  config = loadWorkerExposureConfig(env),
  logger = console
} = {}) {
  return new WorkerExposurePolicy({
    stateStore,
    blockchainGateway,
    gasEstimateUsdc,
    capUsdc: config.capUsdc,
    logger
  });
}

export class WorkerExposurePolicy {
  constructor({
    stateStore,
    blockchainGateway,
    gasEstimateUsdc,
    capUsdc = DEFAULT_WORKER_OPEN_EXPOSURE_CAP_USDC,
    logger = console
  } = {}) {
    if (typeof stateStore?.listSessionsByWallet !== "function") {
      throw new ConfigError("Worker exposure requires wallet-session pagination.");
    }
    this.stateStore = stateStore;
    this.blockchainGateway = blockchainGateway;
    this.capUnits = usdcUnits(capUsdc, "worker open exposure cap");
    this.gasEstimateUnits = usdcUnits(gasEstimateUsdc, "brokered gas estimate");
    this.logger = logger;
  }

  async evaluate({ wallet, job, claimEconomics } = {}) {
    if (isExternalJob(job)) {
      return {
        eligible: true,
        applies: false,
        status: "not_applicable",
        reason: "external_job_is_poster_funded_and_worker_pays_claim_gas"
      };
    }

    let candidate;
    let current;
    try {
      candidate = this.exposureForDefinition(job, claimEconomics);
      current = await this.currentExposure(wallet);
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

    const projectedUnits = current.totalUnits + candidate.totalUnits;
    const eligible = projectedUnits <= this.capUnits;
    return {
      eligible,
      applies: true,
      status: eligible ? "within_cap" : "exceeded",
      reason: eligible ? "worker_open_exposure_within_cap" : WORKER_EXPOSURE_CAP_REACHED_REASON,
      capUsdc: usdcAmount(this.capUnits),
      currentExposureUsdc: usdcAmount(current.totalUnits),
      candidateExposureUsdc: usdcAmount(candidate.totalUnits),
      projectedExposureUsdc: usdcAmount(projectedUnits),
      headroomUsdc: usdcAmount(this.capUnits > projectedUnits ? this.capUnits - projectedUnits : 0n),
      currentOpenSessionCount: current.sessionCount,
      candidate: publicComponents(candidate),
      components: current.components,
      message: eligible
        ? "The claim fits within this wallet's open operator exposure allowance."
        : "This claim would exceed the wallet's open USDC exposure allowance. Finish existing work before claiming another job."
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
    const asset = String(job?.rewardAsset ?? "").trim().toUpperCase();
    const rate = STABLECOIN_USDC_RATES.get(asset);
    if (!rate) {
      throw new Error(`No explicit USDC exposure rate exists for ${asset || "unknown asset"}`);
    }
    const rewardUnits = usdcUnits(Number(job?.rewardAmount) * rate, "reserved reward exposure");
    const feeRetained = claimEconomics?.claimFeeRetainedOnSuccess === true
      && claimEconomics?.claimEconomicsWaived !== true;
    const gasUnits = feeRetained ? 0n : this.gasEstimateUnits;
    return { rewardUnits, gasUnits, totalUnits: rewardUnits + gasUnits };
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
