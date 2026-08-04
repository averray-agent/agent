import { readFileSync } from "node:fs";

import { disputeIdForSession } from "./dispute-resolution.js";
import { resolveOnboardingInventoryHealth } from "./onboarding-inventory.js";

/**
 * /health truth split — Package B (P1.1b) close.
 *
 * The legacy `/health` shape collapsed "is the API process responding?"
 * (a service-liveness question) with "can you actually mutate treasury?"
 * (a capability question). The blockchain gateway's `healthCheck()`
 * returns `ok: true` even when disabled, so the legacy `status: "ok"`
 * stayed green during misconfigurations that broke real treasury — the
 * exact failure shape the audit board flags as launch-blocking.
 *
 * This module splits the response into:
 *
 *   serviceHealth      — "is the API process up?" Reflects the
 *                        state-store, auth config, and basic runtime.
 *                        HTTP 200 + status "ok" follow this signal
 *                        ALONE; uptime monitors that page on 503 only
 *                        fire when the API itself is degraded.
 *
 *   capabilityHealth   — "what can you actually do right now?"
 *                        Per-capability enum:
 *                          blockchain: enabled | disabled | unhealthy
 *                          treasuryMutations: available | unavailable | degraded
 *                          xcmObserver: live | staged | unavailable
 *                          indexer: synced | lagging | unavailable
 *                          gasSponsor: enabled | disabled
 *                        Monitoring dashboards read this to surface
 *                        treasury / XCM / indexer warnings without
 *                        flipping the overall 503.
 *
 * The legacy top-level `components` and `auth` keys are preserved so
 * existing dashboards / probes that read `components.blockchain.ok`
 * continue working. This is a purely additive correctness fix.
 */

export const BLOCKCHAIN_STATUS = Object.freeze({
  ENABLED: "enabled",
  DISABLED: "disabled",
  UNHEALTHY: "unhealthy"
});

export const TREASURY_MUTATIONS_STATUS = Object.freeze({
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
  DEGRADED: "degraded"
});

export const XCM_OBSERVER_STATUS = Object.freeze({
  LIVE: "live",
  STAGED: "staged",
  UNAVAILABLE: "unavailable"
});

export const INDEXER_STATUS = Object.freeze({
  SYNCED: "synced",
  LAGGING: "lagging",
  UNAVAILABLE: "unavailable"
});

export const GAS_SPONSOR_STATUS = Object.freeze({
  ENABLED: "enabled",
  DISABLED: "disabled"
});

export const EXTERNAL_POSTING_STATUS = Object.freeze({
  ENABLED: "enabled",
  STAGED: "staged",
  DISABLED: "disabled"
});

const DEFAULT_PRODUCT_HEALTH_CACHE_MS = 60_000;
const DEFAULT_LIVE_HEALTH_REFRESH_MS = 15_000;
const DEFAULT_LIVE_HEALTH_MAX_AGE_MS = 60_000;
const DEFAULT_REWARD_BANK_REFRESH_MS = 15_000;
const DEFAULT_REWARD_BANK_MAX_AGE_MS = 60_000;
const DEFAULT_SETTLEMENT_SESSION_LIMIT = 1_000;
const DEFAULT_SETTLEMENT_STUCK_AFTER_MS = 30 * 60 * 1000;
const DEFAULT_REWARD_BANK_DECIMALS = 6;
const SETTLED_SESSION_STATUSES = new Set(["resolved", "rejected", "closed"]);
const SUBMITTED_NOT_SETTLED_SESSION_STATUSES = new Set(["submitted", "disputed"]);
const EXECUTION_FAILURE_CODES = new Set([
  "blockchain_revert",
  "mutation_receipt_error",
  "tx_reverted",
  "transaction_reverted",
  "settlement_failed"
]);
const TESTNET_DEPLOYMENT_MANIFEST_URL = new URL("../../../deployments/testnet.json", import.meta.url);

let deploymentManifestCache;

/**
 * Compute `serviceHealth` from process-local liveness signals.
 *
 *   - `stateStoreHealth.ok === true` → state store reachable.
 *   - `authConfig` present + the active JWT backend configured (strict)
 *     OR permissive mode → auth dependencies loaded.
 *
 * The `ok` field is the AND of every component; anything false flips
 * the overall HTTP status code to 503 because the API process itself
 * cannot serve a request reliably.
 */
