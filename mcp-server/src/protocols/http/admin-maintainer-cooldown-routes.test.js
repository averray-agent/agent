import assert from "node:assert/strict";
import test from "node:test";

import { createAdminMaintainerCooldownRoutes } from "./admin-maintainer-cooldown-routes.js";
import { AuthorizationError } from "../../core/errors.js";

const AUTH = { wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", roles: ["admin"] };

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createAdminMaintainerCooldownRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      if (overrides.deny) throw new AuthorizationError("Missing capability.");
      return overrides.auth ?? AUTH;
    },
    readJsonBody: async () => {
      calls.push(["body"]);
      return overrides.body ?? { reason: "maintainer confirmed resume" };
    },
    respond: (res, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
    service: {
      clearMaintainerRepoCooldown: async (input) => {
        calls.push(["clear", input]);
        if (overrides.clear) return overrides.clear(input);
        return { repoId: input.repoId, cleared: true, cooldownUntil: null, cooldownReason: null, closeCount30d: 0 };
      }
    }
  });
  return { calls, response, route };
}

test("cooldown clear ignores unrelated paths and non-POST methods", async () => {
  const { calls, response, route } = makeHarness();
  assert.equal(await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/github/status"),
    pathname: "/admin/github/status"
  }), false);
  assert.equal(await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/maintainer-repos/424242/cooldown/clear"),
    pathname: "/admin/maintainer-repos/424242/cooldown/clear"
  }), false);
  assert.equal(await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/maintainer-repos/old-name/cooldown/clear"),
    pathname: "/admin/maintainer-repos/old-name/cooldown/clear"
  }), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("POST cooldown clear requires jobs:lifecycle and does not clear without it", async () => {
  const denied = makeHarness({ deny: true });
  await assert.rejects(
    () => denied.route({
      request: { method: "POST" },
      response: denied.response,
      url: new URL("http://localhost/admin/maintainer-repos/424242/cooldown/clear"),
      pathname: "/admin/maintainer-repos/424242/cooldown/clear"
    }),
    (error) => error.name === "AuthorizationError"
  );
  assert.deepEqual(denied.calls, [["auth", { requireCapability: "jobs:lifecycle" }]]);

  const { calls, response, route } = makeHarness();
  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/maintainer-repos/424242/cooldown/clear"),
    pathname: "/admin/maintainer-repos/424242/cooldown/clear"
  });
  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.stringify(response.body).includes(AUTH.wallet), false);
  assert.deepEqual(calls, [
    ["auth", { requireCapability: "jobs:lifecycle" }],
    ["body"],
    ["clear", { repoId: 424242, actor: AUTH.wallet, reason: "maintainer confirmed resume" }],
    ["respond", {
      statusCode: 200,
      body: { repoId: 424242, cleared: true, cooldownUntil: null, cooldownReason: null, closeCount30d: 0 }
    }]
  ]);
});
