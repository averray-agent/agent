import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Interface } from "ethers";
import {
  parseArgs,
  buildInnerCalls,
  buildOnchainPayload,
  resolveProfileSigner,
  assertOwnerRecordAuthority,
  resolveSubstrateEndpoint,
  buildPolkadotAppsExtrinsicsUrl,
  assertSubstrateProfileEncoding,
  SUBSTRATE_PROFILE_CONFIG,
  verifyEvmCalldataEmbedded,
  UTILITY_BATCH_ALL_CALL_INDEX
} from "./redeploy-escrowcore-wire-multisig.mjs";

const TREASURY_POLICY_ABI = [
  "function setSettlementBroker(address account, bool allowed)",
  "function setAgentTransferBroker(address account, bool allowed)",
  "function setReputationWriter(address account, bool allowed)",
  "function setOutflowRecorder(address account, bool allowed)"
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
const BACKEND_SIGNER = "0x31ad432dFe083B998c69B6dB88A984ec5207ab7F";
const MAINNET_OWNER_RECORD = JSON.parse(
  readFileSync(
    new URL("../../deployments/mainnet-multisig-owner.json", import.meta.url),
    "utf8"
  )
);
const TESTNET_OWNER_RECORD = JSON.parse(
  readFileSync(
    new URL("../../deployments/testnet-multisig-owner.json", import.meta.url),
    "utf8"
  )
);

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

test("profile signer resolution rejects aliases from the other network", () => {
  const mainnetLedger = resolveProfileSigner({
    ownerRecord: MAINNET_OWNER_RECORD,
    profile: "mainnet",
    signerLabel: "ledger"
  });
  assert.equal(
    mainnetLedger.me.address,
    "1mhf9yyYq3ArZAEysQQfWYNe2rgrDP6omrn6xiJBbwKqYZH"
  );
  assert.throws(
    () =>
      resolveProfileSigner({
        ownerRecord: MAINNET_OWNER_RECORD,
        profile: "mainnet",
        signerLabel: "hot"
      }),
    /--signer hot is not defined for profile mainnet.*ledger, vault, nova/u
  );

  const testnetHot = resolveProfileSigner({
    ownerRecord: TESTNET_OWNER_RECORD,
    profile: "testnet",
    signerLabel: "hot"
  });
  assert.equal(
    testnetHot.me.address,
    "14ruuTeh5cXMTr9SLNuLt1NiroQZgt5ZQnwYrhg7K5LHiXQb"
  );
  assert.throws(
    () =>
      resolveProfileSigner({
        ownerRecord: TESTNET_OWNER_RECORD,
        profile: "testnet",
        signerLabel: "nova"
      }),
    /--signer nova is not defined for profile testnet.*vault, ledger, hot/u
  );
  assert.throws(
    () =>
      resolveProfileSigner({
        ownerRecord: TESTNET_OWNER_RECORD,
        profile: "mainnet",
        signerLabel: "ledger"
      }),
    /Owner record profile "testnet" does not match requested profile "mainnet"/u
  );
});

test("mainnet owner record derives the live TreasuryPolicy owner", () => {
  const result = assertOwnerRecordAuthority({
    ownerRecord: MAINNET_OWNER_RECORD,
    livePolicyOwner: "0x01e6eed856e989201f4ff6346e18eab7e46c874c"
  });
  assert.equal(
    result.derivedAccountId32,
    "0x93511e8deef3e7ec69cc1f18a573176da9870a0fb474ab2e0c18d88a5e74fd47"
  );
  assert.equal(
    result.derivedOwner,
    "0x01E6eed856e989201F4FF6346E18EAb7e46C874C"
  );
});

test("owner authority derivation fails closed on a tampered roster", () => {
  const tampered = structuredClone(MAINNET_OWNER_RECORD);
  tampered.signatories[0].address =
    "13pav6xpfdapyCAqfRhWZXxUnqDhjrF92dJr3FBwVfBKUKSM";
  tampered.signatories[0].accountId32 =
    "0x7cc32bbee82258e9302721a93de10cc95bd1def2af0762223ee22dbb18f1da67";

  assert.throws(
    () =>
      assertOwnerRecordAuthority({
        ownerRecord: tampered,
        livePolicyOwner: "0x01e6eed856e989201f4ff6346e18eab7e46c874c"
      }),
    /derived multisig AccountId32 .* does not match verified owner record/u
  );
});

test("owner authority derivation fails closed when the live policy has another owner", () => {
  assert.throws(
    () =>
      assertOwnerRecordAuthority({
        ownerRecord: MAINNET_OWNER_RECORD,
        livePolicyOwner: "0x1f8c4da4aaac79916350f1fabf1221309591b6f9"
      }),
    /derived H160 .* does not match live TreasuryPolicy\.owner\(\)/u
  );
});

test("testnet profile resolution preserves the former hardcoded roster and ordering", () => {
  const resolved = resolveProfileSigner({
    ownerRecord: TESTNET_OWNER_RECORD,
    profile: "testnet",
    signerLabel: "ledger"
  });
  assert.deepEqual(
    {
      label: resolved.me.label,
      address: resolved.me.address,
      otherSignatories: resolved.otherSignatories
    },
    {
      label: "ledger",
      address: "148tqwhGxeCva7ZX8RwvaLjCS7HvDJJaSbxfTUwE9Zyc5Xtm",
      otherSignatories: [
        "13pav6xpfdapyCAqfRhWZXxUnqDhjrF92dJr3FBwVfBKUKSM",
        "14ruuTeh5cXMTr9SLNuLt1NiroQZgt5ZQnwYrhg7K5LHiXQb"
      ]
    }
  );
});

test("signatory sorting normalizes accountId32 case before byte-order comparison", () => {
  const mixedCaseRecord = {
    profile: "testnet",
    status: "verified",
    threshold: 2,
    signatories: [
      { label: "b", address: "B", accountId32: "0xB0" },
      { label: "a", address: "A", accountId32: "0xa0" },
      { label: "c", address: "C", accountId32: "0xC0" }
    ]
  };
  const resolved = resolveProfileSigner({
    ownerRecord: mixedCaseRecord,
    profile: "testnet",
    signerLabel: "b"
  });
  assert.deepEqual(resolved.otherSignatories, ["A", "C"]);
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
    backendSigner: BACKEND_SIGNER,
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
    backendSigner: BACKEND_SIGNER,
    skipRevoke
  });
}

