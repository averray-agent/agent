import { DEFAULT_ESCROW_ASSET_SYMBOL, decimalsForAssetSymbol, normalizeAssetSymbol } from "./assets.js";
import { ConfigError, ConflictError, ExternalServiceError } from "./errors.js";
import { isExternalJob } from "./external-job-lifecycle.js";
import { decimalToBaseUnits, formatBaseUnits } from "./platform-service-helpers.js";

export const DEFAULT_ONBOARDING_WAIVER_CLAIM_COUNT = 3;
export const DEFAULT_CLAIM_FEE_BPS = 200;
export const DEFAULT_CLAIM_FEE_VERIFIER_BPS = 7000;
// Production observed 60 brokered claims in 24h. At the conservative measured
// $0.084 lifecycle exposure that is $5.04; $8 leaves ~59% normal-day headroom
// while still putting a finite bound on a runaway.
export const DEFAULT_ONBOARDING_SUBSIDY_DAILY_BUDGET_USDC = 8;
export const DEFAULT_ONBOARDING_SUBSIDY_GAS_ESTIMATE_USDC = 0.059;
export const ONBOARDING_SUBSIDY_EXHAUSTED_REASON = "onboarding_subsidy_exhausted";
export const ONBOARDING_SUBSIDY_EXHAUSTED_MESSAGE =
  "The free onboarding tier is fully allocated for today. Use the self-funded claim path to continue by paying your own claim fee.";
export const DEFAULT_MIN_CLAIM_FEE_BY_ASSET = {
  USDC: 0.05,
  DOT: 0.05
};

const ONBOARDING_SUBSIDY_SCOPE = "tier-0-onboarding-subsidy";
const USDC_DECIMALS = 6;
const DEFAULT_ASSET_USDC_RATES = {
  USDC: 1,
  USDT: 1,
  USDT0: 1
};

export function loadOnboardingSubsidyBudgetConfig(env = process.env) {
  return {
    dailyBudgetUsdc: nonNegativeConfigNumber(
      env.ONBOARDING_SUBSIDY_DAILY_BUDGET_USDC,
      DEFAULT_ONBOARDING_SUBSIDY_DAILY_BUDGET_USDC,
      "ONBOARDING_SUBSIDY_DAILY_BUDGET_USDC"
    ),
    gasEstimateUsdc: nonNegativeConfigNumber(
      env.ONBOARDING_SUBSIDY_GAS_ESTIMATE_USDC,
      DEFAULT_ONBOARDING_SUBSIDY_GAS_ESTIMATE_USDC,
      "ONBOARDING_SUBSIDY_GAS_ESTIMATE_USDC"
    )
  };
}

export function createOnboardingSubsidyBudget({
  stateStore,
  env = process.env,
  now = () => new Date(),
  config = loadOnboardingSubsidyBudgetConfig(env)
} = {}) {
  return new OnboardingSubsidyBudget({ stateStore, now, ...config });
}

export class OnboardingSubsidyBudget {
  constructor({
    stateStore,
    dailyBudgetUsdc = DEFAULT_ONBOARDING_SUBSIDY_DAILY_BUDGET_USDC,
    gasEstimateUsdc = DEFAULT_ONBOARDING_SUBSIDY_GAS_ESTIMATE_USDC,
    assetUsdcRates = DEFAULT_ASSET_USDC_RATES,
    now = () => new Date()
  } = {}) {
    if (
      typeof stateStore?.getDailyBudgetUsage !== "function"
      || typeof stateStore?.reserveDailyBudget !== "function"
    ) {
      throw new ConfigError("The onboarding subsidy budget requires an atomic daily-budget state store.");
    }
    this.stateStore = stateStore;
    this.dailyBudgetUnits = usdcUnits(dailyBudgetUsdc, "onboarding subsidy daily budget");
    this.gasEstimateUnits = usdcUnits(gasEstimateUsdc, "onboarding subsidy gas estimate");
    this.assetUsdcRates = Object.fromEntries(
      Object.entries(assetUsdcRates ?? {}).map(([asset, rate]) => [
        normalizeAssetSymbol(asset),
        nonNegativeConfigNumber(rate, undefined, `onboarding subsidy ${asset} USDC rate`)
      ])
    );
    this.now = now;
  }

