import test from "node:test";
import assert from "node:assert/strict";

import { capabilityMatrix, resolveCapabilities } from "./capabilities.js";

test("resolveCapabilities returns base capabilities for signed-in wallets", () => {
  const capabilities = resolveCapabilities({ roles: [] });
  assert.ok(capabilities.includes("jobs:claim"));
  assert.ok(capabilities.includes("session:timeline"));
  assert.ok(capabilities.includes("xcm:read"));
});

test("resolveCapabilities expands admin and verifier capabilities", () => {
  const capabilities = resolveCapabilities({ roles: ["admin", "verifier"] });
  assert.ok(capabilities.includes("jobs:create"));
  assert.ok(capabilities.includes("jobs:pause-recurring"));
  assert.ok(capabilities.includes("verifier:run"));
  assert.ok(capabilities.includes("subjobs:create"));
  assert.ok(capabilities.includes("xcm:observe"));
  assert.ok(capabilities.includes("xcm:finalize"));
});

test("capabilityMatrix exposes base and role capability groups", () => {
  const matrix = capabilityMatrix();
  assert.ok(matrix.base.includes("jobs:list"));
  assert.ok(matrix.base.includes("jobs:submit"));
  assert.ok(matrix.roles.admin.includes("jobs:fire-recurring"));
  assert.ok(matrix.roles.admin.includes("xcm:observe"));
  assert.ok(matrix.roles.admin.includes("xcm:finalize"));
  assert.ok(matrix.roles.verifier.includes("verifier:replay"));
  assert.deepEqual(matrix.routes["/admin/jobs/pause"], ["jobs:pause-recurring"]);
  assert.deepEqual(matrix.routes["/admin/xcm/observe"], ["xcm:observe"]);
  assert.deepEqual(matrix.routes["/admin/xcm/finalize"], ["xcm:finalize"]);
});
