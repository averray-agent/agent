import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTRACT_ARTIFACTS,
  contractArtifactFor,
  RESERVATION_SETTLED_INPUTS,
  RESERVATION_SETTLED_SIGNATURE,
  RESERVATION_SETTLED_TOPIC0,
  artifactAbiHash,
  checkArtifactProvenance,
  checkRuntimeProvenance,
  compareMaskedRuntime,
  eventSignature,
  runtimeCodeHash,
  validateProvenanceManifest,
} from "./check-contract-provenance.mjs";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const SOURCE_COMMIT = "a".repeat(40);
const VERIFIED_AT = "2026-07-29T19:40:33.000Z";
const CODE = "0x60010203";

test("T3 v22 identities and movable pool aliases select the correct artifacts at cutover", () => {
  const v21 = "0x2121212121212121212121212121212121212121";
  const v22 = "0x2222222222222222222222222222222222222222";
  const manifest = { contracts: { depositPoolV21: v21, legacyDepositPoolV21: v21,
    depositPoolV22: v22, depositPool: v21, depositPoolV2: v21 } };
  const oldArtifact = ["DepositPoolV2.sol", "DepositPoolV2"];
  const nextArtifact = ["DepositPoolV22.sol", "DepositPoolV22"];
  for (const key of ["depositPool", "depositPoolV2"]) {
    assert.deepEqual(contractArtifactFor(manifest, key), oldArtifact);
    manifest.contracts[key] = v22;
    assert.deepEqual(contractArtifactFor(manifest, key), nextArtifact);
  }
  assert.deepEqual(contractArtifactFor(manifest, "legacyDepositPoolV21"), oldArtifact);
  assert.deepEqual(contractArtifactFor(manifest, "depositPoolV21"), oldArtifact);
  assert.deepEqual(CONTRACT_ARTIFACTS.depositPoolV22, nextArtifact);
  assert.deepEqual(CONTRACT_ARTIFACTS.aacPoolAggregatorAdapterV22, ["AacPoolAggregatorAdapterV22.sol", "AacPoolAggregatorAdapterV22"]);
  assert.deepEqual(CONTRACT_ARTIFACTS.depositPoolLaneV22, ["HydrationUsdcAdapterV22.sol", "HydrationUsdcAdapterV22"]);
  assert.deepEqual(CONTRACT_ARTIFACTS.hydrationDepositPoolAdapterV22, ["HydrationDepositPoolAdapter.sol", "HydrationDepositPoolAdapter"]);
});

test("T3 each new v22 manifest identity requires creation provenance as well as runtime provenance", () => {
  for (const key of ["depositPoolV22", "aacPoolAggregatorAdapterV22", "depositPoolLaneV22", "hydrationDepositPoolAdapterV22"]) {
    const manifest = manifestFor();
    manifest.contracts[key] = ADDRESS;
    assert.throws(() => validateProvenanceManifest(manifest), /creationBytecodeHash/u);
    manifest.contractProvenance[ADDRESS].creationBytecodeHash = `0x${"c".repeat(64)}`;
    assert.ok(validateProvenanceManifest(manifest).some((c) => c.name === key));
  }
});

function manifestFor(code = CODE) {
  return {
    profile: "mainnet",
    rpcUrl: "https://rpc.invalid",
    contracts: {
      treasuryPolicy: ADDRESS,
      xcmWrapper: null,
      token: "0x0000053900000000000000000000000001200000",
    },
    contractProvenance: {
      [ADDRESS]: {
        sourceCommit: SOURCE_COMMIT,
        abiHash: `sha256:${"b".repeat(64)}`,
        runtimeCodeHash: runtimeCodeHash(code),
        verifiedAt: VERIFIED_AT,
      },
    },
  };
}

function mockRpc({ chainId = 420420419, code = CODE } = {}) {
  return async (_url, init) => {
    const request = JSON.parse(init.body);
    const result = request.method === "eth_chainId" ? `0x${chainId.toString(16)}` : code;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: request.id, result }) };
  };
}

test("runtimeCodeHash hashes decoded runtime bytes, not the hex text", () => {
  assert.equal(
    runtimeCodeHash("0x00ff"),
    "sha256:06eb7d6a69ee19e5fbdf749018d3d2abfa04bcbd1365db312eb86dc7169389b8"
  );
});

