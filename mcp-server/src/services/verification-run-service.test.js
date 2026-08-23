import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import { VerificationProfileRegistry } from "./verification-profile-registry.js";
import { decorateVerificationRunPresentation } from "../core/verdict-presentation.js";
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

function mcpRequest(paymentProof = "mcp-proof") {
  return {
    profile: "mcp-failure-semantics-v1",
    profileVersion: 1,
    target: { endpoint: "https://mcp.example.test/run", transport: "streamable_http" },
    inputs: {},
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

function harness({ runnerResult, runnerError, runner: runnerOverride, gate = paymentGate(), ids = ["one", "two"], profileRegistry = new VerificationProfileRegistry(), verifierRegistry, clock = { now: new Date("2026-08-18T12:00:00.000Z") } } = {}) {
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
    paymentGate: gate,
    verifierRegistry,
    now: () => new Date(clock.now),
    randomUUIDImpl: () => ids[idIndex++] ?? `id-${idIndex}`,
    publicReceiptBaseUrl: "https://averray.com",
    runnerTimeoutMarginMs: 10,
    finalizerId: "test-finalizer"
  });
  return { clock, gate, profileRegistry, runner, runnerCalls, service, stateStore };
}

async function executeAndFinalize(context) {
  const run = await context.stateStore.claimNextVerificationRun({
    owner: "test-runner",
    claimedAt: context.clock.now.toISOString(),
    leaseSeconds: 60
  });
  assert.ok(run, "a queued verification run should be available to the isolated runner");
  const profile = context.profileRegistry.get(run.profile, run.profileVersion);
  await context.runner.validate?.({ profile, target: run.target, inputs: run.inputs });
  let execution;
  try {
    execution = await context.runner.run({
      profile,
      runId: run.runId,
      target: run.target,
      inputs: run.inputs
    });
  } catch (error) {
    execution = {
      status: "inconclusive",
      reason: "runner_fault",
      detail: error?.message ?? String(error)
    };
  }
  await context.stateStore.storeVerificationRunExecution(run.runId, {
    owner: "test-runner",
    execution,
    executedAt: context.clock.now.toISOString()
  });
  const finalized = await context.service.finalizeAvailableRuns();
  assert.equal(finalized.length, 1);
  return context.service.getRun(run.runId);
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

test("published profile is immutable and queued re-runs reproduce verdict and receipt id", async () => {
  const profileRegistry = new VerificationProfileRegistry();
  const profile = profileRegistry.get("git-patch-tests-v1", 1);
  assert.throws(() => { profile.price.amount = "9"; }, TypeError);
  assert.throws(() => profileRegistry.publish(structuredClone(profile)), /already published.*cannot be changed/u);

  const firstHarness = harness({ profileRegistry, ids: ["first"] });
  await firstHarness.service.createRun(request("proof-a"));
  const first = await executeAndFinalize(firstHarness);
  const replayHarness = harness({ profileRegistry, ids: ["second"] });
  await replayHarness.service.createRun(request("proof-b"));
  const replay = await executeAndFinalize(replayHarness);
  assert.equal(first.verdict.outcome, "approved");
  assert.equal(replay.verdict.outcome, first.verdict.outcome);
  assert.equal(replay.receiptId, first.receiptId);
  assert.equal(first.profileRef, "git-patch-tests-v1@1");
});

test("inconclusive is never billed and never presents as an artifact failure", async () => {
  const context = harness({
    runnerResult: {
      status: "inconclusive",
      reason: "flaky",
      detail: "The two bounded repetitions disagreed."
    }
  });
  const queued = await context.service.createRun(request());
  assert.equal(queued.status, "queued");
  const run = await executeAndFinalize(context);
  const receipt = await context.stateStore.getWorkReceiptDocument(run.receiptId);

  assert.equal(run.status, "complete");
  assert.equal(run.verdict.outcome, "inconclusive");
  assert.equal(run.verdict.reason, "flaky");
  assert.notEqual(run.verdict.outcome, "rejected");
  assert.equal(run.billing.status, "not_billed");
  assert.equal(context.gate.calls.capture, 0);
  assert.equal(context.gate.calls.release, 1);
  assert.equal(receipt.intent.valueAtRisk.amountRaw, "0");
  assert.equal(Object.hasOwn(receipt, "settlement"), false);
});

test("MCP target, TLS, and auth inability outcomes are never billed or converted to fail", async () => {
  for (const [reason, detail] of [
    ["target_unreachable", "The declared endpoint could not be reached."],
    ["target_unreachable", "The TLS handshake could not be validated."],
    ["ambiguous_evidence", "The scoped endpoint authentication could not be completed."]
  ]) {
    const context = harness({ runnerResult: { status: "inconclusive", reason, detail } });
    await context.service.createRun(mcpRequest(`proof-${detail}`));
    const run = await executeAndFinalize(context);
    assert.equal(run.verdict.outcome, "inconclusive");
    assert.notEqual(run.verdict.outcome, "rejected");
    assert.equal(run.billing.status, "not_billed");
    assert.equal(context.gate.calls.capture, 0);
    assert.equal(context.gate.calls.release, 1);
  }
});

test("MCP egress boundary faults are platform_fault and never billed", async () => {
  const context = harness({
    runnerResult: {
      status: "platform_fault",
      reason: "runner_fault",
      detail: "The egress boundary refused an undeclared destination."
    }
  });
  await context.service.createRun(mcpRequest("egress-fault-proof"));
  const run = await executeAndFinalize(context);
  assert.equal(run.verdict.outcome, "platform_fault");
  assert.equal(run.billing.status, "not_billed");
  assert.equal(context.gate.calls.capture, 0);
});

test("MCP endpoint cannot smuggle a credential into durable URL fields or mismatch its transport", async () => {
  for (const [endpoint, transport] of [
    ["https://secret@mcp.example.test/run", "streamable_http"],
    ["https://mcp.example.test/run?token=secret", "streamable_http"],
    ["wss://mcp.example.test/run", "streamable_http"],
    ["https://mcp.example.test/run", "websocket"]
  ]) {
    const context = harness();
    await assert.rejects(
      () => context.service.createRun({ ...mcpRequest("boundary-proof"), target: { endpoint, transport } }),
      /must not embed|transport must pair/u
    );
    assert.equal(context.gate.calls.authorize, 0);
    assert.equal((await context.stateStore.listActiveVerificationRuns()).length, 0);
  }
});

test("a broken runner is classified as inconclusive runner_fault, never fail", async () => {
  const context = harness({ runnerError: new Error("runner exploded") });
  await context.service.createRun(request());
  const run = await executeAndFinalize(context);

  assert.equal(run.verdict.outcome, "inconclusive");
  assert.equal(run.verdict.reason, "runner_fault");
  assert.match(run.verdict.detail, /runner exploded/u);
  assert.equal(run.billing.status, "not_billed");
  assert.equal(context.gate.calls.capture, 0);
});

test("an absent runner ages a queued request to runner_fault without billing or harming backend reads", async () => {
  const baseProfile = new VerificationProfileRegistry().get("git-patch-tests-v1", 1);
  const shortProfile = structuredClone(baseProfile);
  shortProfile.limits.timeoutMs = 5;
  const shortRegistry = new VerificationProfileRegistry({ profiles: [shortProfile] });
  const timeout = harness({ profileRegistry: shortRegistry });
  const queued = await timeout.service.createRun(request("timeout-proof"));
  timeout.clock.now = new Date(timeout.clock.now.getTime() + 16);
  const finalized = await timeout.service.finalizeAvailableRuns();
  assert.equal(finalized.length, 1);
  const timedOut = await timeout.service.getRun(queued.runId);
  assert.equal(timedOut.verdict.outcome, "inconclusive");
  assert.equal(timedOut.verdict.reason, "runner_fault");
  assert.match(timedOut.verdict.detail, /No isolated verification runner claimed/u);
  assert.doesNotMatch(timedOut.verdict.detail, /evidence/u);
  assert.equal(timedOut.billing.status, "not_billed");
  assert.equal(timeout.gate.calls.capture, 0);
  assert.equal((await timeout.service.getRun(queued.runId)).status, "complete");
});

test("a wedged claimed run ages out independently of its runner lease and rejects a late result", async () => {
  const baseProfile = new VerificationProfileRegistry().get("git-patch-tests-v1", 1);
  const shortProfile = structuredClone(baseProfile);
  shortProfile.limits.timeoutMs = 5;
  const context = harness({ profileRegistry: new VerificationProfileRegistry({ profiles: [shortProfile] }) });
  const queued = await context.service.createRun(request("wedged-proof"));
  await context.stateStore.claimNextVerificationRun({
    owner: "wedged-runner",
    claimedAt: context.clock.now.toISOString(),
    leaseSeconds: 180
  });
  context.clock.now = new Date(context.clock.now.getTime() + 16);

  const finalized = await context.service.finalizeAvailableRuns();
  assert.equal(finalized.length, 1);
  const completed = await context.service.getRun(queued.runId);
  assert.equal(completed.status, "complete");
  assert.equal(completed.verdict.reason, "runner_fault");
  assert.equal(completed.billing.status, "not_billed");
  assert.equal(context.gate.calls.capture, 0);
  assert.equal(await context.stateStore.storeVerificationRunExecution(queued.runId, {
    owner: "wedged-runner",
    executedAt: context.clock.now.toISOString(),
    execution: { status: "decidable", evidence: "source_binding_verified tests_passed" }
  }), undefined);
});

test("payment gates work and a replayed proof cannot buy a second run", async () => {
  const unpaidService = new VerificationRunService({
    stateStore: new MemoryStateStore(),
    profileRegistry: new VerificationProfileRegistry()
  });
  await assert.rejects(
    () => unpaidService.createRun(request(undefined)),
    (error) => error.statusCode === 402 && error.code === "verification_payment_required"
  );

  const context = harness();
  const first = await context.service.createRun(request("same-proof"));
  const replay = await context.service.createRun(request("same-proof"));
  assert.equal(replay.runId, first.runId);
  assert.equal(context.runnerCalls.length, 0);
  assert.equal(context.gate.calls.authorize, 1);
  assert.equal(context.gate.calls.capture, 0);
  await executeAndFinalize(context);
  assert.equal(context.runnerCalls.length, 1);
  assert.equal(context.gate.calls.capture, 1);
});

test("capture failure degrades a decisive result to inconclusive, bills nothing, and releases", async () => {
  const gate = paymentGate();
  gate.capture = async () => {
    gate.calls.capture += 1;
    throw new Error("Base capture unavailable");
  };
  const context = harness({ gate });
  await context.service.createRun(request("capture-failure-proof"));
  const run = await executeAndFinalize(context);

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
  const context = harness({ verifierRegistry });
  await context.service.createRun(request("isolated-proof"));
  const run = await executeAndFinalize(context);

  assert.equal(run.verdict.outcome, "approved");
  assert.equal(run.billing.status, "captured");
  const presented = decorateVerificationRunPresentation(run, {
    env: {
      X402_PAYMENT_NETWORK: "eip155:8453",
      X402_PAYMENT_ASSET_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    }
  });
  assert.equal(presented.result, "PASS");
  assert.equal(presented.billing.status, "captured", "Verify PASS must retain captured billing truth");
  assert.equal(presented.assetContext.chainName, "Base");
  assert.equal(Object.hasOwn(presented, "settlement"), false, "Verify PASS is billed, never job-settled");
});
