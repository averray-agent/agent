import assert from "node:assert/strict";
import test from "node:test";

import { createAdminPlatformFaultRemediationRoutes } from "./admin-platform-fault-remediation-routes.js";

test("GET /admin/platform-fault-remediations exposes only the internal hardware-signing queue", async () => {
  const calls = [];
  const response = {};
  const item = {
    id: "platform-fault-abc",
    status: "awaiting_hardware_arbitrator",
    workerInitiated: false,
    resolution: {
      method: "resolveDispute",
      workerPayoutRaw: "7700000",
      transaction: { data: "0x1234" }
    }
  };
  const route = createAdminPlatformFaultRemediationRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
    },
    parseLimit: () => 25,
    respond: (res, statusCode, body) => {
      res.statusCode = statusCode;
      res.body = body;
    },
    stateStore: {
      async listPlatformFaultRemediations(options) {
        calls.push(["list", options]);
        return [item];
      }
    }
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("https://api.example.test/admin/platform-fault-remediations"),
    pathname: "/admin/platform-fault-remediations"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.items, [item]);
  assert.equal(response.body.scope, "internal");
  assert.equal(response.body.execution, "out_of_band_hardware");
  assert.equal(response.body.workerInitiated, false);
  assert.deepEqual(calls, [
    ["auth", { requireCapability: "ops:view" }],
    ["list", { status: "awaiting_hardware_arbitrator", limit: 25 }]
  ]);
});

test("platform-fault remediation route ignores unrelated and mutating requests", async () => {
  const route = createAdminPlatformFaultRemediationRoutes({
    authMiddleware: async () => { throw new Error("must not authenticate"); },
    parseLimit: () => 25,
    respond: () => {},
    stateStore: {}
  });

  assert.equal(await route({
    request: { method: "POST" },
    response: {},
    url: new URL("https://api.example.test/admin/platform-fault-remediations"),
    pathname: "/admin/platform-fault-remediations"
  }), false);
});
