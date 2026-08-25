import {
  getAddress,
  keccak256,
  toUtf8Bytes,
  verifyMessage
} from "ethers";

import { buildSiweMessage } from "../auth/siwe.js";
import { canonicalizeContent } from "../core/canonical-content.js";
import { ConfigError, ConflictError, NotFoundError, ValidationError } from "../core/errors.js";
import { decimalToBaseUnits, formatBaseUnits } from "../core/platform-service-helpers.js";

export const LOCKED_TIERS_ENABLED_ENV = "LOCKED_TIERS_ENABLED";
export const LOCKED_TIER_PER_WALLET_CAP_USDC_ENV = "LOCKED_TIER_PER_WALLET_CAP_USDC";
export const LOCKED_TIER_COHORT_CAP_USDC_ENV = "LOCKED_TIER_COHORT_CAP_USDC";
export const CREDIT_READ_GRACE_MS_ENV = "CREDIT_READ_GRACE_MS";
export const LOCKED_TIER_PER_WALLET_CAP_CEILING_RAW = 25_000_000n;
export const LOCKED_TIER_COHORT_CAP_CEILING_RAW = 1_000_000_000n;
export const CREDIT_READ_GRACE_DEFAULT_MS = 5 * 60 * 1_000;
export const CREDIT_READ_GRACE_CEILING_MS = 15 * 60 * 1_000;
export const LOCKED_TIER_MINIMUM_COHORT_RAW = 15_000_000n;
export const LOCKED_TIER_CYCLE_FRICTION_RAW = 60_000n;
export const LOCKED_TIER_YIELD_MARGIN_MULTIPLE = 2n;
export const LOCKED_TIER_CYCLE_DAYS = 30n;
export const LOCKED_TIER_YIELD_INACTIVE_TEXT =
  "yield inactive — pool below activation threshold.";
export const LOCKED_TIER_EARLY_EXIT_TERMS =
  "Request at any time; principal returns via the normal withdrawal path after the standard vesting delay; forfeits: current-period yield share + tier perks (drops to Flex immediately). No principal haircut.";
export const LOCKED_TIER_RISK_SENTENCE =
  "A locked deposit is eligible for a pro-rata NAV share only while the activation gate is open and carries its pro-rata venue gain or loss; Flex and working balances never leave the platform.";
export const LOCKED_TIER_FORFEIT_TERMS_HASH = keccak256(
  toUtf8Bytes(LOCKED_TIER_EARLY_EXIT_TERMS)
).toLowerCase();

const ASSET_DECIMALS = 6;
const DEFAULT_PER_WALLET_CAP_USDC = "25";
const DEFAULT_COHORT_CAP_USDC = "1000";
const DEFAULT_VESTING_HOURS = 48;
const QUOTE_TTL_MS = 10 * 60 * 1_000;
const ALARM_SCOPE = "locked-tiers:withdrawal-consent-alarm";
const TIERS = Object.freeze({
  t30: Object.freeze({ termDays: 30, priorityRank: 1 }),
  t90: Object.freeze({ termDays: 90, priorityRank: 2 })
});

export function loadLockedTierConfig(env = process.env, { logger = console } = {}) {
  const enabled = parseBoolean(env[LOCKED_TIERS_ENABLED_ENV], false, LOCKED_TIERS_ENABLED_ENV);
  const requestedRaw = parsePositiveUsdc(
    env[LOCKED_TIER_PER_WALLET_CAP_USDC_ENV] ?? DEFAULT_PER_WALLET_CAP_USDC,
    LOCKED_TIER_PER_WALLET_CAP_USDC_ENV
  );
  const perWalletCapRaw = requestedRaw > LOCKED_TIER_PER_WALLET_CAP_CEILING_RAW
    ? LOCKED_TIER_PER_WALLET_CAP_CEILING_RAW
    : requestedRaw;
  if (requestedRaw > LOCKED_TIER_PER_WALLET_CAP_CEILING_RAW) {
    logger.warn?.(
      {
        configuredRaw: requestedRaw.toString(),
        effectiveRaw: perWalletCapRaw.toString(),
        ceilingRaw: LOCKED_TIER_PER_WALLET_CAP_CEILING_RAW.toString()
      },
      "locked_tiers.per_wallet_cap_clamped"
    );
  }
  const requestedCohortRaw = parsePositiveUsdc(
    env[LOCKED_TIER_COHORT_CAP_USDC_ENV] ?? DEFAULT_COHORT_CAP_USDC,
    LOCKED_TIER_COHORT_CAP_USDC_ENV
  );
  const cohortCapRaw = requestedCohortRaw > LOCKED_TIER_COHORT_CAP_CEILING_RAW
    ? LOCKED_TIER_COHORT_CAP_CEILING_RAW
    : requestedCohortRaw;
  if (requestedCohortRaw > LOCKED_TIER_COHORT_CAP_CEILING_RAW) {
    logger.warn?.(
      {
        configuredRaw: requestedCohortRaw.toString(),
        effectiveRaw: cohortCapRaw.toString(),
        ceilingRaw: LOCKED_TIER_COHORT_CAP_CEILING_RAW.toString()
      },
      "locked_tiers.cohort_cap_clamped"
    );
  }
  const requestedCreditReadGraceMs = parseNonNegativeInteger(
    env[CREDIT_READ_GRACE_MS_ENV] ?? CREDIT_READ_GRACE_DEFAULT_MS,
    CREDIT_READ_GRACE_MS_ENV
  );
  const creditReadGraceMs = Math.min(
    requestedCreditReadGraceMs,
    CREDIT_READ_GRACE_DEFAULT_MS,
    CREDIT_READ_GRACE_CEILING_MS
  );
  if (requestedCreditReadGraceMs > CREDIT_READ_GRACE_DEFAULT_MS) {
    logger.warn?.(
      {
        configuredMs: requestedCreditReadGraceMs,
        effectiveMs: creditReadGraceMs,
        envMaximumMs: CREDIT_READ_GRACE_DEFAULT_MS,
        ceilingMs: CREDIT_READ_GRACE_CEILING_MS
      },
      "locked_tiers.credit_read_grace_clamped"
    );
  }
  return Object.freeze({
    enabled,
    perWalletCapRaw,
    perWalletCapUsdc: formatBaseUnits(perWalletCapRaw, ASSET_DECIMALS),
    cohortCapRaw,
    cohortCapUsdc: formatBaseUnits(cohortCapRaw, ASSET_DECIMALS),
    creditReadGraceMs
  });
}