export function resolveServiceHealth({ stateStoreHealth, authConfig }) {
  const stateStoreOk = Boolean(stateStoreHealth?.ok);
  const jwtBackend = authConfig?.jwtBackend ?? "hmac";
  const hmacConfigured = Array.isArray(authConfig?.secrets) && authConfig.secrets.length > 0;
  const kmsConfigured = Boolean(authConfig?.kmsJwt);
  const strictAuthOk = jwtBackend === "hmac"
    ? hmacConfigured
    : jwtBackend === "kms"
      ? kmsConfigured
      : jwtBackend === "both"
        ? hmacConfigured && kmsConfigured
        : false;
  const authOk = authConfig?.mode === "permissive"
    || (authConfig?.mode === "strict" && strictAuthOk);

  return {
    ok: stateStoreOk && authOk,
    components: {
      api: { ok: true, mode: "running" },
      stateStore: {
        ok: stateStoreOk,
        backend: stateStoreHealth?.backend ?? "unknown",
        mode: stateStoreHealth?.mode ?? "unknown"
      },
      auth: {
        ok: authOk,
        mode: authConfig?.mode ?? "unknown",
        domain: authConfig?.domain ?? "unknown",
        chainId: authConfig?.chainId
      }
    }
  };
}

/**
 * Compute `capabilityHealth` from external dependency probes.
 *
 * @param {object} options
 * @param {object} [options.blockchainHealth] — gateway.healthCheck()
 *   output. `enabled === false` → disabled. `ok === false` → unhealthy.
 *   Anything else → enabled.
 * @param {object} [options.mutationBackendStatus] — from
 *   `getMutationBackendStatus`. `ok: true` → available. `ok: false` →
 *   unavailable.
 * @param {object} [options.xcmWatcherStatus] — from
 *   `xcmSettlementWatcher.getStatus()`. Resolves: enabled+running with
 *   pendingCount > 0 → live; enabled+running with pendingCount === 0 →
 *   staged; else → unavailable.
 * @param {object} [options.indexerProbe] — optional `{ ok, blockNumber,
 *   blockTimestamp, lagBudgetSeconds }`. When omitted the indexer
 *   capability resolves to `unavailable` rather than asserting a state
 *   we can't prove.
 * @param {object} [options.gasSponsorHealth] — pimlico.healthCheck()
 *   output. `enabled === true` → enabled, else → disabled.
 */
export function resolveCapabilityHealth({
  blockchainHealth,
  mutationBackendStatus,
  xcmWatcherStatus,
  indexerProbe,
  gasSponsorHealth,
  externalPostingMode = "closed",
  externalPostingWatcherStatus
}) {
  return {
    blockchain: resolveBlockchainStatus(blockchainHealth),
    treasuryMutations: resolveTreasuryStatus(mutationBackendStatus),
    xcmObserver: resolveXcmObserverStatus(xcmWatcherStatus),
    indexer: resolveIndexerStatus(indexerProbe),
    gasSponsor: resolveGasSponsorStatus(gasSponsorHealth),
    externalPosting: resolveExternalPostingStatus(
      externalPostingMode,
      externalPostingWatcherStatus
    ),
    externalPostingWatcherLagSeconds: Number.isFinite(
      externalPostingWatcherStatus?.lagSeconds
    )
      ? Number(externalPostingWatcherStatus.lagSeconds)
      : null
  };
}

function resolveBlockchainStatus(health) {
  if (!health || health.enabled === false) {
    return BLOCKCHAIN_STATUS.DISABLED;
  }
  if (health.ok === false) {
    return BLOCKCHAIN_STATUS.UNHEALTHY;
  }
  return BLOCKCHAIN_STATUS.ENABLED;
}

function resolveTreasuryStatus(status) {
  if (!status) {
    return TREASURY_MUTATIONS_STATUS.UNAVAILABLE;
  }
  if (status.ok === true) {
    return TREASURY_MUTATIONS_STATUS.AVAILABLE;
  }
  return TREASURY_MUTATIONS_STATUS.UNAVAILABLE;
}

function resolveXcmObserverStatus(status) {
  if (!status || status.enabled !== true || status.running !== true) {
    return XCM_OBSERVER_STATUS.UNAVAILABLE;
  }
  if (Number(status.pendingCount ?? 0) > 0) {
    return XCM_OBSERVER_STATUS.LIVE;
  }
  return XCM_OBSERVER_STATUS.STAGED;
}

