import { McpEgressGrantService } from "./mcp-egress-grant-service.js";
import { McpEgressGrantVerifierServer } from "./mcp-egress-grant-verifier-server.js";
import { McpProbeCoordinator, McpProberClient } from "./mcp-probe-coordinator.js";
import { VerificationProfileRegistry } from "./verification-profile-registry.js";
import { MCP_FAILURE_SEMANTICS_PROFILE_REF } from "./verification-profile-registry.js";
import {
  loadVerificationRunFinalizerConfig,
  VerificationRunFinalizerService
} from "./verification-run-finalizer.js";
import { VerificationRunService } from "./verification-run-service.js";

export async function createVerificationShelf({
  stateStore,
  paymentGate,
  authConfig,
  selfIdentityRegistry,
  publicReceiptBaseUrl = process.env.PUBLIC_BASE_URL,
  env = process.env,
  logger = console
} = {}) {
  const config = loadVerificationRunFinalizerConfig(env);
  let executionDispatcher;
  let mcpEgressGrantVerifier;
  let mcpAvailability = {
    status: "unavailable",
    reason: "isolated_mcp_prober_not_configured"
  };
  if (String(env.MCP_PROBER_URL ?? "").trim()) {
    try {
      const grantService = new McpEgressGrantService({ authConfig });
      executionDispatcher = new McpProbeCoordinator({
        stateStore,
        grantService,
        client: new McpProberClient({ baseUrl: env.MCP_PROBER_URL }),
        logger
      });
      mcpEgressGrantVerifier = new McpEgressGrantVerifierServer({ grantService, logger });
      await mcpEgressGrantVerifier.listen({
        socketPath: env.MCP_EGRESS_GRANT_SOCKET ?? "/run/mcp-egress-control/grants.sock"
      });
      mcpAvailability = { status: "available" };
    } catch (error) {
      await mcpEgressGrantVerifier?.close?.().catch(() => {});
      executionDispatcher = undefined;
      mcpEgressGrantVerifier = undefined;
      mcpAvailability = { status: "unavailable", reason: "isolated_mcp_prober_control_unavailable" };
      logger.error?.(
        { errorName: error?.name ?? "Error" },
        "verification_shelf.mcp_prober_unavailable"
      );
    }
  }
  const verificationProfileRegistry = new VerificationProfileRegistry({
    availabilityByProfile: { [MCP_FAILURE_SEMANTICS_PROFILE_REF]: mcpAvailability }
  });
  const verificationRunService = new VerificationRunService({
    stateStore,
    profileRegistry: verificationProfileRegistry,
    paymentGate,
    executionDispatcher,
    selfIdentityRegistry,
    publicReceiptBaseUrl,
    runnerTimeoutMarginMs: config.runnerTimeoutMarginMs
  });
  const verificationRunFinalizer = new VerificationRunFinalizerService({
    verificationRunService,
    intervalMs: config.intervalMs,
    batchSize: config.batchSize,
    logger
  });
  return {
    verificationProfileRegistry,
    verificationRunService,
    verificationRunFinalizer,
    mcpEgressGrantVerifier
  };
}