/**
 * Pure activation law. Deliberately accepts only the locked cohort: there is
 * no environment switch, operator override, or caller-supplied rate.
 *
 * The projection is the ratified epoch-2 observation (0.009 USDC earned by
 * 9.5 USDC in seven days), extended over the 30-day cycle. The second gate
 * requires that projection to cover twice the measured 0.060-USDC round trip.
 */
export function lockedTierActivationGate(totalLockedRaw) {
  const lockedRaw = nonNegativeRaw(totalLockedRaw);
  const projectedCycleYieldRaw = lockedRaw * 9_000n * LOCKED_TIER_CYCLE_DAYS
    / (9_500_000n * 7n);
  const requiredProjectedYieldRaw = LOCKED_TIER_CYCLE_FRICTION_RAW
    * LOCKED_TIER_YIELD_MARGIN_MULTIPLE;
  const minimumMet = lockedRaw >= LOCKED_TIER_MINIMUM_COHORT_RAW;
  const economicsMet = projectedCycleYieldRaw >= requiredProjectedYieldRaw;
  const open = minimumMet && economicsMet;
  const blockers = [
    ...(minimumMet ? [] : ["locked_cohort_below_minimum"]),
    ...(economicsMet ? [] : ["projected_cycle_yield_below_2x_friction"])
  ];
  return {
    open,
    status: open ? "open" : "closed",
    blockers,
    totalLocked: amount(lockedRaw),
    minimumLocked: amount(LOCKED_TIER_MINIMUM_COHORT_RAW),
    projection: {
      cycleDays: Number(LOCKED_TIER_CYCLE_DAYS),
      projectedCycleYield: amount(projectedCycleYieldRaw),
      basis: {
        observedPrincipal: amount(9_500_000n),
        observedYield: amount(9_000n),
        observedDays: 7
      }
    },
    friction: {
      cycleFriction: amount(LOCKED_TIER_CYCLE_FRICTION_RAW),
      marginMultiple: Number(LOCKED_TIER_YIELD_MARGIN_MULTIPLE),
      requiredProjectedYield: amount(requiredProjectedYieldRaw)
    },
    override: "none",
    yieldStatusText: open
      ? "NAV share active — the locked cohort satisfies the automatic activation gate."
      : LOCKED_TIER_YIELD_INACTIVE_TEXT
  };
}

export function lockedTierPriority(tier) {
  const normalized = String(tier ?? "flex").toLowerCase();
  return {
    tier: TIERS[normalized] ? normalized : "flex",
    rank: TIERS[normalized]?.priorityRank ?? 0
  };
}

export class LockedTierService {
  constructor({
    stateStore,
    accountPositionReader,
    creditPositionReader,
    config = loadLockedTierConfig(),
    chainId,
    siweDomain = "localhost",
    publicBaseUrl = "http://localhost",
    vestingHours = DEFAULT_VESTING_HOURS,
    now = () => new Date()
  } = {}) {
    if (
      typeof stateStore?.listLockedTierEntries !== "function"
      || typeof stateStore?.createLockedTierEntry !== "function"
      || typeof stateStore?.upsertLockedTierEntry !== "function"
    ) {
      throw new ConfigError("Locked tiers require the durable lock-ledger state-store surface.");
    }
    this.stateStore = stateStore;
    this.accountPositionReader = accountPositionReader;
    this.creditPositionReader = creditPositionReader;
    this.config = config;
    this.creditReadGraceMs = Math.min(
      parseNonNegativeInteger(
        config.creditReadGraceMs ?? CREDIT_READ_GRACE_DEFAULT_MS,
        "config.creditReadGraceMs"
      ),
      CREDIT_READ_GRACE_CEILING_MS
    );
    this.lastSuccessfulCreditReadByWallet = new Map();
    this.chainId = Number(chainId);
    this.siweDomain = String(siweDomain);
    this.consentUri = new URL("/locked-deposits/consent", publicBaseUrl).toString();
    this.vestingHours = Number(vestingHours);
    this.now = now;
  }