function resolveIndexerStatus(probe) {
  if (!probe || probe.ok !== true) {
    return INDEXER_STATUS.UNAVAILABLE;
  }
  const lagBudget = Number.isFinite(probe.lagBudgetSeconds) ? probe.lagBudgetSeconds : 600;
  const headTs = Number(probe.blockTimestamp);
  if (!Number.isFinite(headTs)) {
    return INDEXER_STATUS.UNAVAILABLE;
  }
  const lagSeconds = Math.max(0, Math.floor(Date.now() / 1000) - headTs);
  return lagSeconds <= lagBudget ? INDEXER_STATUS.SYNCED : INDEXER_STATUS.LAGGING;
}

function resolveGasSponsorStatus(health) {
  return health?.enabled === true
    ? GAS_SPONSOR_STATUS.ENABLED
    : GAS_SPONSOR_STATUS.DISABLED;
}

function resolveExternalPostingStatus(mode, watcherStatus) {
  const normalizedMode = String(mode ?? "closed").trim().toLowerCase();
  if (normalizedMode === "closed") {
    return EXTERNAL_POSTING_STATUS.DISABLED;
  }
  return watcherStatus?.current === true
    ? EXTERNAL_POSTING_STATUS.ENABLED
    : EXTERNAL_POSTING_STATUS.STAGED;
}

/**
 * Translate a `capabilityHealth` block into an ordered list of structured
 * warning entries. Each warning has a stable `code` so operator dashboards
 * and CLI smoke checks can match on it without parsing prose. Severity is
 * `critical` only for capabilities that block real treasury action; the
 * rest are `warning` so an XCM observer that is staged on a trust-core
 * launch does not page the on-call.
 *
 * The shape is deliberately additive: capabilities in their happy state
 * (blockchain enabled, treasury available, xcm live, indexer synced, gas
 * sponsor enabled) produce no entry. Operator app code can render the
 * array as-is or pick out a single capability by `code` prefix.
 */
export function buildCapabilityWarnings(capabilityHealth) {
  if (!capabilityHealth) return [];
  const warnings = [];

  if (capabilityHealth.blockchain !== BLOCKCHAIN_STATUS.ENABLED) {
    warnings.push({
      code: `blockchain_${capabilityHealth.blockchain}`,
      severity: capabilityHealth.blockchain === BLOCKCHAIN_STATUS.UNHEALTHY ? "critical" : "warning",
      message: `Blockchain capability is ${capabilityHealth.blockchain}.`
    });
  }

  if (capabilityHealth.treasuryMutations !== TREASURY_MUTATIONS_STATUS.AVAILABLE) {
    warnings.push({
      code: `treasury_mutations_${capabilityHealth.treasuryMutations}`,
      severity: capabilityHealth.treasuryMutations === TREASURY_MUTATIONS_STATUS.UNAVAILABLE
        ? "critical"
        : "warning",
      message: `Treasury mutations are ${capabilityHealth.treasuryMutations}.`
    });
  }

  if (capabilityHealth.xcmObserver !== XCM_OBSERVER_STATUS.LIVE) {
    warnings.push({
      code: `xcm_observer_${capabilityHealth.xcmObserver}`,
      severity: "warning",
      message: `XCM observer is ${capabilityHealth.xcmObserver}.`
    });
  }

  if (capabilityHealth.indexer !== INDEXER_STATUS.SYNCED) {
    warnings.push({
      code: `indexer_${capabilityHealth.indexer}`,
      severity: "warning",
      message: `Indexer capability is ${capabilityHealth.indexer}.`
    });
  }

  if (capabilityHealth.gasSponsor && capabilityHealth.gasSponsor !== GAS_SPONSOR_STATUS.ENABLED) {
    warnings.push({
      code: `gas_sponsor_${capabilityHealth.gasSponsor}`,
      severity: "warning",
      message: `Gas sponsor capability is ${capabilityHealth.gasSponsor}.`
    });
  }

  if (capabilityHealth.externalPosting === EXTERNAL_POSTING_STATUS.STAGED) {
    warnings.push({
      code: "external_posting_staged",
      severity: "warning",
      message: "External posting is staged because its finalized-event watcher is not current."
    });
  }

  return warnings;
}

