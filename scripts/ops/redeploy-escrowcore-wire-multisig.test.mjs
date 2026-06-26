import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import {
  parseArgs,
  buildInnerCalls,
  buildOnchainPayload,
  resolveWs,
  verifyEvmCalldataEmbedded,
  UTILITY_BATCH_ALL_CALL_INDEX
} from "./redeploy-escrowcore-wire-multisig.mjs";

const TREASURY_POLICY_ABI = [
  "function setServiceOperator(address account, bool allowed)"
];
const AGENT_ACCOUNT_ABI = [
  "function setEscrowOperator(address escrowOperator, bool approved)"
];
const policyIface = new Interface(TREASURY_POLICY_ABI);
const accountIface = new Interface(AGENT_ACCOUNT_ABI);

const NEW = "0xb8fd8A932F69bD5E39700b7cf6D2920aF84d1B27";
const OLD = "0x7BB8fea44bDeE9870cF27c1dB616E7017BC38b0a";
const TREASURY_POLICY = "0x648Cc5fdE94435992296C4e5ac642d18bB64c12B";
const AGENT_ACCOUNT = "0x71B111d8c9DF84Be26cb9067D27dAd7A2d5E7e08";
const NEW_AGENT_ACCOUNT = "0xbd9c2d9336a91415287bb032ec34e8b80a1f38a0";

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

test("parseArgs reads fresh AgentAccountCore overrides", () => {
  const args = parseArgs([
    "--new-escrow", NEW,
    "--new-agent-account", NEW_AGENT_ACCOUNT,
    "--old-agent-account", AGENT_ACCOUNT,
    "--signer", "hot"
  ]);
  assert.equal(args.newAgentAccount, NEW_AGENT_ACCOUNT);
  assert.equal(args.oldAgentAccount, AGENT_ACCOUNT);
});

function buildFixtureCalls({ skipRevoke = false } = {}) {
  return buildInnerCalls({
    policyIface,
    accountIface,
    treasuryPolicy: TREASURY_POLICY,
    agentAccount: AGENT_ACCOUNT,
    newEscrow: NEW,
    oldEscrow: OLD,
    skipRevoke
  });
}

function buildFreshAgentAccountCalls({ skipRevoke = false } = {}) {
  return buildInnerCalls({
    policyIface,
    accountIface,
    treasuryPolicy: TREASURY_POLICY,
    agentAccount: NEW_AGENT_ACCOUNT,
    newAgentAccount: NEW_AGENT_ACCOUNT,
    oldAgentAccount: AGENT_ACCOUNT,
    newEscrow: NEW,
    oldEscrow: OLD,
    skipRevoke
  });
}

test("buildInnerCalls produces four calls by default (batched approve + revoke across both contracts)", () => {
  const calls = buildFixtureCalls();
  assert.equal(calls.length, 4);
  assert.match(calls[0].label, /AgentAccountCore\.setEscrowOperator/u);
  assert.match(calls[1].label, /TreasuryPolicy\.setServiceOperator/u);
  assert.match(calls[2].label, /AgentAccountCore\.setEscrowOperator/u);
  assert.match(calls[3].label, /TreasuryPolicy\.setServiceOperator/u);
  assert.equal(calls[0].to, AGENT_ACCOUNT);
  assert.equal(calls[1].to, TREASURY_POLICY);
  assert.equal(calls[2].to, AGENT_ACCOUNT);
  assert.equal(calls[3].to, TREASURY_POLICY);
  assert.equal(
    calls[0].data,
    accountIface.encodeFunctionData("setEscrowOperator", [NEW, true])
  );
  assert.equal(
    calls[1].data,
    policyIface.encodeFunctionData("setServiceOperator", [NEW, true])
  );
  assert.equal(
    calls[2].data,
    accountIface.encodeFunctionData("setEscrowOperator", [OLD, false])
  );
  assert.equal(
    calls[3].data,
    policyIface.encodeFunctionData("setServiceOperator", [OLD, false])
  );
});

test("buildInnerCalls produces two approve calls when --skip-revoke is set", () => {
  const calls = buildFixtureCalls({ skipRevoke: true });
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].data,
    accountIface.encodeFunctionData("setEscrowOperator", [NEW, true])
  );
  assert.equal(
    calls[1].data,
    policyIface.encodeFunctionData("setServiceOperator", [NEW, true])
  );
});

