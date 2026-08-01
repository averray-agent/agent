import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDiscoveryManifest,
  buildPlatformCapabilities,
  POLKADOT_HUB_MAINNET_CHAIN_ID,
  POLKADOT_HUB_TESTNET_CHAIN_ID
} from "./discovery-manifest.js";

test("buildDiscoveryManifest returns the full public discovery shape", () => {
  const manifest = buildDiscoveryManifest({
    baseUrl: "https://api.example.com",
    discoveryUrl: "https://example.com/.well-known/agent-tools.json",
    profile: "https://app.example.com/agents/<wallet>",
    operatorAppUrl: "https://app.example.com",
    chainId: 420420417,
    rpcUrl: "https://eth-rpc-testnet.polkadot.io"
  });

  assert.equal(manifest.version, "0.3.1");
  assert.equal(manifest.discoveryMode, "directory-safe");
  assert.equal(manifest.baseUrl, "https://api.example.com");
  assert.equal(manifest.discoveryUrl, "https://example.com/.well-known/agent-tools.json");
  assert.equal(manifest.profile, "https://app.example.com/agents/<wallet>");
  assert.deepEqual(manifest.protocolEndpoints, {
    http: "https://api.example.com",
    mcp: "https://api.example.com/onboarding"
  });
  assert.equal(manifest.onboarding.entrypoint, "https://api.example.com/onboarding");
  assert.equal(manifest.onboarding.posterEntrypoint, "https://api.example.com/poster/onboarding");
  assert.equal(manifest.health, "https://api.example.com/health");
  assert.ok(Array.isArray(manifest.publicEndpoints));
  assert.ok(manifest.publicEndpoints.some((entry) => entry.path === "/poster/onboarding"));
  assert.ok(Array.isArray(manifest.authenticatedEndpoints));
  assert.ok(Array.isArray(manifest.tools));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/account/position"));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/account/borrow-capacity"));
  assert.ok(!manifest.authenticatedEndpoints.some((entry) => entry.path === "/payments/send"));
  assert.ok(!manifest.tools.some((tool) => tool.name === "sendToAgent"));
  // /auth/refresh rotates the wallet JWT in place — both the entrypoint
  // list and the authenticated-endpoints list must advertise it so clients
  // can avoid re-running SIWE every AUTH_TOKEN_TTL_SECONDS.
  assert.ok(manifest.executionSurfaces.authEntrypoints.includes("/auth/refresh"));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/auth/refresh"));
  // Tools advertised in the manifest must also surface as authenticated endpoints
  // so an MCP client following the manifest can actually call them. The
  // explainEligibility / estimateNetReward tools were previously reachable only
  // as sub-fields of preflightJob / recommendJobs — they now have direct routes.
  assert.ok(manifest.tools.some((tool) => tool.name === "explainEligibility"));
  assert.ok(manifest.tools.some((tool) => tool.name === "estimateNetReward"));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/jobs/explain-eligibility"));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/jobs/estimate-reward"));
  assert.equal(manifest.tools[0]?.name, "getPlatformCapabilities");
  assert.equal(manifest.executionSurfaces.operatorApp, "https://app.example.com");
  assert.equal(manifest.schemas.agentBadge, "https://averray.com/schemas/agent-badge-v1.json");
  assert.equal(manifest.schemas.jobSchemasIndex, "https://api.example.com/schemas/jobs");
  assert.equal(manifest.schemas.jobSchemaPathTemplate, "https://api.example.com/schemas/jobs/<name>.json");
  assert.ok(manifest.publicEndpoints.some((entry) => entry.path === "/schemas/jobs"));
  assert.ok(manifest.publicEndpoints.some((entry) => entry.path === "/session/state-machine"));
  assert.ok(manifest.tools.some((tool) => tool.name === "listJobSchemas"));
  assert.ok(manifest.tools.some((tool) => tool.name === "getSessionStateMachine"));
  assert.equal(manifest.auth.schemeId, "SIWE_JWT");
  assert.deepEqual(manifest.auth.supportedWalletModes, ["evm-siwe"]);
  assert.equal(manifest.docs.walletOnboarding, "https://github.com/depre-dev/agent/blob/main/docs/AGENT_WALLET_ONBOARDING.md");
  assert.equal(manifest.docs.productionChecklist, "https://github.com/depre-dev/agent/blob/main/docs/PRODUCTION_CHECKLIST.md");
  assert.equal(manifest.docs.threatModel, "https://github.com/depre-dev/agent/blob/main/docs/THREAT_MODEL.md");
  assert.equal(manifest.docs.noToken, "https://github.com/depre-dev/agent/blob/main/docs/NO_TOKEN.md");
  assert.equal(manifest.docs.week12Gate, "https://github.com/depre-dev/agent/blob/main/docs/WEEK12_GATE.md");
  assert.equal(manifest.docs.productProofGate, "https://github.com/depre-dev/agent/blob/main/docs/PRODUCT_PROOF_GATE.md");
  assert.equal(manifest.docs.disputeCodes, "https://github.com/depre-dev/agent/blob/main/docs/DISPUTE_CODES.md");
  assert.equal(manifest.docs.arbitrationMigration, "https://github.com/depre-dev/agent/blob/main/docs/ARBITRATION_MIGRATION.md");
  assert.ok(manifest.onboarding.walletModes.some((mode) => (
    mode.id === "evm-siwe"
    && mode.status === "supported"
    && mode.chain.faucetUrl === "https://faucet.polkadot.io/"
    && mode.setup.secretHandling.includes("never paste raw keys")
  )));
  assert.ok(manifest.onboarding.walletModes.some((mode) => (
    mode.id === "substrate-mapped"
    && mode.status === "documented_not_yet_supported_for_http_auth"
    && mode.mappingRequirement.includes("pallet_revive.map_account")
    && mode.currentBlocker.includes("do not yet accept native Substrate signatures")
  )));
  assert.ok(manifest.onboarding.walletModes.some((mode) => (
    mode.id === "agent-self-custody"
    && mode.status === "supported"
    && mode.forAutonomousAgents === true
    && mode.authScheme === "SIWE_JWT"
    && Array.isArray(mode.bootstrap) && mode.bootstrap.length >= 3
    && mode.setup.secretHandling.includes("Never paste it into chat")
  )));
  assert.ok(manifest.onboarding.readinessChecks.some((check) => (
    check.id === "wallet-funded" && check.faucetUrl === "https://faucet.polkadot.io/"
  )));
  assert.ok(manifest.onboarding.selfServeChecklist.some((entry) => entry.includes("do not paste")));
  assert.ok(manifest.onboarding.starterFlow.includes("select-first-waiver-eligible-claimable-job"));
  assert.equal(manifest.onboarding.starterFlow.includes("claim-starter-job"), false);
  assert.ok(manifest.onboarding.actionRequirements.some((entry) => (
    entry.method === "POST" && entry.path === "/jobs/claim" && entry.requiredAction === "wallet_sign_in"
  )));
});