  async getStatus() {
    const window = this.currentWindow();
    const usage = await this.stateStore.getDailyBudgetUsage(ONBOARDING_SUBSIDY_SCOPE, window.day);
    return this.formatStatus({ window, usedUnits: usage.usedUnits });
  }

  async inspect({ rewardAsset, waivedClaimStake } = {}) {
    const status = await this.getStatus();
    const estimate = this.estimateClaimSubsidy({ rewardAsset, waivedClaimStake });
    return {
      ...status,
      applies: true,
      available: estimate.totalUnits <= usdcUnits(status.headroomUsdc, "onboarding subsidy headroom"),
      estimatedClaimSubsidyUsdc: usdcAmount(estimate.totalUnits),
      waivedClaimStakeUsdc: usdcAmount(estimate.waivedClaimStakeUnits),
      brokeredGasEstimateUsdc: usdcAmount(this.gasEstimateUnits)
    };
  }

  async reserve({ reservationId, estimatedClaimSubsidyUsdc } = {}) {
    const window = this.currentWindow();
    const amountUnits = usdcUnits(
      estimatedClaimSubsidyUsdc,
      "estimated onboarding claim subsidy"
    );
    const reservation = await this.stateStore.reserveDailyBudget(
      ONBOARDING_SUBSIDY_SCOPE,
      window.day,
      {
        reservationId,
        amountUnits,
        limitUnits: this.dailyBudgetUnits,
        // Keep the completed day's ledger for one extra day of operator
        // evidence. The date-keyed aggregate still resets exactly at UTC 00:00.
        ttlSeconds: window.secondsUntilReset + 86_400
      }
    );
    const status = this.formatStatus({ window, usedUnits: reservation.usedUnits });
    return {
      ...status,
      applies: true,
      available: reservation.accepted,
      accepted: reservation.accepted,
      alreadyReserved: reservation.alreadyReserved,
      estimatedClaimSubsidyUsdc: usdcAmount(amountUnits),
      brokeredGasEstimateUsdc: usdcAmount(this.gasEstimateUnits)
    };
  }

  estimateClaimSubsidy({ rewardAsset, waivedClaimStake } = {}) {
    const asset = normalizeAssetSymbol(rewardAsset);
    const rate = this.assetUsdcRates[asset];
    if (!Number.isFinite(rate)) {
      throw new ConfigError(
        `No USDC conversion rate is configured for onboarding subsidy asset ${asset}.`,
        { asset }
      );
    }
    const waivedClaimStakeUnits = usdcUnits(
      Math.max(Number(waivedClaimStake) || 0, 0) * rate,
      "waived onboarding claim stake"
    );
    return {
      waivedClaimStakeUnits,
      totalUnits: waivedClaimStakeUnits + this.gasEstimateUnits
    };
  }

  currentWindow() {
    const current = new Date(this.now());
    if (!Number.isFinite(current.getTime())) {
      throw new ConfigError("The onboarding subsidy clock returned an invalid time.");
    }
    const resetAt = new Date(Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      current.getUTCDate() + 1
    ));
    return {
      day: current.toISOString().slice(0, 10),
      resetAt: resetAt.toISOString(),
      secondsUntilReset: Math.max(1, Math.ceil((resetAt.getTime() - current.getTime()) / 1000))
    };
  }

  formatStatus({ window, usedUnits }) {
    const safeUsedUnits = Math.max(0, Number(usedUnits) || 0);
    return {
      scope: ONBOARDING_SUBSIDY_SCOPE,
      day: window.day,
      clock: "UTC",
      resetAt: window.resetAt,
      dailyBudgetUsdc: usdcAmount(this.dailyBudgetUnits),
      allocatedUsdc: usdcAmount(safeUsedUnits),
      headroomUsdc: usdcAmount(Math.max(this.dailyBudgetUnits - safeUsedUnits, 0)),
      source: "state_store_daily_aggregate"
    };
  }
}

export function countClaimedSessions(sessions = []) {
  return sessions.filter((session) => session?.claimedAt || session?.status).length;
}

