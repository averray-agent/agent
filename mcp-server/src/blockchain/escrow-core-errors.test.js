import assert from "node:assert/strict";
import test from "node:test";

import { id } from "ethers";

import { decodeEscrowCoreRevert } from "./escrow-core-errors.js";

const INVALID_STATE_SELECTOR = id("InvalidState()").slice(0, 10);

test("EscrowCore InvalidState is decoded by ABI name and selector", () => {
  assert.deepEqual(decodeEscrowCoreRevert({
    info: { error: { data: { data: INVALID_STATE_SELECTOR } } }
  }), {
    name: "InvalidState",
    selector: "0xbaf3f0f7",
    reason: "EscrowCore.InvalidState()"
  });
});

test("unknown EscrowCore revert data is not classified", () => {
  assert.equal(decodeEscrowCoreRevert({ data: "0xdeadbeef" }), undefined);
});
