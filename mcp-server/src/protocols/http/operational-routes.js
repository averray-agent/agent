import { timingSafeEqual } from "node:crypto";

import { getMutationBackendStatus } from "../../core/mutation-backend.js";
import {
  buildCapabilityWarnings,
  createNonBlockingBlockchainHealthProvider,
  createNonBlockingRewardBankHealthProvider,
  createProductHealthSnapshotProvider,
  createRewardBankHealthProvider,
  resolveCapabilityHealth,
  resolveServiceHealth
} from "../../core/health-capability.js";
import { buildOnboardingInventoryWarnings } from "../../core/onboarding-inventory.js";

function bearerTokenMatches(header, expectedToken) {
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const actualToken = header.slice(prefix.length);
  const actual = Buffer.from(actualToken);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseRequiredFlag(value, defaultValue) {
  const normalized = String(value ?? defaultValue).trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
}

export function resolveMetricsAuthConfig(env = process.env) {
  return {
    metricsBearerToken: env.METRICS_BEARER_TOKEN?.trim() || undefined,
    metricsAuthRequired: parseRequiredFlag(
      env.METRICS_AUTH_REQUIRED,
      env.NODE_ENV === "production" ? "1" : "0"
    )
  };
}

export function createOperationalRoutes({
  authConfig,
  deployedSha = process.env.DEPLOYED_SHA?.trim() || "unknown",
  externalPostingMode = "closed",
  externalPostingWatcher,
  gateway,
  getRewardBankHealth,
  indexerHealthProbe,
  metrics,
  metricsAuthRequired,
  metricsBearerToken,
  mutationBackendConfig,
  pimlicoClient,
  respond,
  service,
  stateStore
}) {
  const getLiveRewardBankHealth = getRewardBankHealth ?? createRewardBankHealthProvider({
    gateway
  });
  const getCachedRewardBankHealth = createNonBlockingRewardBankHealthProvider({
    getRewardBankHealth: getLiveRewardBankHealth
  });
  const getCachedBlockchainHealth = createNonBlockingBlockchainHealthProvider({
    gateway
  });
  const getProductHealthSnapshot = createProductHealthSnapshotProvider({
    gateway,
    service,
    getRewardBankHealth: getCachedRewardBankHealth,
    stateStore
  });

  return async function handleOperationalRoute({ request, response, pathname }) {
    if (request.method === "GET" && pathname === "/health") {
      // Package B (P1.1b) — health truth split. `serviceHealth` is the
      // API-process liveness contract: state-store reachable + auth config
      // loaded. HTTP status follows `serviceHealth.ok` alone, so a
      // trust-core-only launch still returns 200/"ok" at the liveness layer
      // and surfaces chain/treasury posture via `capabilityHealth`.
      const [
        storeHealth,
        chainHealth,
        gasHealth,
        xcmWatcherStatus,
        indexerProbe,
        externalPostingWatcherStatus
      ] = await Promise.all([
        stateStore.healthCheck?.() ?? { ok: true, backend: stateStore.constructor.name },
        getCachedBlockchainHealth(),
        pimlicoClient?.healthCheck?.() ?? { ok: true, backend: "pimlico", enabled: false, mode: "disabled" },
        service?.xcmSettlementWatcher?.getStatus?.()?.catch?.(() => undefined) ?? undefined,
        indexerHealthProbe?.().catch(() => ({ ok: false, reason: "indexer_status_unavailable" }))
          ?? { ok: false, reason: "indexer_status_url_unconfigured" },
        externalPostingWatcher?.getStatus?.()?.catch?.(() => undefined) ?? undefined
      ]);
      const mutationBackendStatus = await getMutationBackendStatus({
        gateway,
        config: mutationBackendConfig,
        route: "/health",
        gatewayStatus: chainHealth
      }).catch(() => ({ ok: false, route: "/health" }));

      const serviceHealth = resolveServiceHealth({ stateStoreHealth: storeHealth, authConfig });
      const capabilityHealth = resolveCapabilityHealth({
        blockchainHealth: chainHealth,
        mutationBackendStatus,
        xcmWatcherStatus,
        indexerProbe,
        gasSponsorHealth: gasHealth,
        externalPostingMode,
        externalPostingWatcherStatus
      });
      const productHealth = await getProductHealthSnapshot();

      respond(response, serviceHealth.ok ? 200 : 503, {
        status: serviceHealth.ok ? "ok" : "degraded",
        deployedSha,
        auth: { mode: authConfig.mode, domain: authConfig.domain, chainId: authConfig.chainId },
        serviceHealth,
        capabilityHealth,
        ...productHealth,
        // Structured, codeable warnings derived from capabilityHealth.
        warnings: [
          ...buildCapabilityWarnings(capabilityHealth),
          ...buildOnboardingInventoryWarnings(productHealth.onboarding)
        ],
        components: {
          stateStore: storeHealth,
          blockchain: chainHealth,
          gasSponsor: gasHealth,
          indexer: indexerProbe,
          externalPostingWatcher: externalPostingWatcherStatus
        }
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/metrics") {
      // Fail closed in production: public metrics reveal request paths,
      // status-code mix, and operational posture.
      if (metricsAuthRequired && !metricsBearerToken) {
        respond(response, 503, { error: "metrics_auth_unconfigured" });
        return true;
      }
      if (metricsAuthRequired) {
        const header = request.headers.authorization ?? "";
        if (!bearerTokenMatches(header, metricsBearerToken)) {
          respond(response, 401, { error: "unauthorized" });
          return true;
        }
      }
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4",
        ...(response._corsHeaders ?? {}),
        "x-request-id": response._requestId ?? ""
      });
      response.end(metrics.serialize());
      return true;
    }

    return false;
  };
}