test("buildInnerCalls produces least-privilege role calls by default", () => {
  const calls = buildFixtureCalls();
  assert.equal(calls.length, 9);
  assert.match(calls[0].label, /AgentAccountCore\.setEscrowOperator/u);
  assert.match(calls[1].label, /TreasuryPolicy\.setSettlementBroker/u);
  assert.match(calls[2].label, /TreasuryPolicy\.setReputationWriter/u);
  assert.match(calls[3].label, /TreasuryPolicy\.setSettlementBroker/u);
  assert.match(calls[4].label, /TreasuryPolicy\.setAgentTransferBroker/u);
  assert.match(calls[5].label, /TreasuryPolicy\.setReputationWriter/u);
  assert.match(calls[6].label, /AgentAccountCore\.setEscrowOperator/u);
  assert.match(calls[7].label, /TreasuryPolicy\.setSettlementBroker/u);
  assert.match(calls[8].label, /TreasuryPolicy\.setReputationWriter/u);
  assert.equal(calls[0].to, AGENT_ACCOUNT);
  assert.equal(calls[1].to, TREASURY_POLICY);
  assert.equal(calls[2].to, TREASURY_POLICY);
  assert.equal(calls[3].to, TREASURY_POLICY);
  assert.equal(calls[4].to, TREASURY_POLICY);
  assert.equal(calls[5].to, TREASURY_POLICY);
  assert.equal(calls[6].to, AGENT_ACCOUNT);
  assert.equal(calls[7].to, TREASURY_POLICY);
  assert.equal(calls[8].to, TREASURY_POLICY);
  assert.equal(
    calls[0].data,
    accountIface.encodeFunctionData("setEscrowOperator", [NEW, true])
  );
  assert.equal(
    calls[1].data,
    policyIface.encodeFunctionData("setSettlementBroker", [NEW, true])
  );
  assert.equal(
    calls[2].data,
    policyIface.encodeFunctionData("setReputationWriter", [NEW, true])
  );
  assert.equal(
    calls[3].data,
    policyIface.encodeFunctionData("setSettlementBroker", [BACKEND_SIGNER, true])
  );
  assert.equal(
    calls[4].data,
    policyIface.encodeFunctionData("setAgentTransferBroker", [BACKEND_SIGNER, true])
  );
  assert.equal(
    calls[5].data,
    policyIface.encodeFunctionData("setReputationWriter", [BACKEND_SIGNER, true])
  );
  assert.equal(
    calls[6].data,
    accountIface.encodeFunctionData("setEscrowOperator", [OLD, false])
  );
  assert.equal(
    calls[7].data,
    policyIface.encodeFunctionData("setSettlementBroker", [OLD, false])
  );
  assert.equal(
    calls[8].data,
    policyIface.encodeFunctionData("setReputationWriter", [OLD, false])
  );
});

