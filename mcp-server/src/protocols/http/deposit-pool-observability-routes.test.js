import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createDepositPoolObservabilityRoutes } from "./deposit-pool-observability-routes.js";

test("GET /monitor/deposit-pool serves the internal read-only snapshot", async () => {
  const payload = { schemaVersion: 1, available: true };
  const response = {};
  const requests = [];
  const route = createDepositPoolObservabilityRoutes({
    depositPoolObservability: { async getSnapshot(request) { requests.push(request); return payload; } },
    respond(target, statusCode, body) {
      target.statusCode = statusCode;
      target.body = body;
    }
  });

  assert.equal(await route({ request: { method: "GET" }, response, pathname: "/monitor/deposit-pool" }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, payload);
  assert.deepEqual(requests, [{ poolAddress: undefined }]);
  assert.equal(await route({ request: { method: "POST" }, response: {}, pathname: "/monitor/deposit-pool" }), false);
});

test("GET /monitor/deposit-pool forwards an explicit legacy pool selector", async () => {
  const legacyPool = "0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30";
  const response = {};
  const route = createDepositPoolObservabilityRoutes({
    depositPoolObservability: {
      async getSnapshot({ poolAddress }) {
        return { schemaVersion: 1, available: true, pool: poolAddress };
      }
    },
    respond(target, statusCode, body) {
      target.statusCode = statusCode;
      target.body = body;
    }
  });

  const url = new URL(`http://localhost/monitor/deposit-pool?pool=${legacyPool}`);
  assert.equal(await route({ request: { method: "GET" }, response, url, pathname: url.pathname }), true);
  assert.deepEqual(response.body, { schemaVersion: 1, available: true, pool: legacyPool });
});

test("public Caddy ingress cannot reach the internal DepositPool snapshot", async () => {
  const caddy = await readFile(new URL("../../../../deploy/Caddyfile.averray", import.meta.url), "utf8");
  assert.match(caddy, /handle \/api\/monitor\/deposit-pool\* \{\s+respond 404\s+\}/u);
  assert.match(caddy, /handle \/monitor\/deposit-pool\* \{\s+respond 404\s+\}/u);
});