/**
 * Resolve the economics claimJobFor will charge if this wallet claims now.
 *
 * Both the public preflight projection and the claim path's precompute use this
 * function. In chain mode it distinguishes an existing escrow (whose contract
 * preview is authoritative) from an unknown escrow (whose claim-time ensureJob
 * mutation must be simulated locally without calling a reverting preview).
 */
export async function resolveClaimEconomicsDecision({
  wallet,
  job,
  blockchainGateway = undefined,
  getDefaultClaimStakeBps = async () => 500,
  getClaimEconomicsConfig = async () => ({}),
  getLocalPriorClaimCount = async () => 0,
  onboardingSubsidyBudget = undefined
} = {}) {
  const chainMode = Boolean(blockchainGateway?.isEnabled?.());
  if (!chainMode) {
    const [priorClaimCount, claimStakeBps, claimEconomicsConfig] = await Promise.all([
      getLocalPriorClaimCount(),
      getDefaultClaimStakeBps(),
      getClaimEconomicsConfig()
    ]);
    const input = {
      rewardAmount: job?.rewardAmount,
      rewardAsset: job?.rewardAsset,
      priorClaimCount,
      claimStakeBps,
      ...claimEconomicsConfig
    };
    return withOnboardingSubsidyStatus({
      chainMode: false,
      claimFeeRetainedOnSuccess: false,
      contractLayout: undefined,
      escrowExists: false,
      source: "local",
      economics: computeClaimEconomics({
        ...input,
        onboardingWaiverEligible: Boolean(job?.onboardingWaiverEligible)
      })
    }, {
      onboardingSubsidyBudget,
      job,
      paidEconomics: computeClaimEconomics({ ...input, onboardingWaiverEligible: false })
    });
  }

  requireGatewayMethod(blockchainGateway, "getClaimEconomicsDecisionState");
  const chainState = await blockchainGateway.getClaimEconomicsDecisionState(job?.id);
  if (!["current", "legacy"].includes(chainState?.contractLayout)
    || typeof chainState?.exists !== "boolean") {
    throw claimEconomicsUnavailable(
      "Chain claim-economics job state is unavailable.",
      { jobId: job?.id, field: "claimEconomicsDecisionState" }
    );
  }
  const contractLayout = chainState.contractLayout;
  const escrowExists = chainState.exists;

  if (contractLayout === "legacy") {
    const [claimStakeBps, claimEconomicsConfig] = await Promise.all([
      getDefaultClaimStakeBps(),
      getClaimEconomicsConfig()
    ]);
    return withOnboardingSubsidyStatus({
      chainMode: true,
      claimFeeRetainedOnSuccess: Boolean(chainState.claimFeeRetainedOnSuccess),
      contractLayout,
      escrowExists,
      source: "legacy_local",
      economics: computeClaimEconomics({
        rewardAmount: job?.rewardAmount,
        rewardAsset: job?.rewardAsset,
        priorClaimCount: 0,
        onboardingWaiverEligible: false,
        claimStakeBps,
        ...claimEconomicsConfig
      })
    }, { onboardingSubsidyBudget, job });
  }

  if (escrowExists) {
    requireGatewayMethod(blockchainGateway, "previewClaimEconomics");
    if (typeof chainState?.onboardingWaiverEligible !== "boolean") {
      throw claimEconomicsUnavailable(
        "On-chain onboarding-waiver eligibility is unavailable for the existing escrow.",
        { jobId: job?.id, field: "onboardingWaiverEligibleJobs" }
      );
    }

    const preview = await blockchainGateway.previewClaimEconomics(wallet, job?.id);
    if (job?.onboardingWaiverEligible === true && chainState.onboardingWaiverEligible === false) {
      const [claimStakeBps, config] = await Promise.all([
        getDefaultClaimStakeBps(),
        getClaimEconomicsConfig({ requireWaiverInputs: true })
      ]);
      const onboardingWaiverClaimCount = requireNonNegativeInteger(
        config?.onboardingWaiverClaimCount,
        "onboardingWaiverClaimCount",
        job?.id
      );
      const claimNumber = requirePositiveInteger(preview?.claimNumber, "claimNumber", job?.id);
      const economics = claimNumber <= onboardingWaiverClaimCount
        ? waiveContractPreview(preview)
        : preview;
      return withOnboardingSubsidyStatus({
        chainMode: true,
        claimFeeRetainedOnSuccess: Boolean(chainState.claimFeeRetainedOnSuccess),
        contractLayout,
        escrowExists,
        source: "contract_preview_adjusted_for_sync",
        economics
      }, {
        onboardingSubsidyBudget,
        job,
        paidEconomics: computeClaimEconomics({
          rewardAmount: job?.rewardAmount,
          rewardAsset: job?.rewardAsset,
          priorClaimCount: claimNumber - 1,
          onboardingWaiverEligible: false,
          claimStakeBps,
          ...config
        })
      });
    }

    let paidEconomics;
    if (preview?.claimEconomicsWaived === true && onboardingSubsidyBudget) {
      const claimNumber = requirePositiveInteger(preview?.claimNumber, "claimNumber", job?.id);
      const [claimStakeBps, config] = await Promise.all([
        getDefaultClaimStakeBps(),
        getClaimEconomicsConfig()
      ]);
      paidEconomics = computeClaimEconomics({
        rewardAmount: job?.rewardAmount,
        rewardAsset: job?.rewardAsset,
        priorClaimCount: claimNumber - 1,
        onboardingWaiverEligible: false,
        claimStakeBps,
        ...config
      });
    }
    return withOnboardingSubsidyStatus({
      chainMode: true,
      claimFeeRetainedOnSuccess: Boolean(chainState.claimFeeRetainedOnSuccess),
      contractLayout,
      escrowExists,
      source: "contract_preview",
      economics: preview
    }, { onboardingSubsidyBudget, job, paidEconomics });
  }

  requireGatewayMethod(blockchainGateway, "getWorkerClaimCount");
  const requireWaiverInputs = job?.onboardingWaiverEligible === true;
  const [priorClaimCount, claimStakeBps, claimEconomicsConfig] = await Promise.all([
    blockchainGateway.getWorkerClaimCount(wallet),
    getDefaultClaimStakeBps(),
    getClaimEconomicsConfig({ requireWaiverInputs })
  ]);
  requireNonNegativeInteger(priorClaimCount, "workerClaimCount", job?.id);
  if (requireWaiverInputs) {
    requireNonNegativeInteger(
      claimEconomicsConfig?.onboardingWaiverClaimCount,
      "onboardingWaiverClaimCount",
      job?.id
    );
  }

  const input = {
    rewardAmount: job?.rewardAmount,
    rewardAsset: job?.rewardAsset,
    priorClaimCount,
    claimStakeBps,
    ...claimEconomicsConfig
  };
  return withOnboardingSubsidyStatus({
    chainMode: true,
    claimFeeRetainedOnSuccess: Boolean(chainState.claimFeeRetainedOnSuccess),
    contractLayout,
    escrowExists,
    source: "current_local_before_ensure",
    economics: computeClaimEconomics({
      ...input,
      onboardingWaiverEligible: Boolean(job?.onboardingWaiverEligible)
    })
  }, {
    onboardingSubsidyBudget,
    job,
    paidEconomics: computeClaimEconomics({ ...input, onboardingWaiverEligible: false })
  });
}

