import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SelfIdentityRegistry } from "./self-identity-registry.js";
import {
  assertWorkReceiptContentAddress,
  buildWorkReceipt,
  hashWorkReceiptContent,
  WORK_RECEIPT_SCHEMA_VERSION
} from "./work-receipt.js";

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
  assert.equal(receipt.settlement.pinnedRewardAmountRaw, "250000");
  assert.equal(receipt.settlement.rewardAmountRaw, "300000");
  assert.equal(
    BigInt(receipt.settlement.rewardAmountRaw),
    BigInt(receipt.settlement.workerAmountRaw)
      + BigInt(receipt.settlement.gasRetentionAmountRaw)
      + BigInt(receipt.settlement.protocolFeeAmountRaw)
  );
  assert.equal(receipt.settlement.settlementTx, live.source.transactionHash);
  assert.equal(receipt.settlement.gasRetentionBps, 2000);
  assert.equal(receipt.execution.providerClass, "ours");
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
  assert.equal(receipt.settlement.rewardAmountRaw, "300000");
});

test("claim-time chain read failure remains explicit in receipt intent", () => {
  const receipt = buildWorkReceipt(input({ specSource: "chain_unavailable_fail_open" }));
  assert.equal(receipt.intent.specSource, "chain_unavailable_fail_open");
  assert.notEqual(receipt.intent.specSource, "chain_verified");
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