test("buildInnerCalls produces approve-only role calls when --skip-revoke is set", () => {
  const calls = buildFixtureCalls({ skipRevoke: true });
  assert.equal(calls.length, 6);
  assert.equal(
    calls[0].data,
    accountIface.encodeFunctionData("setEscrowOperator", [NEW, true])
  );
  assert.equal(
    calls[1].data,
    policyIface.encodeFunctionData("setSettlementBroker", [NEW, true])
  );
  assert.equal(
    calls[2].data,
    policyIface.encodeFunctionData("setReputationWriter", [NEW, true])
  );
  assert.equal(
    calls[3].data,
    policyIface.encodeFunctionData("setSettlementBroker", [BACKEND_SIGNER, true])
  );
  assert.equal(
    calls[4].data,
    policyIface.encodeFunctionData("setAgentTransferBroker", [BACKEND_SIGNER, true])
  );
  assert.equal(
    calls[5].data,
    policyIface.encodeFunctionData("setReputationWriter", [BACKEND_SIGNER, true])
  );
});

test("buildInnerCalls wires a freshly redeployed AgentAccountCore in the same batch", () => {
  const calls = buildFreshAgentAccountCalls();
  assert.equal(calls.length, 10);
  assert.match(calls[0].label, /approve new AgentAccountCore/u);
  assert.equal(calls[0].to, TREASURY_POLICY);
  assert.equal(
    calls[0].data,
    policyIface.encodeFunctionData("setOutflowRecorder", [NEW_AGENT_ACCOUNT, true])
  );
  assert.equal(calls[1].to, NEW_AGENT_ACCOUNT);
  assert.equal(
    calls[1].data,
    accountIface.encodeFunctionData("setEscrowOperator", [NEW, true])
  );
  assert.equal(calls[2].to, TREASURY_POLICY);
  assert.equal(
    calls[2].data,
    policyIface.encodeFunctionData("setSettlementBroker", [NEW, true])
  );
  assert.equal(calls[3].to, TREASURY_POLICY);
  assert.equal(
    calls[3].data,
    policyIface.encodeFunctionData("setReputationWriter", [NEW, true])
  );
  assert.equal(calls[4].to, TREASURY_POLICY);
  assert.equal(calls[5].to, TREASURY_POLICY);
  assert.equal(calls[6].to, TREASURY_POLICY);
  assert.equal(calls[7].to, AGENT_ACCOUNT);
  assert.equal(
    calls[7].data,
    accountIface.encodeFunctionData("setEscrowOperator", [OLD, false])
  );
  assert.equal(calls[8].to, TREASURY_POLICY);
  assert.equal(calls[9].to, TREASURY_POLICY);
});