export async function reserveOnboardingSubsidyForClaim({
  economics,
  onboardingSubsidyBudget,
  reservationId
} = {}) {
  if (!onboardingSubsidyBudget || economics?.onboardingSubsidy?.applies !== true) {
    return economics;
  }
  const inspected = economics.onboardingSubsidy;
  const reservation = await onboardingSubsidyBudget.reserve({
    reservationId,
    estimatedClaimSubsidyUsdc: inspected?.estimatedClaimSubsidyUsdc
  });
  if (reservation.accepted !== true) {
    throw new ConflictError(
      ONBOARDING_SUBSIDY_EXHAUSTED_MESSAGE,
      ONBOARDING_SUBSIDY_EXHAUSTED_REASON,
      reservation
    );
  }
  return {
    ...economics,
    onboardingSubsidy: {
      ...inspected,
      ...reservation,
      reserved: true
    }
  };
}

export function computeClaimEconomics({
  rewardAmount,
  rewardAsset = DEFAULT_ESCROW_ASSET_SYMBOL,
  priorClaimCount = 0,
  claimStakeBps = 500,
  claimFeeBps = DEFAULT_CLAIM_FEE_BPS,
  claimFeeVerifierBps = DEFAULT_CLAIM_FEE_VERIFIER_BPS,
  onboardingWaiverClaimCount = DEFAULT_ONBOARDING_WAIVER_CLAIM_COUNT,
  onboardingWaiverEligible = false,
  minClaimFeeByAsset = DEFAULT_MIN_CLAIM_FEE_BY_ASSET
} = {}) {
  const reward = finiteNumber(rewardAmount, 0);
  const asset = normalizeAssetSymbol(rewardAsset);
  const claimNumber = Math.max(0, Math.floor(finiteNumber(priorClaimCount, 0))) + 1;
  const waived = Boolean(onboardingWaiverEligible)
    && claimNumber <= Math.max(0, Math.floor(finiteNumber(onboardingWaiverClaimCount, 0)));

  if (waived) {
    return {
      claimStake: 0,
      claimStakeBps: 0,
      claimFee: 0,
      claimFeeBps: 0,
      claimFeeVerifierBps,
      claimEconomicsWaived: true,
      claimNumber,
      totalClaimLock: 0
    };
  }

  const stakeBps = Math.max(0, finiteNumber(claimStakeBps, 0));
  const feeBps = Math.max(0, finiteNumber(claimFeeBps, 0));
  const minimumFee = Math.max(finiteNumber(minClaimFeeByAsset?.[asset], 0), 0);
  // E-17: compute the stake/fee in integer base units at the asset's precision
  // so this off-chain projection matches the on-chain integer math exactly,
  // instead of accumulating IEEE-754 drift through `reward * bps / 10000`.
  const { claimStake, claimFee, totalClaimLock } = computeClaimAmounts({
    reward,
    asset,
    stakeBps,
    feeBps,
    minimumFee
  });

  return {
    claimStake,
    claimStakeBps: stakeBps,
    claimFee,
    claimFeeBps: feeBps,
    claimFeeVerifierBps,
    claimEconomicsWaived: false,
    claimNumber,
    totalClaimLock
  };
}

