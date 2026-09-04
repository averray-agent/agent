import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { keccak256 } from "ethers";

import {
  CONTRACT_ARTIFACTS,
  assertArtifactSourceCommit,
  buildVenuePairPlan,
} from "./deploy-venue-pair.mjs";
import { buildBackendRebuildPattern } from "./backend-image-rebuild-pattern.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfilePath = path.join(repoRoot, "mcp-server", "Dockerfile");
const dockerfile = readFileSync(dockerfilePath, "utf8");
const artifactStageName = "venue-pair-artifacts";

function driverArtifactPath([sourceName, contractName]) {
  return `out/${sourceName}/${contractName}.json`;
}

function shippedArtifactCopies(source = dockerfile) {
  const paths = new Map();
  for (const line of source.split("\n")) {
    const match = new RegExp(
      `^\\s*COPY\\s+--from=${artifactStageName}\\s+(\\S+)\\s+\\./(out/\\S+\\.json)\\s*$`,
      "u",
    ).exec(line);
    if (match) paths.set(match[2], match[1]);
  }
  return paths;
}

function assertArtifactInventory(artifactInventory, shipped = shippedArtifactCopies()) {
  const missing = Object.entries(artifactInventory)
    .map(([role, definition]) => [role, driverArtifactPath(definition)])
    .filter(([, artifactPath]) => shipped.get(artifactPath) !== `/build/${artifactPath}`);
  assert.deepEqual(
    missing,
    [],
    `backend image omits deploy-venue-pair artifact(s): ${missing.map(([role, value]) => `${role}=${value}`).join(", ")}`,
  );
}

test("backend image ships every artifact named by deploy-venue-pair CONTRACT_ARTIFACTS", () => {
  assertArtifactInventory(CONTRACT_ARTIFACTS);
  assert.equal(shippedArtifactCopies().size, Object.keys(CONTRACT_ARTIFACTS).length);
});

test("adding a deploy-venue-pair contract without an image artifact fails the inventory guard", () => {
  const mutatedInventory = {
    ...CONTRACT_ARTIFACTS,
    future: ["FutureVenueContract.sol", "FutureVenueContract"],
  };
  assert.throws(
    () => assertArtifactInventory(mutatedInventory),
    /future=out\/FutureVenueContract\.sol\/FutureVenueContract\.json/u,
  );
});

test("venue-pair out artifacts remain generated, gitignored, and uncommitted", () => {
  const gitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /^out\/$/mu);
  assert.equal(
    execFileSync("git", ["ls-files", "out"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    "",
  );
  assert.doesNotMatch(dockerfile, /^COPY\s+(?:\.\/)?out(?:\/|\s)/mu);
});

test("deployment evidence binds image-built creation bytecode hashes to its source SHA", async () => {
  const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
  const artifacts = {
    lane: {
      abi: [{
        type: "constructor",
        stateMutability: "nonpayable",
        inputs: [
          { name: "policy_", type: "address" },
          { name: "asset_", type: "address" },
          { name: "strategyId_", type: "bytes32" },
          { name: "wrapper_", type: "address" },
          { name: "agentAccountCore_", type: "address" },
        ],
      }],
      bytecode: { object: "0x60006000" },
    },
    adapter: {
      abi: [{
        type: "constructor",
        stateMutability: "nonpayable",
        inputs: [
          { name: "pool_", type: "address" },
          { name: "lane_", type: "address" },
        ],
      }],
      bytecode: { object: "0x60016000" },
    },
  };
  const plan = await buildVenuePairPlan({
    deployer: "0x5a6836c6D4d293F6E5377E6c28054F4171915813",
    nonce: 17,
    artifacts,
    sourceCommit,
  });

  assert.equal(plan.artifactProvenance.sourceCommit, sourceCommit);
  assert.equal(plan.artifactProvenance.lane.creationBytecodeHash, keccak256(artifacts.lane.bytecode.object));
  assert.equal(plan.artifactProvenance.adapter.creationBytecodeHash, keccak256(artifacts.adapter.bytecode.object));
  assert.equal(plan.artifactProvenance.lane.path, driverArtifactPath(CONTRACT_ARTIFACTS.lane));
  assert.equal(plan.artifactProvenance.adapter.path, driverArtifactPath(CONTRACT_ARTIFACTS.adapter));
  assert.equal(assertArtifactSourceCommit(sourceCommit), sourceCommit);
  assert.throws(() => assertArtifactSourceCommit("unknown"), /full 40-hex DEPLOYED_SHA/u);
});

test("Foundry and unrelated build output stay outside the backend runtime stage", () => {
  const stages = dockerfile.split(/^FROM\s+/mu);
  assert.equal(stages.length, 3, "expected one artifact builder and one runtime stage");
  const builder = stages[1];
  const runtime = stages[2];

  assert.match(builder, /^ghcr\.io\/foundry-rs\/foundry:v1\.7\.1@sha256:[a-f0-9]{64}\s+AS\s+venue-pair-artifacts/mu);
  assert.match(builder, /^COPY contracts \.\/contracts$/mu);
  assert.match(builder, /^COPY foundry\.toml \.\/foundry\.toml$/mu);
  assert.match(builder, /^COPY lib\/forge-std \.\/lib\/forge-std$/mu);
  assert.match(builder, /forge build[\s\S]*HydrationUsdcAdapterV22\.sol[\s\S]*HydrationDepositPoolAdapter\.sol/u);
  assert.match(runtime, /^node:22-bookworm-slim$/mu);
  assert.doesNotMatch(runtime, /apt-get install[^\n]*foundry|\bforge build\b/u);
  assert.equal(shippedArtifactCopies().size, 2, "runtime must receive only the two driver artifacts");
  assert.doesNotMatch(dockerfile, /COPY\s+--from=venue-pair-artifacts\s+\/build\/out\s/u);

  const rebuildMatcher = new RegExp(buildBackendRebuildPattern({ dockerfileText: dockerfile, repoRoot }), "u");
  assert.match("contracts/strategies/HydrationUsdcAdapterV22.sol", rebuildMatcher);
  assert.match("foundry.toml", rebuildMatcher);
  assert.match("lib/forge-std/src/Test.sol", rebuildMatcher);
});
