import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createDepositPoolObservabilityRoutes } from "./deposit-pool-observability-routes.js";

test("GET /monitor/deposit-pool serves the internal read-only snapshot", async () => {
  const payload = { schemaVersion: 1, available: true };
  const response = {};
  const route = createDepositPoolObservabilityRoutes({
    depositPoolObservability: { async getSnapshot() { return payload; } },
    respond(target, statusCode, body) {
      target.statusCode = statusCode;
      target.body = body;
    }
  });

  assert.equal(await route({ request: { method: "GET" }, response, pathname: "/monitor/deposit-pool" }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, payload);
  assert.equal(await route({ request: { method: "POST" }, response: {}, pathname: "/monitor/deposit-pool" }), false);
});

test("public Caddy ingress cannot reach the internal DepositPool snapshot", async () => {
  const caddy = await readFile(new URL("../../../../deploy/Caddyfile.averray", import.meta.url), "utf8");
  assert.match(caddy, /handle \/api\/monitor\/deposit-pool\* \{\s+respond 404\s+\}/u);
  assert.match(caddy, /handle \/monitor\/deposit-pool\* \{\s+respond 404\s+\}/u);
});
