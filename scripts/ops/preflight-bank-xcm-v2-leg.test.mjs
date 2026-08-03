import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";

import {
  assertReviveLegSimulation,
  buildLegCall,
  deriveSafeReviveLimits
} from "./preflight-bank-xcm-v2-leg.mjs";
import { buildBankXcmV2Messages, buildRecoveryHomeMessage } from "./bank-xcm-v2-ceremony-lib.mjs";

const WRAPPER = "0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9";
const ADAPTER = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x0000053900000000000000000000000001200000";
const OWNER = "0x01e6eed856e989201f4ff6346e18eab7e46c874c";
const CONVERTED = "0x51845ee08e8949d64f0016be27942ce7b6d21df02c3b00104a290ca4e749fc55";
const bundle = buildBankXcmV2Messages({
  wrapper: WRAPPER,
  convertedAccountId32: CONVERTED,
  asset: TOKEN,
  treasuryContext: OWNER
});
const recovery = buildRecoveryHomeMessage({
  wrapper: WRAPPER,
  convertedAccountId32: CONVERTED,
  amount: 100_000n,
  fee: 1_402n,
  nonce: 1n
});
const maxWeight = { refTime: 1n, proofSize: 1n };

function success(id) {
  return {
    weightRequired: { refTime: 100n, proofSize: 20n },
    storageDeposit: { charge: 10n },
    result: { ok: { flags: { bits: 0 }, data: id } }
  };
}

test("deployed-leg simulation refuses a revert flag or unexpected return id", () => {
  const id = bundle.contexts.deposit && bundle.messages[0].requestId;
  assert.equal(assertReviveLegSimulation(success(id), id).result.ok.flags.bits, 0);
  assert.throws(
    () => assertReviveLegSimulation({ ...success(id), result: { ok: { flags: { bits: 1 }, data: "0x820c74ed" } } }, id),
    /ReviveApi_call failed/u
  );
  assert.throws(() => assertReviveLegSimulation(success(`0x${"00".repeat(32)}`), id), /unexpected|failed/u);
});

test("safe outer limits add 25 percent and a nonzero storage floor", () => {
  const safe = deriveSafeReviveLimits(success(bundle.messages[0].requestId));
  assert.deepEqual(safe.weightLimit, { refTime: 125n, proofSize: 25n });
  assert.equal(safe.storageDepositLimit, 1_000_000_000n);
  assert.equal(
    deriveSafeReviveLimits({ ...success(bundle.messages[0].requestId), storageDeposit: { refund: 7n } })
      .storageDepositLimit,
    1_000_000_000n
  );
});

test("all five legs encode only their reviewed adapter or wrapper selector", () => {
  const expected = {
    deposit_funding: ["owner", ADAPTER, "stageTreasuryDeposit"],
    deposit_sell: ["operator", WRAPPER, "queueRequest"],
    withdraw_sell: ["owner", ADAPTER, "stageTreasuryWithdraw"],
    withdraw_home: ["operator", WRAPPER, "queueRequest"],
    recovery_home: ["owner", WRAPPER, "dispatchRecoveryHome"]
  };
  for (const [leg, [origin, to, functionName]] of Object.entries(expected)) {
    const call = buildLegCall({ leg, bundle, recovery, wrapper: WRAPPER, adapter: ADAPTER, owner: OWNER, maxWeight });
    assert.equal(call.origin, origin, leg);
    assert.equal(call.to.toLowerCase(), to.toLowerCase(), leg);
    const iface = new Interface([
      "function stageTreasuryDeposit(address,uint256,bytes,bytes,(uint64,uint64),uint64)",
      "function stageTreasuryWithdraw(address,uint256,bytes,bytes,(uint64,uint64),uint64)",
      "function queueRequest((bytes32,uint8,address,address,address,uint256,uint256,uint64),bytes,bytes,(uint64,uint64))",
      "function dispatchRecoveryHome(uint256,uint64,bytes,bytes)"
    ]);
    assert.equal(call.data.slice(0, 10), iface.getFunction(functionName).selector, leg);
  }
});
