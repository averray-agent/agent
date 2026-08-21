import { ConflictError } from "./errors.js";
import { nextLockedTier } from "./job-catalog-gates.js";

export const DEFAULT_CREDIT_INTEREST_SETTLED_JOBS = 3;
export const CREDIT_INTEREST_STATEMENT =
  "Proven workers can register interest in a small zero-interest cash line (pilot).";
export const CREDIT_INTEREST_CANNOT_AUTHORIZE_ORIGINATION =
  "credit_interest_cannot_authorize_origination";

const USDC_DECIMALS = 6n;
const USDC_SCALE = 10n ** USDC_DECIMALS;

/**
 * One server-side retention read model. Settlement, session status, and
 * eligibility narration all consume this object instead of rebuilding tiers,
 * badges, or capital-backed caps independently.
 */
export class WorkerProgressionService {
  constructor({
    stateStore,
    getReputation,
    workerExposurePolicy,
    workerDailyExposurePolicy,
    selfIdentityRegistry,
    creditInterestSettledJobs = DEFAULT_CREDIT_INTEREST_SETTLED_JOBS,
    publicBaseUrl = undefined,
    now = () => new Date()
  } = {}) {
    this.stateStore = stateStore;
    this.getReputation = getReputation;
    this.workerExposurePolicy = workerExposurePolicy;
    this.workerDailyExposurePolicy = workerDailyExposurePolicy;
    this.selfIdentityRegistry = selfIdentityRegistry;
    this.creditInterestSettledJobs = positiveInteger(
      creditInterestSettledJobs,
      "credit interest settled-job threshold"
    );
    this.publicBaseUrl = publicBaseUrl;
    this.now = now;
  }

  async getProgression(wallet, {
    settlementSessionId = undefined,
    previousProgression = undefined
  } = {}) {
    const normalizedWallet = normalizeWallet(wallet);
    const allSessions = await collectAllWalletSessions(this.stateStore, normalizedWallet);
    const sessions = allSessions.filter((session) => !this.isSyntheticSession(normalizedWallet, session));
    if (this.isSyntheticWallet(normalizedWallet, allSessions, sessions)) return undefined;

    const [reputation, capacity, registration] = await Promise.all([
      this.getReputation(normalizedWallet),
      this.workerExposurePolicy.capacityForWallet(normalizedWallet),
      this.stateStore.getCreditInterestRegistration?.(normalizedWallet)
    ]);
    const daily = this.workerDailyExposurePolicy.progressionConfig();
    const approved = approvedSettlements(sessions);
    const progression = this.buildProgression({
      normalizedWallet,
      sessions,
      approved,
      reputation,
      capacity,
      daily,
      registration
    });
    progression.justChanged = this.justChanged({
      progression,
      approved,
      sessions,
      settlementSessionId,
      previousProgression,
      daily
    });
    return progression;
  }

  async registerCreditInterest(wallet) {
    const normalizedWallet = normalizeWallet(wallet);
    const progression = await this.getProgression(normalizedWallet);
    if (!progression) {
      throw new ConflictError(
        "Synthetic and canary identities cannot register credit interest.",
        "credit_interest_synthetic_identity_excluded"
      );
    }
    const existing = await this.stateStore.getCreditInterestRegistration?.(normalizedWallet);
    if (existing) return existing;
    if (progression.creditInterest.eligible !== true) {
      throw new ConflictError(
        "Credit-interest registration requires the configured number of settled, verified jobs.",
        "credit_interest_eligibility_not_met"
      );
    }
    const record = {
      wallet: normalizedWallet,
      registeredAt: asIso(this.now()),
      source: "worker_opt_in",
      status: "interested"
    };
    return this.stateStore.putCreditInterestRegistration(normalizedWallet, record);
  }

  async listCreditInterestRegistrations(options = {}) {
    return this.stateStore.listCreditInterestRegistrations?.(options) ?? [];
  }