// E-17 — exact fixed-point claim economics.
// The contract computes stake/fee as `reward * bps / 10000` in uint256 base
// units. Doing the same arithmetic off-chain in IEEE-754 drifts (e.g.
// 0.1 * 500 / 10000 → 0.005000000000000001), and that noise leaks into the
// projection ledger and API payloads. We convert the human-decimal inputs to
// base units at the asset's precision, run the bps math in BigInt with the same
// floor division the contract uses, then format back to a Number to preserve
// the existing return contract. Inputs that can't be represented exactly at the
// asset's precision (malformed / over-precise projection values) fall back to
// the legacy Number path, so this never throws where it previously computed.
function computeClaimAmounts({ reward, asset, stakeBps, feeBps, minimumFee }) {
  try {
    const decimals = decimalsForAssetSymbol(asset);
    const rewardBase = decimalToBaseUnits(reward, decimals, "reward");
    const minimumFeeBase = decimalToBaseUnits(minimumFee, decimals, "minimum claim fee");
    const claimStakeBase = applyBpsFloor(rewardBase, stakeBps);
    const percentageFeeBase = applyBpsFloor(rewardBase, feeBps);
    const claimFeeBase = percentageFeeBase > minimumFeeBase ? percentageFeeBase : minimumFeeBase;
    return {
      claimStake: Number(formatBaseUnits(claimStakeBase, decimals)),
      claimFee: Number(formatBaseUnits(claimFeeBase, decimals)),
      totalClaimLock: Number(formatBaseUnits(claimStakeBase + claimFeeBase, decimals))
    };
  } catch {
    const claimStake = Math.max((reward * stakeBps) / 10_000, 0);
    const percentageFee = Math.max((reward * feeBps) / 10_000, 0);
    const claimFee = Math.max(percentageFee, minimumFee);
    return { claimStake, claimFee, totalClaimLock: claimStake + claimFee };
  }
}

