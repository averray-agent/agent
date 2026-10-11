import test from "node:test";
import assert from "node:assert/strict";
import { canonicalReceiptLogs, receiptLogScan } from "./canonical-receipt-logs.mjs";

const tx = `0x${"1".repeat(64)}`, blockHash = `0x${"2".repeat(64)}`;
const log = { transactionHash: tx, blockNumber: 20, logIndex: "0x2d", address: `0x${"a".repeat(40)}`, topics: [tx], data: "0x01" };
const receipt = { transactionHash: tx, blockNumber: 20, blockHash, logs: [log] };
const provider = { getTransactionReceipt: async () => receipt, getBlock: async hash => {
  assert.equal(hash, blockHash); return { number: 20, hash: blockHash, timestamp: 1000 };
} };

test("receipt normalization dedupes across chunks without a phantom poisoning the real log", async () => {
  const scan = receiptLogScan();
  const phantom = await canonicalReceiptLogs(provider, [{ ...log, blockNumber: 15 }], scan);
  assert.equal(phantom.phantomLogsDropped, 1); assert.deepEqual(phantom.events, []);
  const real = await canonicalReceiptLogs(provider, [log, { ...log, transactionHash: tx.toUpperCase(), logIndex: 45 }], scan);
  assert.equal(real.events.length, 1); assert.equal(real.events[0].blockNumber, 20);
  assert.equal(real.events[0].timestamp, 1000); assert.equal(real.events[0].logIndex, 45);
  assert.deepEqual((await canonicalReceiptLogs(provider, [log], scan)).events, []);
});

test("receipt/header or event disagreement and missing receipts fail closed", async () => {
  for (const bad of [
    { ...provider, getTransactionReceipt: async () => null },
    { ...provider, getTransactionReceipt: async () => ({ ...receipt, logs: [] }) },
    { ...provider, getTransactionReceipt: async () => ({ ...receipt, logs: [{ ...log, data: "0x02" }] }) },
    { ...provider, getBlock: async () => null },
    { ...provider, getBlock: async () => ({ number: 20, hash: tx, timestamp: 1000 }) }
  ]) await assert.rejects(canonicalReceiptLogs(bad, [log]), /unavailable|mismatch/);
});