  buildProgression({ normalizedWallet, sessions, approved, reputation, capacity, daily, registration }) {
    const settledCatalogueJobs = approved.filter((session) => !isExternallyPosted(session)).length;
    const rollingActive = settledCatalogueJobs >= daily.graduationSettledJobs;
    const tier = normalizeTier(reputation?.tier, reputation?.skill);
    const badges = approved
      .slice()
      .sort((left, right) => timestampOf(right) - timestampOf(left))
      .map((session) => badgeSummary(session, this.publicBaseUrl));
    const perJobMax = cap({
      raw: capacity.externalRewardCeilingRaw,
      amount: capacity.externalRewardCeilingUsdc,
      source: "capital_backed_external_reward_ceiling",
      components: {
        base: capComponent(capacity.externalRewardCeilingBaseRaw, capacity.externalRewardCeilingBaseUsdc),
        deposit: capComponent(capacity.externalRewardCeilingRaiseRaw, capacity.externalRewardCeilingRaiseUsdc)
      }
    });
    const concurrent = cap({
      raw: capacity.openExposureCapRaw,
      amount: capacity.openExposureCapUsdc,
      source: "worker_open_operator_exposure",
      components: {
        base: capComponent(capacity.baseOpenExposureCapRaw, capacity.baseOpenExposureCapUsdc),
        deposit: capComponent(capacity.openExposureRaiseRaw, capacity.openExposureRaiseUsdc)
      }
    });
    const rolling24h = {
      ...cap({
        raw: daily.rolling24hRaw,
        amount: daily.rolling24hUsdc,
        source: "settled_completion_rolling_budget"
      }),
      active: rollingActive,
      settledJobs: settledCatalogueJobs,
      activatesAtSettledJobs: daily.graduationSettledJobs
    };
    const raises = buildRaises({ tier, reputation, capacity, daily, settledCatalogueJobs });
    return {
      tier,
      badges,
      effectiveCaps: { perJobMax, rolling24h, concurrent },
      justChanged: null,
      raises,
      creditInterest: {
        eligible: approved.length >= this.creditInterestSettledJobs,
        registered: Boolean(registration)
      }
    };
  }

  justChanged({ progression, approved, sessions, settlementSessionId, previousProgression, daily }) {
    if (!settlementSessionId) return null;
    const settled = sessions.find((session) => session.sessionId === settlementSessionId);
    if (!settled || !isApprovedSettlement(settled)) return null;
    if (previousProgression?.tier && previousProgression.tier !== progression.tier) {
      return { field: "tier", from: previousProgression.tier, to: progression.tier };
    }
    const settledAt = timestampOf(settled);
    const approvedThroughSettlement = approved.filter((session) => (
      timestampOf(session) < settledAt
      || (timestampOf(session) === settledAt && session.sessionId === settlementSessionId)
    ));
    const approvedBefore = approvedThroughSettlement.filter(
      (session) => session.sessionId !== settlementSessionId
    );
    const catalogueBefore = approvedBefore.filter((session) => !isExternallyPosted(session)).length;
    const catalogueAfter = approvedThroughSettlement
      .filter((session) => !isExternallyPosted(session)).length;
    if (catalogueBefore < daily.graduationSettledJobs
      && catalogueAfter >= daily.graduationSettledJobs) {
      return {
        field: "effectiveCaps.rolling24h",
        from: null,
        to: progression.effectiveCaps.rolling24h
      };
    }
    if (approvedBefore.length < this.creditInterestSettledJobs
      && approvedThroughSettlement.length >= this.creditInterestSettledJobs) {
      return { field: "creditInterest.eligible", from: false, to: true };
    }
    return null;
  }

  isSyntheticSession(wallet, session) {
    return this.selfIdentityRegistry?.isSelf?.({ wallet, session }) === true;
  }

  isSyntheticWallet(wallet, allSessions, externalSessions) {
    if (this.selfIdentityRegistry?.isSelf?.({ wallet }) === true) return true;
    return allSessions.length > 0 && externalSessions.length === 0;
  }
}

export function buildEligibilityProgression({ preflight, progression }) {
  if (!progression) return {};
  const external = preflight?.workerExposure?.consumesOperatorExposure === false;
  let currentCap;
  let gate;
  if (external) {
    currentCap = progression.effectiveCaps.perJobMax;
    gate = "capital_backed_external_reward_ceiling";
  } else if (preflight?.workerExposure?.eligible === false) {
    currentCap = progression.effectiveCaps.concurrent;
    gate = "worker_open_operator_exposure";
  } else if (preflight?.dailyExposure?.catalogueAccess?.mode === "lifetime_credit") {
    currentCap = cap({
      raw: preflight.dailyExposure.catalogueAccess.lifetimeCreditRaw,
      amount: preflight.dailyExposure.catalogueAccess.lifetimeCredit,
      source: "finite_lifetime_catalogue_credit"
    });
    gate = "finite_lifetime_catalogue_credit";
  } else if (preflight?.dailyExposure) {
    currentCap = progression.effectiveCaps.rolling24h;
    gate = "settled_completion_rolling_budget";
  } else {
    currentCap = progression.effectiveCaps.concurrent;
    gate = "worker_open_operator_exposure";
  }
  return {
    currentCap,
    capSource: {
      gate,
      tier: progression.tier,
      deposit: {
        vestedRaw: preflight?.workerExposure?.vestedAssetsRaw ?? "0",
        perJobRaiseRaw: progression.effectiveCaps.perJobMax.components?.deposit?.raw ?? "0",
        concurrentRaiseRaw: progression.effectiveCaps.concurrent.components?.deposit?.raw ?? "0"
      }
    },
    nextRaise: progression.raises.find((raise) => (
      gate === "capital_backed_external_reward_ceiling"
      || gate === "worker_open_operator_exposure"
        ? raise.action === "deposit"
        : raise.action === "keep_completing"
    )) ?? null
  };
}

