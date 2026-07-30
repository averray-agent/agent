#!/usr/bin/env node
/**
 * Classify compiled runtime drift for the D-03 production deploy gate.
 *
 * The live-chain guard remains check-contract-provenance.mjs. This companion
 * check is only Tier 1: build the candidate checkout with its own foundry.toml,
 * compare each currently deployed contract with the live runtime using the
 * provenance checker's exact immutable-slot masking, and identify semantic
 * runtime changes. ABI-only and non-contract path changes cannot trigger it.
 *
 * A known-unshipped entry is an exact candidate masked-runtime hash plus an
 * explicit reason. It permits that one compiled runtime, not every future
 * change to the named contract.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_ARTIFACTS,
  checkRuntimeProvenance,
  compareMaskedRuntime,
  hexBytes,
  immutableSlots,
  loadDeployment,
  validateProvenanceManifest,
} from "./check-contract-provenance.mjs";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function maskedArtifactRuntimeHash(artifact) {
  const runtime = hexBytes(
    artifact?.deployedBytecode?.object,
    "artifact deployed runtime"
  );
  const slots = immutableSlots(
    artifact?.deployedBytecode?.immutableReferences ?? {}
  );
  const masked = Buffer.from(runtime);
  for (const slot of slots) {
    if (slot.start + slot.length > masked.length) {
      throw new Error(
        `immutable slot ${slot.sourceId}@${slot.start}+${slot.length} exceeds ${masked.length}-byte runtime.`
      );
    }
    masked.fill(0, slot.start, slot.start + slot.length);
  }
  return {
    hash: sha256(masked),
    runtimeBytes: runtime.length,
    immutableSlotCount: slots.length,
  };
}

export function validateKnownUnshippedContractChanges(manifest, contracts) {
  const raw = manifest?.knownUnshippedContractChanges ?? {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "manifest.knownUnshippedContractChanges must be a contract-name-keyed object."
    );
  }

  const deployedNames = new Set(contracts.map((contract) => contract.name));
  const validated = new Map();
  for (const [name, entries] of Object.entries(raw)) {
    if (!deployedNames.has(name)) {
      throw new Error(
        `knownUnshippedContractChanges.${name} is not a currently deployed source-controlled contract.`
      );
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(
        `knownUnshippedContractChanges.${name} must be a non-empty array.`
      );
    }

    const hashes = new Set();
    validated.set(
      name,
      entries.map((entry, index) => {
        const label = `knownUnshippedContractChanges.${name}[${index}]`;
        if (
          entry === null ||
          typeof entry !== "object" ||
          Array.isArray(entry)
        ) {
          throw new Error(`${label} must be an object.`);
        }
        if (!HASH_PATTERN.test(entry.maskedRuntimeCodeHash)) {
          throw new Error(
            `${label}.maskedRuntimeCodeHash must be sha256:<64 lowercase hex>.`
          );
        }
        if (hashes.has(entry.maskedRuntimeCodeHash)) {
          throw new Error(
            `${label}.maskedRuntimeCodeHash duplicates another ${name} entry.`
          );
        }
        hashes.add(entry.maskedRuntimeCodeHash);
        if (
          typeof entry.reason !== "string" ||
          entry.reason.trim().length === 0
        ) {
          throw new Error(`${label}.reason must be a non-empty string.`);
        }
        if (
          entry.sourceCommit !== undefined &&
          !COMMIT_PATTERN.test(entry.sourceCommit)
        ) {
          throw new Error(
            `${label}.sourceCommit must be a full lowercase commit SHA when present.`
          );
        }
        return {
          maskedRuntimeCodeHash: entry.maskedRuntimeCodeHash,
          reason: entry.reason.trim(),
          ...(entry.sourceCommit
            ? { sourceCommit: entry.sourceCommit }
            : {}),
        };
      })
    );
  }
  return validated;
}

export function checkCompiledArtifacts({
  manifest,
  artifactsByName,
  chainCode,
}) {
  const contracts = validateProvenanceManifest(manifest);
  const allowlist = validateKnownUnshippedContractChanges(manifest, contracts);
  const checks = contracts.map((contract) => {
    const artifact = artifactsByName.get(contract.name);
    if (!artifact) {
      throw new Error(`missing candidate artifact for ${contract.name}.`);
    }
    const deployedCode = chainCode.get(contract.name);
    if (typeof deployedCode !== "string") {
      throw new Error(`missing live runtime for ${contract.name}.`);
    }

    const candidate = maskedArtifactRuntimeHash(artifact);
    const runtime = compareMaskedRuntime(
      artifact.deployedBytecode.object,
      deployedCode,
      artifact.deployedBytecode.immutableReferences ?? {}
    );
    const knownUnshipped = (allowlist.get(contract.name) ?? []).find(
      (entry) => entry.maskedRuntimeCodeHash === candidate.hash
    );
    const status = runtime.matches
      ? "deployed"
      : knownUnshipped
        ? "known-unshipped"
        : "drift";

    return {
      name: contract.name,
      address: contract.address,
      status,
      ok: status !== "drift",
      candidateMaskedRuntimeCodeHash: candidate.hash,
      candidateRuntimeBytes: candidate.runtimeBytes,
      immutableSlotCount: candidate.immutableSlotCount,
      runtime,
      knownUnshipped: knownUnshipped ?? null,
    };
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

export async function checkCompiledSourceProvenance({
  profile = "mainnet",
  manifest,
  artifactsByName,
  rpcUrl,
  fetchImpl = fetch,
}) {
  const runtime = await checkRuntimeProvenance({
    profile,
    manifest,
    rpcUrl,
    fetchImpl,
  });
  if (!runtime.ok) {
    throw new Error(
      "live chain runtime no longer matches the manifest; Tier 2 must resolve before source drift can be classified."
    );
  }
  return {
    profile,
    chainId: runtime.chainId,
    rpcUrl: runtime.rpcUrl,
    ...checkCompiledArtifacts({
      manifest,
      artifactsByName,
      chainCode: runtime.chainCode,
    }),
  };
}

function parseArgs(argv) {
  const args = { profile: "mainnet", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") args.profile = argv[++index];
    else if (arg === "--rpc") args.rpcUrl = argv[++index];
    else if (arg === "--artifacts") args.artifacts = resolve(argv[++index]);
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const HELP = `check-contract-source-drift.mjs — classify immutable-masked compiled runtime drift

  --profile <name>   deployments/<name>.json (default: mainnet)
  --rpc <url>        override the manifest RPC URL
  --artifacts <dir>  candidate Foundry out directory (required)
  --json             print machine-readable evidence

Exit: 0 = deployed/allowlisted runtimes only, 1 = unallowlisted compiled drift,
      2 = usage/build-artifact/manifest/RPC error.`;

function loadArtifacts(artifactsRoot, manifest) {
  const artifacts = new Map();
  for (const contract of validateProvenanceManifest(manifest)) {
    const definition = CONTRACT_ARTIFACTS[contract.name];
    if (!definition) {
      throw new Error(`no artifact mapping for contracts.${contract.name}.`);
    }
    const [sourceFile, contractName] = definition;
    const path = join(artifactsRoot, sourceFile, `${contractName}.json`);
    artifacts.set(contract.name, JSON.parse(readFileSync(path, "utf8")));
  }
  return artifacts;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!args.artifacts) {
    console.error("--artifacts is required.");
    process.exitCode = 2;
    return;
  }

  try {
    const manifest = loadDeployment(args.profile);
    const result = await checkCompiledSourceProvenance({
      profile: args.profile,
      manifest,
      artifactsByName: loadArtifacts(args.artifacts, manifest),
      rpcUrl: args.rpcUrl,
    });

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `D-03 compiled provenance: ${result.profile} chainId ${result.chainId}`
      );
      for (const check of result.checks) {
        console.log(
          `  [${check.status}] ${check.name} ${check.address}: ` +
            `${check.candidateRuntimeBytes} bytes, ${check.candidateMaskedRuntimeCodeHash}`
        );
        if (check.knownUnshipped) {
          console.log(`    reason: ${check.knownUnshipped.reason}`);
        }
        if (check.status === "drift") {
          console.log(
            `    live comparison: ${check.runtime.diffBytes ?? "n/a"} diff bytes, ` +
              `${check.runtime.outsideImmutableSlots ?? "n/a"} outside immutable slots`
          );
        }
      }
    }
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Compiled contract provenance check failed: ${error.message}`);
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
