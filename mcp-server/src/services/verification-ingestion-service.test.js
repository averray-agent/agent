import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import { transitionSession } from "../core/session-state-machine.js";
import { BADGE_RECEIPT_COSIGN_POLICY_TAG } from "../core/builtin-policies.js";
import { VerificationIngestionService } from "./verification-ingestion-service.js";

test("approved verification persists an immutable badge document at resolution", async () => {
  const stateStore = new MemoryStateStore();
  const claimed = transitionSession({
    sessionId: "session-durable-badge",
    wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    jobId: "job-durable-badge",
    chainJobId: "0x1111111111111111111111111111111111111111111111111111111111111111",
    claimStake: 0.25,
    idempotencyKey: "claim-durable-badge",
    submission: "verified evidence"
  }, "claimed", { reason: "job_claimed", timestamp: "2026-07-09T10:00:00.000Z" });
  const submitted = transitionSession(claimed, "submitted", {
    reason: "work_submitted",
    timestamp: "2026-07-09T10:05:00.000Z"
  });
  await stateStore.upsertSession(submitted);

  const job = {
    id: "job-durable-badge",
    category: "security",
    tier: "starter",
    rewardAsset: "USDC",
    rewardAmount: 5,
    verifierMode: "deterministic",
    verifierConfig: { handler: "deterministic" }
  };
  const service = new VerificationIngestionService(
    stateStore,
    undefined,
    () => job,
    { info() {}, warn() {} },
    {
      badgeReceiptSigner: {
        async signDocument(document) {
          assert.equal(document.averray.sessionId, submitted.sessionId);
          return {
            alg: "ES256",
            kid: "badge-1",
            sig: "protected..signature",
            signedAt: "2026-07-09T10:06:00.000Z"
          };
        }
      }
    }
  );

  await service.ingest(submitted.sessionId, {
    handler: "deterministic",
    handlerVersion: 1,
    outcome: "approved",
    reasonCode: "OK"
  });

  const badge = await stateStore.getBadgeDocument(submitted.sessionId);
  assert.equal(badge.averray.sessionId, submitted.sessionId);
  assert.equal(badge.averray.category, "security");
  assert.equal(badge.signature.kid, "badge-1");
  assert.deepEqual(badge.signers.map((entry) => entry.role), ["worker"]);
  assert.deepEqual(badge.averray.reward, { asset: "USDC", amount: "5000000", decimals: 6 });
  assert.equal((await stateStore.getSession(submitted.sessionId)).badgeSnapshot.rewardAsset, "USDC");
});

test("co-sign policy records only live role-backed operator and verifier identities", async () => {
  const stateStore = new MemoryStateStore();
  const worker = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const serviceSigner = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const claimed = transitionSession({
    sessionId: "session-cosign-badge",
    wallet: worker,
    jobId: "receipt-cosign-live-proof",
    chainJobId: "0x2222222222222222222222222222222222222222222222222222222222222222",
    claimStake: 0.25,
    idempotencyKey: "claim-cosign-badge",
    submission: "complete verified output"
  }, "claimed", { reason: "job_claimed", timestamp: "2026-07-12T01:00:00.000Z" });
  const submitted = transitionSession(claimed, "submitted", {
    reason: "work_submitted",
    timestamp: "2026-07-12T01:05:00.000Z"
  });
  await stateStore.upsertSession(submitted);

  const job = {
    id: "receipt-cosign-live-proof",
    category: "coding",
    tier: "starter",
    rewardAsset: "USDC",
    rewardAmount: 0.1,
    verifierMode: "benchmark",
    verifierConfig: { handler: "benchmark" },
    verification: { receiptPolicyTag: BADGE_RECEIPT_COSIGN_POLICY_TAG }
  };
  const service = new VerificationIngestionService(
    stateStore,
    undefined,
    () => job,
    { info() {}, warn() {} },
    {
      blockchainGateway: {
        async getTreasuryPolicyStatus() {
          return {
            roles: {
              signerAddress: serviceSigner,
              signerIsSettlementBroker: true,
              signerIsVerifier: true
            }
          };
        }
      },
      policyService: {
        findByTagOrId(value) {
          assert.equal(value, BADGE_RECEIPT_COSIGN_POLICY_TAG);
          return { scope: "co-sign", state: "Active" };
        }
      },
      badgeReceiptSigner: {
        async signDocument() {
          return {
            alg: "ES256",
            kid: "badge-1",
            sig: "protected..signature",
            signedAt: "2026-07-12T01:06:00.000Z"
          };
        }
      }
    }
  );

  await service.ingest(submitted.sessionId, {
    handler: "benchmark",
    handlerVersion: 1,
    outcome: "approved",
    reasonCode: "BENCHMARK_THRESHOLD_MET"
  });

  const badge = await stateStore.getBadgeDocument(submitted.sessionId);
  assert.deepEqual(badge.signers.map((entry) => entry.role), ["operator", "verifier", "worker"]);
  assert.deepEqual(badge.signers.map((entry) => entry.wallet), [serviceSigner, serviceSigner, worker]);
  assert.equal(badge.signers[0].at, "2026-07-12T01:00:00.000Z");
  assert.equal(badge.signers[2].at, "2026-07-12T01:05:00.000Z");
  assert.ok(!Number.isNaN(Date.parse(badge.signers[1].at)));
});

test("co-sign policy omits an operator role the live policy status did not earn", async () => {
  const service = new VerificationIngestionService(
    undefined,
    undefined,
    undefined,
    { warn() {} },
    {
      blockchainGateway: {
        async getTreasuryPolicyStatus() {
          return {
            roles: {
              signerAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              signerIsSettlementBroker: false,
              signerIsVerifier: true
            }
          };
        }
      },
      policyService: {
        findByTagOrId() {
          return { scope: "co-sign", state: "Active" };
        }
      }
    }
  );

  const context = await service.resolveBadgeSignerContext({
    id: "partial-cosign",
    verification: { receiptPolicyTag: BADGE_RECEIPT_COSIGN_POLICY_TAG }
  });
  assert.equal(context.posterAddress, undefined);
  assert.equal(context.verifierAddress, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
});