/**
 * Source-level architectural tripwire used by the mutation drill. Interest is
 * an observability/opt-in record; any origination module that reads it has
 * silently turned a non-promise into underwriting authority.
 */
export function assertCreditInterestIsolatedFromOrigination(source) {
  if (/credit[-_]?interest|creditInterest/iu.test(String(source ?? ""))) {
    throw new ConflictError(
      "Credit-interest registration cannot authorize or approve origination.",
      CREDIT_INTEREST_CANNOT_AUTHORIZE_ORIGINATION
    );
  }
  return true;
}

function buildRaises({ tier, reputation, capacity, daily, settledCatalogueJobs }) {
  const raises = [];
  const nextTier = nextLockedTier(reputation);
  if (nextTier) {
    raises.push({
      action: "keep_completing",
      effect: `Keep completing verified work to reach ${nextTier.tier} at ${nextTier.requires.skill} skill and unlock ${nextTier.tier}-tier claims.`
    });
  } else if (settledCatalogueJobs < daily.graduationSettledJobs) {
    raises.push({
      action: "keep_completing",
      effect: `Settle ${daily.graduationSettledJobs - settledCatalogueJobs} more verified catalogue jobs to enter the rolling 24-hour allowance.`
    });
  }
  const requiredRaw = asRaw(capacity.nextConcurrentRaiseAmountRaw);
  if (requiredRaw > 0n) {
    raises.push({
      action: "deposit",
      effect: `Let ${displayRaw(requiredRaw)} USDC vest for ${Number(capacity.vestingHours)} hours to raise the concurrent cap to ${displayRaw(capacity.nextConcurrentOpenExposureCapRaw)} USDC and the external per-job max to ${displayRaw(capacity.nextConcurrentExternalRewardCeilingRaw)} USDC.`
    });
  }
  return raises;
}

function badgeSummary(session, publicBaseUrl) {
  const snapshot = session.badgeSnapshot ?? session.jobSnapshot?.definition ?? {};
  return {
    sessionId: session.sessionId,
    jobId: session.jobId,
    category: String(snapshot.category ?? "unknown").trim().toLowerCase(),
    level: Number.isInteger(snapshot.level) && snapshot.level > 0
      ? snapshot.level
      : snapshot.payoutMode === "milestone" ? 2 : 1,
    ...(publicBaseUrl
      ? { badgeUrl: `${String(publicBaseUrl).replace(/\/+$/u, "")}/badges/${encodeURIComponent(session.sessionId)}` }
      : {})
  };
}

function approvedSettlements(sessions) {
  return sessions.filter(isApprovedSettlement);
}

function isApprovedSettlement(session) {
  return session?.status === "resolved"
    && (session?.verificationSummary?.outcome === "approved"
      || session?.verification?.outcome === "approved");
}

function isExternallyPosted(session) {
  const definition = session?.jobSnapshot?.definition;
  return definition?.source === "external"
    || definition?.source?.type === "external"
    || definition?.sourceType === "external";
}

function cap({ raw, amount, source, components = undefined }) {
  return {
    asset: "USDC",
    raw: asRaw(raw).toString(),
    amount: Number(amount),
    source,
    ...(components ? { components } : {})
  };
}

function capComponent(raw, amount) {
  return { raw: asRaw(raw).toString(), amount: Number(amount) };
}

async function collectAllWalletSessions(stateStore, wallet, { pageSize = 64, maxSessions = 10_000 } = {}) {
  const sessions = [];
  for (let offset = 0; offset < maxSessions; offset += pageSize) {
    const page = await stateStore.listSessionsByWallet(wallet, pageSize, offset);
    if (!Array.isArray(page) || page.length === 0) break;
    sessions.push(...page);
    if (page.length < pageSize) break;
  }
  if (sessions.length >= maxSessions) throw new Error("Worker progression session history exceeded its read cap.");
  return sessions;
}

function normalizeTier(tier, skill) {
  if (tier === "starter" || tier === "pro" || tier === "elite") return tier;
  if (Number(skill) >= 200) return "elite";
  if (Number(skill) >= 100) return "pro";
  return "starter";
}

function normalizeWallet(wallet) {
  const normalized = String(wallet ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/u.test(normalized)) throw new TypeError("worker progression wallet must be an EVM address");
  return normalized;
}

function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${field} must be a positive integer`);
  return parsed;
}

function asRaw(value) {
  const raw = BigInt(value ?? 0);
  if (raw < 0n) throw new TypeError("progression raw values must be non-negative");
  return raw;
}

function displayRaw(value) {
  const raw = asRaw(value);
  const whole = raw / USDC_SCALE;
  const fraction = (raw % USDC_SCALE).toString().padStart(Number(USDC_DECIMALS), "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function timestampOf(session) {
  const value = Date.parse(session?.resolvedAt ?? session?.updatedAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("progression clock must return a valid date");
  return date.toISOString();
}
