import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { hashCanonicalContent } from "../core/canonical-content.js";
import { MemoryStateStore } from "../core/state-store.js";
import { PaymentSettlementOutcomeUnknownError } from "../payments/settlement-adapter.js";
import {
  actionableVerifyPaymentError,
  X402VerifyIntake
} from "../payments/x402-verify-intake.js";
import {
  assertStandaloneVerificationSourceIsolation,
  assertVerifyIntakeIsolation
} from "./verification-run-isolation.js";
import { VerificationProfileRegistry } from "./verification-profile-registry.js";
import { VerificationRunService } from "./verification-run-service.js";

const CUSTOMER = "0x1111111111111111111111111111111111111111";
const PAYMENT_ID = `0x${"a".repeat(64)}`;
const PAYMENT_TX = `0x${"b".repeat(64)}`;
const TARGET = {
  repository: "github.com/example/project",
  commit: "c".repeat(40)
};
const INPUTS = {
  bundle: {
    sha256: "d".repeat(64),
    bytes: 1024,
    locator: { kind: "https", url: "https://example.test/source.bundle" },
    format: "git-bundle"
  },
  patch: {
    sha256: "e".repeat(64),
    bytes: 512,
    locator: { kind: "https", url: "https://example.test/candidate.patch" },
    format: "file"
  },
  testCommand: ["npm", "test"]
};

function conclusiveRunner(counter = { calls: 0 }) {
  return {
    async run() {
      counter.calls += 1;
      return {
        status: "conclusive",
        evidence: "pass",
        reasonCode: "TESTS_PASSED",
        evidenceHash: hashCanonicalContent({ result: "pass" }),
        report: { result: "pass" },
        execution: {
          artifactHash: `0x${INPUTS.patch.sha256}`,
          sourceBinding: {
            method: "offline_git_bundle",
            verified: true,
            ref: TARGET.commit,
            bundleHash: `0x${INPUTS.bundle.sha256}`
          }
        }
      };
    }
  };
}

function makeService({ runner = conclusiveRunner(), now } = {}) {
  const stateStore = new MemoryStateStore();
  const profileRegistry = new VerificationProfileRegistry();
  const service = new VerificationRunService({
    stateStore,
    profileRegistry,
    runners: { "git-patch-tests-v1@1": runner },
    now: now ?? (() => new Date("2026-08-18T12:00:00.000Z"))
  });
  return { service, stateStore, profileRegistry };
}

function request() {
  return {
    profile: "git-patch-tests-v1",
    profileVersion: 1,
    customer: CUSTOMER,
    target: TARGET,
    inputs: INPUTS
  };
}

function payment() {
  return {
    status: "settled",
    network: "eip155:8453",
    amountRaw: "5000000",
    payer: CUSTOMER,
    receiptId: PAYMENT_TX,
    settledAt: "2026-08-18T12:00:00.000Z"
  };
}

test("no-settlement isolation mutation drill rejects a deliberately reachable payout call", async () => {
  const source = await readFile(new URL("./verification-run-service.js", import.meta.url), "utf8");
  assert.equal(assertStandaloneVerificationSourceIsolation(source), true);
  const mutation = `${source}\nasync function forbiddenMutation(gateway) { await gateway.resolveSinglePayout(); }\n`;
  assert.throws(
    () => assertStandaloneVerificationSourceIsolation(mutation),
    /may not reach settlement: resolveSinglePayout call/u
  );
  const { service } = makeService();
  assert.equal("gateway" in service, false);
  assert.equal("settlementAdapter" in service, false);
});

test("verify payment intake has no Hub float, bridge, or posting-settlement capability", async () => {
  const source = await readFile(new URL("../payments/x402-verify-intake.js", import.meta.url), "utf8");
  assert.equal(assertVerifyIntakeIsolation(source), true);
  const mutation = `${source}\nimport { X402PosterRampService } from "../payments/x402-poster-ramp.js";\n`;
  assert.throws(
    () => assertVerifyIntakeIsolation(mutation),
    /may not reach the posting rail: posting ramp import/u
  );
});

test("published profile is immutable and the same profile@version request reproduces verdict and receiptId", async () => {
  const { service, profileRegistry } = makeService();
  const [profile] = service.listProfiles();
  assert.equal(profile.name, "git-patch-tests-v1");
  assert.equal(profile.version, 1);
  assert.equal(profile.handler, "deterministic");
  assert.equal(service.listProfiles().length, 1, "later profiles remain unbuilt");
  profile.price.amountRaw = "1";
  assert.equal(service.listProfiles()[0].price.amountRaw, "5000000");
  assert.throws(() => profileRegistry.publish(profile), /already published and immutable/u);

  const first = await service.execute(request());
  const completed = await service.finalize(first.runId, { payment: payment() });
  const replay = await service.execute(request());
  assert.equal(replay.status, "complete");
  assert.equal(replay.verdict.outcome, completed.verdict.outcome);
  assert.equal(replay.receiptId, completed.receiptId);
});

