import assert from "node:assert/strict";
import test from "node:test";

import { formatReceiptAssetLine } from "./receipt-asset-context.js";

test("receipt asset line distinguishes Hub settlement from Base billing", () => {
  assert.equal(formatReceiptAssetLine({
    result: "PASS",
    assetContext: {
      symbol: "USDC",
      chain: "eip155:420420419",
      chainName: "Polkadot Hub",
      assetId: 1337,
      token: "0x0000053900000000000000000000000001200000"
    }
  }), "Settled in Hub USDC · Polkadot Hub (eip155:420420419) · asset 1337");

  assert.equal(formatReceiptAssetLine({
    result: "PASS",
    assetContext: {
      symbol: "USDC",
      chain: "eip155:8453",
      chainName: "Base",
      token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
    }
  }), "Billed in Base USDC (eip155:8453)");
});

test("receipt asset line does not infer labels from incomplete or unknown context", () => {
  assert.equal(formatReceiptAssetLine({ result: "PASS", assetContext: { symbol: "USDC" } }), undefined);
  assert.equal(formatReceiptAssetLine({
    result: "PASS",
    assetContext: { symbol: "USDC", chain: "eip155:1", chainName: "Ethereum" }
  }), undefined);
});