  async quote(walletInput, input = {}, { poolInfo } = {}) {
    this.#assertNewLocksEnabled();
    assertOnlyFields(input, new Set(["tier", "amountRaw", "consentNonce", "publicProfileOptIn"]));
    const wallet = normalizeWalletAddress(walletInput);
    const tier = normalizeTier(input.tier);
    const tierDefinition = TIERS[tier];
    const requested = exactPositiveRaw(input.amountRaw, "amountRaw");
    const consentNonce = consentNonceValue(input.consentNonce);
    const publicProfileOptIn = input.publicProfileOptIn === true;
    if (input.publicProfileOptIn !== undefined && typeof input.publicProfileOptIn !== "boolean") {
      throw new ValidationError("publicProfileOptIn must be a boolean.", { field: "publicProfileOptIn" });
    }
    if (tier !== "t90" && publicProfileOptIn) {
      throw new ValidationError(
        "The committed depositor public-profile flag is a T90 perk and cannot be selected for T30.",
        { field: "publicProfileOptIn", tier }
      );
    }

    const [position, allEntries, credit] = await Promise.all([
      this.#readAccountPosition(wallet),
      this.#currentEntries(),
      this.#readCredit(wallet)
    ]);
    const entries = entriesForWallet(allEntries, wallet);
    this.#assertNoOutstandingCredit(credit);
    const encumberedRaw = sumEncumbered(entries);
    const activeRaw = sumActive(entries);
    const liquidRaw = BigInt(position.position.liquidRaw);
    this.#assertWalletCapacity({ requested, liquidRaw, encumberedRaw, activeRaw });
    const pool = poolSnapshot(poolInfo, wallet);
    const globalActiveRaw = sumActive(allEntries);
    this.#assertPoolCapacity({ requested, activeRaw, globalActiveRaw, pool });
    const gate = lockedTierActivationGate(globalActiveRaw);
    const issuedAt = this.now();
    const quoteExpiresAt = new Date(issuedAt.getTime() + QUOTE_TTL_MS);
    const terms = {
      schemaVersion: 1,
      wallet,
      tier,
      amountRaw: requested.toString(),
      asset: getAddress(position.asset.address),
      assetSymbol: String(position.asset.symbol ?? "USDC").toUpperCase(),
      assetDecimals: Number(position.asset.decimals),
      termDays: tierDefinition.termDays,
      consentNonce,
      issuedAt: issuedAt.toISOString(),
      quoteExpiresAt: quoteExpiresAt.toISOString(),
      forfeitTermsHash: LOCKED_TIER_FORFEIT_TERMS_HASH,
      earlyExitTerms: LOCKED_TIER_EARLY_EXIT_TERMS,
      riskSentence: LOCKED_TIER_RISK_SENTENCE,
      publicProfileOptIn,
      fundsMovement: "none — the ledger encumbers existing AAC liquid",
      activationGate: gate,
      nav: pool.nav
    };
    const termsHash = hashLockedTierTerms(terms);
    return {
      schemaVersion: 1,
      available: true,
      product: "locked deposit",
      terms,
      termsHash,
      tierTerms: tierTerms(tier),
      activationGate: gate,
      nav: pool.nav,
      riskSentence: LOCKED_TIER_RISK_SENTENCE,
      balance: {
        liquid: amount(liquidRaw),
        alreadyEncumbered: amount(encumberedRaw),
        availableToLock: amount(clampAtZero(liquidRaw - encumberedRaw))
      },
      caps: {
        perWallet: amount(this.config.perWalletCapRaw),
        lockedCohort: amount(this.config.cohortCapRaw),
        existingPoolHeadroom: amount(pool.globalHeadroomRaw),
        existingPoolPerAgentHeadroom: amount(pool.perAgentHeadroomRaw)
      },
      consent: {
        required: true,
        method: "SIWE_EIP4361",
        message: this.#consentMessage(terms, termsHash),
        submit: { method: "POST", path: "/locked-deposits/consent" }
      }
    };
  }

