import assert from "node:assert/strict";
import test from "node:test";
import { ValidationError } from "../../core/errors.js";
import { createPolicyRoutes } from "./policy-routes.js";

const AUTH = { wallet: "0xadmin", roles: ["admin"] };
const POLICY = { id: "policy-1", tag: "ops/sample@v1", state: "Active" };
const PROPOSAL = { id: "p-proposed-abcd1234", tag: "ops/proposed@v1", state: "Pending" };

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createPolicyRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return overrides.auth ?? AUTH;
    },
    buildPolicyProposal: (payload, auth) => {
      calls.push(["buildPolicyProposal", { payload, auth }]);
      return overrides.proposal ?? PROPOSAL;
    },
    eventBus: overrides.eventBus ?? {
      publish: (event) => {
        calls.push(["event", {
          ...event,
          id: event.id.replace(/-\d+$/u, "-<timestamp>"),
          timestamp: "<timestamp>",
        }]);
      },
    },
    findPolicy: (tag) => {
      calls.push(["findPolicy", tag]);
      return overrides.policy === undefined ? POLICY : overrides.policy;
    },
    listPolicies: () => {
      calls.push(["listPolicies"]);
      return overrides.policies ?? [POLICY];
    },
    policyService: {
      propose: (proposal) => {
        calls.push(["propose", proposal]);
      },
    },
    readJsonBody: async () => {
      calls.push(["body"]);
      return overrides.payload ?? { tag: "ops/proposed@v1" };
    },
    respond: (res, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
  });
  return { calls, response, route };
}

test("policy routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/not-policies"),
    pathname: "/not-policies",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /policies requires auth and returns all policies", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/policies"),
    pathname: "/policies",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, [POLICY]);
  assert.deepEqual(calls, [
    ["auth", undefined],
    ["listPolicies"],
    ["respond", { statusCode: 200, body: [POLICY] }],
  ]);
});

test("POST /policies requires admin auth, proposes, publishes, and returns created proposal", async () => {
  const payload = { tag: "ops/proposed@v1", title: "Proposed policy" };
  const { calls, response, route } = makeHarness({ payload });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/policies"),
    pathname: "/policies",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.body, PROPOSAL);
  assert.deepEqual(calls, [
    ["auth", { requireRole: "admin" }],
    ["body"],
    ["buildPolicyProposal", { payload, auth: AUTH }],
    ["propose", PROPOSAL],
    ["event", {
      id: "policy-proposal-p-proposed-abcd1234-<timestamp>",
      topic: "policy.proposed",
      wallet: AUTH.wallet,
      wallets: [AUTH.wallet],
      timestamp: "<timestamp>",
      data: { tag: PROPOSAL.tag, status: PROPOSAL.state },
    }],
    ["respond", { statusCode: 201, body: PROPOSAL }],
  ]);
});

test("GET /policies/:tag decodes tag and returns policy", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/policies/ops%2Fsample%40v1"),
    pathname: "/policies/ops%2Fsample%40v1",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, POLICY);
  assert.deepEqual(calls, [
    ["auth", undefined],
    ["findPolicy", "ops/sample@v1"],
    ["respond", { statusCode: 200, body: POLICY }],
  ]);
});

test("GET /policies/:tag returns not_found for unknown policies", async () => {
  const { calls, response, route } = makeHarness({ policy: null });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/policies/missing"),
    pathname: "/policies/missing",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { status: "not_found", tag: "missing" });
  assert.deepEqual(calls.slice(-2), [
    ["findPolicy", "missing"],
    ["respond", { statusCode: 404, body: { status: "not_found", tag: "missing" } }],
  ]);
});

test("GET /policies/ rejects empty policy tag path", async () => {
  const { response, route } = makeHarness();

  await assert.rejects(
    route({
      request: { method: "GET" },
      response,
      url: new URL("http://localhost/policies/"),
      pathname: "/policies/",
    }),
    (error) => error instanceof ValidationError
      && error.message === "policy tag path segment is required."
  );
});
