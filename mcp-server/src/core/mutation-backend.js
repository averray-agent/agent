import { ChainBackendRequiredError, ConfigError } from "./errors.js";

const MODES = new Set(["memory", "chain", "required"]);

export function loadMutationBackendConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? "development";
  const configured = env.MUTATION_BACKEND?.trim().toLowerCase();
  const mode = configured || (nodeEnv === "production" ? "required" : "memory");
  if (!MODES.has(mode)) {
    throw new ConfigError(
      `MUTATION_BACKEND must be one of memory, chain, or required; got "${env.MUTATION_BACKEND}".`,
      { mode: env.MUTATION_BACKEND }
    );
  }
  return {
    mode,
    defaulted: !configured,
    requiresChain: mode === "chain" || mode === "required",
    allowsMemory: mode === "memory"
  };
}

export function describeMutationBackendStartup(config, gateway) {
  return {
    mutationBackend: config.mode,
    mutationBackendDefaulted: config.defaulted,
    chainStatus: gateway?.isEnabled?.() ? "enabled" : "disabled"
  };
}

export async function getMutationBackendStatus({ gateway, config = loadMutationBackendConfig(), route = undefined } = {}) {
  if (!config.requiresChain) {
    return {
      ok: true,
      mode: config.mode,
      route,
      chainRequired: false,
      chainAvailable: false,
      reason: "memory backend allowed"
    };
  }

  if (!gateway?.isEnabled?.()) {
    return unavailable(config, route, "blockchain gateway is disabled", {
      ok: false,
      backend: "blockchain",
      enabled: false,
      mode: "disabled"
    });
  }

  let health;
  try {
    health = typeof gateway.healthCheck === "function"
      ? await gateway.healthCheck()
      : {
          ok: true,
          backend: "blockchain",
          enabled: true,
          mode: "enabled_without_healthcheck"
        };
  } catch (error) {
    return unavailable(config, route, error?.message ?? "blockchain gateway health check failed", {
      ok: false,
      backend: "blockchain",
      enabled: true,
      error: error?.message ?? String(error)
    });
  }

  if (!health?.ok || health?.enabled === false) {
    return unavailable(
      config,
      route,
      health?.error || (health?.enabled === false ? "blockchain gateway is disabled" : "blockchain gateway is unhealthy"),
      health
    );
  }

  return {
    ok: true,
    mode: config.mode,
    route,
    chainRequired: true,
    chainAvailable: true,
    gatewayStatus: health
  };
}

export async function assertMutationBackendAvailable(options = {}) {
  const status = await getMutationBackendStatus(options);
  if (status.ok) {
    return status;
  }
  throw new ChainBackendRequiredError(status.reason, {
    mode: status.mode,
    route: status.route,
    gatewayStatus: status.gatewayStatus
  });
}

function unavailable(config, route, reason, gatewayStatus) {
  return {
    ok: false,
    mode: config.mode,
    route,
    chainRequired: true,
    chainAvailable: false,
    reason,
    gatewayStatus
  };
}
