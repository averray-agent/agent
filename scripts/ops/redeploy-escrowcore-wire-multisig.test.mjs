import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import {
  parseArgs,
  buildInnerCalls,
  resolveWs,
  verifyEvmCalldataEmbedded,
  UTILITY_BATCH_ALL_CALL_INDEX
} from "./redeploy-escrowcore-wire-multisig.mjs";

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

test("parseArgs reads --ws / --no-ws", () => {
  const a = parseArgs(["--ws", "wss://custom.example/asset-hub-paseo"]);
  assert.equal(a.ws, "wss://custom.example/asset-hub-paseo");
  assert.equal(a.noWs, false);
  const b = parseArgs(["--no-ws"]);
  assert.equal(b.noWs, true);
});

test("resolveWs prefers --ws over env, env over default, --no-ws returns null", () => {
  const prevEnv = process.env.PASEO_AH_WS;
  try {
    process.env.PASEO_AH_WS = "wss://env-endpoint.example";
    assert.equal(resolveWs({ ws: "wss://cli.example", noWs: false }), "wss://cli.example");
    assert.equal(resolveWs({ noWs: false }), "wss://env-endpoint.example");
    assert.equal(resolveWs({ noWs: true }), null);
    delete process.env.PASEO_AH_WS;
    assert.equal(resolveWs({ noWs: false }), "wss://sys.ibp.network/asset-hub-paseo");
  } finally {
    if (prevEnv === undefined) delete process.env.PASEO_AH_WS;
    else process.env.PASEO_AH_WS = prevEnv;
  }
});

test("UTILITY_BATCH_ALL_CALL_INDEX is the Asset Hub Paseo runtime prefix", () => {
  // pallet_utility (40 = 0x28) + batchAll call (2 = 0x02). If a runtime
  // upgrade reshuffles pallet indexes, this constant — and the on-chain
  // hex emitter that checks against it — needs to be updated.
  assert.equal(UTILITY_BATCH_ALL_CALL_INDEX, "0x2802");
});

test("verifyEvmCalldataEmbedded flags missing calldata inside the outer SCALE hex", () => {
  const NEW_DATA = iface.encodeFunctionData("setServiceOperator", [NEW, true]);
  const OLD_DATA = iface.encodeFunctionData("setServiceOperator", [OLD, false]);
  const innerCalls = [
    { label: "approve new", data: NEW_DATA },
    { label: "revoke old", data: OLD_DATA }
  ];
  // Construct an outer hex that contains both calldatas verbatim.
  const outerCallHex = "0x2802" + NEW_DATA.slice(2) + OLD_DATA.slice(2);
  const ok = verifyEvmCalldataEmbedded({ outerCallHex, innerCalls });
  assert.equal(ok.length, 2);
  assert.equal(ok[0].embedded, true);
  assert.equal(ok[1].embedded, true);

  // Drop the revoke calldata from the outer hex; the verifier should catch it.
  const tampered = "0x2802" + NEW_DATA.slice(2);
  const bad = verifyEvmCalldataEmbedded({ outerCallHex: tampered, innerCalls });
  assert.equal(bad[0].embedded, true);
  assert.equal(bad[1].embedded, false);
});
