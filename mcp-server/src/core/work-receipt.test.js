import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SelfIdentityRegistry } from "./self-identity-registry.js";
import {
  assertWorkReceiptContentAddress,
  buildVerifyReceipt,
  buildWorkReceipt,
  hashWorkReceiptContent,
  WORK_RECEIPT_SCHEMA_VERSION
} from "./work-receipt.js";
import { STARTER_BENCHMARK_CHECK_DEPTH } from "./verification-depth.js";

const live = JSON.parse(readFileSync(
  new URL("./fixtures/work-receipt-retention-2026-08-16.json", import.meta.url),
  "utf8"
));
const SPEC_HASH = `0x${"1".repeat(64)}`;
const ARTIFACT_HASH = `0x${"2".repeat(64)}`;
const BUNDLE_HASH = `0x${"3".repeat(64)}`;

function input({ outcome = "approved", specSource = "chain_verified", settlement = live.settlement } = {}) {
  const claimedAt = "2026-08-16T12:00:00.000Z";
  const job = {
    id: "retention-live-proof-2026-08-16",
    rewardAsset: live.assetSymbol,
    rewardAmount: 0.25,
    claimTtlSeconds: 3600,
    verifierMode: "deterministic",
    verifierConfig: { handler: "deterministic" }
  };
  return {
    session: {
      sessionId: "session-retention-live-proof",
      jobId: job.id,
      chainJobId: live.chainJobId,
      wallet: live.worker,
      claimedAt,
      submittedAt: "2026-08-16T12:10:00.000Z",
      ...(outcome === "approved"
        ? { resolvedAt: "2026-08-16T12:11:00.000Z" }
        : outcome === "rejected"
          ? { rejectedAt: "2026-08-16T12:11:00.000Z" }
          : { disputedAt: "2026-08-16T12:11:00.000Z" }),
      submission: {
        artifactHash: ARTIFACT_HASH,
        sourceBinding: { method: "git-bundle", verified: true, ref: "refs/heads/main", bundleHash: BUNDLE_HASH }
      },
      gasRetention: { brokered: true, waived: false, retentionCapBps: 2000 },
      jobSnapshot: {
        specHash: SPEC_HASH,
        specSource,
        definition: job,
        claimEconomics: { gasRetention: { rewardRaw: "250000" } }
      }
    },
    job,
    verification: {
      handler: "deterministic",
      handlerVersion: 1,
      outcome,
      reasonCode: outcome === "approved" ? "DETERMINISTIC_MATCH" : "VERIFIER_COULD_NOT_DECIDE",
      verificationInputHash: `0x${"4".repeat(64)}`,
      workerConsequence: "none",
      ...(outcome === "approved"
        ? {
            payoutTx: { txHash: live.source.transactionHash, status: 1 },
            settlement: {
              worker: live.worker,
              treasuryAccount: live.treasuryAccount,
              asset: live.asset,
              assetSymbol: live.assetSymbol,
              ...settlement
            }
          }
        : {})
    },
    context: {
      posterAddress: live.poster,
      publicReceiptBaseUrl: "https://averray.com",
      selfIdentityRegistry: new SelfIdentityRegistry({ acceptanceWallets: [live.worker], operatorWallets: [live.poster] })
    }
  };
}

test("2026-08-16 live settlement reconciles payout, retention, and poster fee", () => {
  const receipt = buildWorkReceipt(input());
  assert.equal(receipt.schemaVersion, WORK_RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.settlement.workerAmountRaw, "200000");
  assert.equal(receipt.settlement.gasRetentionAmountRaw, "50000");
  assert.equal(receipt.settlement.protocolFeeAmountRaw, "50000");
  assert.equal(receipt.settlement.rewardAmountRaw, "250000");
  assert.equal(receipt.settlement.rewardAmount, "0.25");
  assert.equal(receipt.settlement.posterTotalAmountRaw, "300000");
  assert.equal(receipt.settlement.posterTotalAmount, "0.3");
  assert.equal(
    BigInt(receipt.settlement.rewardAmountRaw),
    BigInt(receipt.settlement.workerAmountRaw)
      + BigInt(receipt.settlement.gasRetentionAmountRaw)
  );
  assert.equal(
    BigInt(receipt.settlement.posterTotalAmountRaw),
    BigInt(receipt.settlement.rewardAmountRaw)
      + BigInt(receipt.settlement.protocolFeeAmountRaw)
  );
  assert.equal(receipt.intent.valueAtRisk.amountRaw, receipt.settlement.rewardAmountRaw);
  assert.equal(receipt.settlement.settlementTx, live.source.transactionHash);
  assert.equal(receipt.settlement.gasRetentionBps, 2000);
  assert.equal(receipt.execution.providerClass, "ours");
});

