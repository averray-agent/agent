import test from "node:test";
import assert from "node:assert/strict";

import { buildDiscoveryManifest, buildPlatformCapabilities } from "./discovery-manifest.js";

test("buildDiscoveryManifest returns the full public discovery shape", () => {
  const manifest = buildDiscoveryManifest({
    baseUrl: "https://api.example.com",
    discoveryUrl: "https://example.com/.well-known/agent-tools.json",
    profile: "https://app.example.com/agents/<wallet>",
    operatorAppUrl: "https://app.example.com"
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
  assert.equal(manifest.health, "https://api.example.com/health");
  assert.ok(Array.isArray(manifest.publicEndpoints));
  assert.ok(Array.isArray(manifest.authenticatedEndpoints));
  assert.ok(Array.isArray(manifest.tools));
  assert.ok(manifest.authenticatedEndpoints.some((entry) => entry.path === "/account/borrow-capacity"));
  assert.ok(!manifest.authenticatedEndpoints.some((entry) => entry.path === "/payments/send"));
  assert.ok(!manifest.tools.some((tool) => tool.name === "sendToAgent"));
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
  assert.ok(manifest.onboarding.walletModes.some((mode) => mode.id === "substrate-mapped"));
  assert.ok(manifest.onboarding.actionRequirements.some((entry) => (
    entry.method === "POST" && entry.path === "/jobs/claim" && entry.requiredAction === "wallet_sign_in"
  )));
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
