import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";

import { CREDIT_POOL_ABI } from "../../mcp-server/src/blockchain/abis.js";
import { verifyCreditTemplate } from "./scratch-dogfood-credit.mjs";

test("credit walkthrough independently decodes the exact unsigned borrow intent", () => {
  const data = new Interface(CREDIT_POOL_ABI).encodeFunctionData("repay", [`0x${"11".repeat(32)}`, 1_000_000n]);
  const decoded = verifyCreditTemplate({
    step: "repay",
    unsigned: true,
    data,
    value: "0",
    decoded: { function: "repay(bytes32,uint256)" }
  });
  assert.equal(decoded.function, "repay(bytes32,uint256)");
  assert.equal(decoded.args[1], "1000000");
});

test("credit walkthrough rejects an advertised decoded function that does not match the bytes", () => {
  const data = new Interface(CREDIT_POOL_ABI).encodeFunctionData("repay", [`0x${"11".repeat(32)}`, 1n]);
  assert.throws(() => verifyCreditTemplate({ step: "repay", unsigned: true, data, value: "0", decoded: { function: "deposit(uint256,address)" } }), /advertised deposit/u);
});
