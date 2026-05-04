import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTH_POLICY_VERSION,
  capabilityMatrix,
  getRouteCapabilityRequirements,
  missingCapabilities,
  resolveCapabilities
} from "./capabilities.js";

test("resolveCapabilities returns base capabilities for signed-in wallets", () => {
  const capabilities = resolveCapabilities({ roles: [] });
  assert.ok(capabilities.includes("jobs:claim"));
  assert.ok(capabilities.includes("session:timeline"));
  assert.ok(capabilities.includes("xcm:read"));
});

test("resolveCapabilities expands admin and verifier capabilities", () => {
  const capabilities = resolveCapabilities({ roles: ["admin", "verifier"] });
  assert.ok(capabilities.includes("jobs:create"));
  assert.ok(capabilities.includes("jobs:ingest"));
  assert.ok(capabilities.includes("jobs:lifecycle"));
  assert.ok(capabilities.includes("jobs:pause-recurring"));
  assert.ok(capabilities.includes("jobs:timeline"));
  assert.ok(capabilities.includes("ops:view"));
  assert.ok(capabilities.includes("verifier:run"));
  assert.ok(capabilities.includes("subjobs:create"));
  assert.ok(capabilities.includes("xcm:observe"));
  assert.ok(capabilities.includes("xcm:finalize"));
});

test("resolveCapabilities includes explicit future scopes from signed claims", () => {
  const capabilities = resolveCapabilities({
    roles: [],
    capabilities: ["jobs:create"],
    scopes: ["ops:view", "jobs:create"]
  });
  assert.ok(capabilities.includes("jobs:create"));
  assert.ok(capabilities.includes("ops:view"));
});

test("capabilityMatrix exposes base and role capability groups", () => {
  const matrix = capabilityMatrix();
  assert.equal(matrix.version, AUTH_POLICY_VERSION);
  assert.ok(matrix.base.includes("jobs:list"));
  assert.ok(matrix.base.includes("jobs:submit"));
  assert.ok(matrix.roles.admin.includes("jobs:fire-recurring"));
  assert.ok(matrix.roles.admin.includes("jobs:ingest"));
  assert.ok(matrix.roles.admin.includes("xcm:observe"));
  assert.ok(matrix.roles.admin.includes("xcm:finalize"));
  assert.ok(matrix.roles.verifier.includes("verifier:replay"));
  assert.deepEqual(matrix.routes["/admin/jobs/pause"], ["jobs:pause-recurring"]);
  assert.deepEqual(matrix.routes["/admin/jobs/timeline"], ["jobs:timeline"]);
  assert.deepEqual(matrix.routes["/admin/xcm/observe"], ["xcm:observe"]);
  assert.deepEqual(matrix.routes["/admin/xcm/finalize"], ["xcm:finalize"]);
  assert.deepEqual(matrix.uiControls["admin.status.view"], ["admin:status", "ops:view"]);
  assert.deepEqual(matrix.automationActions["job.fireRecurring"], ["jobs:fire-recurring"]);
});

test("getRouteCapabilityRequirements resolves method-specific route policies", () => {
  assert.deepEqual(getRouteCapabilityRequirements("GET", "/admin/jobs"), ["ops:view"]);
  assert.deepEqual(getRouteCapabilityRequirements("POST", "/admin/jobs"), ["jobs:create"]);
  assert.deepEqual(getRouteCapabilityRequirements("POST", "/admin/jobs/ingest/wikipedia"), ["jobs:ingest"]);
  assert.deepEqual(getRouteCapabilityRequirements("POST", "/disputes/dispute-123/verdict"), ["disputes:verdict"]);
  assert.deepEqual(getRouteCapabilityRequirements("GET", "/unknown"), []);
});

test("missingCapabilities reports the exact capability gap", () => {
  assert.deepEqual(
    missingCapabilities(["jobs:create"], ["jobs:create", "ops:view"]),
    ["ops:view"]
  );
});
