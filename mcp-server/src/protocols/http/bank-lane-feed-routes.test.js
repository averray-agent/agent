import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createBankLaneFeedRoutes } from "./bank-lane-feed-routes.js";

function harness() {
  const calls = [];
  const payload = {
    position: { raw: "100000", source: "erc20:aUSDC.balanceOf(account)", readAtMs: 1, lastError: null },
    float: { raw: "28463", source: "substrate_tokens:Tokens.accounts(account,22)", readAtMs: 2, lastError: null },
    postage: { raw: "15100000000", source: "substrate_system:System.account(account)", readAtMs: 3, lastError: null },
    requests: { items: [], readAtMs: 4, lastError: null },
    calibration: null
  };
  const route = createBankLaneFeedRoutes({
    bankLaneFeed: {
      async getFeed() {
        calls.push("getFeed");
        return payload;
      }
    },
    respond(response, statusCode, body) {
      calls.push("respond");
      response.statusCode = statusCode;
      response.body = body;
    }
  });
  return { calls, payload, route };
}

test("GET /monitor/bank-feed is read-only and requires no credential middleware", async () => {
  const { calls, payload, route } = harness();
  const response = {};
  assert.equal(await route({
    request: { method: "GET" },
    response,
    pathname: "/monitor/bank-feed"
  }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, payload);
  assert.deepEqual(calls, ["getFeed", "respond"]);
});

test("Bank feed route ignores mutations and unrelated paths", async () => {
  const { calls, route } = harness();
  assert.equal(await route({
    request: { method: "POST" },
    response: {},
    pathname: "/monitor/bank-feed"
  }), false);
  assert.equal(await route({
    request: { method: "GET" },
    response: {},
    pathname: "/admin/status"
  }), false);
  assert.deepEqual(calls, []);
});

test("public Caddy ingress cannot reach the internal credential-free Bank feed", async () => {
  const caddy = await readFile(
    new URL("../../../../deploy/Caddyfile.averray", import.meta.url),
    "utf8"
  );
  assert.match(caddy, /handle \/api\/monitor\/bank-feed\* \{\s+respond 404\s+\}/u);
  assert.match(caddy, /handle \/monitor\/bank-feed\* \{\s+respond 404\s+\}/u);
});
