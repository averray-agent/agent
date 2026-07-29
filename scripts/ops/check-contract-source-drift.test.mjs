import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  checkCompiledArtifacts,
  maskedArtifactRuntimeHash,
  validateKnownUnshippedContractChanges,
} from "./check-contract-source-drift.mjs";
import {
  runtimeCodeHash,
  validateProvenanceManifest,
} from "./check-contract-provenance.mjs";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const SOURCE_COMMIT = "a".repeat(40);
const VERIFIED_AT = "2026-07-29T19:40:33.000Z";

function artifact(code, immutableReferences = {}) {
  return {
    abi: [],
    deployedBytecode: {
      object: code,
      immutableReferences,
    },
  };
}

function manifestFor({
  chainCode = "0x60010203",
  knownUnshippedContractChanges = {},
} = {}) {
  return {
    profile: "mainnet",
    rpcUrl: "https://rpc.invalid",
    contracts: {
      agentAccountCore: ADDRESS,
      token: "0x0000053900000000000000000000000001200000",
    },
    contractProvenance: {
      [ADDRESS]: {
        sourceCommit: SOURCE_COMMIT,
        abiHash: `sha256:${"b".repeat(64)}`,
        runtimeCodeHash: runtimeCodeHash(chainCode),
        verifiedAt: VERIFIED_AT,
      },
    },
    knownUnshippedContractChanges,
  };
}

function checkOne({ candidate, chainCode = "0x60010203", allowlist = {} }) {
  return checkCompiledArtifacts({
    manifest: manifestFor({
      chainCode,
      knownUnshippedContractChanges: allowlist,
    }),
    artifactsByName: new Map([["agentAccountCore", candidate]]),
    chainCode: new Map([["agentAccountCore", chainCode]]),
  }).checks[0];
}

test("candidate runtime hash masks the exact compiler immutable slots", () => {
  const left = maskedArtifactRuntimeHash(
    artifact("0x60010203", { "17": [{ start: 1, length: 1 }] })
  );
  const right = maskedArtifactRuntimeHash(
    artifact("0x60ff0203", { "17": [{ start: 1, length: 1 }] })
  );

  assert.equal(left.hash, right.hash);
  assert.equal(left.immutableSlotCount, 1);
  assert.equal(left.runtimeBytes, 4);
});

test("compiled candidate matching deployed code after masking is not drift", () => {
  const check = checkOne({
    candidate: artifact("0x60010203", {
      "17": [{ start: 1, length: 1 }],
    }),
    chainCode: "0x60aa0203",
  });

  assert.equal(check.ok, true);
  assert.equal(check.status, "deployed");
  assert.equal(check.runtime.outsideImmutableSlots, 0);
  assert.equal(check.runtime.diffBytes, 1);
});

test("compiled candidate difference outside immutable slots is Tier 1 drift", () => {
  const check = checkOne({
    candidate: artifact("0x60010203", {
      "17": [{ start: 1, length: 1 }],
    }),
    chainCode: "0x60aa9903",
  });

  assert.equal(check.ok, false);
  assert.equal(check.status, "drift");
  assert.equal(check.runtime.outsideImmutableSlots, 1);
});

test("exact known-unshipped masked runtime is allowed with its reason", () => {
  const candidate = artifact("0x6001020304", {
    "17": [{ start: 1, length: 1 }],
  });
  const candidateHash = maskedArtifactRuntimeHash(candidate).hash;
  const check = checkOne({
    candidate,
    allowlist: {
      agentAccountCore: [
        {
          sourceCommit: SOURCE_COMMIT,
          maskedRuntimeCodeHash: candidateHash,
          reason: "Audited candidate is deliberately not deployed.",
        },
      ],
    },
  });

  assert.equal(check.ok, true);
  assert.equal(check.status, "known-unshipped");
  assert.equal(
    check.knownUnshipped.reason,
    "Audited candidate is deliberately not deployed."
  );
});

test("allowlist is exact and does not cover a later compiled runtime", () => {
  const allowed = artifact("0x6001020304");
  const later = artifact("0x6001020305");
  const check = checkOne({
    candidate: later,
    allowlist: {
      agentAccountCore: [
        {
          sourceCommit: SOURCE_COMMIT,
          maskedRuntimeCodeHash: maskedArtifactRuntimeHash(allowed).hash,
          reason: "Only the pinned candidate is accepted.",
        },
      ],
    },
  });

  assert.equal(check.ok, false);
  assert.equal(check.status, "drift");
  assert.equal(check.knownUnshipped, null);
});

test("known-unshipped entries require an explicit non-empty reason", () => {
  const manifest = manifestFor({
    knownUnshippedContractChanges: {
      agentAccountCore: [
        {
          sourceCommit: SOURCE_COMMIT,
          maskedRuntimeCodeHash: `sha256:${"c".repeat(64)}`,
          reason: "   ",
        },
      ],
    },
  });
  const contracts = [
    {
      name: "agentAccountCore",
      address: ADDRESS,
    },
  ];

  assert.throws(
    () => validateKnownUnshippedContractChanges(manifest, contracts),
    /reason must be a non-empty string/u
  );
});

for (const profile of ["mainnet", "testnet"]) {
  test(`${profile} pins EscrowCore v2 to one masked runtime and an explicit reason`, () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL(`../../deployments/${profile}.json`, import.meta.url),
        "utf8"
      )
    );
    const contracts = validateProvenanceManifest(manifest);
    const allowlist = validateKnownUnshippedContractChanges(
      manifest,
      contracts
    );

    assert.equal(contracts.length, 6);
    assert.deepEqual(allowlist.get("escrowCore"), [
      {
        sourceCommit: "775a826b0a33d0ec04dd19f0455e69402dc9bbcd",
        maskedRuntimeCodeHash:
          "sha256:64ec86a04369cbbd49a30e0dcf04cf785707a78fcd42f87c0c692f77a7372788",
        reason:
          "EscrowCore v2 success-path protocol fees (#850) are deliberately undeployed pending external audit, migration, dual-address drain, and dogfood proof.",
      },
    ]);
  });
}
