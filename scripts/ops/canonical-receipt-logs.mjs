// eth_getLogs is discovery only: bind evidence to mined receipts, never to a
// provider's duplicate/phantom placement of the same transaction log.
const lower = value => String(value).toLowerCase();
const indexOf = log => {
  const index = Number(log.index ?? log.logIndex);
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("receipt_log_index_unavailable");
  return index;
};

export function receiptLogScan() {
  return { receipts: new Map(), blocks: new Map(), seen: new Set() };
}

export async function canonicalReceiptLogs(provider, logs, scan = receiptLogScan()) {
  const events = [];
  let phantomLogsDropped = 0;
  for (const log of logs) {
    const transactionHash = lower(log.transactionHash), logIndex = indexOf(log);
    if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) throw new Error("receipt_transaction_hash_unavailable");
    if (!scan.receipts.has(transactionHash)) scan.receipts.set(transactionHash, await provider.getTransactionReceipt(transactionHash));
    const receipt = scan.receipts.get(transactionHash);
    if (!receipt || lower(receipt.hash ?? receipt.transactionHash) !== transactionHash) throw new Error("transaction_receipt_unavailable");
    const blockNumber = Number(receipt.blockNumber);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new Error("receipt_block_unavailable");
    // Count before deduplication, so a phantom is visible even after its real
    // copy. Do not mark it seen: the real copy may arrive in a later chunk.
    if (Number(log.blockNumber) !== blockNumber) { phantomLogsDropped++; continue; }
    const key = `${transactionHash}:${logIndex}`;
    if (scan.seen.has(key)) continue;
    const minedLog = receipt.logs.find(entry => indexOf(entry) === logIndex);
    if (!minedLog || lower(minedLog.address) !== lower(log.address) || lower(minedLog.data) !== lower(log.data)
        || JSON.stringify(minedLog.topics.map(lower)) !== JSON.stringify(log.topics.map(lower))) {
      throw new Error("receipt_log_evidence_mismatch");
    }
    const blockKey = receipt.blockHash ?? blockNumber;
    if (!scan.blocks.has(blockKey)) scan.blocks.set(blockKey, await provider.getBlock(blockKey));
    const block = scan.blocks.get(blockKey);
    if (!block || Number(block.number) !== blockNumber || !Number.isSafeInteger(Number(block.timestamp))
        || (receipt.blockHash && lower(block.hash) !== lower(receipt.blockHash))) throw new Error("receipt_block_unavailable");
    scan.seen.add(key);
    events.push({ address: lower(minedLog.address), topics: minedLog.topics.map(lower), data: lower(minedLog.data),
      transactionHash, logIndex, blockNumber, blockHash: block.hash, timestamp: Number(block.timestamp) });
  }
  events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex || a.transactionHash.localeCompare(b.transactionHash));
  return { events, phantomLogsDropped };
}
