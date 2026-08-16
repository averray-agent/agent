import assert from "node:assert/strict";
import test from "node:test";

import { ReceiptGraphUnderwriter } from "./receipt-graph-underwriter.js";

const input = {
  wallet: "0x1111111111111111111111111111111111111111",
  asset: "0x2222222222222222222222222222222222222222",
  cashCapRaw: "25000000",
  postingCapRaw: "25000000"
};

test("underwriting derives L2/L3 limits only from decoded SettlementSplit worker amounts", async () => {
  const service = new ReceiptGraphUnderwriter({
    reader: {
      readWindow: async () => ({
        settlements: [{ workerAmountRaw: "3000000" }, { workerAmountRaw: "7000000" }],
        slashes: [], upheldDisputes: [], fromBlock: 10, headBlock: 20
      })
    }
  });
  const result = await service.evaluate(input);
  assert.equal(result.trailingNetRaw, "10000000");
  assert.equal(result.cashLimitRaw, "5000000");
  assert.equal(result.postingLimitRaw, "10000000");
  assert.equal(result.source, "decoded_settlement_split_logs");
});

test("any slash or upheld dispute hard-zeros both receipt-graph limits", async () => {
  for (const evidence of [
    { slashes: [{ amountRaw: "1" }], upheldDisputes: [] },
    { slashes: [], upheldDisputes: [{ jobId: "0xjob" }] }
  ]) {
    const service = new ReceiptGraphUnderwriter({
      reader: { readWindow: async () => ({ settlements: [{ workerAmountRaw: "50000000" }], ...evidence }) }
    });
    const result = await service.evaluate(input);
    assert.equal(result.cashLimitRaw, "0");
    assert.equal(result.postingLimitRaw, "0");
    assert.equal(result.disqualified, true);
  }
});

test("event-read failure fails closed without inventing earnings", async () => {
  const service = new ReceiptGraphUnderwriter({ reader: { readWindow: async () => { throw new Error("rpc down"); } } });
  const result = await service.evaluate(input);
  assert.equal(result.available, false);
  assert.equal(result.trailingNetRaw, null);
  assert.equal(result.cashLimitRaw, "0");
  assert.equal(result.disqualificationReason, "receipt_graph_unavailable");
});
