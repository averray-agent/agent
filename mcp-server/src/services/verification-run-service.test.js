import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import { VerificationProfileRegistry } from "./verification-profile-registry.js";
import { GitPatchTestsRunner } from "./git-patch-tests-runner.js";
import { VerifierRegistry } from "./verifier-handlers.js";
import {
  UnavailableVerificationPaymentGate,
  VerificationRunService
} from "./verification-run-service.js";

const CUSTOMER = "0x1111111111111111111111111111111111111111";
const TARGET = {
  repository: "github.com/example/project",
  commit: "1".repeat(40)
};
const INPUTS = {
  gitBundle: { sha256: "2".repeat(64), bytes: 100, locator: { kind: "https", url: "https://example.test/source.bundle" }, format: "git-bundle" },
  patch: { sha256: "3".repeat(64), bytes: 50, locator: { kind: "https", url: "https://example.test/change.patch" }, format: "file" },
  testCommand: ["npm", "test"]
};

function request(paymentProof = "proof-1") {
  return {
    profile: "git-patch-tests-v1",
    profileVersion: 1,
    target: TARGET,
    inputs: INPUTS,
    paymentProof
  };
}

function paymentGate() {
  const calls = { authorize: 0, capture: 0, release: 0 };
  return {
    calls,
    async authorize({ paymentProof }) {
      calls.authorize += 1;
      if (!paymentProof) return new UnavailableVerificationPaymentGate().authorize({});
      return {
        id: `authorization:${paymentProof}`,
        customer: CUSTOMER,
        amountRaw: "5000000",
        asset: "USDC",
        network: "eip155:8453"
      };
    },
    async capture() {
      calls.capture += 1;
      return { transactionHash: `0x${"4".repeat(64)}` };
    },
    async release() {
      calls.release += 1;
    }
  };
}

function harness({ runnerResult, runnerError, runner: runnerOverride, gate = paymentGate(), ids = ["one", "two"], profileRegistry = new VerificationProfileRegistry(), verifierRegistry } = {}) {
  const runnerCalls = [];
  const runner = runnerOverride ?? {
    validate() {},
    async run(input) {
      runnerCalls.push(input);
      if (runnerError) throw runnerError;
      return runnerResult ?? {
        status: "decidable",
        evidence: "source_binding_verified tests_passed",
        artifactHash: `0x${"3".repeat(64)}`,
        sourceBinding: {
          method: "git-bundle",
          verified: true,
          ref: TARGET.commit,
          bundleHash: `0x${"2".repeat(64)}`
        },
        report: { verdict: "PASS" },
        environment: { kind: "test" }
      };
    }
  };
  let idIndex = 0;
  const stateStore = new MemoryStateStore();
  const service = new VerificationRunService({
    stateStore,
    profileRegistry,
    runner,
    paymentGate: gate,
    verifierRegistry,
    now: () => new Date("2026-08-18T12:00:00.000Z"),
    randomUUIDImpl: () => ids[idIndex++] ?? `id-${idIndex}`,
    publicReceiptBaseUrl: "https://averray.com"
  });
  return { gate, runnerCalls, service, stateStore };
}

function assertNoSettlementPath(source) {
  const forbidden = [
    /from\s+["']\.\/verifier-service\.js["']/u,
    /from\s+["'][^"']*blockchain\/gateway\.js["']/u,
    /\bresolveSinglePayout\b/u,
    /\bingestVerification\b/u,
    /\bVerifierService\b/u
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern, `standalone Verify reached forbidden settlement dependency ${pattern}`);
  }
}

test("no-settlement isolation guard rejects a deliberately wired settlement import", () => {
  const source = readFileSync(new URL("./verification-run-service.js", import.meta.url), "utf8");
  assertNoSettlementPath(source);

  const deliberatelyMutated = `import { VerifierService } from "./verifier-service.js";\n${source}`;
  assert.throws(
    () => assertNoSettlementPath(deliberatelyMutated),
    /forbidden settlement dependency/u
  );
});

test("published profile is immutable and pinned re-runs reproduce verdict and receipt id", async () => {
  const profileRegistry = new VerificationProfileRegistry();
  const profile = profileRegistry.get("git-patch-tests-v1", 1);
  assert.throws(() => { profile.price.amount = "9"; }, TypeError);
  assert.throws(() => profileRegistry.publish(structuredClone(profile)), /already published.*cannot be changed/u);

  const { service } = harness();
  const first = await service.createRun(request("proof-a"));
  const replay = await service.createRun(request("proof-b"));
  assert.equal(first.verdict.outcome, "approved");
  assert.equal(replay.verdict.outcome, first.verdict.outcome);
  assert.equal(replay.receiptId, first.receiptId);
  assert.equal(first.profileRef, "git-patch-tests-v1@1");
});

