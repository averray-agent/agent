import assert from "node:assert/strict";
import test from "node:test";

import { createAdminL3PostingRoutes } from "./admin-l3-posting-routes.js";

function setup() {
  const calls = [];
  const responses = [];
  const keeper = {
    async list(options) { calls.push(["list", options]); return [{ id: "request-1" }]; },
    async listRefusals(options) { calls.push(["refusals", options]); return [{ reason: "l3_disabled" }]; },
    async enqueue(payload) { calls.push(["enqueue", payload]); return { id: "request-1" }; },
    async advance(id) { calls.push(["advance", id]); return { id, status: "posted" }; },
    async reconcile(id) { calls.push(["reconcile", id]); return { id, status: "repaid" }; },
    async sweep(payload) { calls.push(["sweep", payload]); return { processed: 1 }; }
  };
  const route = createAdminL3PostingRoutes({
    authMiddleware: async (_request, _url, options) => calls.push(["auth", options]),
    l3PostingKeeper: keeper,
    parseLimit: () => 25,
    readJsonBody: async (request) => request.body ?? {},
    respond: (_response, statusCode, body) => responses.push({ statusCode, body })
  });
  return { calls, responses, route };
}

test("admin L3 posting routes expose the durable queue and named-refusal log", async () => {
  const h = setup();
  assert.equal(await h.route({
    request: { method: "GET" }, response: {},
    url: new URL("https://api.example/admin/l3-posting/requests?status=posted"),
    pathname: "/admin/l3-posting/requests"
  }), true);
  assert.equal(await h.route({
    request: { method: "GET" }, response: {},
    url: new URL("https://api.example/admin/l3-posting/refusals?reason=l3_disabled"),
    pathname: "/admin/l3-posting/refusals"
  }), true);

  assert.deepEqual(h.calls, [
    ["auth", { requireRole: "admin" }],
    ["list", { borrower: undefined, status: "posted", limit: 25 }],
    ["auth", { requireRole: "admin" }],
    ["refusals", { reason: "l3_disabled", limit: 25 }]
  ]);
  assert.equal(h.responses[0].body.count, 1);
  assert.equal(h.responses[1].body.items[0].reason, "l3_disabled");
});

test("admin L3 posting mutations use the existing credit:originate capability", async () => {
  const h = setup();
  const requests = [
    ["/admin/l3-posting/requests", { termsHash: "0xterms" }],
    ["/admin/l3-posting/requests/request-1/advance", {}],
    ["/admin/l3-posting/requests/request-1/reconcile", {}],
    ["/admin/l3-posting/sweep", { limit: 5 }]
  ];
  for (const [pathname, body] of requests) {
    assert.equal(await h.route({
      request: { method: "POST", body }, response: {},
      url: new URL(`https://api.example${pathname}`), pathname
    }), true);
  }
  assert.equal(
    h.calls.filter(([name]) => name === "auth")
      .every(([, options]) => options.requireCapability === "credit:originate"),
    true
  );
  assert.deepEqual(h.calls.filter(([name]) => name !== "auth").map(([name]) => name), [
    "enqueue", "advance", "reconcile", "sweep"
  ]);
});

test("admin L3 posting routes ignore unrelated requests", async () => {
  const h = setup();
  assert.equal(await h.route({
    request: { method: "DELETE" }, response: {},
    url: new URL("https://api.example/admin/l3-posting/requests"),
    pathname: "/admin/l3-posting/requests"
  }), false);
  assert.deepEqual(h.calls, []);
});
