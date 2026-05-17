import { getMutationBackendStatus } from "./mutation-backend.js";

const DEFAULT_CHAIN_HEALTH = {
  ok: true,
  backend: "blockchain",
  enabled: false,
  mode: "disabled"
};

const DEFAULT_GAS_HEALTH = {
  ok: true,
  backend: "pimlico",
  enabled: false,
  mode: "disabled"
};

const DEFAULT_XCM_OBSERVER_STATUS = {
  enabled: false,
  running: false,
  syncing: false
};

export async function buildHealthReport({
  stateStore,
  gateway,
  pimlicoClient,
  mutationBackendConfig,
  authConfig,
  xcmObservationRelay = undefined
} = {}) {
  const [storeHealth, chainHealth, gasHealth, mutationStatus, xcmObserverStatus] = await Promise.all([
    stateStore?.healthCheck?.() ?? { ok: true, backend: stateStore?.constructor?.name ?? "unknown" },
    gateway?.healthCheck?.() ?? DEFAULT_CHAIN_HEALTH,
    pimlicoClient?.healthCheck?.() ?? DEFAULT_GAS_HEALTH,
    getMutationBackendStatus({
      gateway,
      config: mutationBackendConfig,
      route: "/health"
    }),
    readXcmObserverStatus(xcmObservationRelay)
  ]);

  const serviceComponents = {
    api: { ok: true, mode: "http" },
    stateStore: storeHealth,
    auth: {
      ok: Boolean(authConfig?.mode),
      mode: authConfig?.mode,
      domain: authConfig?.domain,
      chainId: authConfig?.chainId
    },
    runtime: { ok: true, node: "running" }
  };
  const serviceOk = Object.values(serviceComponents).every((component) => component?.ok !== false);

  const capabilityHealth = {
    blockchain: summarizeBlockchain(chainHealth),
    treasuryMutations: summarizeTreasuryMutations(mutationStatus),
    xcmObserver: summarizeXcmObserver(xcmObserverStatus, chainHealth),
    indexer: summarizeIndexer()
  };

  if (gasHealth.enabled || gasHealth.ok === false) {
    capabilityHealth.gasSponsor = summarizeGasSponsor(gasHealth);
  }

  const warnings = buildCapabilityWarnings(capabilityHealth, {
    chainHealth,
    gasHealth,
    mutationStatus,
    xcmObserverStatus
  });

  return {
    status: serviceOk ? "ok" : "degraded",
    serviceHealth: serviceOk ? "ok" : "degraded",
    capabilityHealth,
    warnings,
    auth: {
      mode: authConfig?.mode,
      domain: authConfig?.domain,
      chainId: authConfig?.chainId
    },
    serviceComponents,
    capabilityDetails: {
      blockchain: chainHealth,
      treasuryMutations: mutationStatus,
      xcmObserver: xcmObserverStatus,
      indexer: {
        checked: false,
        reason: "indexer health is checked by hosted-stack smoke until an indexer status URL is configured"
      },
      gasSponsor: gasHealth
    },
    // Legacy component shape kept for existing health consumers while new
    // monitors move to serviceHealth/capabilityHealth.
    components: {
      stateStore: storeHealth,
      blockchain: chainHealth,
      gasSponsor: gasHealth
    }
  };
}

async function readXcmObserverStatus(xcmObservationRelay) {
  if (!xcmObservationRelay?.getStatus) {
    return DEFAULT_XCM_OBSERVER_STATUS;
  }
  try {
    return await xcmObservationRelay.getStatus();
  } catch (error) {
    return {
      ...DEFAULT_XCM_OBSERVER_STATUS,
      enabled: Boolean(xcmObservationRelay.enabled),
      running: Boolean(xcmObservationRelay.running),
      syncing: Boolean(xcmObservationRelay.syncing),
      error: error?.message ?? "xcm_observer_status_unavailable"
    };
  }
}

function summarizeBlockchain(chainHealth) {
  if (chainHealth?.enabled === false) return "disabled";
  if (chainHealth?.ok === false) return "unhealthy";
  return "enabled";
}

function summarizeTreasuryMutations(mutationStatus) {
  if (mutationStatus?.ok && mutationStatus.chainAvailable) return "available";
  if (mutationStatus?.ok && mutationStatus.chainRequired === false) return "degraded";
  return "unavailable";
}

function summarizeXcmObserver(xcmObserverStatus, chainHealth) {
  if (xcmObserverStatus?.enabled && xcmObserverStatus?.running && !xcmObserverStatus?.lastError && !xcmObserverStatus?.error) {
    return "live";
  }
  if (chainHealth?.enabled && (chainHealth?.xcmWrapperConfigured || xcmObserverStatus?.enabled)) {
    return "staged";
  }
  return "unavailable";
}

function summarizeIndexer() {
  return "unavailable";
}

function summarizeGasSponsor(gasHealth) {
  if (gasHealth?.enabled === false) return "unavailable";
  if (gasHealth?.ok === false) return "degraded";
  return "available";
}

function buildCapabilityWarnings(capabilityHealth, details) {
  const warnings = [];

  if (capabilityHealth.blockchain !== "enabled") {
    warnings.push({
      code: `blockchain_${capabilityHealth.blockchain}`,
      severity: capabilityHealth.blockchain === "unhealthy" ? "critical" : "warning",
      message: `Blockchain capability is ${capabilityHealth.blockchain}.`,
      details: details.chainHealth
    });
  }

  if (capabilityHealth.treasuryMutations !== "available") {
    warnings.push({
      code: `treasury_mutations_${capabilityHealth.treasuryMutations}`,
      severity: capabilityHealth.treasuryMutations === "unavailable" ? "critical" : "warning",
      message: `Treasury mutations are ${capabilityHealth.treasuryMutations}.`,
      details: details.mutationStatus
    });
  }

  if (capabilityHealth.xcmObserver !== "live") {
    warnings.push({
      code: `xcm_observer_${capabilityHealth.xcmObserver}`,
      severity: "warning",
      message: `XCM observer is ${capabilityHealth.xcmObserver}.`,
      details: details.xcmObserverStatus
    });
  }

  if (capabilityHealth.indexer !== "synced") {
    warnings.push({
      code: `indexer_${capabilityHealth.indexer}`,
      severity: "warning",
      message: `Indexer capability is ${capabilityHealth.indexer}.`
    });
  }

  if (capabilityHealth.gasSponsor && capabilityHealth.gasSponsor !== "available") {
    warnings.push({
      code: `gas_sponsor_${capabilityHealth.gasSponsor}`,
      severity: "warning",
      message: `Gas sponsor capability is ${capabilityHealth.gasSponsor}.`,
      details: details.gasHealth
    });
  }

  return warnings;
}