test("inconclusive is never billed and never presents as an artifact failure", async () => {
  const { gate, service, stateStore } = harness({
    runnerResult: {
      status: "inconclusive",
      reason: "flaky",
      detail: "The two bounded repetitions disagreed."
    }
  });
  const run = await service.createRun(request());
  const receipt = await stateStore.getWorkReceiptDocument(run.receiptId);

  assert.equal(run.status, "complete");
  assert.equal(run.verdict.outcome, "inconclusive");
  assert.equal(run.verdict.reason, "flaky");
  assert.notEqual(run.verdict.outcome, "rejected");
  assert.equal(run.billing.status, "not_billed");
  assert.equal(gate.calls.capture, 0);
  assert.equal(gate.calls.release, 1);
  assert.equal(receipt.intent.valueAtRisk.amountRaw, "0");
  assert.equal(Object.hasOwn(receipt, "settlement"), false);
});

test("a broken runner is classified as inconclusive runner_fault, never fail", async () => {
  const { gate, service } = harness({ runnerError: new Error("runner exploded") });
  const run = await service.createRun(request());

  assert.equal(run.verdict.outcome, "inconclusive");
  assert.equal(run.verdict.reason, "runner_fault");
  assert.match(run.verdict.detail, /runner exploded/u);
  assert.equal(run.billing.status, "not_billed");
  assert.equal(gate.calls.capture, 0);
});

test("timeouts and declared resource-limit breaches are inconclusive and not billed", async () => {
  const baseProfile = new VerificationProfileRegistry().get("git-patch-tests-v1", 1);
  const shortProfile = structuredClone(baseProfile);
  shortProfile.limits.timeoutMs = 5;
  const shortRegistry = new VerificationProfileRegistry({ profiles: [shortProfile] });
  const slowRunner = {
    validate() {},
    async run() {
      return new Promise((resolve) => setTimeout(() => resolve({
        status: "decidable",
        evidence: "source_binding_verified tests_passed"
      }), 30));
    }
  };
  const timeout = harness({ runner: slowRunner, profileRegistry: shortRegistry });
  const timedOut = await timeout.service.createRun(request("timeout-proof"));
  assert.equal(timedOut.verdict.outcome, "inconclusive");
  assert.equal(timedOut.verdict.reason, "runner_fault");
  assert.equal(timedOut.billing.status, "not_billed");
  assert.equal(timeout.gate.calls.capture, 0);

  const resource = harness({ runner: new GitPatchTestsRunner() });
  const oversized = structuredClone(request("oversized-proof"));
  oversized.inputs.gitBundle.bytes = 30 * 1024 * 1024;
  const limited = await resource.service.createRun(oversized);
  assert.equal(limited.verdict.outcome, "inconclusive");
  assert.equal(limited.verdict.reason, "runner_fault");
  assert.equal(limited.billing.status, "not_billed");
  assert.equal(resource.gate.calls.capture, 0);
});

test("payment gates work and a replayed proof cannot buy a second run", async () => {
  const unpaidRunner = { validate() {}, async run() { assert.fail("unpaid request performed work"); } };
  const unpaidService = new VerificationRunService({
    stateStore: new MemoryStateStore(),
    profileRegistry: new VerificationProfileRegistry(),
    runner: unpaidRunner
  });
  await assert.rejects(
    () => unpaidService.createRun(request(undefined)),
    (error) => error.statusCode === 402 && error.code === "verification_payment_required"
  );

  const { gate, runnerCalls, service } = harness();
  const first = await service.createRun(request("same-proof"));
  const replay = await service.createRun(request("same-proof"));
  assert.equal(replay.runId, first.runId);
  assert.equal(runnerCalls.length, 1);
  assert.equal(gate.calls.authorize, 1);
  assert.equal(gate.calls.capture, 1);
});

test("capture failure degrades a decisive result to inconclusive, bills nothing, and releases", async () => {
  const gate = paymentGate();
  gate.capture = async () => {
    gate.calls.capture += 1;
    throw new Error("Base capture unavailable");
  };
  const { service } = harness({ gate });
  const run = await service.createRun(request("capture-failure-proof"));

  assert.equal(run.verdict.outcome, "inconclusive");
  assert.equal(run.verdict.reason, "runner_fault");
  assert.match(run.verdict.detail, /Base capture unavailable/u);
  assert.equal(run.billing.status, "not_billed");
  assert.equal(gate.calls.capture, 1);
  assert.equal(gate.calls.release, 1);
});

test("standalone verification completes with a gateway double whose every method throws", async () => {
  const throwingGateway = new Proxy({}, {
    get(_target, property) {
      return () => { throw new Error(`forbidden gateway method ${String(property)}`); };
    }
  });
  assert.throws(() => throwingGateway.anyMethod(), /forbidden gateway method/u);

  const verifierRegistry = new VerifierRegistry({ gateway: throwingGateway });
  const { service } = harness({ verifierRegistry });
  const run = await service.createRun(request("isolated-proof"));

  assert.equal(run.verdict.outcome, "approved");
  assert.equal(run.billing.status, "captured");
});
