import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import { McpProbeCoordinator } from "./mcp-probe-coordinator.js";

test("scoped endpoint credential exists only for the live dispatch and is never persisted or logged", async () => {
  const stateStore = new MemoryStateStore();
  const run = {
    runId: "verify-credential-one",
    profile: "mcp-failure-semantics-v1",
    profileVersion: 1,
    profileRef: "mcp-failure-semantics-v1@1",
    target: {
      endpoint: "https://mcp.example.test/run",
      transport: "streamable_http",
      auth: { scheme: "bearer", credentialRef: "customer-run-only" }
    },
    inputs: {},
    submittedAt: "2026-08-20T08:00:00.000Z",
    status: "queued"
  };
  await stateStore.reserveVerificationRun(run, { paymentId: "payment-one", authorization: { id: "authorization-one" } });
  const secret = "ephemeral-customer-secret-never-store";
  let releaseProbe;
  const loggerEntries = [];
  const coordinator = new McpProbeCoordinator({
    stateStore,
    owner: "mcp-test-runner",
    grantService: { async mint() { return { token: "signed-egress-grant" }; } },
    client: {
      async probe(payload) {
        assert.equal(payload.credential, secret);
        return new Promise((resolve) => { releaseProbe = resolve; });
      }
    },
    now: () => new Date("2026-08-20T08:00:01.000Z"),
    logger: { warn(entry, message) { loggerEntries.push({ entry, message }); } }
  });
  const profile = { ref: run.profileRef, version: 1, limits: { timeoutMs: 30_000 } };
  assert.equal(await coordinator.start({ run, profile, ephemeralCredential: secret }), true);
  assert.doesNotMatch(JSON.stringify(await stateStore.getVerificationRun(run.runId)), new RegExp(secret, "u"));
  assert.doesNotMatch(JSON.stringify(loggerEntries), new RegExp(secret, "u"));

  const task = coordinator.inFlight.get(run.runId);
  releaseProbe({
    status: "decidable",
    evidence: "mcp_auth_boundary_pass",
    report: { checks: [{ name: "auth-boundary", verdict: "pass", reason: "rejected", detail: "Rejected." }] }
  });
  await task;
  const stored = await stateStore.getVerificationRun(run.runId);
  assert.equal(stored.status, "executed");
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(secret, "u"));
  assert.doesNotMatch(JSON.stringify(coordinator), new RegExp(secret, "u"));
});