test("inconclusive never bills and never presents as failure of the customer artifact", async () => {
  let settleCalls = 0;
  const { service, stateStore } = makeService({
    runner: {
      async run() {
        return {
          status: "inconclusive",
          reason: "ambiguous_evidence",
          reasonCode: "AMBIGUOUS_EVIDENCE",
          detail: "A rename cannot be classified confidently.",
          evidenceHash: hashCanonicalContent({ ambiguous: true })
        };
      }
    }
  });
  const intake = new X402VerifyIntake({
    config: intakeConfig(),
    facilitator: {
      verify: async () => authorization(),
      collect: async () => { settleCalls += 1; return settledPayment(); }
    },
    verificationRunService: service,
    stateStore
  });
  const result = await intake.run({ payload: publicPayload(), paymentProof: "signed-proof" });
  assert.equal(settleCalls, 0);
  assert.equal(result.body.verdict.outcome, "inconclusive");
  assert.equal(result.body.verdict.reason, "ambiguous_evidence");
  assert.equal(result.body.verdict.customerArtifactStatus, "undetermined");
  assert.equal(result.body.verdict.billing, "not_billed");
  assert.equal(result.body.payment.status, "not_billed");
  const receipt = await stateStore.getWorkReceiptDocument(result.body.receiptId);
  assert.equal(receipt.intent.valueAtRisk.amountRaw, "0");
  assert.equal(receipt.settlement, undefined);
});

test("a broken runner and a service timeout classify as inconclusive runner_fault, never fail", async () => {
  const broken = makeService({ runner: { async run() { throw new Error("runner exploded"); } } });
  const brokenRun = await broken.service.execute(request());
  assert.equal(brokenRun.verdict.outcome, "inconclusive");
  assert.equal(brokenRun.verdict.reason, "runner_fault");
  assert.notEqual(brokenRun.verdict.outcome, "rejected");

  const profile = new VerificationProfileRegistry().get("git-patch-tests-v1", 1);
  profile.limits.timeout = 0.005;
  const timeoutService = new VerificationRunService({
    stateStore: new MemoryStateStore(),
    profileRegistry: { list: () => [profile], get: () => structuredClone(profile) },
    runners: { "git-patch-tests-v1@1": { run: () => new Promise(() => {}) } }
  });
  const timedOut = await timeoutService.execute(request());
  assert.equal(timedOut.verdict.outcome, "inconclusive");
  assert.equal(timedOut.verdict.reason, "runner_fault");
});

test("payment gating does no unpaid work and replayed proof buys exactly one run", async () => {
  const counter = { calls: 0 };
  let settleCalls = 0;
  const { service, stateStore } = makeService({ runner: conclusiveRunner(counter) });
  const intake = new X402VerifyIntake({
    config: intakeConfig(),
    facilitator: {
      verify: async () => authorization(),
      collect: async () => { settleCalls += 1; return settledPayment(); }
    },
    verificationRunService: service,
    stateStore
  });
  const challenge = intake.paymentRequired(publicPayload());
  assert.equal(challenge.statusCode, 402);
  assert.equal(counter.calls, 0);

  const first = await intake.run({ payload: publicPayload(), paymentProof: "same-proof" });
  const replay = await intake.run({ payload: publicPayload(), paymentProof: "same-proof" });
  assert.equal(first.body.runId, replay.body.runId);
  assert.equal(first.body.receiptId, replay.body.receiptId);
  assert.equal(counter.calls, 1);
  assert.equal(settleCalls, 1);
  assert.equal(first.body.payment.amountRaw, "5000000");
  assert.equal(first.body.payment.network, "eip155:8453");
});

test("payment challenge refuses malformed or oversized inputs before asking for money", () => {
  const { service, stateStore } = makeService();
  const intake = new X402VerifyIntake({
    config: intakeConfig(),
    facilitator: { verify: async () => authorization(), collect: async () => settledPayment() },
    verificationRunService: service,
    stateStore
  });
  const malformed = structuredClone(publicPayload());
  malformed.inputs.patch.locator.url = "http://example.test/change.patch";
  assert.throws(() => intake.paymentRequired(malformed), /must use HTTPS/u);

  const oversized = structuredClone(publicPayload());
  oversized.inputs.bundle.bytes = 10 * 1024 * 1024;
  assert.throws(() => intake.paymentRequired(oversized), /exceed.*limit/u);
});

test("Verify translates shared facilitator failures into customer language without job fiction", () => {
  const error = actionableVerifyPaymentError(new PaymentSettlementOutcomeUnknownError(
    "The job was delisted.",
    { action: "check_wallet_and_contact_support", posterFunds: "unknown" }
  ));
  assert.equal(error.code, "payment_settlement_outcome_unknown");
  assert.equal(error.details.customerFunds, "unknown");
  assert.equal("posterFunds" in error.details, false);
  assert.doesNotMatch(error.message, /job|poster|delist/iu);
});

function publicPayload() {
  return {
    profile: "git-patch-tests-v1",
    profileVersion: 1,
    target: TARGET,
    inputs: INPUTS
  };
}

function intakeConfig() {
  return {
    enabled: true,
    publicOrigin: "https://api.averray.com",
    network: "eip155:8453",
    asset: "0x2222222222222222222222222222222222222222",
    payTo: "0x3333333333333333333333333333333333333333",
    assetEip712Name: "USD Coin",
    assetEip712Version: "2",
    maxTimeoutSeconds: 60
  };
}

function authorization() {
  return {
    authorizationId: PAYMENT_ID,
    payer: CUSTOMER,
    expiresAt: "2026-08-18T12:05:00.000Z",
    verifiedAt: "2026-08-18T12:00:00.000Z"
  };
}

function settledPayment() {
  return {
    receiptId: PAYMENT_TX,
    network: "eip155:8453",
    payer: CUSTOMER,
    amount: "5000000",
    settledAt: "2026-08-18T12:00:01.000Z"
  };
}