test("masked runtime comparison accepts only immutable-slot differences", () => {
  const comparison = compareMaskedRuntime("0x60010203", "0x60aa0203", {
    "17": [{ start: 1, length: 1 }],
  });

  assert.equal(comparison.matches, true);
  assert.equal(comparison.diffBytes, 1);
  assert.equal(comparison.outsideImmutableSlots, 0);
  assert.equal(comparison.maskedCompiledHash, comparison.maskedDeployedHash);
  assert.deepEqual(comparison.slotDiffs, [
    { sourceId: "17", start: 1, length: 1, diffBytes: 1 },
  ]);
});

test("masked runtime comparison rejects a diff outside immutable slots", () => {
  const comparison = compareMaskedRuntime("0x60010203", "0x60aa9903", {
    "17": [{ start: 1, length: 1 }],
  });

  assert.equal(comparison.matches, false);
  assert.equal(comparison.diffBytes, 2);
  assert.equal(comparison.outsideImmutableSlots, 1);
  assert.notEqual(comparison.maskedCompiledHash, comparison.maskedDeployedHash);
});

test("masked runtime comparison fails closed on unequal lengths", () => {
  const comparison = compareMaskedRuntime("0x60010203", "0x600102", {});
  assert.equal(comparison.matches, false);
  assert.equal(comparison.lengthsMatch, false);
  assert.equal(comparison.compiledBytes, 4);
  assert.equal(comparison.deployedBytes, 3);
});

test("runtime provenance passes matching chain code and fails closed on a wrong manifest hash", async () => {
  const matching = await checkRuntimeProvenance({
    profile: "mainnet",
    manifest: manifestFor(),
    fetchImpl: mockRpc(),
  });
  assert.equal(matching.ok, true);
  assert.equal(matching.checks[0].codeBytes, 4);

  const wrongHashManifest = manifestFor();
  wrongHashManifest.contractProvenance[ADDRESS].runtimeCodeHash =
    `sha256:${"0".repeat(64)}`;
  const drifted = await checkRuntimeProvenance({
    profile: "mainnet",
    manifest: wrongHashManifest,
    fetchImpl: mockRpc(),
  });
  assert.equal(drifted.ok, false);
  assert.notEqual(drifted.checks[0].actual, drifted.checks[0].expected);
});

test("runtime provenance rejects the wrong chain before reading code", async () => {
  await assert.rejects(
    checkRuntimeProvenance({
      profile: "mainnet",
      manifest: manifestFor(),
      fetchImpl: mockRpc({ chainId: 1 }),
    }),
    /chainId 1 does not match mainnet chainId 420420419/u
  );
});

test("manifest validation requires provenance for every source-controlled address", () => {
  const manifest = manifestFor();
  delete manifest.contractProvenance[ADDRESS];
  assert.throws(
    () => validateProvenanceManifest(manifest),
    /missing contractProvenance for contracts\.treasuryPolicy/u
  );
});

test("ReservationSettled uses the topic0 observed in a live mainnet log", () => {
  const abi = [
    {
      type: "event",
      name: "ReservationSettled",
      inputs: [
        { indexed: true, name: "settlementId", type: "bytes32" },
        { indexed: true, name: "account", type: "address" },
        { indexed: true, name: "recipient", type: "address" },
        { indexed: false, name: "asset", type: "address" },
        { indexed: false, name: "amount", type: "uint256" },
      ],
    },
  ];

  assert.deepEqual(abi[0].inputs, RESERVATION_SETTLED_INPUTS);
  assert.equal(abi[0].inputs[0].name, "settlementId");
  assert.equal(eventSignature(abi, "ReservationSettled"), RESERVATION_SETTLED_SIGNATURE);
  assert.equal(
    RESERVATION_SETTLED_TOPIC0,
    "0x3cdc0be5ec7141f2342208f6404c1b1852936343f0edf1fda179e6c9f46573ee"
  );
});

