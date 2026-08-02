import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FunctionFragment, id } from "ethers";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const interfacePath = resolve(repoRoot, "deployments/interfaces/mainnet-escrow-core-v2.json");
const manifestPath = resolve(repoRoot, "deployments/mainnet.json");
const frozen = JSON.parse(readFileSync(interfacePath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const ADDRESS = "0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC";
const SOURCE_COMMIT = "775a826b0a33d0ec04dd19f0455e69402dc9bbcd";
const RECOVERED_SELECTORS = {
  "0xbcb2689a":
    "createSinglePayoutJobFeeWaived(bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32)",
  "0x090cf6d5": "claimJobFor(bytes32,address)",
  "0x1b2ef921": "submitWorkFor(bytes32,address,bytes32)",
  "0xcca2acd6": "setOnboardingWaiverEligible(bytes32,bool)"
};

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("deployed EscrowCore v2 interface is pinned to mainnet provenance", () => {
  const provenance = manifest.contractProvenance[ADDRESS];

  assert.equal(frozen.schemaVersion, 1);
  assert.equal(frozen.contractName, "EscrowCore");
  assert.equal(frozen.deploymentLabel, "EscrowCore v2");
  assert.equal(frozen.network.chainId, 420420419);
  assert.equal(frozen.deployment.address, ADDRESS);
  assert.equal(frozen.deployment.blockNumber, manifest.deploymentBlocks.escrowCoreV2);
  assert.equal(frozen.deployment.transactionHash, manifest.escrowRedeployTxHashes.deploy);
  assert.equal(frozen.source.available, true);
  assert.equal(frozen.source.commit, SOURCE_COMMIT);
  assert.equal(frozen.source.commit, provenance.sourceCommit);
  assert.equal(provenance.interfaceArtifact, "deployments/interfaces/mainnet-escrow-core-v2.json");
  assert.equal(frozen.provenance.abiHash, provenance.abiHash);
  assert.equal(frozen.provenance.runtimeCodeHash, provenance.runtimeCodeHash);
  assert.equal(sha256(JSON.stringify(frozen.abi)), provenance.abiHash);
});

test("deployed EscrowCore v2 records the available source and its Foundry config", () => {
  assert.equal(frozen.source.available, true);
  assert.equal(frozen.source.path, "contracts/EscrowCore.sol");
  assert.equal(frozen.source.commit, SOURCE_COMMIT);
  assert.equal(frozen.source.blobSha1, "b44210b69c842ad77482b99d7f09590617dd8898");
  assert.equal(frozen.source.foundryConfigPath, "foundry.toml");
  assert.equal(frozen.source.foundryConfigBlobSha1, "4f6135ab85e9d4d58ff838adccd4b671736173ef");
  assert.deepEqual(frozen.source.compiler, {
    solc: "0.8.24",
    optimizer: true,
    optimizerRuns: 200,
    viaIR: true
  });
});

test("deployed EscrowCore v2 ABI reproduces every committed method identifier", () => {
  const derived = {};
  for (const entry of frozen.abi.filter(({ type }) => type === "function")) {
    const signature = FunctionFragment.from(entry).format("sighash");
    derived[signature] = id(signature).slice(2, 10);
  }

  assert.equal(Object.keys(derived).length, 51);
  assert.deepEqual(derived, frozen.methodIdentifiers);
});

test("deployed EscrowCore v2 recovers all four live unknown selectors", () => {
  assert.deepEqual(frozen.observedSelectors, RECOVERED_SELECTORS);

  for (const [selector, signature] of Object.entries(RECOVERED_SELECTORS)) {
    assert.equal(id(signature).slice(0, 10), selector, `${signature} must hash to ${selector}`);
    assert.equal(`0x${frozen.methodIdentifiers[signature]}`, selector);
  }
});
