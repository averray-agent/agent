import assert from "node:assert/strict";
import test from "node:test";

import { createVerifyRoutes } from "./verify-routes.js";

const PROFILE = {
  name: "git-patch-tests-v1",
  version: 1,
  status: "published"
};
const PAYLOAD = {
  profile: PROFILE.name,
  profileVersion: PROFILE.version,
  target: { repository: "github.com/example/project", commit: "a".repeat(40) },
  inputs: {
    bundle: {
      sha256: "b".repeat(64),
      bytes: 12,
      locator: { kind: "https", url: "https://example.test/source.bundle" },
      format: "git-bundle"
    },
    patch: {
      sha256: "c".repeat(64),
      bytes: 8,
      locator: { kind: "https", url: "https://example.test/change.patch" },
      format: "file"
    },
    testCommand: ["npm", "test"]
  }
};

function harness({ paymentProof = "", run = undefined } = {}) {
  const calls = [];
  const response = {};
  const verificationRunService = {
    listProfiles: () => {
      calls.push("profiles");
      return [PROFILE];
    },
    getRun: async (runId) => {
      calls.push(["get", runId]);
      return run ?? { runId, status: "complete" };
    }
  };
  const x402VerifyIntake = {
    paymentRequired: (payload) => {
      calls.push(["challenge", payload]);
      return {
        statusCode: 402,
        body: { error: "Payment required." },
        headers: { "payment-required": "challenge" }
      };
    },
    run: async (input) => {
      calls.push(["run", input]);
      return { statusCode: 200, body: run ?? { status: "complete" }, headers: {} };
    }
  };
  const route = createVerifyRoutes({
    enforceLimit: async (...input) => calls.push(["limit", ...input]),
    rateLimitConfig: { verifyRuns: { limit: 10, windowSeconds: 60 } },
    readJsonBody: async () => PAYLOAD,
    respond: (target, statusCode, body, headers = {}) => {
      target.statusCode = statusCode;
      target.body = body;
      target.headers = headers;
    },
    verificationRunService,
    x402VerifyIntake
  });
  const request = {
    method: "POST",
    headers: paymentProof ? { "payment-signature": paymentProof } : {},
    socket: { remoteAddress: "192.0.2.10" }
  };
  return { calls, request, response, route };
}

test("GET /verify/profiles is public and exposes only the published first profile", async () => {
  const { calls, response, route } = harness();
  assert.equal(await route({ request: { method: "GET" }, response, pathname: "/verify/profiles" }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { profiles: [PROFILE] });
  assert.deepEqual(calls, ["profiles"]);
});

test("unpaid POST /verify/runs returns 402 and never starts verification work", async () => {
  const { calls, request, response, route } = harness();
  assert.equal(await route({ request, response, pathname: "/verify/runs" }), true);
  assert.equal(response.statusCode, 402);
  assert.equal(response.headers["payment-required"], "challenge");
  assert.equal(calls.filter((entry) => Array.isArray(entry) && entry[0] === "run").length, 0);
});

test("paid POST /verify/runs and GET /verify/runs/:runId expose the standalone run", async () => {
  const runId = `verify_${"d".repeat(64)}`;
  const completed = { runId, status: "complete", verdict: { outcome: "approved" } };
  const { calls, request, response, route } = harness({ paymentProof: "signed", run: completed });
  assert.equal(await route({ request, response, pathname: "/verify/runs" }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, completed);
  assert.equal(calls.filter((entry) => Array.isArray(entry) && entry[0] === "run").length, 1);

  const getResponse = {};
  assert.equal(await route({
    request: { method: "GET" },
    response: getResponse,
    pathname: `/verify/runs/${runId}`
  }), true);
  assert.equal(getResponse.statusCode, 200);
  assert.deepEqual(getResponse.body, completed);
});