  async createLock(walletInput, input = {}, { poolInfo } = {}) {
    this.#assertNewLocksEnabled();
    const wallet = normalizeWalletAddress(walletInput);
    assertOnlyFields(input, new Set(["terms", "termsHash", "consentSignature"]));
    const terms = input.terms;
    if (!terms || typeof terms !== "object" || Array.isArray(terms)) {
      throw new ValidationError(
        "terms must be the unmodified object returned by the locked-deposit quote. No signed consent means no lock.",
        { field: "terms" }
      );
    }
    const termsHash = hashLockedTierTerms(terms);
    if (bytes32(input.termsHash, "termsHash") !== termsHash) {
      throw new ConflictError(
        "The submitted locked-deposit terms no longer reproduce termsHash; request a fresh quote and sign it unchanged.",
        "locked_tier_terms_hash_mismatch"
      );
    }
    this.#assertTermsBinding(wallet, terms);
    const signature = signatureValue(input.consentSignature, "consentSignature");
    const consentMessage = this.#consentMessage(terms, termsHash);
    const recovered = getAddress(verifyMessage(consentMessage, signature));
    if (recovered !== wallet) {
      throw new ConflictError(
        "The locked-deposit consent signer does not match the authenticated wallet.",
        "locked_tier_consent_signer_mismatch"
      );
    }
    const existingEntry = (await this.#currentEntries(wallet))
      .find((entry) => entry.id === termsHash);
    if (existingEntry) {
      return {
        schemaVersion: 1,
        created: false,
        entry: existingEntry,
        tierState: await this.getWalletState(wallet)
      };
    }
    if (Date.parse(terms.quoteExpiresAt) < this.now().getTime()) {
      throw new ConflictError(
        "The locked-deposit quote expired before consent was submitted; request a fresh quote and sign the new terms.",
        "locked_tier_quote_expired"
      );
    }

    const [position, allEntries, credit] = await Promise.all([
      this.#readAccountPosition(wallet),
      this.#currentEntries(),
      this.#readCredit(wallet)
    ]);
    const entries = entriesForWallet(allEntries, wallet);
    this.#assertNoOutstandingCredit(credit);
    if (getAddress(position.asset.address) !== getAddress(terms.asset)) {
      throw new ConflictError(
        "The live AAC asset no longer matches the signed quote. No lock was created; request and sign a fresh quote.",
        "locked_tier_asset_mismatch"
      );
    }
    const requested = BigInt(terms.amountRaw);
    const encumberedRaw = sumEncumbered(entries);
    const activeRaw = sumActive(entries);
    const liquidRaw = BigInt(position.position.liquidRaw);
    this.#assertWalletCapacity({ requested, liquidRaw, encumberedRaw, activeRaw });
    const pool = poolSnapshot(poolInfo, wallet);
    this.#assertPoolCapacity({
      requested,
      activeRaw,
      globalActiveRaw: sumActive(allEntries),
      pool
    });

    const consentRecord = {
      hash: termsHash,
      kind: "locked_tier_consent_v1",
      wallet,
      terms,
      termsHash,
      consentMessage,
      consentSignature: signature,
      storedAt: this.now().toISOString()
    };
    await this.stateStore.upsertContent(consentRecord);