test("worker-facing reward must reconcile to payout plus gas retention", () => {
  const fixture = input();
  fixture.verification.settlement.rewardAmountRaw = "249999";
  assert.throws(
    () => buildWorkReceipt(fixture),
    /rewardAmountRaw must equal workerAmountRaw \+ gasRetentionAmountRaw/u
  );
});

test("poster total must reconcile to reward plus poster-side protocol fee", () => {
  const fixture = input();
  fixture.verification.settlement.posterTotalAmountRaw = "299999";
  assert.throws(
    () => buildWorkReceipt(fixture),
    /posterTotalAmountRaw must equal rewardAmountRaw \+ protocolFeeAmountRaw/u
  );
});

test("claim-time value at risk cannot drift from the settled worker reward", () => {
  const fixture = input();
  fixture.session.jobSnapshot.claimEconomics.gasRetention.rewardRaw = "260000";
  assert.throws(
    () => buildWorkReceipt(fixture),
    /intent valueAtRisk\.amountRaw must equal settlement rewardAmountRaw/u
  );
});

test("waived brokered settlement records zero retention and remains reconcilable", () => {
  const fixture = input({
    settlement: {
      ...live.settlement,
      workerAmount: 0.25,
      workerAmountRaw: "250000",
      gasRetention: { retainedRaw: "0", rewardRaw: "250000" }
    }
  });
  fixture.session.gasRetention.waived = true;
  fixture.session.claimEconomicsWaived = true;
  const receipt = buildWorkReceipt(fixture);
  assert.equal(receipt.settlement.waived, true);
  assert.equal(receipt.settlement.gasRetentionAmountRaw, "0");
  assert.equal(receipt.settlement.rewardAmountRaw, "250000");
  assert.equal(receipt.settlement.posterTotalAmountRaw, "300000");
});

test("designated external settlement pays provider plus poster fee with zero retention", () => {
  const fixture = input({
    settlement: {
      ...live.settlement,
      workerAmount: 0.25,
      workerAmountRaw: "250000",
      gasRetention: { retainedRaw: "0", rewardRaw: "250000" }
    }
  });
  fixture.job.source = {
    type: "external",
    poster: { wallet: live.poster }
  };
  fixture.job.designatedClaimants = [live.worker];
  fixture.job.requiresSponsoredGas = false;
  fixture.session.gasRetention = {
    brokered: false,
    waived: false,
    retentionCapBps: 0,
    rewardRaw: "250000"
  };
  fixture.context.selfIdentityRegistry = new SelfIdentityRegistry({
    operatorWallets: [live.poster]
  });

  const receipt = buildWorkReceipt(fixture);
  assert.equal(receipt.execution.providerClass, "external");
  assert.equal(receipt.settlement.workerAmountRaw, "250000");
  assert.equal(receipt.settlement.gasRetentionAmountRaw, "0");
  assert.equal(receipt.settlement.brokered, false);
  assert.equal(receipt.settlement.protocolFeeAmountRaw, "50000");
  assert.equal(receipt.settlement.posterTotalAmountRaw, "300000");
  assert.equal(
    BigInt(receipt.settlement.posterTotalAmountRaw),
    BigInt(receipt.settlement.rewardAmountRaw)
      + BigInt(receipt.settlement.protocolFeeAmountRaw)
  );
});

test("claim-time chain read failure remains explicit in receipt intent", () => {
  const receipt = buildWorkReceipt(input({ specSource: "chain_unavailable_fail_open" }));
  assert.equal(receipt.intent.specSource, "chain_unavailable_fail_open");
  assert.notEqual(receipt.intent.specSource, "chain_verified");
});

test("benchmark work receipt carries the starter check-depth statement verbatim", () => {
  const fixture = input();
  fixture.job.verifierMode = "benchmark";
  fixture.job.verifierConfig = { version: 1, handler: "benchmark" };
  fixture.session.jobSnapshot.definition = structuredClone(fixture.job);
  fixture.verification.handler = "benchmark";
  fixture.verification.handlerVersion = 2;

  const receipt = buildWorkReceipt(fixture);
  assert.equal(receipt.verification.checkDepth, STARTER_BENCHMARK_CHECK_DEPTH);
  assert.equal(
    receipt.verification.checkDepth,
    "Starter-tier benchmark check: output schema conformance and required reference terms. This is not a content audit."
  );
});

test("platform fault is inconclusive, never settles, and cannot blame the worker", () => {
  const receipt = buildWorkReceipt(input({ outcome: "platform_fault" }));
  assert.equal(receipt.verdict.outcome, "platform_fault");
  assert.equal(receipt.verdict.workerConsequence, "none");
  assert.equal(receipt.settlement, undefined);

  const mutation = input({ outcome: "platform_fault" });
  mutation.verification.workerConsequence = "no_payout";
  assert.throws(() => buildWorkReceipt(mutation), /platform_fault.*workerConsequence none/u);
});