test("mainnet chainId renders the mainnet chain block on every network-dependent surface", () => {
  const manifest = buildDiscoveryManifest({ chainId: POLKADOT_HUB_MAINNET_CHAIN_ID });
  const mainnetChain = {
    name: "Polkadot Hub",
    currencySymbol: "DOT",
    chainId: POLKADOT_HUB_MAINNET_CHAIN_ID,
    rpcUrl: "https://eth-rpc.polkadot.io"
  };

  for (const id of ["evm-siwe", "agent-self-custody"]) {
    const mode = manifest.onboarding.walletModes.find((entry) => entry.id === id);
    assert.deepEqual(mode.chain, mainnetChain, `${id} must advertise the mainnet chain`);
  }

  const walletFunded = manifest.onboarding.readinessChecks.find((check) => check.id === "wallet-funded");
  assert.equal(
    walletFunded.description,
    "For non-brokered or non-waived jobs, acquire DOT on Polkadot Hub; starter jobs advertised as operator-brokered and stake-waived need no wallet funding."
  );
  assert.ok(!("faucetUrl" in walletFunded), "mainnet has no faucet — wallet-funded must not carry faucetUrl");

  assert.ok(manifest.onboarding.selfServeChecklist.includes(
    "For non-brokered or non-waived jobs, acquire DOT on Polkadot Hub; operator-brokered, stake-waived starter jobs require no wallet funding."
  ));

  // Anti-desync guard: nothing in the mainnet manifest may still reference the
  // testnet chain, its currency, or a faucet — however the wording evolves.
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes(String(POLKADOT_HUB_TESTNET_CHAIN_ID)));
  assert.ok(!/testnet/iu.test(serialized));
  assert.ok(!/faucet/iu.test(serialized));
  assert.ok(!serialized.includes('"PAS"'));
});