    const lockedAt = this.now();
    const entry = {
      id: termsHash,
      wallet: wallet.toLowerCase(),
      tier: terms.tier,
      amountRaw: requested.toString(),
      lockedAt: lockedAt.toISOString(),
      termDays: Number(terms.termDays),
      expiresAt: new Date(
        lockedAt.getTime() + Number(terms.termDays) * 24 * 60 * 60 * 1_000
      ).toISOString(),
      consentRef: termsHash,
      status: "active",
      publicProfileOptIn: terms.publicProfileOptIn === true
    };
    const result = await this.stateStore.createLockedTierEntry(entry, {
      perWalletCapRaw: this.config.perWalletCapRaw.toString(),
      globalActiveCapRaw: minRaw(
        this.config.cohortCapRaw,
        pool.globalHeadroomRaw
      ).toString()
    });
    if (!result.accepted) {
      const reason = result.reason === "global_cap_exceeded"
        ? "locked_tier_cohort_cap_exceeded"
        : "locked_tier_per_wallet_cap_exceeded";
      throw new ConflictError(
        result.reason === "global_cap_exceeded"
          ? "The existing pool cap has no room for this locked deposit. Retry after pool capacity is released."
          : `This lock would exceed the ${this.config.perWalletCapUsdc} USDC per-wallet locked-deposit cap. Reduce the amount or wait for an existing lock to release.`,
        reason,
        {
          requested: amount(requested),
          existing: amount(result.existingRaw),
          cap: amount(result.capRaw)
        }
      );
    }
    return {
      schemaVersion: 1,
      created: result.created,
      entry: result.entry,
      tierState: await this.getWalletState(wallet)
    };
  }

  async requestExit(walletInput, lockIdInput) {
    const wallet = normalizeWalletAddress(walletInput);
    const lockId = bytes32(lockIdInput, "lockId");
    const entries = await this.#currentEntries(wallet);
    const entry = entries.find((candidate) => candidate.id === lockId);
    if (!entry) throw new NotFoundError("Locked deposit not found for this wallet.", "locked_tier_not_found");
    if (entry.status === "released") {
      throw new ConflictError(
        "This locked deposit is already released; no early-exit request is needed.",
        "locked_tier_already_released"
      );
    }
    if (entry.status === "exiting") {
      return { schemaVersion: 1, entry, tierState: await this.getWalletState(wallet) };
    }
    const exitRequestedAt = this.now();
    const updated = {
      ...entry,
      status: "exiting",
      exitRequestedAt: exitRequestedAt.toISOString(),
      releaseAt: new Date(
        exitRequestedAt.getTime() + this.vestingHours * 60 * 60 * 1_000
      ).toISOString(),
      forfeiture: {
        yieldShare: "current_period",
        perks: "immediate",
        principalHaircutRaw: "0",
        penaltyFeeRaw: "0"
      }
    };
    await this.stateStore.upsertLockedTierEntry(updated);
    return {
      schemaVersion: 1,
      entry: updated,
      consequence: {
        tier: "flex",
        perks: "forfeited immediately",
        yieldShare: "current period forfeited",
        principal: "returns through the normal withdrawal path after the standard vesting delay",
        releaseAt: updated.releaseAt,
        principalHaircutRaw: "0",
        penaltyFeeRaw: "0"
      },
      tierState: await this.getWalletState(wallet)
    };
  }

  async getWalletState(walletInput) {
    const wallet = normalizeWalletAddress(walletInput);
    const [entries, credit] = await Promise.all([
      this.#currentEntries(wallet),
      this.#readCredit(wallet)
    ]);
    const active = entries.filter((entry) => entry.status === "active");
    const highest = active.sort(compareTierDescending)[0];
    const creditEvidence = this.#creditForPerks(wallet, credit);
    const creditOutstanding = nonNegativeRaw(creditEvidence.credit?.outstandingDebtRaw) > 0n;
    const creditPositionReadable = isCreditPositionReadable(creditEvidence.credit);
    const t90Suspended = highest?.tier === "t90"
      && (creditOutstanding || !creditPositionReadable);
    const effectiveTier = t90Suspended ? "flex" : highest?.tier ?? "flex";
    const priority = lockedTierPriority(effectiveTier);
    const allEntries = await this.#currentEntries();
    const activationGate = lockedTierActivationGate(sumActive(allEntries));
    return {
      enabledForNewLocks: this.config.enabled,
      tier: effectiveTier,
      contractualTier: highest?.tier ?? "flex",
      priorityRank: priority.rank,
      perksActive: Boolean(highest) && !t90Suspended,
      ...(t90Suspended ? {
        perksSuspendedReason: creditOutstanding
          ? "outstanding_credit_draw"
          : "credit_position_unavailable"
      } : {}),
      ...(highest?.tier === "t90"
        && !t90Suspended
        && creditEvidence.staleSeconds !== undefined
        ? { creditReadStaleSeconds: creditEvidence.staleSeconds }
        : {}),
      locked: amount(sumActive(entries)),
      encumbered: amount(sumEncumbered(entries)),
      activationGate,
      yieldStatusText: activationGate.yieldStatusText,
      entries
    };
  }

  async getPriorityRank(walletInput) {
    const state = await this.getWalletState(walletInput);
    return { tier: state.tier, rank: state.priorityRank, perksActive: state.perksActive };
  }

  async getPoolTelemetry(walletInput = undefined) {
    const entries = await this.#currentEntries();
    const activationGate = lockedTierActivationGate(sumActive(entries));
    return {
      enabledForNewLocks: this.config.enabled,
      product: "locked deposit",
      activationGate,
      yieldStatusText: activationGate.yieldStatusText,
      cohort: {
        activeLockCount: entries.filter((entry) => entry.status === "active").length,
        totalLocked: amount(sumActive(entries))
      },
      ...(walletInput ? { wallet: await this.getWalletState(walletInput) } : {})
    };
  }

  async getCapability() {
    const telemetry = await this.getPoolTelemetry();
    return {
      status: this.config.enabled ? "available" : "flag_off",
      enabled: this.config.enabled,
      product: "locked deposit",
      tiers: [tierTerms("t30"), tierTerms("t90")],
      priority: "T90 ranks above T30 ranks above Flex inside the deposit-claim-priority window.",
      activationGate: telemetry.activationGate,
      yieldStatusText: telemetry.yieldStatusText,
      endpoints: {
        quote: { method: "POST", path: "/locked-deposits/quote" },
        consent: { method: "POST", path: "/locked-deposits/consent" },
        earlyExit: { method: "POST", path: "/locked-deposits/:id/exit" },
        state: { method: "GET", path: "/me" }
      }
    };
  }

  async getPublicCommitment(walletInput) {
    const wallet = normalizeWalletAddress(walletInput);
    const entries = await this.#currentEntries(wallet);
    const optedIn = entries.some((entry) =>
      entry.status === "active"
      && entry.tier === "t90"
      && entry.publicProfileOptIn === true
    );
    if (!optedIn) return undefined;
    const credit = this.#creditForPerks(wallet, await this.#readCredit(wallet)).credit;
    if (
      !isCreditPositionReadable(credit)
      || nonNegativeRaw(credit?.outstandingDebtRaw) > 0n
    ) return undefined;
    return { committedDepositor: true, tier: "t90" };
  }

  async assessWithdrawal({ wallet: walletInput, requestedRaw, liquidRaw } = {}) {
    const wallet = normalizeWalletAddress(walletInput);
    const requested = exactPositiveRaw(requestedRaw, "amount");
    const liquid = nonNegativeRaw(liquidRaw);
    const entries = await this.#currentEntries(wallet);
    const encumberedRaw = sumEncumbered(entries);
    const availableRaw = clampAtZero(liquid - encumberedRaw);
    if (requested <= availableRaw || requested > liquid) {
      return { allowed: requested <= availableRaw, availableRaw, encumberedRaw, entries };
    }

    const mismatches = [];
    for (const entry of entries.filter(isEncumbered)) {
      const covered = await this.#consentCoversEntry(entry).catch(() => false);
      if (!covered) mismatches.push(entry.id);
    }
    if (mismatches.length > 0) {
      const alarm = await this.stateStore.upsertServiceState(ALARM_SCOPE, {
        ok: false,
        severity: "critical",
        code: "locked_tier_withdrawal_consent_mismatch",
        wallet: wallet.toLowerCase(),
        lockIds: mismatches,
        detectedAt: this.now().toISOString(),
        message: "A locked-deposit gate denied a withdrawal without intact consent coverage. Disable new locks and investigate before asking the wallet to retry."
      });
      return { allowed: false, availableRaw, encumberedRaw, entries, consentMismatch: true, alarm };
    }
    return { allowed: false, availableRaw, encumberedRaw, entries, consentMismatch: false };
  }

  async getHealth() {
    const alarm = await this.stateStore.getServiceState(ALARM_SCOPE);
    if (alarm?.ok === false) return alarm;
    return { ok: true, state: "healthy" };
  }

  async #currentEntries(wallet = undefined) {
    const entries = await this.stateStore.listLockedTierEntries(wallet?.toLowerCase());
    const nowMs = this.now().getTime();
    const matured = [];
    for (const entry of entries) {
      const termComplete = entry.status === "active" && Date.parse(entry.expiresAt) <= nowMs;
      const exitComplete = entry.status === "exiting" && Date.parse(entry.releaseAt) <= nowMs;
      if (!termComplete && !exitComplete) {
        matured.push(entry);
        continue;
      }
      const released = {
        ...entry,
        status: "released",
        releasedAt: termComplete ? entry.expiresAt : entry.releaseAt,
        releaseReason: termComplete ? "term_completed" : "early_exit_vesting_completed"
      };
      await this.stateStore.upsertLockedTierEntry(released);
      matured.push(released);
    }
    return matured;
  }

  async #readAccountPosition(wallet) {
    if (typeof this.accountPositionReader !== "function") {
      throw new ConfigError("Locked tiers require the live AAC position reader.");
    }
    let position;
    try {
      position = await this.accountPositionReader(wallet, "USDC");
    } catch {
      throw new ConflictError(
        "The live AAC balance could not be read. No lock was created; retry after the chain read recovers.",
        "locked_tier_aac_balance_unavailable"
      );
    }
    if (!/^\d+$/u.test(String(position?.position?.liquidRaw ?? ""))) {
      throw new ConflictError(
        "The live AAC response did not contain an exact USDC liquid balance. No lock was created.",
        "locked_tier_aac_balance_unavailable"
      );
    }
    return position;
  }

  async #readCredit(wallet) {
    if (typeof this.creditPositionReader !== "function") {
      return { available: false, reason: "credit_pool_not_configured", outstandingDebtRaw: "0" };
    }
    try {
      const capacity = await this.creditPositionReader(wallet);
      const credit = capacity?.credit ?? capacity ?? { available: false, reason: "credit_position_missing" };
      if (isCreditPositionReadable(credit)) {
        this.lastSuccessfulCreditReadByWallet.set(wallet.toLowerCase(), {
          outstandingDebtRaw: nonNegativeRaw(credit?.outstandingDebtRaw).toString(),
          readAtMs: this.now().getTime()
        });
      }
      return credit;
    } catch {
      return { available: false, reason: "credit_pool_read_failed", outstandingDebtRaw: "0" };
    }
  }

  #creditForPerks(wallet, freshCredit) {
    if (isCreditPositionReadable(freshCredit)) return { credit: freshCredit };
    const walletKey = wallet.toLowerCase();
    const cached = this.lastSuccessfulCreditReadByWallet.get(walletKey);
    if (!cached) return { credit: freshCredit };
    const ageMs = Math.max(0, this.now().getTime() - cached.readAtMs);
    if (ageMs >= this.creditReadGraceMs) {
      this.lastSuccessfulCreditReadByWallet.delete(walletKey);
      return { credit: freshCredit };
    }
    return {
      credit: { available: true, outstandingDebtRaw: cached.outstandingDebtRaw },
      staleSeconds: Math.floor(ageMs / 1_000)
    };
  }

  #assertNoOutstandingCredit(credit) {
    const readable = isCreditPositionReadable(credit);
    if (!readable) {
      throw new ConflictError(
        "The outstanding-credit check is unavailable. No lock was created; retry after the credit read recovers.",
        "locked_tier_credit_position_unavailable"
      );
    }
    if (nonNegativeRaw(credit?.outstandingDebtRaw) > 0n) {
      throw new ConflictError(
        "A wallet with an outstanding credit draw cannot create a locked deposit. Repay the draw, then request a fresh quote.",
        "locked_tier_outstanding_credit_draw"
      );
    }
  }

  #assertWalletCapacity({ requested, liquidRaw, encumberedRaw, activeRaw }) {
    if (encumberedRaw + requested > liquidRaw) {
      throw new ConflictError(
        "AAC liquid does not cover the existing encumbrance plus this lock. Reduce the amount or wait for an exiting lock to release.",
        "locked_tier_insufficient_aac_liquid",
        {
          liquid: amount(liquidRaw),
          encumbered: amount(encumberedRaw),
          requested: amount(requested)
        }
      );
    }
    if (activeRaw + requested > this.config.perWalletCapRaw) {
      throw new ConflictError(
        `This lock would exceed the ${this.config.perWalletCapUsdc} USDC per-wallet locked-deposit cap. Reduce the amount or wait for an existing lock to release.`,
        "locked_tier_per_wallet_cap_exceeded",
        {
          active: amount(activeRaw),
          requested: amount(requested),
          cap: amount(this.config.perWalletCapRaw)
        }
      );
    }
  }

  #assertPoolCapacity({ requested, activeRaw, globalActiveRaw, pool }) {
    const globalCapRaw = minRaw(this.config.cohortCapRaw, pool.globalHeadroomRaw);
    if (globalActiveRaw + requested > globalCapRaw) {
      throw new ConflictError(
        "The existing pool cap has no room for this locked deposit. Retry after pool capacity is released.",
        "locked_tier_cohort_cap_exceeded"
      );
    }
    if (activeRaw + requested > pool.perAgentHeadroomRaw) {
      throw new ConflictError(
        "The existing pool per-agent cap has no room for this locked deposit. Reduce the amount or withdraw pool principal first.",
        "locked_tier_pool_per_agent_cap_exceeded"
      );
    }
  }

  #assertTermsBinding(wallet, terms) {
    const tier = normalizeTier(terms.tier);
    const issuedAt = Date.parse(terms.issuedAt);
    const quoteExpiresAt = Date.parse(terms.quoteExpiresAt);
    const asset = getAddress(terms.asset);
    if (
      getAddress(terms.wallet) !== wallet
      || asset === "0x0000000000000000000000000000000000000000"
      || terms.assetSymbol !== "USDC"
      || Number(terms.assetDecimals) !== ASSET_DECIMALS
      || exactPositiveRaw(terms.amountRaw, "terms.amountRaw") <= 0n
      || Number(terms.termDays) !== TIERS[tier].termDays
      || terms.forfeitTermsHash !== LOCKED_TIER_FORFEIT_TERMS_HASH
      || terms.earlyExitTerms !== LOCKED_TIER_EARLY_EXIT_TERMS
      || terms.riskSentence !== LOCKED_TIER_RISK_SENTENCE
      || (tier !== "t90" && terms.publicProfileOptIn === true)
      || !Number.isFinite(issuedAt)
      || !Number.isFinite(quoteExpiresAt)
      || quoteExpiresAt - issuedAt !== QUOTE_TTL_MS
      || consentNonceValue(terms.consentNonce) !== terms.consentNonce
    ) {
      throw new ConflictError(
        "The signed locked-deposit terms are not bound to this wallet and the ratified tier schedule. Request a fresh quote.",
        "locked_tier_consent_binding_mismatch"
      );
    }
  }

  async #consentCoversEntry(entry) {
    const consent = await this.stateStore.getContent(entry.consentRef);
    if (!consent || consent.kind !== "locked_tier_consent_v1") return false;
    const termsHash = hashLockedTierTerms(consent.terms);
    if (
      consent.termsHash !== entry.consentRef
      || termsHash !== entry.consentRef
      || String(consent.wallet).toLowerCase() !== entry.wallet
      || consent.terms.tier !== entry.tier
      || String(consent.terms.amountRaw) !== String(entry.amountRaw)
      || Number(consent.terms.termDays) !== Number(entry.termDays)
      || consent.terms.forfeitTermsHash !== LOCKED_TIER_FORFEIT_TERMS_HASH
      || consent.terms.earlyExitTerms !== LOCKED_TIER_EARLY_EXIT_TERMS
    ) return false;
    const expectedMessage = this.#consentMessage(consent.terms, termsHash);
    if (expectedMessage !== consent.consentMessage) return false;
    return getAddress(verifyMessage(expectedMessage, consent.consentSignature)).toLowerCase()
      === entry.wallet;
  }

  #consentMessage(terms, termsHash) {
    return buildSiweMessage({
      domain: this.siweDomain,
      address: terms.wallet,
      statement: `Authorize Averray locked deposit terms ${termsHash}. Terms JSON: ${canonicalizeContent(terms)}`,
      uri: this.consentUri,
      chainId: this.chainId,
      nonce: terms.consentNonce,
      issuedAt: terms.issuedAt,
      expirationTime: terms.quoteExpiresAt
    });
  }

  #assertNewLocksEnabled() {
    if (!this.config.enabled) {
      throw new ConflictError(
        "Locked deposits are flag-off. Existing locks remain honored; wait for the separately gated T30 rollout before requesting a new quote.",
        "locked_tiers_disabled"
      );
    }
  }
}