test("artifact provenance reports ABI and per-slot masked-runtime evidence", () => {
  const abi = [
    {
      type: "event",
      name: "ReservationSettled",
      inputs: RESERVATION_SETTLED_INPUTS,
    },
  ];
  const artifact = {
    abi,
    deployedBytecode: {
      object: CODE,
      immutableReferences: { "17": [{ start: 1, length: 1 }] },
    },
  };
  const result = checkArtifactProvenance({
    name: "agentAccountCore",
    artifact,
    deployedCode: "0x60aa0203",
    provenance: {
      abiHash: artifactAbiHash(abi),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.runtime.outsideImmutableSlots, 0);
  assert.equal(result.runtime.slotDiffs[0].diffBytes, 1);
  assert.deepEqual(result.reservationSettled, {
    signature: RESERVATION_SETTLED_SIGNATURE,
    topic0: RESERVATION_SETTLED_TOPIC0,
    fields: RESERVATION_SETTLED_INPUTS,
    ok: true,
  });
});

test("mainnet manifest covers every deployed source-controlled contract address", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../deployments/mainnet.json", import.meta.url), "utf8")
  );
  const contracts = validateProvenanceManifest(manifest);
  assert.deepEqual(
    contracts.map((contract) => contract.name),
    [
      "treasuryPolicy",
      "strategyAdapterRegistry",
      "agentAccountCore",
      "reputationSbt",
      "discoveryRegistry",
      "escrowCore",
      "xcmWrapper",
      "legacyEscrowCore",
      "hydrationUsdcAdapter",
      "depositPoolLane",
      "hydrationDepositPoolAdapter",
      "depositPool",
      "depositPoolLaneV2",
      "hydrationDepositPoolAdapterV2",
      "depositPoolV2",
      "legacyDepositPoolV2",
      "creditPool",
      "creditBook",
      "depositPoolV21",
      "legacyDepositPoolV21",
      "aacPoolAggregatorAdapter",
      "depositPoolLaneV21",
      "hydrationDepositPoolAdapterV21",
      "depositPoolV22",
      "aacPoolAggregatorAdapterV22",
      "depositPoolLaneV22",
      "hydrationDepositPoolAdapterV22",
    ]
  );
  assert.equal(
    contracts.find((contract) => contract.name === "escrowCore")?.provenance.sourceCommit,
    "052b3a7a791112001257226ecfbea7a919d9aca2"
  );
  assert.equal(
    contracts.find((contract) => contract.name === "legacyEscrowCore")?.provenance.sourceCommit,
    "775a826b0a33d0ec04dd19f0455e69402dc9bbcd"
  );
  for (const name of ["xcmWrapper", "hydrationUsdcAdapter"]) {
    assert.equal(
      contracts.find((contract) => contract.name === name)?.provenance.sourceCommit,
      "464fd8c018c5735a7f1e495c9a2eeb17c378bb0d"
    );
  }
  // The lane and retired v2 pool still compile from the L1 ceremony tree.
  for (const name of [
    "depositPoolLane",
    "hydrationDepositPoolAdapter",
    "depositPoolLaneV2",
    "hydrationDepositPoolAdapterV2",
    "legacyDepositPoolV2",
    "creditPool",
  ]) {
    assert.equal(
      contracts.find((contract) => contract.name === name)?.provenance.sourceCommit,
      "9a6f3dffa6010ddbdc6b50617454e1632afe0b99"
    );
  }
  for (const name of ["depositPoolV21", "legacyDepositPoolV21"]) {
    assert.equal(
      contracts.find((contract) => contract.name === name)?.provenance.sourceCommit,
      "684ab8860f8e2f3ffd76ac0587f742f5e9d517e2"
    );
  }
  assert.deepEqual(CONTRACT_ARTIFACTS.legacyDepositPoolV2, [
    "DepositPoolV2.sol",
    "DepositPoolV2",
  ]);
  for (const [name, artifact, creationBytecodeHash] of [
    ["depositPoolLaneV21", "HydrationUsdcAdapterV22", "0x997ddcced2590a77dda1a555e07916e9e55231f28e130b5b26d6bc9fc10e1efe"],
    ["hydrationDepositPoolAdapterV21", "HydrationDepositPoolAdapter", "0xe862dde09519a056c22c17d3bc8071a9b9f1f8df3eeecca4636de7a04ae49a44"],
  ]) {
    const { provenance } = contracts.find((contract) => contract.name === name);
    assert.equal(provenance.sourceCommit, "9ada467d96753e55d7df164b32c08802ffa6a220");
    assert.equal(provenance.creationBytecodeHash, creationBytecodeHash);
    assert.deepEqual(CONTRACT_ARTIFACTS[name], [`${artifact}.sol`, artifact]);
  }
  assert.deepEqual(CONTRACT_ARTIFACTS.depositPoolLane, [
    "HydrationUsdcAdapterV22.sol",
    "HydrationUsdcAdapterV22",
  ]);
  assert.deepEqual(CONTRACT_ARTIFACTS.hydrationUsdcAdapter, [
    "HydrationUsdcAdapterV22.sol",
    "HydrationUsdcAdapterV22",
  ]);
});