export function createProductHealthSnapshotProvider({
  gateway,
  service,
  stateStore,
  env = process.env,
  deploymentManifest = undefined,
  getRewardBankHealth = undefined,
  now = () => new Date(),
  cacheMs = DEFAULT_PRODUCT_HEALTH_CACHE_MS,
  settlementSessionLimit = DEFAULT_SETTLEMENT_SESSION_LIMIT,
  settlementStuckAfterMs = DEFAULT_SETTLEMENT_STUCK_AFTER_MS
} = {}) {
  let cached;
  let refreshPromise;
  const rewardBankHealthProvider = getRewardBankHealth ?? createRewardBankHealthProvider({
    gateway,
    env,
    deploymentManifest,
    now
  });

  return async function getProductHealthSnapshot() {
    const currentTime = now();
    const nowMs = currentTime.getTime();
    // Reward-bank health has its own short-TTL cache. Always overlay its latest
    // non-blocking value so a cold product snapshot cannot pin "unreadable" for
    // the full settlement/session cache window.
    const rewardBank = await rewardBankHealthProvider();
    if (cached && cached.expiresAtMs > nowMs) {
      return { ...cached.value, rewardBank };
    }
    if (refreshPromise) {
      return refreshPromise.then((value) => ({ ...value, rewardBank }));
    }

    refreshPromise = buildProductHealthSnapshot({
      gateway,
      service,
      stateStore,
      env,
      deploymentManifest,
      getRewardBankHealth: () => rewardBank,
      now: currentTime,
      settlementSessionLimit,
      settlementStuckAfterMs
    })
      .then((value) => {
        cached = {
          expiresAtMs: nowMs + Math.max(0, cacheMs),
          value
        };
        return value;
      })
      .finally(() => {
        refreshPromise = undefined;
      });

    return refreshPromise;
  };
}

/**
 * Cache a live health read using stale-while-revalidate semantics.
 *
 * The getter never awaits `read`: it returns the latest bounded reading and
 * starts refresh work in the background. Fresh failed reads reuse a
 * last-known-good value; once maxAgeMs is exceeded the value remains visible
 * with its original asOf but is marked stale/unreadable so truth consumers do
 * not mistake old evidence for current proof.
 */
function createNonBlockingCachedHealthProvider({
  read,
  initialValue,
  isUsable,
  now = () => new Date(),
  refreshMs = DEFAULT_LIVE_HEALTH_REFRESH_MS,
  maxAgeMs = DEFAULT_LIVE_HEALTH_MAX_AGE_MS
}) {
  const initialTime = now();
  let cached = stampHealthReading(initialValue, initialTime);
  let lastKnownGood = isUsable(cached) ? cached : undefined;
  let refreshPromise;
  let nextRefreshAtMs = 0;

  const getHealth = () => {
    const currentTime = now();
    const nowMs = currentTime.getTime();
    if (!refreshPromise && nowMs >= nextRefreshAtMs) {
      nextRefreshAtMs = nowMs + Math.max(0, refreshMs);
      const refreshAttemptedAt = currentTime.toISOString();
      refreshPromise = Promise.resolve()
        .then(() => read())
        .then((value) => {
          const completedAt = now();
          const reading = stampHealthReading(value, completedAt);
          if (isUsable(reading)) {
            cached = reading;
            lastKnownGood = reading;
            return;
          }
          if (lastKnownGood) {
            cached = failedHealthRefreshFallback({
              lastKnownGood,
              nowMs: completedAt.getTime(),
              maxAgeMs,
              refreshAttemptedAt,
              refreshError: healthReadingError(reading)
            });
            return;
          }
          cached = {
            ...reading,
            stale: true,
            ...(lastKnownGood?.asOf ? { lastKnownGoodAsOf: lastKnownGood.asOf } : {})
          };
        })
        .catch((error) => {
          const completedAt = now();
          if (lastKnownGood) {
            cached = failedHealthRefreshFallback({
              lastKnownGood,
              nowMs: completedAt.getTime(),
              maxAgeMs,
              refreshAttemptedAt,
              refreshError: error?.code ?? "read_failed"
            });
            return;
          }
          cached = {
            ...cached,
            stale: true,
            refreshAttemptedAt,
            refreshError: error?.code ?? "read_failed",
            ...(lastKnownGood?.asOf ? { lastKnownGoodAsOf: lastKnownGood.asOf } : {})
          };
        })
        .finally(() => {
          refreshPromise = undefined;
        });
    }

    const projected = { ...cached };
    if (healthReadingAgeMs(projected, nowMs) > Math.max(0, maxAgeMs)) {
      projected.stale = true;
      if (Object.hasOwn(projected, "ok")) projected.ok = false;
      if (Object.hasOwn(projected, "readable")) projected.readable = false;
      if (lastKnownGood?.asOf) projected.lastKnownGoodAsOf = lastKnownGood.asOf;
    }
    if (refreshPromise) projected.refreshing = true;
    return projected;
  };

  // Warm once when the route graph is built. This is fire-and-forget: a
  // blackholed dependency stays in the background, while a fast dependency is
  // usually cached before the first external health request arrives.
  getHealth();
  return getHealth;
}

