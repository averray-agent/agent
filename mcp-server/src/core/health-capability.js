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

/**
 * Compute `serviceHealth` from process-local liveness signals.
 *
 *   - `stateStoreHealth.ok === true` → state store reachable.
 *   - `authConfig` present + `secrets` non-empty (strict) OR permissive
 *     mode → auth dependencies loaded.
 *
 * The `ok` field is the AND of every component; anything false flips
 * the overall HTTP status code to 503 because the API process itself
 * cannot serve a request reliably.
 */
export function resolveServiceHealth({ stateStoreHealth, authConfig }) {
  const stateStoreOk = Boolean(stateStoreHealth?.ok);
  const authOk = authConfig?.mode === "permissive"
    || (Array.isArray(authConfig?.secrets) && authConfig.secrets.length > 0);

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
 *   capability resolves to `unavailable` with a `reason` field rather
 *   than asserting a state we can't prove. Backend does not currently
 *   hold a direct indexer URL dependency; wiring is a future step.
 * @param {object} [options.gasSponsorHealth] — pimlico.healthCheck()
 *   output. `enabled === true` → enabled, else → disabled.
 */
export function resolveCapabilityHealth({
  blockchainHealth,
  mutationBackendStatus,
  xcmWatcherStatus,
  indexerProbe,
  gasSponsorHealth
}) {
  return {
    blockchain: resolveBlockchainStatus(blockchainHealth),
    treasuryMutations: resolveTreasuryStatus(mutationBackendStatus),
    xcmObserver: resolveXcmObserverStatus(xcmWatcherStatus),
    indexer: resolveIndexerStatus(indexerProbe),
    gasSponsor: resolveGasSponsorStatus(gasSponsorHealth)
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

  return warnings;
}
