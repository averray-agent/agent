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
import { recordCapabilityWarningTransitions } from "../../services/overnight-ledger.js";

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

function buildSubmittedJobAutoVerifierWarnings(health) {
  if (health?.ok !== false) return [];
  const persistentSessionCount = Number.isFinite(health.persistentSubmittedFailureCount)
    ? Number(health.persistentSubmittedFailureCount)
    : 0;
  const code = health.state ?? "submitted_job_auto_verifier_unhealthy";
  return [{
    code,
    severity: "critical",
    message: `Submitted-job auto-verifier is unhealthy (${code}); persistent submitted session count: ${persistentSessionCount}.`
  }];
}

function buildLockedTierWarnings(health) {
  if (health?.ok !== false) return [];
  return [{
    code: health.code ?? "locked_tier_unhealthy",
    severity: "critical",
    message: health.message
      ?? "The locked-deposit withdrawal gate has a signed-consent integrity failure."
  }];
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
  eventBus,
  gateway,
  getRewardBankHealth,
  indexerHealthProbe,
  metrics,
  metricsAuthRequired,
  metricsBearerToken,
  lockedTierService,
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
        externalPostingWatcherStatus,
        submittedJobAutoVerifierHealth,
        lockedTierHealth
      ] = await Promise.all([
        stateStore.healthCheck?.() ?? { ok: true, backend: stateStore.constructor.name },
        getCachedBlockchainHealth(),
        pimlicoClient?.healthCheck?.() ?? { ok: true, backend: "pimlico", enabled: false, mode: "disabled" },
        service?.xcmSettlementWatcher?.getStatus?.()?.catch?.(() => undefined) ?? undefined,
        indexerHealthProbe?.().catch(() => ({ ok: false, reason: "indexer_status_unavailable" }))
          ?? { ok: false, reason: "indexer_status_url_unconfigured" },
        externalPostingWatcher?.getStatus?.()?.catch?.(() => undefined) ?? undefined,
        service?.submittedJobAutoVerifier?.getHealth?.()?.catch?.(() => ({
          ok: false,
          state: "status_unavailable"
        })) ?? { ok: false, state: "status_unavailable" },
        lockedTierService?.getHealth?.()?.catch?.(() => ({
          ok: false,
          code: "locked_tier_health_unavailable",
          message: "Locked-deposit health state is unreadable."
        })) ?? { ok: true, state: "not_configured" }
      ]);
      const mutationBackendStatus = await getMutationBackendStatus({
        gateway,
        config: mutationBackendConfig,
        route: "/health",
        gatewayStatus: chainHealth
      }).catch(() => ({ ok: false, route: "/health" }));

      const serviceHealth = resolveServiceHealth({
        stateStoreHealth: storeHealth,
        authConfig,
        submittedJobAutoVerifierHealth
      });
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
      const warnings = [
        ...buildCapabilityWarnings(capabilityHealth),
        ...buildOnboardingInventoryWarnings(productHealth.onboarding),
        ...buildSubmittedJobAutoVerifierWarnings(submittedJobAutoVerifierHealth),
        ...buildLockedTierWarnings(lockedTierHealth)
      ];
      await recordCapabilityWarningTransitions({
        stateStore,
        eventBus,
        warnings
      }).catch(() => undefined);

      respond(response, serviceHealth.ok ? 200 : 503, {
        status: serviceHealth.ok ? "ok" : "degraded",
        deployedSha,
        auth: { mode: authConfig.mode, domain: authConfig.domain, chainId: authConfig.chainId },
        serviceHealth,
        capabilityHealth,
        ...productHealth,
        // Structured, codeable warnings derived from capability and
        // correctness health without changing API-process liveness.
        warnings,
        components: {
          stateStore: storeHealth,
          blockchain: chainHealth,
          gasSponsor: gasHealth,
          indexer: indexerProbe,
          externalPostingWatcher: externalPostingWatcherStatus,
          submittedJobAutoVerifier: submittedJobAutoVerifierHealth,
          lockedTiers: lockedTierHealth
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
