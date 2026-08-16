import assert from "node:assert/strict";
import test from "node:test";

import { CreditBookKeeperService } from "./credit-book-keeper.js";

const WORKER = "0x1111111111111111111111111111111111111111";
const LOAN = `0x${"22".repeat(32)}`;
const TERMS = `0x${"33".repeat(32)}`;
const TX = `0x${"44".repeat(32)}`;
const NOW_SECONDS = 2_000_000_000;

function info() {
  return {
    available: true,
    schedule: { repayBps: 5_000 },
    wallet: {
      cash: { activeLoan: { loanId: LOAN, termsHash: TERMS, outstanding: { raw: "1000000" } } },
      posting: { activeLoan: null }
    }
  };
}

function settlement() {
  return {
    session: { sessionId: "session-1", wallet: WORKER },
    payoutTx: { settlement: { worker: WORKER, workerAmountRaw: "2000000" } }
  };
}

test("keeper sweeps exactly min(payout x 5000bps, outstanding) through the shared relay", async () => {
  const calls = [];
  const authorization = {
    from: WORKER,
    recipient: "0x5555555555555555555555555555555555555555",
    asset: "0x6666666666666666666666666666666666666666",
    amount: "1000000",
    nonce: "9",
    deadline: String(NOW_SECONDS + 100),
    signature: `0x${"77".repeat(65)}`
  };
  const keeper = new CreditBookKeeperService({
    creditBookDoor: {
      getInfo: async () => info(),
      getConsent: async () => ({ repaymentAuthorizations: [authorization] })
    },
    gateway: {
      isSendToAgentAuthorizationUsed: async () => false,
      submitAuthorizedAgentTransfer: async (input) => {
        calls.push(["transfer", input]);
        return { txHash: TX };
      },
      recordCreditBookSweep: async (...args) => { calls.push(["record", ...args]); return { txHash: TX }; }
    },
    now: () => new Date(NOW_SECONDS * 1_000)
  });
  const result = await keeper.afterSettlement(settlement());
  assert.equal(result.status, "swept");
  assert.equal(result.sweeps[0].amountRaw, "1000000");
  assert.deepEqual(calls.map(([name]) => name), ["transfer", "record"]);
});

test("expired sweep authorization pauses deduction without touching settlement", async () => {
  let transferCalls = 0;
  let recordCalls = 0;
  const keeper = new CreditBookKeeperService({
    creditBookDoor: {
      getInfo: async () => info(),
      getConsent: async () => ({
        repaymentAuthorizations: [{ amount: "1000000", deadline: String(NOW_SECONDS - 1) }]
      })
    },
    gateway: {
      submitAuthorizedAgentTransfer: async () => { transferCalls += 1; },
      recordCreditBookSweep: async () => { recordCalls += 1; }
    },
    now: () => new Date(NOW_SECONDS * 1_000)
  });
  const settledEvidence = settlement();
  const result = await keeper.afterSettlement(settledEvidence);
  assert.equal(result.status, "paused");
  assert.equal(result.reason, "authorization_expired");
  assert.equal(transferCalls, 0);
  assert.equal(recordCalls, 0);
  assert.equal(settledEvidence.payoutTx.settlement.workerAmountRaw, "2000000");
});

test("a mined transfer whose record step crashed is recovered without replaying the nonce", async () => {
  let transferCalls = 0;
  let recordCalls = 0;
  const keeper = new CreditBookKeeperService({
    creditBookDoor: {
      getInfo: async () => info(),
      getConsent: async () => ({
        repaymentAuthorizations: [{
          from: WORKER,
          recipient: "0x5555555555555555555555555555555555555555",
          asset: "0x6666666666666666666666666666666666666666",
          amount: "1000000",
          nonce: "9",
          deadline: String(NOW_SECONDS + 100),
          signature: `0x${"77".repeat(65)}`
        }]
      })
    },
    gateway: {
      isSendToAgentAuthorizationUsed: async () => true,
      submitAuthorizedAgentTransfer: async () => { transferCalls += 1; },
      recordCreditBookSweep: async () => { recordCalls += 1; return { txHash: TX }; }
    },
    now: () => new Date(NOW_SECONDS * 1_000)
  });

  const result = await keeper.afterSettlement(settlement());

  assert.equal(result.status, "swept");
  assert.equal(transferCalls, 0);
  assert.equal(recordCalls, 1);
  assert.equal(result.sweeps[0].transferTxHash, null);
});