test("buildInnerCalls wires a freshly redeployed AgentAccountCore in the same batch", () => {
  const calls = buildFreshAgentAccountCalls();
  assert.equal(calls.length, 5);
  assert.match(calls[0].label, /approve new AgentAccountCore/u);
  assert.equal(calls[0].to, TREASURY_POLICY);
  assert.equal(
    calls[0].data,
    policyIface.encodeFunctionData("setServiceOperator", [NEW_AGENT_ACCOUNT, true])
  );
  assert.equal(calls[1].to, NEW_AGENT_ACCOUNT);
  assert.equal(
    calls[1].data,
    accountIface.encodeFunctionData("setEscrowOperator", [NEW, true])
  );
  assert.equal(calls[2].to, TREASURY_POLICY);
  assert.equal(calls[3].to, AGENT_ACCOUNT);
  assert.equal(
    calls[3].data,
    accountIface.encodeFunctionData("setEscrowOperator", [OLD, false])
  );
  assert.equal(calls[4].to, TREASURY_POLICY);
});

test("setServiceOperator(0xb8fd…, true) encodes to the same calldata used by Apps recipe", () => {
  const data = policyIface.encodeFunctionData("setServiceOperator", [NEW, true]);
  assert.equal(
    data,
    "0xeea03c28000000000000000000000000b8fd8a932f69bd5e39700b7cf6d2920af84d1b270000000000000000000000000000000000000000000000000000000000000001"
  );
});

test("setServiceOperator(0x7BB8…, false) encodes to the revoke calldata", () => {
  const data = policyIface.encodeFunctionData("setServiceOperator", [OLD, false]);
  assert.equal(
    data,
    "0xeea03c280000000000000000000000007bb8fea44bdee9870cf27c1db616e7017bc38b0a0000000000000000000000000000000000000000000000000000000000000000"
  );
});

test("setEscrowOperator(0xb8fd…, true) encodes to the ledger-authority calldata", () => {
  const data = accountIface.encodeFunctionData("setEscrowOperator", [NEW, true]);
  assert.equal(
    data,
    "0x7205676e000000000000000000000000b8fd8a932f69bd5e39700b7cf6d2920af84d1b270000000000000000000000000000000000000000000000000000000000000001"
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

// Live SCALE-encoding check against Paseo Asset Hub. Default-skipped to keep
// `npm run test:ops` runnable offline / in CI. Opt in with
//   RUN_PASEO_AH_WS_TESTS=1 npm run test:ops
// or by pointing PASEO_AH_WS at any reachable Asset Hub Paseo endpoint and
// setting RUN_PASEO_AH_WS_TESTS=1. The test is the only check tied to runtime
// metadata, so it catches pallet-index reshuffles in CI when explicitly run.
const RUN_WS = process.env.RUN_PASEO_AH_WS_TESTS === "1";
test(
  `buildOnchainPayload emits a utility.batchAll call whose hex starts with ${UTILITY_BATCH_ALL_CALL_INDEX}`,
  { skip: RUN_WS ? false : "set RUN_PASEO_AH_WS_TESTS=1 to exercise the live Paseo AH endpoint" },
  async () => {
    const { ApiPromise, WsProvider } = await import("@polkadot/api");
    const { blake2AsHex } = await import("@polkadot/util-crypto");
    const wsUrl = process.env.PASEO_AH_WS || "wss://sys.ibp.network/asset-hub-paseo";
    const provider = new WsProvider(wsUrl);
    const api = await ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
    try {
      const innerCalls = buildFixtureCalls();
      const payload = await buildOnchainPayload({
        api,
        blake2AsHex,
        innerCalls,
        reviveRefTime: 4_000_000_000,
        reviveProofSize: 100_000,
        storageDepositLimit: 1_000_000_000,
        threshold: 2,
        otherSignatories: [
          "13pav6xpfdapyCAqfRhWZXxUnqDhjrF92dJr3FBwVfBKUKSM",
          "148tqwhGxeCva7ZX8RwvaLjCS7HvDJJaSbxfTUwE9Zyc5Xtm"
        ],
        timepoint: null,
        maxWeightRefTime: 9_000_000_000,
        maxWeightProofSize: 300_000
      });

      assert.equal(payload.isBatch, true);
      assert.ok(
        payload.outerCallHex.toLowerCase().startsWith(UTILITY_BATCH_ALL_CALL_INDEX.toLowerCase()),
        `outerCallHex ${payload.outerCallHex.slice(0, 12)}… should start with ${UTILITY_BATCH_ALL_CALL_INDEX}`
      );
      assert.match(payload.outerCallHash, /^0x[0-9a-f]{64}$/u);
      // Sanity: the EVM calldata we passed in must show up inside the SCALE blob.
      const checks = verifyEvmCalldataEmbedded({ outerCallHex: payload.outerCallHex, innerCalls });
      assert.ok(checks.every((c) => c.embedded), "every inner EVM calldata must be embedded in batchAll hex");
    } finally {
      await api.disconnect();
    }
  }
);

test("verifyEvmCalldataEmbedded flags missing calldata inside the outer SCALE hex", () => {
  const NEW_DATA = policyIface.encodeFunctionData("setServiceOperator", [NEW, true]);
  const OLD_DATA = policyIface.encodeFunctionData("setServiceOperator", [OLD, false]);
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
