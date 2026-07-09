import test from "node:test";
import assert from "node:assert/strict";

import { extractReceiptSigners } from "./receipt-signers.js";

test("receipt signers prefer explicit role from #760 badge signer payload", () => {
  const signers = extractReceiptSigners([
    {
      role: "worker",
      wallet: "0x3333333333333333333333333333333333333333",
      at: "2026-04-16T14:12:00.000Z",
      status: "submitted",
    },
  ]);

  assert.equal(signers.length, 1);
  assert.equal(signers[0].role, "worker");
  assert.equal(signers[0].address, "0x333333…3333");
  assert.equal(signers[0].identified, true);
  assert.equal(signers[0].signedAt, "14:12:00 UTC");
});