export function createNonBlockingBlockchainHealthProvider({
  gateway,
  now,
  refreshMs,
  maxAgeMs
} = {}) {
  const enabled = Boolean(gateway?.isEnabled?.());
  return createNonBlockingCachedHealthProvider({
    read: async () => gateway?.healthCheck?.() ?? {
      ok: false,
      backend: "blockchain",
      enabled,
      error: "health_check_unavailable"
    },
    initialValue: enabled
      ? {
          ok: false,
          backend: "blockchain",
          enabled: true,
          readable: false,
          source: "health_cache_cold"
        }
      : {
          ok: true,
          backend: "blockchain",
          enabled: false,
          mode: "disabled",
          readable: true,
          source: "configuration"
        },
    isUsable: (reading) => reading?.ok === true,
    now,
    refreshMs,
    maxAgeMs
  });
}

export function createNonBlockingRewardBankHealthProvider({
  getRewardBankHealth,
  now,
  refreshMs,
  maxAgeMs
} = {}) {
  return createNonBlockingCachedHealthProvider({
    read: async () => getRewardBankHealth?.() ?? {
      liquid: null,
      liquidRaw: null,
      decimals: DEFAULT_REWARD_BANK_DECIMALS,
      readable: false,
      source: "reward_bank_reader_unavailable"
    },
    initialValue: {
      liquid: null,
      liquidRaw: null,
      decimals: DEFAULT_REWARD_BANK_DECIMALS,
      readable: false,
      source: "health_cache_cold"
    },
    isUsable: (reading) => reading?.readable === true && reading?.stale !== true,
    now,
    refreshMs,
    maxAgeMs
  });
}

function stampHealthReading(value, at) {
  const reading = value && typeof value === "object" ? value : {};
  return {
    ...reading,
    asOf: Number.isFinite(Date.parse(reading.asOf ?? ""))
      ? reading.asOf
      : at.toISOString()
  };
}

function healthReadingAgeMs(reading, nowMs) {
  const asOfMs = Date.parse(reading?.asOf ?? "");
  return Number.isFinite(asOfMs)
    ? Math.max(0, nowMs - asOfMs)
    : Number.POSITIVE_INFINITY;
}

function healthReadingError(reading) {
  return reading?.error ?? (reading?.ok === false ? "health_check_failed" : "read_failed");
}

function failedHealthRefreshFallback({
  lastKnownGood,
  nowMs,
  maxAgeMs,
  refreshAttemptedAt,
  refreshError
}) {
  const fallback = {
    ...lastKnownGood,
    fallback: "last_known_good",
    refreshAttemptedAt,
    refreshError
  };
  if (healthReadingAgeMs(lastKnownGood, nowMs) <= Math.max(0, maxAgeMs)) {
    return fallback;
  }
  fallback.stale = true;
  fallback.lastKnownGoodAsOf = lastKnownGood.asOf;
  if (Object.hasOwn(fallback, "ok")) fallback.ok = false;
  if (Object.hasOwn(fallback, "readable")) fallback.readable = false;
  return fallback;
}

export async function buildProductHealthSnapshot({
  gateway,
  service,
  stateStore,
  env = process.env,
  deploymentManifest = undefined,
  getRewardBankHealth = undefined,
  now = new Date(),
  settlementSessionLimit = DEFAULT_SETTLEMENT_SESSION_LIMIT,
  settlementStuckAfterMs = DEFAULT_SETTLEMENT_STUCK_AFTER_MS
} = {}) {
  const manifest = deploymentManifest ?? loadTestnetDeploymentManifest();
  const addresses = resolveHealthAddresses({ deploymentManifest: manifest, env });
  const [rewardBank, settlement] = await Promise.all([
    getRewardBankHealth
      ? getRewardBankHealth()
      : resolveRewardBankHealth({ gateway, addresses, now }),
    resolveSettlementHealth({
      stateStore,
      now,
      limit: settlementSessionLimit,
      stuckAfterMs: settlementStuckAfterMs
    })
  ]);
  const onboarding = await resolveOnboardingInventoryHealth({
    service,
    rewardBank,
    now
  });

  return {
    addresses,
    rewardBank,
    settlement,
    ...(onboarding ? { onboarding } : {})
  };
}

