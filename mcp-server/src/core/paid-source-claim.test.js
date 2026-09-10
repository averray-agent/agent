import test from "node:test";
import assert from "node:assert/strict";
import { assessPaidSourceClaim } from "./paid-source-claim.js";

const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const job = { id: "new", source: { type: "wikipedia_article", language: "en", pageId: 123, revisionId: "456" } };
const prior = { sessionId: "old", jobId: "old", wallet, status: "resolved" };
const payout = { settlement: { workerAmountRaw: "350000" } };
function options(session, verification) {
  return { wallet, job, getJobDefinition: () => job, stateStore: {
    listSessionsByWallet: async () => [session], getVerificationResult: async () => verification
  } };
}

test("legacy separately stored payout evidence blocks the same source without a snapshot", async () => {
  assert.equal((await assessPaidSourceClaim(options(prior, { payoutTx: payout }))).reason, "source_already_paid");
});

test("resolved without provable payout, missing source pins and truncated history fail closed", async () => {
  assert.equal((await assessPaidSourceClaim(options(prior))).reason, "source_payment_history_unavailable");
  const missing = options({ ...prior, payoutTx: payout });
  missing.getJobDefinition = () => { throw new Error("removed"); };
  assert.equal((await assessPaidSourceClaim(missing)).reason, "source_payment_history_unavailable");
  const truncated = options(prior);
  truncated.stateStore.listSessionsByWallet = async () => Array(64).fill({ ...prior, status: "expired" });
  assert.equal((await assessPaidSourceClaim(truncated)).reason, "source_payment_history_unavailable");
});

test("payment arriving between preflight and attempt is read again, never cached", async () => {
  const input = options({ ...prior, status: "expired" });
  assert.equal((await assessPaidSourceClaim(input)).eligible, true);
  input.stateStore.listSessionsByWallet = async () => [{ ...prior, payoutTx: payout }];
  assert.equal((await assessPaidSourceClaim(input)).reason, "source_already_paid");
});
