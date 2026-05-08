#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { keccak256, toUtf8Bytes, Contract, JsonRpcProvider, Wallet, getAddress } from "ethers";

const DEFAULT_MANIFEST_URL = "https://averray.com/.well-known/agent-tools.json";
const DISCOVERY_REGISTRY_ABI = [
  "function publisher() view returns (address)",
  "function currentManifestHash() view returns (bytes32)",
  "function currentVersion() view returns (uint64)",
  "function publish(bytes32 newHash)",
  "event ManifestPublished(uint64 indexed version, bytes32 indexed hash, uint64 timestamp, address publisher)"
];

export function canonicalizeJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize non-finite JSON number.");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error(`Cannot canonicalize JSON value of type ${typeof value}.`);
}

export function hashDiscoveryManifest(manifest) {
  const canonical = canonicalizeJson(manifest);
  return {
    canonical,
    hash: keccak256(toUtf8Bytes(canonical))
  };
}

export async function loadDiscoveryManifest({ manifestPath, manifestUrl, fetchImpl = fetch } = {}) {
  if (manifestPath) {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  }
  const url = manifestUrl || DEFAULT_MANIFEST_URL;
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      "user-agent": "averray-discovery-registry-publisher"
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discovery manifest fetch failed (${response.status}) for ${url}: ${body}`);
  }
  return response.json();
}

export async function publishManifestHash({
  registryAddress,
  rpcUrl,
  privateKey,
  hash,
  wait = true
} = {}) {
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);
  const registry = new Contract(registryAddress, DISCOVERY_REGISTRY_ABI, wallet);
  const publisher = await registry.publisher();
  if (getAddress(publisher) !== getAddress(wallet.address)) {
    throw new Error(`Publisher key mismatch: signer ${wallet.address} is not registry publisher ${publisher}.`);
  }
  const currentHash = await registry.currentManifestHash();
  const currentVersion = await registry.currentVersion();
  if (String(currentHash).toLowerCase() === String(hash).toLowerCase()) {
    return {
      status: "already_current",
      hash,
      currentHash,
      currentVersion: currentVersion.toString(),
      publisher
    };
  }
  const tx = await registry.publish(hash);
  const receipt = wait ? await tx.wait() : undefined;
  const nextVersion = await registry.currentVersion();
  return {
    status: "published",
    hash,
    previousHash: currentHash,
    previousVersion: currentVersion.toString(),
    currentVersion: nextVersion.toString(),
    publisher,
    txHash: tx.hash,
    blockNumber: receipt?.blockNumber
  };
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
    if (["dry-run", "skip-missing-config", "no-wait"].includes(key)) {
      args[toCamelCase(key)] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      args[toCamelCase(key)] = value;
      index += 1;
    } else {
      args[toCamelCase(key)] = true;
    }
  }
  return args;
}

export async function runPublishDiscoveryManifestCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  fetchImpl = fetch
} = {}) {
  const args = parseArgs(argv);
  const manifest = await loadDiscoveryManifest({
    manifestPath: args.manifestPath || env.DISCOVERY_MANIFEST_PATH,
    manifestUrl: args.manifestUrl || env.DISCOVERY_MANIFEST_URL || DEFAULT_MANIFEST_URL,
    fetchImpl
  });
  const { canonical, hash } = hashDiscoveryManifest(manifest);
  const registryAddress = args.registry || env.DISCOVERY_REGISTRY_ADDRESS;
  const rpcUrl = args.rpcUrl || env.DISCOVERY_PUBLISH_RPC_URL || env.POLKADOT_RPC_URL || env.RPC_URL;
  const privateKey = args.privateKey || env.DISCOVERY_PUBLISHER_PRIVATE_KEY;
  const base = {
    manifestUrl: args.manifestUrl || env.DISCOVERY_MANIFEST_URL || DEFAULT_MANIFEST_URL,
    manifestPath: args.manifestPath || env.DISCOVERY_MANIFEST_PATH,
    hash,
    canonicalBytes: Buffer.byteLength(canonical, "utf8")
  };
  if (args.dryRun) {
    const result = { status: "dry_run", ...base };
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (!registryAddress || !rpcUrl || !privateKey) {
    if (!args.skipMissingConfig) {
      throw new Error(
        "Publishing requires DISCOVERY_REGISTRY_ADDRESS, DISCOVERY_PUBLISH_RPC_URL/POLKADOT_RPC_URL/RPC_URL, and DISCOVERY_PUBLISHER_PRIVATE_KEY."
      );
    }
    const result = {
      status: "skipped",
      reason: "missing_publish_config",
      ...base,
      configured: {
        registryAddress: Boolean(registryAddress),
        rpcUrl: Boolean(rpcUrl),
        privateKey: Boolean(privateKey)
      }
    };
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const publish = await publishManifestHash({
    registryAddress,
    rpcUrl,
    privateKey,
    hash,
    wait: !args.noWait
  });
  const result = { ...base, ...publish, registryAddress };
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/gu, (_, char) => char.toUpperCase());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPublishDiscoveryManifestCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