/**
 * Shared reward-bank reader for /health and public claimability.
 *
 * The refresh window coalesces catalog reads into one chain request. A failed
 * refresh may reuse a last-known-good reading only while that reading remains
 * inside maxAgeMs; once it ages out, callers receive an explicit stale,
 * unreadable result and must stop advertising funding as verified.
 */
export function createRewardBankHealthProvider({
  gateway,
  env = process.env,
  deploymentManifest = undefined,
  now = () => new Date(),
  refreshMs = DEFAULT_REWARD_BANK_REFRESH_MS,
  maxAgeMs = DEFAULT_REWARD_BANK_MAX_AGE_MS
} = {}) {
  const manifest = deploymentManifest ?? loadTestnetDeploymentManifest();
  const addresses = resolveHealthAddresses({ deploymentManifest: manifest, env });
  let cached;
  let lastKnownGood;
  let refreshPromise;

  return async function getRewardBankHealth() {
    const currentTime = now();
    const nowMs = currentTime.getTime();
    if (
      cached
      && cached.expiresAtMs > nowMs
      && rewardBankReadingAgeMs(cached.value, nowMs) <= Math.max(0, maxAgeMs)
    ) {
      return cached.value;
    }
    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = resolveRewardBankHealth({ gateway, addresses, now: currentTime })
      .then((reading) => {
        let value = reading;
        if (reading.readable === true) {
          lastKnownGood = reading;
        } else if (
          lastKnownGood
          && rewardBankReadingAgeMs(lastKnownGood, nowMs) <= Math.max(0, maxAgeMs)
        ) {
          value = {
            ...lastKnownGood,
            fallback: "last_known_good",
            refreshAttemptedAt: reading.asOf,
            refreshError: reading.error ?? "read_failed"
          };
        } else {
          value = {
            ...reading,
            stale: true,
            ...(lastKnownGood?.asOf ? { lastKnownGoodAsOf: lastKnownGood.asOf } : {})
          };
        }

        const maxCacheExpiryMs = value.readable === true
          ? nowMs + Math.max(0, maxAgeMs - rewardBankReadingAgeMs(value, nowMs))
          : Number.POSITIVE_INFINITY;
        cached = {
          expiresAtMs: Math.min(
            nowMs + Math.max(0, refreshMs),
            maxCacheExpiryMs
          ),
          value
        };
        return value;
      })
      .finally(() => {
        refreshPromise = undefined;
      });

    return refreshPromise;
  };
}

export function resolveHealthAddresses({
  deploymentManifest = loadTestnetDeploymentManifest(),
  env = process.env
} = {}) {
  const contracts = deploymentManifest?.contracts ?? {};
  const token = firstPresent(contracts.token, firstSupportedAssetAddress(env));
  const treasuryReserve = firstPresent(
    deploymentManifest?.treasuryReserve,
    deploymentManifest?.opsReserve,
    deploymentManifest?.opsReserveAddress,
    env.USDC_LIQUIDITY_TREASURY_RESERVE_ACCOUNT
  );

  return compactPlainObject({
    token,
    agentAccountCore: firstPresent(contracts.agentAccountCore, env.AGENT_ACCOUNT_ADDRESS),
    escrowCore: firstPresent(contracts.escrowCore, env.ESCROW_CORE_ADDRESS),
    xcmWrapper: firstPresent(contracts.xcmWrapper, env.XCM_WRAPPER_ADDRESS),
    hydrationUsdcAdapter: firstPresent(
      contracts.hydrationUsdcAdapter,
      env.HYDRATION_USDC_ADAPTER_ADDRESS
    ),
    settlementSigner: firstPresent(
      deploymentManifest?.verifier,
      env.SIGNER_ADDRESS,
      env.SIGNER_ADDRESS_OVERRIDE
    ),
    treasuryReserve
  });
}

