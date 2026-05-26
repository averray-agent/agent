import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { parseArgs, buildInnerCalls } from "./redeploy-escrowcore-wire-multisig.mjs";

const TREASURY_POLICY_ABI = [
  "function setServiceOperator(address account, bool allowed)"
];
const iface = new Interface(TREASURY_POLICY_ABI);

const NEW = "0xb8fd8A932F69bD5E39700b7cf6D2920aF84d1B27";
const OLD = "0x7BB8fea44bDeE9870cF27c1dB616E7017BC38b0a";

test("parseArgs defaults profile=testnet, skipRevoke=false", () => {
  const args = parseArgs([]);
  assert.equal(args.profile, "testnet");
  assert.equal(args.skipRevoke, false);
});

test("parseArgs reads --new-escrow / --signer / --timepoint-*", () => {
  const args = parseArgs([
    "--new-escrow", NEW,
    "--signer", "ledger",
    "--timepoint-height", "12345",
    "--timepoint-index", "7"
  ]);
  assert.equal(args.newEscrow, NEW);
  assert.equal(args.signer, "ledger");
  assert.equal(args.tpHeight, "12345");
  assert.equal(args.tpIndex, "7");
});

test("parseArgs reads --skip-revoke + --old-escrow override", () => {
  const args = parseArgs([
    "--new-escrow", NEW,
    "--old-escrow", OLD,
    "--signer", "hot",
    "--skip-revoke"
  ]);
  assert.equal(args.oldEscrow, OLD);
  assert.equal(args.skipRevoke, true);
});

test("buildInnerCalls produces two calls by default (batched)", () => {
  const calls = buildInnerCalls({ iface, newEscrow: NEW, oldEscrow: OLD, skipRevoke: false });
  assert.equal(calls.length, 2);
  assert.match(calls[0].label, /approve new/u);
  assert.match(calls[1].label, /revoke stale/u);
  assert.equal(
    calls[0].data,
    iface.encodeFunctionData("setServiceOperator", [NEW, true])
  );
  assert.equal(
    calls[1].data,
    iface.encodeFunctionData("setServiceOperator", [OLD, false])
  );
});

test("buildInnerCalls produces one call when --skip-revoke is set", () => {
  const calls = buildInnerCalls({ iface, newEscrow: NEW, oldEscrow: OLD, skipRevoke: true });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].data,
    iface.encodeFunctionData("setServiceOperator", [NEW, true])
  );
});

test("setServiceOperator(0xb8fd…, true) encodes to the same calldata used by Apps recipe", () => {
  const data = iface.encodeFunctionData("setServiceOperator", [NEW, true]);
  assert.equal(
    data,
    "0xeea03c28000000000000000000000000b8fd8a932f69bd5e39700b7cf6d2920af84d1b270000000000000000000000000000000000000000000000000000000000000001"
  );
});

test("setServiceOperator(0x7BB8…, false) encodes to the revoke calldata", () => {
  const data = iface.encodeFunctionData("setServiceOperator", [OLD, false]);
  assert.equal(
    data,
    "0xeea03c280000000000000000000000007bb8fea44bdee9870cf27c1db616e7017bc38b0a0000000000000000000000000000000000000000000000000000000000000000"
  );
});