test("receipt id reproduces from served content and every content mutation changes it", () => {
  const receipt = buildWorkReceipt(input());
  assertWorkReceiptContentAddress(receipt);
  assert.equal(hashWorkReceiptContent(receipt), receipt.receiptId);
  assert.equal(receipt.canonicalUrl, `https://averray.com/receipts/${receipt.receiptId}`);
  const mutated = structuredClone(receipt);
  mutated.verdict.reasonCode = "MUTATED";
  assert.notEqual(hashWorkReceiptContent(mutated), receipt.receiptId);
  assert.throws(() => assertWorkReceiptContentAddress(mutated), /content address mismatch/u);
});

test("verify and job receipts share the one canonical content-address function", () => {
  const jobReceipt = buildWorkReceipt(input());
  const profile = {
    name: "git-patch-tests-v1",
    version: 1,
    ref: "git-patch-tests-v1@1",
    handler: "deterministic",
    handlerVersion: 1,
    limits: { timeoutMs: 120_000 },
    price: { asset: "USDC", amount: "5", amountRaw: "5000000" }
  };
  const verifyReceipt = buildVerifyReceipt({
    run: {
      customer: live.poster,
      target: { repository: "github.com/example/project", commit: "1".repeat(40) },
      inputs: { patch: { sha256: "2".repeat(64) }, testCommand: ["npm", "test"] },
      billing: { status: "captured" }
    },
    profile,
    execution: {
      artifactHash: ARTIFACT_HASH,
      sourceBinding: { method: "git-bundle", verified: true, ref: "1".repeat(40), bundleHash: BUNDLE_HASH },
      environment: { kind: "averray_witness" }
    },
    verdict: {
      outcome: "approved",
      reasonCode: "DETERMINISTIC_MATCH",
      evidenceHash: `0x${"4".repeat(64)}`
    },
    context: { publicReceiptBaseUrl: "https://averray.com" }
  });

  assert.equal(hashWorkReceiptContent(jobReceipt), jobReceipt.receiptId);
  assert.equal(hashWorkReceiptContent(verifyReceipt), verifyReceipt.receiptId);
  assertWorkReceiptContentAddress(jobReceipt);
  assertWorkReceiptContentAddress(verifyReceipt);
  assert.equal(verifyReceipt.intent.specSource, "verify_request");
  assert.equal(verifyReceipt.intent.valueAtRisk.amountRaw, "5000000");
  assert.equal(verifyReceipt.execution.providerClass, "external");
  assert.equal(Object.hasOwn(verifyReceipt, "settlement"), false);

  const source = readFileSync(new URL("./work-receipt.js", import.meta.url), "utf8");
  assert.equal(source.match(/export function hashWorkReceiptContent/gu)?.length, 1);
});

test("MCP verify receipt names each bounded check and carries neither credential nor settlement", () => {
  const secret = "credential-that-must-not-enter-receipt";
  const checks = [
    { name: "auth-boundary", verdict: "pass", reason: "unauthenticated_request_rejected", detail: "The boundary rejected the fixed probe." },
    { name: "timeout-recovery", verdict: "pass", reason: "structured_timeout_error", detail: "A structured error returned." },
    { name: "tool-schema-stability", verdict: "pass", reason: "malformed_input_rejected", detail: "Malformed input was rejected." },
    { name: "destructive-action-safety", verdict: "fail", reason: "destructive_call_without_confirmation", detail: "The omission probe returned success." },
    { name: "error-shape-conformance", verdict: "pass", reason: "bounded_mcp_error", detail: "The error was protocol-shaped." }
  ];
  const receipt = buildVerifyReceipt({
    run: {
      customer: live.poster,
      target: { endpoint: "https://mcp.example.test/run", transport: "streamable_http", auth: { scheme: "bearer", credentialRef: "run-only" } },
      inputs: {},
      billing: { status: "captured" }
    },
    profile: {
      name: "mcp-failure-semantics-v1",
      version: 1,
      ref: "mcp-failure-semantics-v1@1",
      handler: "deterministic",
      handlerVersion: 1,
      limits: { timeoutMs: 30_000 },
      price: { asset: "USDC", amount: "5", amountRaw: "5000000" }
    },
    execution: {
      report: { checks },
      environment: { kind: "averray_mcp_prober", egress: "declared_endpoint_only" }
    },
    verdict: { outcome: "rejected", reasonCode: "DETERMINISTIC_MISMATCH" }
  });
  assert.deepEqual(receipt.execution.checks, checks);
  assert.equal(Object.hasOwn(receipt, "settlement"), false);
  assert.equal(receipt.intent.specSource, "verify_request");
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secret, "u"));
  assert.doesNotMatch(JSON.stringify(receipt), /\b(?:certified|secure)\b/iu);
  assertWorkReceiptContentAddress(receipt);
});
