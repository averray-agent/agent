import assert from "node:assert/strict";
import test from "node:test";

import { createVerifyRoutes } from "./verify-routes.js";

function harness() {
  const calls = [];
  const response = {};
  const route = createVerifyRoutes({
    enforceLimit: async (...args) => calls.push(["limit", ...args]),
    rateLimitConfig: { verifierRun: { limit: 5, windowSeconds: 60 } },
    readJsonBody: async () => ({
      profile: "git-patch-tests-v1",
      profileVersion: 1,
      target: { repository: "repo", commit: "a".repeat(40) },
      inputs: { testCommand: ["npm", "test"] }
    }),
    respond: (target, statusCode, body, headers) => Object.assign(target, { statusCode, body, headers }),
    verificationRunService: {
      listProfiles: () => [{ name: "git-patch-tests-v1", version: 1 }],
      getRun: async (runId) => ({ runId, status: "complete" }),
      createRun: async (input) => {
        calls.push(["createRun", input]);
        return { runId: "verify-1", status: "complete" };
      }
    }
  });
  return { calls, response, route };
}

test("GET /verify/profiles is public and cacheable", async () => {
  const { response, route } = harness();
  assert.equal(await route({ request: { method: "GET" }, response, pathname: "/verify/profiles" }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { profiles: [{ name: "git-patch-tests-v1", version: 1 }] });
  assert.equal(response.headers["cache-control"], "public, max-age=300");
});

test("POST /verify/runs forwards only the generic payment boundary and run request", async () => {
  const { calls, response, route } = harness();
  const request = {
    method: "POST",
    headers: { "verification-payment": "proof" },
    socket: { remoteAddress: "127.0.0.1" }
  };
  assert.equal(await route({ request, response, pathname: "/verify/runs" }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(calls.filter(([name]) => name === "createRun").length, 1);
  assert.equal(calls.find(([name]) => name === "createRun")[1].paymentProof, "proof");
});

test("GET /verify/runs/:runId polls by opaque run id", async () => {
  const { response, route } = harness();
  assert.equal(await route({ request: { method: "GET" }, response, pathname: "/verify/runs/verify-1" }), true);
  assert.deepEqual(response.body, { runId: "verify-1", status: "complete" });
});
