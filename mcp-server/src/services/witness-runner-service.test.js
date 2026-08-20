import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import {
  GIT_PATCH_TESTS_PROFILE_REF,
  STRUCTURED_OUTPUT_EVIDENCE_PROFILE_REF,
  VerificationProfileRegistry
} from "./verification-profile-registry.js";
import {
  assertWitnessRunnerEnvironment,
  WitnessRunnerService
} from "./witness-runner-service.js";

const PROFILE_REGISTRY = new VerificationProfileRegistry();

async function queueRun(stateStore, runId = "verify-one") {
  const run = {
    runId,
    profile: "git-patch-tests-v1",
    profileVersion: 1,
    profileRef: "git-patch-tests-v1@1",
    customer: "0x1111111111111111111111111111111111111111",
    target: { repository: "github.com/example/project", commit: "1".repeat(40) },
    inputs: {
      gitBundle: { sha256: "2".repeat(64), bytes: 100, locator: { kind: "https", url: "https://example.test/source.bundle" }, format: "git-bundle" },
      patch: { sha256: "3".repeat(64), bytes: 50, locator: { kind: "https", url: "https://example.test/change.patch" }, format: "file" },
      testCommand: ["npm", "test"]
    },
    submittedAt: "2026-08-19T08:00:00.000Z",
    status: "queued",
    billing: { status: "authorized", amountRaw: "5000000", asset: "USDC" }
  };
  await stateStore.reserveVerificationRun(run, {
    paymentId: `payment-${runId}`,
    authorization: { id: `authorization-${runId}` }
  });
  return run;
}

function runnerDouble({ execute }) {
  return {
    async inspectAvailability() {
      return { status: "available" };
    },
    async validate() {},
    async run(input) {
      return execute(input);
    }
  };
}

test("two runner replicas atomically claim one queued verification exactly once", async () => {
  const stateStore = new MemoryStateStore();
  await queueRun(stateStore);
  let executions = 0;
  const runner = runnerDouble({
    execute: async () => {
      executions += 1;
      return { status: "decidable", evidence: "source_binding_verified tests_passed" };
    }
  });
  const common = {
    stateStore,
    runner,
    profileRegistry: PROFILE_REGISTRY,
    now: () => new Date("2026-08-19T08:00:01.000Z")
  };
  const first = new WitnessRunnerService({ ...common, owner: "runner-one" });
  const second = new WitnessRunnerService({ ...common, owner: "runner-two" });

  const results = await Promise.all([first.runOnce(), second.runOnce()]);
  assert.equal(executions, 1);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await stateStore.getVerificationRun("verify-one")).status, "executed");
});

test("runner failures become neutral runner_fault executions for backend finalization", async () => {
  const stateStore = new MemoryStateStore();
  await queueRun(stateStore);
  const service = new WitnessRunnerService({
    stateStore,
    profileRegistry: PROFILE_REGISTRY,
    runner: runnerDouble({ execute: async () => { throw new Error("sandbox host failed"); } }),
    owner: "runner-one",
    now: () => new Date("2026-08-19T08:00:01.000Z")
  });

  await service.runOnce();
  const run = await stateStore.getVerificationRun("verify-one");
  assert.equal(run.status, "executed");
  assert.equal(run.execution.status, "inconclusive");
  assert.equal(run.execution.reason, "runner_fault");
  assert.match(run.execution.detail, /sandbox host failed/u);
});

test("profile 2 cannot enter the profile-1 code sandbox", async () => {
  const stateStore = new MemoryStateStore();
  const mcpRun = await queueRun(stateStore, "verify-mcp");
  mcpRun.profile = "mcp-failure-semantics-v1";
  mcpRun.profileRef = "mcp-failure-semantics-v1@1";
  mcpRun.target = { endpoint: "https://mcp.example.test", transport: "streamable_http" };
  mcpRun.inputs = {};
  await stateStore.updateVerificationRun(mcpRun.runId, mcpRun);
  await queueRun(stateStore, "verify-git");
  const seen = [];
  const service = new WitnessRunnerService({
    stateStore,
    profileRegistry: PROFILE_REGISTRY,
    runner: runnerDouble({ execute: async ({ runId }) => {
      seen.push(runId);
      return { status: "decidable", evidence: "source_binding_verified tests_passed" };
    } }),
    owner: "profile-one-only"
  });

  await service.runOnce();
  assert.deepEqual(seen, ["verify-git"]);
  assert.equal((await stateStore.getVerificationRun("verify-mcp")).status, "queued");
  assert.equal((await stateStore.getVerificationRun("verify-git")).status, "executed");
});

test("profile 3 is routed to its structured-output runner and never the profile-1 code runner", async () => {
  const stateStore = new MemoryStateStore();
  const structuredRun = await queueRun(stateStore, "verify-structured");
  structuredRun.profile = "structured-output-evidence-v1";
  structuredRun.profileRef = STRUCTURED_OUTPUT_EVIDENCE_PROFILE_REF;
  structuredRun.target = { output: {}, schema: {}, sources: [{}] };
  structuredRun.inputs = {};
  await stateStore.updateVerificationRun(structuredRun.runId, structuredRun);
  const seen = [];
  const service = new WitnessRunnerService({
    stateStore,
    profileRegistry: PROFILE_REGISTRY,
    runnersByProfileRef: new Map([
      [GIT_PATCH_TESTS_PROFILE_REF, runnerDouble({ execute: async () => {
        throw new Error("profile 3 entered the profile-1 runner");
      } })],
      [STRUCTURED_OUTPUT_EVIDENCE_PROFILE_REF, runnerDouble({ execute: async ({ runId }) => {
        seen.push(runId);
        return { status: "decidable", evidence: "structured_output_integrity_pass" };
      } })]
    ]),
    owner: "profile-three-router"
  });

  await service.runOnce();
  assert.deepEqual(seen, ["verify-structured"]);
  assert.equal((await stateStore.getVerificationRun("verify-structured")).status, "executed");
});

test("runner accepts only minimal Redis and proxied Docker configuration", () => {
  assert.doesNotThrow(() => assertWitnessRunnerEnvironment({
    REDIS_URL: "redis://redis:6379",
    DOCKER_HOST: "tcp://witness-docker-proxy:2375",
    NODE_ENV: "production"
  }));
  assert.throws(
    () => assertWitnessRunnerEnvironment({
      REDIS_URL: "redis://redis:6379",
      DOCKER_HOST: "tcp://witness-docker-proxy:2375",
      KMS_KEY_ID: "forbidden",
      X402_VERIFY_MODE: "enabled"
    }),
    /forbidden credential or payment environment: KMS_KEY_ID, X402_VERIFY_MODE/u
  );
  assert.throws(
    () => assertWitnessRunnerEnvironment({ REDIS_URL: "redis://redis:6379", DOCKER_HOST: "unix:\/\/\/var\/run\/docker.sock" }),
    /internal Witness Docker proxy over TCP/u
  );
});