function isCreditPositionReadable(credit) {
  return credit?.available !== false || credit?.reason === "credit_pool_not_configured";
}

export function hashLockedTierTerms(terms) {
  return keccak256(toUtf8Bytes(canonicalizeContent(terms))).toLowerCase();
}

function tierTerms(tier) {
  const definition = TIERS[tier];
  return {
    tier,
    product: "locked deposit",
    termDays: definition.termDays,
    priorityRank: definition.priorityRank,
    perks: tier === "t90"
      ? ["top priority", "committed depositor flag with explicit opt-in"]
      : ["priority above Flex"],
    yield: "pro-rata NAV share only when the automatic activation gate is open",
    earlyExit: LOCKED_TIER_EARLY_EXIT_TERMS
  };
}

function poolSnapshot(poolInfo, wallet) {
  if (!poolInfo?.available || !poolInfo?.sharePrice || !poolInfo?.caps || !poolInfo?.wallet) {
    throw new ConflictError(
      "Current pool NAV and cap headroom could not be proven. No quote or lock was created; retry after the pool read recovers.",
      "locked_tier_nav_unavailable"
    );
  }
  if (String(poolInfo.wallet.address).toLowerCase() !== wallet.toLowerCase()) {
    throw new ConflictError(
      "The pool NAV snapshot belongs to a different wallet. Request a fresh authenticated quote.",
      "locked_tier_nav_wallet_mismatch"
    );
  }
  const globalHeadroomRaw = nonNegativeRaw(poolInfo.caps.poolHeadroom?.raw);
  const perAgentHeadroomRaw = nonNegativeRaw(poolInfo.wallet.perAgentHeadroom?.raw);
  return {
    globalHeadroomRaw,
    perAgentHeadroomRaw,
    nav: {
      block: poolInfo.block,
      asset: poolInfo.asset,
      totalAssets: poolInfo.totalAssets,
      totalShares: poolInfo.totalShares,
      sharePrice: poolInfo.sharePrice
    }
  };
}