export async function resolveRewardBankHealth({ gateway, addresses, now }) {
  const asOf = now.toISOString();
  const fallback = {
    liquid: null,
    liquidRaw: null,
    decimals: DEFAULT_REWARD_BANK_DECIMALS,
    asOf,
    readable: false,
    source: "gateway_unavailable"
  };

  if (!gateway?.isEnabled?.() || typeof gateway.getTreasuryPolicyStatus !== "function") {
    return fallback;
  }

  try {
    const status = await gateway.getTreasuryPolicyStatus();
    const token = normalizeAddressish(addresses?.token);
    const asset = (status?.signerFunding?.assets ?? []).find((candidate) => {
      const candidateAddress = normalizeAddressish(candidate?.address);
      return (token && candidateAddress && token === candidateAddress)
        || String(candidate?.symbol ?? "").toUpperCase() === "USDC";
    });
    const decimals = Number.isFinite(Number(asset?.decimals))
      ? Number(asset.decimals)
      : DEFAULT_REWARD_BANK_DECIMALS;
    if (!asset?.readable) {
      return {
        ...fallback,
        decimals,
        source: "agent_account_position",
        error: "position_unreadable"
      };
    }
    return {
      liquid: normalizeNumericAmount(asset.liquid),
      liquidRaw: asset.liquidRaw ?? null,
      decimals,
      asOf,
      readable: true,
      account: status?.signerFunding?.account ?? addresses?.settlementSigner,
      asset: asset.symbol ?? "USDC",
      source: "agent_account_position"
    };
  } catch (error) {
    return {
      ...fallback,
      source: "agent_account_position",
      error: error?.code ?? error?.shortMessage ?? error?.message ?? "read_failed"
    };
  }
}

function rewardBankReadingAgeMs(reading, nowMs) {
  const asOfMs = Date.parse(reading?.asOf ?? "");
  return Number.isFinite(asOfMs)
    ? Math.max(0, nowMs - asOfMs)
    : Number.POSITIVE_INFINITY;
}

async function resolveSettlementHealth({ stateStore, now, limit, stuckAfterMs }) {
  const asOf = now.toISOString();
  const fallback = {
    claimed24h: 0,
    submitted24h: 0,
    settled24h: 0,
    claimedNotSubmitted: 0,
    submittedNotSettled: 0,
    stuck: 0,
    failed24h: 0,
    asOf,
    source: "backend_state_store",
    readable: false
  };

  if (typeof stateStore?.listRecentSessions !== "function") {
    return fallback;
  }

  try {
    const sessions = await stateStore.listRecentSessions(limit);
    const nowMs = now.getTime();
    const cutoffMs = nowMs - 24 * 60 * 60 * 1000;
    let claimed24h = 0;
    let submitted24h = 0;
    let settled24h = 0;
    let claimedNotSubmitted = 0;
    let submittedNotSettled = 0;
    let stuck = 0;
    let failed24h = 0;
    const seenFailures = new Set();

    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (isTimestampWithinWindow(session?.claimedAt, cutoffMs)) {
        claimed24h += 1;
      }
      if (isTimestampWithinWindow(session?.submittedAt, cutoffMs)) {
        submitted24h += 1;
      }
      if (isSettledWithinWindow(session, cutoffMs)) {
        settled24h += 1;
      }
      if (session?.status === "claimed" && !session?.submittedAt) {
        claimedNotSubmitted += 1;
      }
      if (SUBMITTED_NOT_SETTLED_SESSION_STATUSES.has(session?.status) && session?.submittedAt) {
        submittedNotSettled += 1;
      }
      if (isSubmittedStuck(session, nowMs, stuckAfterMs)) {
        stuck += 1;
      }
      if (isSubmitExecutionFailureWithinWindow(session, cutoffMs)) {
        failed24h += 1;
        seenFailures.add(`session:${session.sessionId ?? session.jobId ?? failed24h}`);
      }
    }

    if (typeof stateStore.getMutationReceipt === "function") {
      for (const session of Array.isArray(sessions) ? sessions : []) {
        const receiptKeys = settlementReceiptKeysForSession(session);
        for (const { bucket, key } of receiptKeys) {
          let receipt;
          try {
            receipt = await stateStore.getMutationReceipt(bucket, key);
          } catch {
            continue;
          }
          if (!isMutationExecutionFailureWithinWindow(receipt, cutoffMs)) {
            continue;
          }
          const failureKey = `${bucket}:${key}`;
          if (!seenFailures.has(failureKey)) {
            failed24h += 1;
            seenFailures.add(failureKey);
          }
        }
      }
    }

    return {
      claimed24h,
      submitted24h,
      settled24h,
      claimedNotSubmitted,
      submittedNotSettled,
      stuck,
      failed24h,
      asOf,
      source: "backend_state_store",
      readable: true
    };
  } catch (error) {
    return {
      ...fallback,
      error: error?.message ?? "read_failed"
    };
  }
}

