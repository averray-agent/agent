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
  assert.ok(capabilities.includes("agent-transfers:submit"));
  assert.ok(capabilities.includes("verifier:run"));
  assert.ok(capabilities.includes("subjobs:create"));
  assert.ok(capabilities.includes("xcm:observe"));
  assert.ok(capabilities.includes("xcm:finalize"));
});

test("viewer-only capability issuance contains every operator read and no mutation capability", () => {
  const capabilities = resolveCapabilities({
    roles: ["viewer"],
    capabilities: ["jobs:create"],
    scopes: ["disputes:verdict"]
  });

  for (const capability of [
    "account:read",
    "admin:capabilities:read",
    "admin:status",
    "agents:list",
    "badges:list",
    "disputes:list",
    "events:read",
    "jobs:list",
    "jobs:timeline",
    "ops:view",
    "session:read"
  ]) {
    assert.ok(capabilities.includes(capability), `viewer must receive ${capability}`);
  }
  for (const capability of [
    "account:fund",
    "admin:capabilities:grant",
    "credit:originate",
    "disputes:verdict",
    "jobs:claim",
    "jobs:create",
    "jobs:lifecycle",
    "jobs:pause-recurring",
    "payments:send",
    "policies:propose",
    "verifier:run",
    "xcm:finalize"
  ]) {
    assert.equal(capabilities.includes(capability), false, `viewer must not receive ${capability}`);
  }
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

test("resolveCapabilities does not give service tokens wallet base capabilities", () => {
  const capabilities = resolveCapabilities({
    roles: ["admin", "verifier"],
    tokenKind: "service",
    serviceToken: true,
    capabilities: ["jobs:create"],
    scopes: ["ops:view"]
  });
  assert.deepEqual(capabilities, []);
});

test("capabilityMatrix exposes base and role capability groups", () => {
  const matrix = capabilityMatrix();
  assert.equal(matrix.version, AUTH_POLICY_VERSION);
  assert.ok(matrix.base.includes("jobs:list"));
  assert.ok(matrix.base.includes("jobs:submit"));
  assert.ok(matrix.roles.admin.includes("jobs:fire-recurring"));
  assert.ok(matrix.roles.admin.includes("jobs:ingest"));
  assert.ok(matrix.roles.admin.includes("admin:self-report:send"));
  assert.ok(matrix.roles.admin.includes("xcm:observe"));
  assert.ok(matrix.roles.admin.includes("xcm:finalize"));
  assert.ok(matrix.roles.verifier.includes("verifier:replay"));
  assert.ok(matrix.roles.viewer.includes("ops:view"));
  assert.equal(matrix.roles.viewer.includes("jobs:lifecycle"), false);
  assert.deepEqual(matrix.routes["/admin/jobs/pause"], ["jobs:pause-recurring"]);
  assert.deepEqual(matrix.routes["/admin/jobs/timeline"], ["jobs:timeline"]);
  assert.deepEqual(matrix.routes["/admin/xcm/observe"], ["xcm:observe"]);
  assert.deepEqual(matrix.routes["/admin/xcm/finalize"], ["xcm:finalize"]);
  assert.deepEqual(matrix.routes["/admin/agent-transfers"], ["agent-transfers:submit"]);
  assert.deepEqual(matrix.routes["/transparency"], ["ops:view"]);
  assert.deepEqual(matrix.uiControls["capital.transparency.view"], ["ops:view"]);
  assert.deepEqual(matrix.uiControls["admin.status.view"], ["admin:status", "ops:view"]);
  assert.deepEqual(matrix.uiControls["admin.bootstrapSelfReport.send"], ["admin:self-report:send"]);
  assert.deepEqual(matrix.automationActions["bootstrapSelfReport.send"], ["admin:self-report:send"]);
  assert.deepEqual(matrix.automationActions["job.fireRecurring"], ["jobs:fire-recurring"]);
});

test("getRouteCapabilityRequirements resolves method-specific route policies", () => {
  assert.deepEqual(getRouteCapabilityRequirements("GET", "/me"), ["account:read", "reputation:read"]);
  assert.deepEqual(getRouteCapabilityRequirements("GET", "/receipts"), ["session:read"]);
  assert.deepEqual(getRouteCapabilityRequirements("GET", "/jobs/job-123/estimate"), ["jobs:preflight"]);
  assert.deepEqual(getRouteCapabilityRequirements("GET", "/admin/jobs"), ["ops:view"]);
  assert.deepEqual(getRouteCapabilityRequirements("GET", "/transparency"), ["ops:view"]);
  assert.deepEqual(getRouteCapabilityRequirements("POST", "/admin/jobs"), ["jobs:create"]);
  assert.deepEqual(getRouteCapabilityRequirements("POST", "/admin/bootstrap-self-report/send"), ["admin:self-report:send"]);
  assert.deepEqual(getRouteCapabilityRequirements("POST", "/admin/agent-transfers"), ["agent-transfers:submit"]);
  assert.deepEqual(getRouteCapabilityRequirements("GET", "/admin/l3-posting/requests"), ["ops:view"]);
  assert.deepEqual(
    getRouteCapabilityRequirements("POST", "/admin/l3-posting/requests/request-1/advance"),
    ["credit:originate"]
  );
  assert.deepEqual(getRouteCapabilityRequirements("POST", "/admin/jobs/ingest/wikipedia"), ["jobs:ingest"]);
  assert.deepEqual(getRouteCapabilityRequirements("POST", "/disputes/dispute-123/verdict"), ["disputes:verdict"]);
  assert.deepEqual(getRouteCapabilityRequirements("POST", "/account/withdraw/transactions"), ["account:read"]);
  assert.deepEqual(getRouteCapabilityRequirements("GET", "/unknown"), []);
});

test("missingCapabilities reports the exact capability gap", () => {
  assert.deepEqual(
    missingCapabilities(["jobs:create"], ["jobs:create", "ops:view"]),
    ["ops:view"]
  );
});

test("capabilityMatrix surfaces the capability-grant routes and UI controls (roadmap §6)", () => {
  const matrix = capabilityMatrix();
  assert.ok(matrix.roles.admin.includes("admin:capabilities:read"));
  assert.ok(matrix.roles.admin.includes("admin:capabilities:grant"));
  assert.ok(matrix.roles.admin.includes("admin:capabilities:revoke"));
  assert.deepEqual(matrix.routes["/admin/capability-grants"], [
    "admin:capabilities:grant",
    "admin:capabilities:read"
  ]);
  assert.deepEqual(matrix.routes["/admin/capability-grants/:id/revoke"], [
    "admin:capabilities:revoke"
  ]);
  assert.deepEqual(matrix.routes["/admin/service-tokens"], [
    "admin:capabilities:grant",
    "admin:capabilities:read"
  ]);
  assert.deepEqual(matrix.routes["/admin/service-tokens/:id/rotate"], [
    "admin:capabilities:grant",
    "admin:capabilities:revoke"
  ]);
  assert.deepEqual(matrix.routes["/admin/service-tokens/:id/revoke"], [
    "admin:capabilities:revoke"
  ]);
  assert.deepEqual(matrix.uiControls["admin.capabilities.view"], ["admin:capabilities:read"]);
  assert.deepEqual(matrix.uiControls["admin.capabilities.grant"], ["admin:capabilities:grant"]);
  assert.deepEqual(matrix.uiControls["admin.capabilities.revoke"], ["admin:capabilities:revoke"]);
  assert.deepEqual(matrix.automationActions["capability.grant"], ["admin:capabilities:grant"]);
  assert.deepEqual(matrix.automationActions["capability.revoke"], ["admin:capabilities:revoke"]);
  assert.deepEqual(matrix.automationActions["serviceToken.issue"], ["admin:capabilities:grant"]);
  assert.deepEqual(matrix.automationActions["serviceToken.rotate"], [
    "admin:capabilities:grant",
    "admin:capabilities:revoke"
  ]);
  assert.deepEqual(matrix.automationActions["serviceToken.revoke"], ["admin:capabilities:revoke"]);
});

test("getRouteCapabilityRequirements resolves capability-grant routes by method", () => {
  assert.deepEqual(
    getRouteCapabilityRequirements("GET", "/admin/capability-grants"),
    ["admin:capabilities:read"]
  );
  assert.deepEqual(
    getRouteCapabilityRequirements("POST", "/admin/capability-grants"),
    ["admin:capabilities:grant"]
  );
  assert.deepEqual(
    getRouteCapabilityRequirements("POST", "/admin/capability-grants/grant-abc/revoke"),
    ["admin:capabilities:revoke"]
  );
  assert.deepEqual(
    getRouteCapabilityRequirements("GET", "/admin/service-tokens"),
    ["admin:capabilities:read"]
  );
  assert.deepEqual(
    getRouteCapabilityRequirements("POST", "/admin/service-tokens"),
    ["admin:capabilities:grant"]
  );
  assert.deepEqual(
    getRouteCapabilityRequirements("POST", "/admin/service-tokens/grant-abc/rotate"),
    ["admin:capabilities:grant", "admin:capabilities:revoke"]
  );
  assert.deepEqual(
    getRouteCapabilityRequirements("POST", "/admin/service-tokens/grant-abc/revoke"),
    ["admin:capabilities:revoke"]
  );
});