test("testnet chainId and unknown/unset chainIds keep the historical testnet block", () => {
  const testnetManifest = buildDiscoveryManifest({ chainId: POLKADOT_HUB_TESTNET_CHAIN_ID });
  const testnetChain = {
    name: "Polkadot Hub TestNet",
    currencySymbol: "PAS",
    chainId: POLKADOT_HUB_TESTNET_CHAIN_ID,
    rpcUrl: "https://eth-rpc-testnet.polkadot.io",
    faucetUrl: "https://faucet.polkadot.io/"
  };
  for (const id of ["evm-siwe", "agent-self-custody"]) {
    const mode = testnetManifest.onboarding.walletModes.find((entry) => entry.id === id);
    assert.deepEqual(mode.chain, testnetChain, `${id} must advertise the testnet chain`);
  }
  assert.ok(testnetManifest.onboarding.selfServeChecklist.includes(
    "For non-brokered or non-waived jobs, fund PAS on Polkadot Hub TestNet from https://faucet.polkadot.io/; operator-brokered, stake-waived starter jobs require no wallet funding."
  ));
  assert.ok(!JSON.stringify(testnetManifest).includes(String(POLKADOT_HUB_MAINNET_CHAIN_ID)));

  // Dev stacks boot with AUTH_CHAIN_ID=0 — they must never advertise mainnet.
  assert.deepEqual(buildDiscoveryManifest(), testnetManifest);
  assert.deepEqual(buildDiscoveryManifest({ chainId: 0 }), testnetManifest);
  assert.deepEqual(buildDiscoveryManifest({ chainId: 31337 }), testnetManifest);
});

test("buildPlatformCapabilities forwards the chainId to the manifest build", () => {
  const capabilities = buildPlatformCapabilities({ chainId: POLKADOT_HUB_MAINNET_CHAIN_ID });
  const mode = capabilities.onboarding.walletModes.find((entry) => entry.id === "evm-siwe");
  assert.equal(mode.chain.chainId, POLKADOT_HUB_MAINNET_CHAIN_ID);
  assert.equal(mode.chain.name, "Polkadot Hub");
});

test("authenticated endpoint docs carry the query-parameter contracts agents tripped on", () => {
  const manifest = buildDiscoveryManifest();
  const preflight = manifest.authenticatedEndpoints.find((entry) => entry.path.startsWith("/jobs/preflight"));
  assert.equal(preflight.path, "/jobs/preflight?jobId=X");
  assert.ok(preflight.description.includes("GET-only"));
  assert.ok(preflight.description.includes("405"));
  const session = manifest.authenticatedEndpoints.find((entry) => entry.path.startsWith("/session?"));
  assert.equal(session.path, "/session?sessionId=X");
  assert.ok(session.description.includes("compatibility alias"));
});

test("buildPlatformCapabilities stays aligned with the discovery tool list", () => {
  const manifest = buildDiscoveryManifest();
  const capabilities = buildPlatformCapabilities();

  assert.equal(capabilities.name, manifest.name);
  assert.equal(capabilities.discoveryUrl, manifest.discoveryUrl);
  assert.equal(capabilities.discoveryMode, manifest.discoveryMode);
  assert.deepEqual(capabilities.protocols, manifest.protocols);
  assert.deepEqual(capabilities.onboarding, {
    starterFlow: manifest.onboarding.starterFlow,
    walletModes: manifest.onboarding.walletModes,
    actionRequirements: manifest.onboarding.actionRequirements,
    readinessChecks: manifest.onboarding.readinessChecks,
    selfServeChecklist: manifest.onboarding.selfServeChecklist
  });
  assert.deepEqual(capabilities.auth, {
    scheme: manifest.auth.scheme,
    schemeId: manifest.auth.schemeId,
    entrypoints: manifest.auth.entrypoints,
    supportedWalletModes: manifest.auth.supportedWalletModes,
    plannedWalletModes: manifest.auth.plannedWalletModes
  });
  assert.deepEqual(capabilities.executionSurfaces, manifest.executionSurfaces);
  assert.deepEqual(
    capabilities.tools,
    manifest.tools.map((tool) => tool.name)
  );
});
