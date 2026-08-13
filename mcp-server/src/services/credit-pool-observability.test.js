import assert from "node:assert/strict";
import test from "node:test";

import { CREDIT_POOL_RISK_DISCLOSURE, CreditPoolObservabilityService } from "./credit-pool-observability.js";

const POOL = "0x1111111111111111111111111111111111111111";
const ASSET = "0x2222222222222222222222222222222222222222";
const DEPOSIT = "0x3333333333333333333333333333333333333333";

function reader({ eventError } = {}) {
  return {
    getBlockNumber: async () => 5_000,
    getBlock: async () => ({ number: 5_000, hash: `0x${"ab".repeat(32)}`, timestamp: 1_700_000_000 }),
    readState: async () => ({
      asset: ASSET, depositPool: DEPOSIT, totalAssets: 20_000_000n, totalShares: 12_000_000n,
      buffer: 12_000_000n, principalOutstanding: 8_000_000n, totalPledgedShares: 10_000_000n,
      defaults: 0n, ltvBps: 8_000n, interestBps: 0n, totalAssetCap: 250_000_000n,
      perLenderCap: 100_000_000n, disclosure: CREDIT_POOL_RISK_DISCLOSURE
    }),
    readEvents: async () => {
      if (eventError) throw eventError;
      return [{ type: "LoanOriginated", loanId: `0x${"44".repeat(32)}`, borrower: ASSET, amountRaw: "8000000", pledgedSharesRaw: "10000000", blockNumber: 4_999, logIndex: 1, txHash: `0x${"55".repeat(32)}` }];
    }
  };
}

test("CreditPool board snapshot exposes buffer, outstanding, pledged, defaults and zero-margin truth", async () => {
  const value = await new CreditPoolObservabilityService({ poolAddress: POOL, chainReader: reader() }).getSnapshot();
  assert.equal(value.available, true);
  assert.equal(value.buffer.raw, "12000000");
  assert.equal(value.principalOutstanding.raw, "8000000");
  assert.equal(value.totalPledgedShares.raw, "10000000");
  assert.equal(value.defaults, 0);
  assert.equal(value.schedule.interestBps, 0);
  assert.equal(value.schedule.platformFeeBps, 0);
  assert.equal(value.reconciliation.reconciled, true);
  assert.equal(value.lifecycle.recent[0].type, "LoanOriginated");
});

test("CreditPool event failure degrades lifecycle only and never invents zero events", async () => {
  const value = await new CreditPoolObservabilityService({ poolAddress: POOL, chainReader: reader({ eventError: new Error("rpc failed") }) }).getSnapshot();
  assert.equal(value.available, true);
  assert.equal(value.totalAssets.raw, "20000000");
  assert.equal(value.lifecycle.status, "unavailable");
  assert.equal(value.lifecycle.recent, null);
});
