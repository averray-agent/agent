import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import { transitionSession } from "../core/session-state-machine.js";
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
  assert.deepEqual(badge.averray.reward, { asset: "USDC", amount: "5000000", decimals: 6 });
  assert.equal((await stateStore.getSession(submitted.sessionId)).badgeSnapshot.rewardAsset, "USDC");
});