test("Ceremony C T3 records all four deployed identities with provenance and no unshipped waiver", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../deployments/mainnet.json", import.meta.url), "utf8"));
  const contracts = validateProvenanceManifest(manifest);
  // Packet PR 1, deployed from d37c2eed; these are identities, not door aliases.
  const eoa = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
  const kms = "0x5a6836c6D4d293F6E5377E6c28054F4171915813";
  for (const [name, address, block, deployer, verifiedAt, creationHash, maskedHash] of [
    ["depositPoolV22", "0x3A2dd08F85009474117CaFC476b6629AE04fB2A9", 20746434, eoa, "2026-09-17T06:58:53.868Z",
      "0xe8cf0ee571b4c64e40afb6763eecea99840cf358ba3a845492e92bb5a8ed8d99",
      "sha256:ade555c3e1f9914aa060c0b57be21a3858ec43ebd3e41b8873aee7cd53181734"],
    ["aacPoolAggregatorAdapterV22", "0x1b3f9B45e0B8672A4FF95Caf67Bf4dbEa385455f", 20746446, eoa, "2026-09-17T06:59:18.209Z",
      "0xf38ef8c4b3fa79accca86fe8b8e9cf98bc3088272e134da8f3fe47ba6c18a730",
      "sha256:d8a083e0db4f8c79b23c1cdea76ce6bbcdd57e7a8c3ceaca8a6ae423e66e4f7f"],
    ["depositPoolLaneV22", "0xd3d76AB8f4642B54C04Be8091F01Be66e91a1aa1", 20746872, kms, "2026-09-17T07:14:25.651Z",
      "0x997ddcced2590a77dda1a555e07916e9e55231f28e130b5b26d6bc9fc10e1efe",
      "sha256:0faec68edf65d6adf5a56677904f4ac8e467b9ec0a59e5247f4184e2fcc18bad"],
    ["hydrationDepositPoolAdapterV22", "0x2894667cF9A54D94695Ca168B81154aA50955722", 20746874, kms, "2026-09-17T07:14:25.917Z",
      "0xe862dde09519a056c22c17d3bc8071a9b9f1f8df3eeecca4636de7a04ae49a44",
      "sha256:82acc3690054051a039d2e5f5ccab8a2b6f76fe1c8c9f4704a4d6a92de6220f4"],
  ]) {
    assert.equal(manifest.contracts[name], address, name);
    assert.equal(manifest.deploymentBlocks[name], block, name);
    assert.equal(manifest.deployers[name], deployer, name);
    const { provenance } = contracts.find((contract) => contract.name === name);
    assert.equal(provenance.sourceCommit, "d37c2eedd2f846f9686ad2fd463569755a63d83c", name);
    assert.equal(provenance.verifiedAt, verifiedAt, name);
    assert.equal(provenance.creationBytecodeHash, creationHash, name);
    assert.equal(provenance.maskedRuntimeHash, maskedHash, name);
    assert.equal(manifest.knownUnshippedContractChanges[name], undefined, name);
  }
});

test("Ceremony C T4 moves only pool aliases; v2.1 reads and the exit aggregator remain pinned", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../deployments/mainnet.json", import.meta.url), "utf8"));
  const contracts = validateProvenanceManifest(manifest);
  for (const name of ["depositPool", "depositPoolV2"]) {
    assert.equal(manifest.contracts[name], manifest.contracts.depositPoolV22, name);
    assert.equal(manifest.deploymentBlocks[name], 20746434, name);
    assert.deepEqual(contractArtifactFor(manifest, name), ["DepositPoolV22.sol", "DepositPoolV22"]);
    assert.equal(contracts.find((contract) => contract.name === name).provenance.sourceCommit,
      "d37c2eedd2f846f9686ad2fd463569755a63d83c");
  }
  for (const name of ["depositPoolV21", "legacyDepositPoolV21"]) {
    assert.equal(manifest.contracts[name], "0x9B35A102d656Fb86d798aF81959e09961DEc28E0", name);
    assert.equal(manifest.deploymentBlocks[name], 19913549, name);
    assert.deepEqual(contractArtifactFor(manifest, name), ["DepositPoolV2.sol", "DepositPoolV2"]);
  }
  assert.equal(manifest.contracts.aacPoolAggregatorAdapter, "0x1DDcA7097c752580c6561e1bF8C673D6C1665CA5");
  assert.equal(manifest.deploymentBlocks.aacPoolAggregatorAdapter, 19913651);
});
