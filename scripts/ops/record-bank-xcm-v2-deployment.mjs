#!/usr/bin/env node

/**
 * Produce the paired deployments/mainnet.json candidate after deployment.
 * Default is stdout only; --out is create-only. It never mutates the live
 * manifest in place and never sends a transaction.
 */

import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "ethers";

import {
  applyBankXcmV2Manifest,
  artifactEvidence,
  loadJson,
  sha256Hex
} from "./bank-xcm-v2-ceremony-lib.mjs";
import { createCeremonyRpcContext, printCeremonyRpcPreflight } from "./ceremony-rpc.mjs";
import { compareMaskedRuntime } from "./check-contract-provenance.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function parseArgs(argv) {
  const args = { profile: "mainnet" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--profile") args.profile = argv[++index];
    else if (token === "--evidence") args.evidence = argv[++index];
    else if (token === "--out") args.out = argv[++index];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function requireEvidenceShape(evidence) {
  if (evidence?.kind !== "averray.bankXcmV2DeploymentEvidence" || evidence?.profile !== "mainnet") {
    throw new Error("deployment evidence kind/profile mismatch.");
  }
  for (const key of ["wrapper", "adapter"]) {
    const entry = evidence[key];
    if (!entry || !entry.address || !entry.txHash || !Number.isInteger(entry.blockNumber)) {
      throw new Error(`deployment evidence ${key} address/txHash/blockNumber is required.`);
    }
  }
  if (!/^[0-9a-f]{40}$/u.test(evidence.sourceCommit)) throw new Error("deployment evidence sourceCommit must be a full lowercase commit.");
  const verifiedAtMs = Date.parse(evidence.verifiedAt);
  if (typeof evidence.verifiedAt !== "string" || Number.isNaN(verifiedAtMs) || new Date(verifiedAtMs).toISOString() !== evidence.verifiedAt) {
    throw new Error("deployment evidence verifiedAt must be an ISO-8601 UTC timestamp.");
  }
  return evidence;
}

function assertArtifactRuntime(label, artifact, liveCode) {
  const comparison = compareMaskedRuntime(
    artifact?.deployedBytecode?.object,
    liveCode,
    artifact?.deployedBytecode?.immutableReferences ?? {}
  );
  if (!comparison.matches) {
    throw new Error(`${label} live runtime does not match the compiled artifact outside declared immutable slots.`);
  }
  return comparison;
}

export async function buildManifestCandidate({ manifest, evidence, provider, wrapperArtifact, adapterArtifact }) {
  requireEvidenceShape(evidence);
  const wrapperAddress = getAddress(evidence.wrapper.address);
  const adapterAddress = getAddress(evidence.adapter.address);
  const [wrapperCode, adapterCode, wrapperReceipt, adapterReceipt] = await Promise.all([
    provider.getCode(wrapperAddress),
    provider.getCode(adapterAddress),
    provider.getTransactionReceipt(evidence.wrapper.txHash),
    provider.getTransactionReceipt(evidence.adapter.txHash)
  ]);
  if (wrapperCode === "0x" || adapterCode === "0x") throw new Error("deployment evidence address has no live bytecode.");
  for (const [label, expected, receipt] of [["wrapper", evidence.wrapper, wrapperReceipt], ["adapter", evidence.adapter, adapterReceipt]]) {
    if (!receipt || receipt.status !== 1 || Number(receipt.blockNumber) !== expected.blockNumber || getAddress(receipt.contractAddress) !== getAddress(expected.address)) {
      throw new Error(`${label} receipt does not match the supplied address/block or was unsuccessful.`);
    }
  }
  const wrapperBuild = artifactEvidence(wrapperArtifact);
  const adapterBuild = artifactEvidence(adapterArtifact);
  assertArtifactRuntime("wrapper", wrapperArtifact, wrapperCode);
  assertArtifactRuntime("adapter", adapterArtifact, adapterCode);
  return applyBankXcmV2Manifest(manifest, {
    ...evidence,
    wrapper: {
      ...evidence.wrapper,
      abiHash: wrapperBuild.abiHash,
      runtimeCodeHash: sha256Hex(wrapperCode)
    },
    adapter: {
      ...evidence.adapter,
      abiHash: adapterBuild.abiHash,
      runtimeCodeHash: sha256Hex(adapterCode)
    }
  });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: node scripts/ops/record-bank-xcm-v2-deployment.mjs --profile mainnet --evidence /tmp/evidence.json [--out /tmp/mainnet.json]");
    return;
  }
  if (args.profile !== "mainnet" || !args.evidence) throw new Error("--profile mainnet and --evidence are required.");
  const manifest = loadJson(resolve(repoRoot, "deployments/mainnet.json"));
  const evidence = loadJson(resolve(args.evidence));
  const checkoutCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  if (String(evidence.sourceCommit).toLowerCase() !== checkoutCommit.toLowerCase()) {
    throw new Error(`deployment evidence sourceCommit ${evidence.sourceCommit} does not match checkout ${checkoutCommit}.`);
  }
  const wrapperArtifact = loadJson(resolve(repoRoot, "out/XcmWrapperV2.sol/XcmWrapperV2.json"));
  const adapterArtifact = loadJson(resolve(repoRoot, "out/HydrationUsdcAdapter.sol/HydrationUsdcAdapter.json"));
  const rpc = await createCeremonyRpcContext({ manifest, phase: "bank-xcm-v2-record", write: false });
  try {
    printCeremonyRpcPreflight(rpc);
    const candidate = await buildManifestCandidate({ manifest, evidence, provider: rpc.provider, wrapperArtifact, adapterArtifact });
    const rendered = `${JSON.stringify(candidate, null, 2)}\n`;
    if (args.out) {
      writeFileSync(resolve(args.out), rendered, { flag: "wx" });
      console.log(`paired manifest candidate written create-only to ${resolve(args.out)}`);
    } else {
      process.stdout.write(rendered);
    }
    return candidate;
  } finally {
    await rpc.provider.destroy?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`record-bank-xcm-v2-deployment failed: ${error.message}`);
    process.exitCode = 1;
  });
}