function loadTestnetDeploymentManifest() {
  if (deploymentManifestCache !== undefined) {
    return deploymentManifestCache;
  }

  deploymentManifestCache = loadDeploymentManifestFromUrl(TESTNET_DEPLOYMENT_MANIFEST_URL);
  return deploymentManifestCache;
}

export function loadDeploymentManifestFromUrl(url) {
  try {
    return JSON.parse(readFileSync(url, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return null;
  }
}

function firstSupportedAssetAddress(env = process.env) {
  const rawJson = env.SUPPORTED_ASSETS_JSON?.trim();
  if (rawJson) {
    try {
      const assets = JSON.parse(rawJson);
      if (Array.isArray(assets)) {
        const preferred = assets.find((asset) => String(asset?.symbol ?? "").toUpperCase() === "USDC")
          ?? assets.find((asset) => typeof asset?.address === "string" && asset.address.trim());
        return preferred?.address;
      }
    } catch {
      return undefined;
    }
  }

  const legacy = env.SUPPORTED_ASSETS?.split(",")
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!legacy) {
    return undefined;
  }
  return legacy.split(":")[1]?.trim();
}

function settlementReceiptKeysForSession(session) {
  const keys = [];
  const sessionId = session?.sessionId;
  const disputeId = session?.disputeId ?? session?.dispute?.id ?? session?.arbitration?.disputeId;
  const shouldCheckDisputeReceipt = Boolean(
    disputeId
      || session?.disputedAt
      || session?.status === "disputed"
      || session?.status === "closed"
  );
  if (sessionId && shouldCheckDisputeReceipt) {
    const stableDisputeId = disputeId ?? stableDisputeIdForSession(sessionId);
    keys.push({ bucket: "dispute_verdict", key: stableDisputeId });
    keys.push({ bucket: "dispute_release", key: stableDisputeId });
  }
  return keys;
}

function stableDisputeIdForSession(sessionId) {
  return disputeIdForSession(sessionId);
}

function isSettledWithinWindow(session, cutoffMs) {
  if (!SETTLED_SESSION_STATUSES.has(session?.status)) {
    return false;
  }
  const settledAt = timestampMs(
    session.resolvedAt
      ?? session.rejectedAt
      ?? session.closedAt
      ?? session.updatedAt
  );
  return Number.isFinite(settledAt) && settledAt >= cutoffMs;
}

function isTimestampWithinWindow(value, cutoffMs) {
  const timestamp = timestampMs(value);
  return Number.isFinite(timestamp) && timestamp >= cutoffMs;
}

function isSubmittedStuck(session, nowMs, stuckAfterMs) {
  if (session?.status !== "submitted") {
    return false;
  }
  const submittedAt = timestampMs(session.submittedAt ?? session.updatedAt);
  return Number.isFinite(submittedAt) && nowMs - submittedAt >= stuckAfterMs;
}

function isSubmitExecutionFailureWithinWindow(session, cutoffMs) {
  const failedAt = timestampMs(session?.submitFailedAt);
  return Number.isFinite(failedAt) && failedAt >= cutoffMs;
}

function isMutationExecutionFailureWithinWindow(receipt, cutoffMs) {
  if (!receipt || typeof receipt !== "object") {
    return false;
  }
  const createdAt = timestampMs(receipt.createdAt ?? receipt.decidedAt ?? receipt.updatedAt);
  if (!Number.isFinite(createdAt) || createdAt < cutoffMs) {
    return false;
  }
  const statusCode = Number(receipt.statusCode);
  if (Number.isFinite(statusCode) && statusCode >= 500) {
    return true;
  }
  const response = receipt.response && typeof receipt.response === "object"
    ? receipt.response
    : {};
  const code = String(response.code ?? receipt.code ?? "").trim();
  if (EXECUTION_FAILURE_CODES.has(code)) {
    return true;
  }
  const chainStatus = String(receipt.chainStatus ?? response.chainStatus ?? "").trim();
  if (["failed", "reverted"].includes(chainStatus)) {
    return true;
  }
  const error = String(response.error ?? receipt.error ?? "").toLowerCase();
  return error.includes("revert") || error.includes("mutation");
}

function timestampMs(value) {
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizeAddressish(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : undefined;
}

function normalizeNumericAmount(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactPlainObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")
  );
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}
