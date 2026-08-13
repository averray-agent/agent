import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTRACT_ARTIFACTS,
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
      "creditPool",
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
  for (const name of [
    "depositPoolLane",
    "hydrationDepositPoolAdapter",
    "depositPool",
  ]) {
    assert.equal(
      contracts.find((contract) => contract.name === name)?.provenance.sourceCommit,
      "9e9cb15135837ce89042a99e455aa536ff68d9ba"
    );
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