function parseBoolean(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError(`${name} must be true or false.`);
}

function parsePositiveUsdc(value, name) {
  try {
    const raw = decimalToBaseUnits(String(value).trim(), ASSET_DECIMALS, name);
    if (raw <= 0n) throw new Error(`${name} must be greater than zero.`);
    return raw;
  } catch (error) {
    throw new ConfigError(error?.message ?? `${name} must be a positive USDC amount.`);
  }
}

function parseNonNegativeInteger(value, name) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/u.test(raw)) {
    throw new ConfigError(`${name} must be a non-negative integer number of milliseconds.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigError(`${name} must be a safe non-negative integer number of milliseconds.`);
  }
  return parsed;
}

function normalizeTier(value) {
  const tier = String(value ?? "").trim().toLowerCase();
  if (!TIERS[tier]) {
    throw new ValidationError("tier must be t30 or t90.", { field: "tier", requestedValue: value });
  }
  return tier;
}

function normalizeWalletAddress(value) {
  return getAddress(String(value ?? "").toLowerCase());
}

function consentNonceValue(value) {
  const nonce = String(value ?? "").trim();
  if (!/^[A-Za-z0-9]{8,128}$/u.test(nonce)) {
    throw new ValidationError(
      "consentNonce must be an opaque 8-128 character alphanumeric nonce.",
      { field: "consentNonce" }
    );
  }
  return nonce;
}

function exactPositiveRaw(value, field) {
  const raw = String(value ?? "").trim();
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new ValidationError(`${field} must be a positive exact base-unit integer string.`, { field });
  }
  return BigInt(raw);
}

function bytes32(value, field) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(raw)) {
    throw new ValidationError(`${field} must be bytes32 hex.`, { field });
  }
  return raw;
}

function signatureValue(value, field) {
  const raw = String(value ?? "").trim();
  if (!/^0x[0-9a-fA-F]{130}$/u.test(raw)) {
    throw new ValidationError(`${field} must be a 65-byte hex signature.`, { field });
  }
  return raw;
}

function nonNegativeRaw(value) {
  try {
    const parsed = BigInt(value ?? 0);
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

function sumActive(entries) {
  return entries
    .filter((entry) => entry.status === "active")
    .reduce((sum, entry) => sum + nonNegativeRaw(entry.amountRaw), 0n);
}

function sumEncumbered(entries) {
  return entries
    .filter(isEncumbered)
    .reduce((sum, entry) => sum + nonNegativeRaw(entry.amountRaw), 0n);
}

function entriesForWallet(entries, wallet) {
  const normalized = wallet.toLowerCase();
  return entries.filter((entry) => String(entry.wallet).toLowerCase() === normalized);
}

function isEncumbered(entry) {
  return entry.status === "active" || entry.status === "exiting";
}

function compareTierDescending(left, right) {
  return (TIERS[right.tier]?.priorityRank ?? 0) - (TIERS[left.tier]?.priorityRank ?? 0);
}

function amount(raw) {
  return { raw: BigInt(raw).toString(), decimals: ASSET_DECIMALS };
}

function clampAtZero(value) {
  return value > 0n ? value : 0n;
}

function minRaw(left, right) {
  return left < right ? left : right;
}

function assertOnlyFields(input, allowed) {
  for (const key of Object.keys(input ?? {})) {
    if (!allowed.has(key)) throw new ValidationError(`Unsupported field '${key}'.`, { field: key });
  }
}
