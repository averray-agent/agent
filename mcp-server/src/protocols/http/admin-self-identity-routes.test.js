import assert from "node:assert/strict";
import test from "node:test";

import { AuthorizationError } from "../../core/errors.js";
import { MemoryStateStore } from "../../core/state-store.js";
import { SelfIdentityRegistry } from "../../core/self-identity-registry.js";
import { createAdminSelfIdentityRoutes } from "./admin-self-identity-routes.js";

const AUTH = { wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", roles: ["admin"] };
const OURS = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const stateStore = overrides.stateStore ?? new MemoryStateStore();
  const registry = new SelfIdentityRegistry();
  const route = createAdminSelfIdentityRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      if (overrides.deny) throw new AuthorizationError("Missing capability.");
      return overrides.auth ?? AUTH;
    },
    readJsonBody: async () => overrides.body ?? {
      action: "add", wallet: OURS, label: "dogfood", purpose: "dogfood", reason: "operator listed"
    },
    respond: (res, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
    service: { selfIdentityRegistry: registry },
    stateStore,
    logger: { info() {} }
  });
  return { calls, response, route, stateStore, registry };
}

test("ours edits ignore unrelated paths and require jobs:lifecycle", async () => {
  const { calls, response, route } = makeHarness();
  assert.equal(await route({
    request: { method: "POST" }, response, url: new URL("http://localhost/admin/status"), pathname: "/admin/status"
  }), false);
  assert.equal(await route({
    request: { method: "GET" }, response, url: new URL("http://localhost/admin/self-identity/ours"), pathname: "/admin/self-identity/ours"
  }), false);
  assert.deepEqual(calls, []);

  const denied = makeHarness({ deny: true });
  await assert.rejects(
    () => denied.route({
      request: { method: "POST" },
      response: denied.response,
      url: new URL("http://localhost/admin/self-identity/ours"),
      pathname: "/admin/self-identity/ours"
    }),
    (error) => error.name === "AuthorizationError"
  );
  assert.deepEqual(denied.calls, [["auth", { requireCapability: "jobs:lifecycle" }]]);
});

test("an ours edit is stored and applied to the live registry without echoing the wallet", async () => {
  const { calls, response, route, registry } = makeHarness();
  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/self-identity/ours"),
    pathname: "/admin/self-identity/ours"
  });
  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { action: "add", label: "dogfood", count: 1 });
  assert.equal(JSON.stringify(response.body).includes(OURS), false);
  assert.equal(registry.classify({ wallet: OURS }).actor, "self");
  assert.equal(registry.classify({ wallet: OURS }).evidence, "admin_ours_registry");
  assert.equal(calls[0][0], "auth");
});