// Mirrors the contract's integer bps math: floor(baseUnits * bps / 10000).
function applyBpsFloor(baseUnits, bps) {
  return (baseUnits * BigInt(Math.max(0, Math.trunc(bps)))) / 10_000n;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function waiveContractPreview(preview) {
  return {
    ...preview,
    claimStake: 0,
    claimStakeRaw: "0",
    claimStakeBps: 0,
    claimFee: 0,
    claimFeeRaw: "0",
    claimFeeBps: 0,
    claimEconomicsWaived: true,
    totalClaimLock: 0
  };
}

async function withOnboardingSubsidyStatus(
  decision,
  { onboardingSubsidyBudget, job, paidEconomics } = {}
) {
  const claimFeeRetainedOnSuccess = decision?.claimFeeRetainedOnSuccess === true;
  const normalizedDecision = {
    ...decision,
    economics: {
      ...decision.economics,
      claimFeeRetainedOnSuccess
    }
  };
  if (!onboardingSubsidyBudget) {
    return normalizedDecision;
  }
  const waived = normalizedDecision.economics?.claimEconomicsWaived === true;
  // Internal/curated claims currently route through claimJobFor and consume
  // operator gas regardless of the advisory requiresSponsoredGas catalog bit.
  // The external lifecycle is the actual self-funded transaction boundary.
  const operatorBrokered = !isExternalJob(job) && (waived || !claimFeeRetainedOnSuccess);
  if (waived && !Number.isFinite(Number(paidEconomics?.claimStake))) {
    throw claimEconomicsUnavailable(
      "The waived claim-stake value is unavailable for onboarding subsidy accounting.",
      { jobId: job?.id, field: "onboardingSubsidyWaivedClaimStake" }
    );
  }
  const onboardingSubsidy = operatorBrokered
    ? await onboardingSubsidyBudget.inspect({
        rewardAsset: job?.rewardAsset,
        waivedClaimStake: waived ? paidEconomics?.claimStake : 0
      })
    : {
        ...await onboardingSubsidyBudget.getStatus(),
        applies: false,
        available: true
      };
  return {
    ...normalizedDecision,
    economics: {
      ...normalizedDecision.economics,
      onboardingSubsidy
    }
  };
}

function usdcUnits(value, field) {
  try {
    const units = decimalToBaseUnits(value, USDC_DECIMALS, field);
    if (units < 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("outside safe integer range");
    }
    return Number(units);
  } catch (error) {
    throw new ConfigError(`${field} must be a non-negative USDC amount with at most 6 decimals.`, {
      field,
      value,
      reason: error?.message
    });
  }
}

function usdcAmount(units) {
  return Number(formatBaseUnits(BigInt(Math.max(0, Math.trunc(units))), USDC_DECIMALS));
}

function nonNegativeConfigNumber(value, fallback, field) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  const parsed = Number(candidate);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConfigError(`${field} must be a non-negative number.`, { field, value: candidate });
  }
  return parsed;
}

function requireGatewayMethod(gateway, method) {
  if (typeof gateway?.[method] !== "function") {
    throw claimEconomicsUnavailable(
      `Chain claim-economics dependency ${method} is unavailable.`,
      { field: method }
    );
  }
}

function requireNonNegativeInteger(value, field, jobId) {
  if (value === undefined || value === null || value === "" || typeof value === "boolean") {
    throw claimEconomicsUnavailable(
      `Chain claim-economics field ${field} is unavailable.`,
      { jobId, field }
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw claimEconomicsUnavailable(
      `Chain claim-economics field ${field} is unavailable.`,
      { jobId, field }
    );
  }
  return parsed;
}

function requirePositiveInteger(value, field, jobId) {
  const parsed = requireNonNegativeInteger(value, field, jobId);
  if (parsed === 0) {
    throw claimEconomicsUnavailable(
      `Chain claim-economics field ${field} is unavailable.`,
      { jobId, field }
    );
  }
  return parsed;
}

function claimEconomicsUnavailable(message, details) {
  return new ExternalServiceError(message, "claim_economics_unavailable", details);
}