test("role-setter calldata uses distinct selectors for the multisig recipe", () => {
  assert.notEqual(
    policyIface.encodeFunctionData("setSettlementBroker", [NEW, true]).slice(0, 10),
    policyIface.encodeFunctionData("setAgentTransferBroker", [NEW, true]).slice(0, 10)
  );
  assert.notEqual(
    policyIface.encodeFunctionData("setReputationWriter", [NEW, true]).slice(0, 10),
    policyIface.encodeFunctionData("setOutflowRecorder", [NEW, true]).slice(0, 10)
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

test("mainnet profile resolves and emits only a Polkadot Asset Hub endpoint", () => {
  const wsUrl = resolveSubstrateEndpoint({ profile: "mainnet" }, {});
  assert.equal(wsUrl, "wss://polkadot-asset-hub-rpc.polkadot.io");
  assert.doesNotMatch(wsUrl, /paseo/iu);

  const appsUrl = buildPolkadotAppsExtrinsicsUrl(wsUrl);
  assert.equal(
    appsUrl,
    "https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Fpolkadot-asset-hub-rpc.polkadot.io#/extrinsics"
  );
  assert.doesNotMatch(appsUrl, /paseo/iu);
});

test("Substrate endpoint resolution is profile-bound with no cross-profile fallback", () => {
  assert.equal(
    resolveSubstrateEndpoint(
      { profile: "mainnet" },
      {
        POLKADOT_AH_WS: "wss://mainnet.example",
        PASEO_AH_WS: "wss://must-not-be-used.example/paseo"
      }
    ),
    "wss://mainnet.example"
  );
  assert.equal(
    resolveSubstrateEndpoint(
      { profile: "testnet" },
      {
        POLKADOT_AH_WS: "wss://must-not-be-used.example/mainnet",
        PASEO_AH_WS: "wss://testnet.example"
      }
    ),
    "wss://testnet.example"
  );
  assert.throws(
    () => resolveSubstrateEndpoint({ profile: "staging" }, {}),
    /No Substrate endpoint is defined for profile "staging"/u
  );
  assert.equal(
    resolveSubstrateEndpoint(
      { profile: "mainnet", noWs: true },
      { POLKADOT_AH_WS: "wss://unverified.example" }
    ),
    "wss://polkadot-asset-hub-rpc.polkadot.io"
  );
  assert.throws(
    () =>
      resolveSubstrateEndpoint(
        { profile: "mainnet", noWs: true, ws: "wss://unverified.example" },
        {}
      ),
    /--ws cannot be combined with --no-ws/u
  );
});

function fakeSubstrateApi({
  profile,
  chainName,
  genesisHash,
  reviveIndex
}) {
  const config = SUBSTRATE_PROFILE_CONFIG[profile];
  return {
    genesisHash: {
      toHex: () => genesisHash ?? config.genesisHash
    },
    rpc: {
      system: {
        chain: async () => ({
          toString: () => chainName ?? config.chainName
        })
      }
    },
    runtimeMetadata: {
      asLatest: {
        pallets: [
          {
            name: { toString: () => "Revive" },
            index: { toNumber: () => reviveIndex ?? config.revivePalletIndex }
          }
        ]
      }
    }
  };
}

test("Paseo-encoded revive calls are rejected for the mainnet profile", async () => {
  await assert.rejects(
    () =>
      assertSubstrateProfileEncoding({
        api: fakeSubstrateApi({ profile: "mainnet" }),
        profile: "mainnet",
        reviveCallHexes: ["0x64deadbeef"]
      }),
    /encoded revive\.call uses pallet index 100 \(0x64\).*mainnet metadata uses 90 \(0x5a\)/u
  );
});

test("Substrate profile guard rejects a Paseo connection for mainnet", async () => {
  await assert.rejects(
    () =>
      assertSubstrateProfileEncoding({
        api: fakeSubstrateApi({
          profile: "mainnet",
          chainName: "Paseo Asset Hub",
          genesisHash: SUBSTRATE_PROFILE_CONFIG.testnet.genesisHash,
          reviveIndex: 100
        }),
        profile: "mainnet",
        reviveCallHexes: ["0x64deadbeef"]
      }),
    /connected genesis .* does not match mainnet Polkadot Asset Hub/u
  );
});

test("UTILITY_BATCH_ALL_CALL_INDEX is the current Asset Hub runtime prefix", () => {
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
  const NEW_DATA = policyIface.encodeFunctionData("setSettlementBroker", [NEW, true]);
  const OLD_DATA = policyIface.encodeFunctionData("setReputationWriter", [OLD, false]);
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
