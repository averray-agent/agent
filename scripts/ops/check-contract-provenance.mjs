#!/usr/bin/env node
/**
 * Fail closed when deployed runtime bytecode drifts from a deployment manifest.
 *
 * Default mode is deliberately dependency-free and read-only:
 *
 *   node scripts/ops/check-contract-provenance.mjs --profile mainnet
 *
 * Source mode additionally compares candidate Foundry artifacts with the live
 * runtime. It masks exactly the byte ranges emitted by solc under
 * deployedBytecode.immutableReferences, then requires:
 *
 *   1. equal runtime lengths;
 *   2. equal SHA-256 after masking both sides; and
 *   3. every raw byte difference to be confined to a declared immutable slot.
 *
 * Build the candidate checkout with that checkout's own foundry.toml first:
 *
 *   forge build --skip test
 *   node scripts/ops/check-contract-provenance.mjs \
 *     --profile mainnet --artifacts /path/to/candidate/out
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/u;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const EXTERNAL_CONTRACT_KEYS = new Set(["token"]);

export const EXPECTED_CHAIN_IDS = Object.freeze({
  testnet: 420420417,
  mainnet: 420420419,
});

export const RESERVATION_SETTLED_SIGNATURE =
  "ReservationSettled(bytes32,address,address,address,uint256)";
export const RESERVATION_SETTLED_TOPIC0 =
  "0x3cdc0be5ec7141f2342208f6404c1b1852936343f0edf1fda179e6c9f46573ee";
export const RESERVATION_SETTLED_INPUTS = Object.freeze([
  Object.freeze({ indexed: true, name: "settlementId", type: "bytes32" }),
  Object.freeze({ indexed: true, name: "account", type: "address" }),
  Object.freeze({ indexed: true, name: "recipient", type: "address" }),
  Object.freeze({ indexed: false, name: "asset", type: "address" }),
  Object.freeze({ indexed: false, name: "amount", type: "uint256" }),
]);

export const CONTRACT_ARTIFACTS = Object.freeze({
  treasuryPolicy: ["TreasuryPolicy.sol", "TreasuryPolicy"],
  strategyAdapterRegistry: ["StrategyAdapterRegistry.sol", "StrategyAdapterRegistry"],
  agentAccountCore: ["AgentAccountCore.sol", "AgentAccountCore"],
  reputationSbt: ["ReputationSBT.sol", "ReputationSBT"],
  discoveryRegistry: ["DiscoveryRegistry.sol", "DiscoveryRegistry"],
  escrowCore: ["EscrowCore.sol", "EscrowCore"],
  legacyEscrowCore: ["EscrowCore.sol", "EscrowCore"],
  // The bank pair is v2.2.1, deployed 2026-08-05: these must name the V22
  // sources. They pointed at the pre-2.2 contracts, so every provenance check
  // compared live V22 runtime against a compiled V2 artifact — a comparison of
  // two different contracts, which can only ever report drift. Proven both
  // ways against mainnet: live 0xF20b35A3 is byte-identical to compiled
  // XcmWrapperV22, live 0x96091d44 to HydrationUsdcAdapterV22 as of the commit
  // before #1043, and the manifest's own abiHashes recorded on deploy day match
  // the V22 ABIs, not the V2 ones.
  xcmWrapper: ["XcmWrapperV22.sol", "XcmWrapperV22"],
  hydrationUsdcAdapter: ["HydrationUsdcAdapterV22.sol", "HydrationUsdcAdapterV22"],
  // The pool lane is a second deployment of HydrationUsdcAdapterV22, not an
  // alias of the operating bank adapter above. Keep a distinct manifest key so
  // source-drift findings and any exact known-unshipped waiver are reasoned
  // about independently for each deployed address.
  depositPoolLane: ["HydrationUsdcAdapterV22.sol", "HydrationUsdcAdapterV22"],
  // Ceremony A, 2026-08-26: the venue-less v2.1 pool (Q1'' set-once bind) and
  // the AAC idle-balance aggregator. Deployed from merged main 684ab886; both
  // masked runtimes reproduce from source at their addresses.
  depositPoolV21: ["DepositPoolV2.sol", "DepositPoolV2"],
  aacPoolAggregatorAdapter: ["AacPoolAggregatorAdapter.sol", "AacPoolAggregatorAdapter"],
  hydrationDepositPoolAdapter: [
    "HydrationDepositPoolAdapter.sol",
    "HydrationDepositPoolAdapter",
  ],
  // Post-L1-cutover, contracts.depositPool aliases the v2 address (the deposit
  // door binds this key), so it must name the V2 source. The drained v1 pool
  // at 0xCCF5FDF3… keeps an orphaned provenance entry as historical record.
  depositPool: ["DepositPoolV2.sol", "DepositPoolV2"],
  // L1 activation, deployed 2026-08-13 (ceremony CEREMONY_POOLV2_CREDITPOOL):
  // a THIRD HydrationUsdcAdapterV22 deployment as the v2 pool's lane (this one
  // compiled at HEAD, so it carries #1043's recordRemotePosition — no waiver),
  // plus the v2 pool pair. The drained v1 pool keys above stay live-checked.
  depositPoolLaneV2: ["HydrationUsdcAdapterV22.sol", "HydrationUsdcAdapterV22"],
  hydrationDepositPoolAdapterV2: [
    "HydrationDepositPoolAdapter.sol",
    "HydrationDepositPoolAdapter",
  ],
  depositPoolV2: ["DepositPoolV2.sol", "DepositPoolV2"],
  creditPool: ["CreditPool.sol", "CreditPool"],
  creditBook: ["CreditBook.sol", "CreditBook"],
});

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function hexBytes(value, label = "hex bytes") {
  if (typeof value !== "string" || !/^0x(?:[a-fA-F0-9]{2})*$/u.test(value)) {
    throw new Error(`${label} must be 0x-prefixed, even-length hex.`);
  }
  return Buffer.from(value.slice(2), "hex");
}

export function runtimeCodeHash(code) {
  return sha256(hexBytes(code, "runtime code"));
}

export function artifactAbiHash(abi) {
  if (!Array.isArray(abi)) throw new Error("artifact ABI must be an array.");
  return sha256(Buffer.from(JSON.stringify(abi), "utf8"));
}

function eventDefinition(abi, eventName) {
  const events = abi.filter((item) => item?.type === "event" && item.name === eventName);
  if (events.length !== 1) {
    throw new Error(`expected exactly one ${eventName} event in ABI; found ${events.length}.`);
  }
  const inputs = events[0].inputs;
  if (!Array.isArray(inputs) || inputs.some((input) => typeof input?.type !== "string")) {
    throw new Error(`${eventName} ABI inputs are malformed.`);
  }
  return events[0];
}

export function eventSignature(abi, eventName) {
  const event = eventDefinition(abi, eventName);
  return `${eventName}(${event.inputs.map((input) => input.type).join(",")})`;
}

export function immutableSlots(immutableReferences = {}) {
  if (immutableReferences === null || typeof immutableReferences !== "object" || Array.isArray(immutableReferences)) {
    throw new Error("immutableReferences must be an object.");
  }

  const slots = Object.entries(immutableReferences)
    .flatMap(([sourceId, refs]) => {
      if (!Array.isArray(refs)) throw new Error(`immutableReferences[${sourceId}] must be an array.`);
      return refs.map((ref) => {
        if (
          !Number.isInteger(ref?.start) ||
          ref.start < 0 ||
          !Number.isInteger(ref?.length) ||
          ref.length <= 0
        ) {
          throw new Error(`invalid immutable slot for source id ${sourceId}.`);
        }
        return { sourceId, start: ref.start, length: ref.length };
      });
    })
    .sort((left, right) => left.start - right.start || left.length - right.length);

  for (let index = 1; index < slots.length; index += 1) {
    const previous = slots[index - 1];
    const current = slots[index];
    if (current.start < previous.start + previous.length) {
      throw new Error(
        `overlapping immutable slots at bytes ${previous.start} and ${current.start}.`
      );
    }
  }
  return slots;
}

/**
 * Compare a compiled runtime with eth_getCode while masking solc immutable slots.
 * The returned slotDiffs are the per-slot diff-confinement evidence.
 */
export function compareMaskedRuntime(compiledCode, chainCode, immutableReferences = {}) {
  const compiled = hexBytes(compiledCode, "compiled runtime");
  const deployed = hexBytes(chainCode, "deployed runtime");
  const slots = immutableSlots(immutableReferences);

  if (compiled.length !== deployed.length) {
    return {
      matches: false,
      lengthsMatch: false,
      compiledBytes: compiled.length,
      deployedBytes: deployed.length,
      immutableSlotCount: slots.length,
      diffBytes: null,
      outsideImmutableSlots: null,
      maskedCompiledHash: null,
      maskedDeployedHash: null,
      slotDiffs: slots.map((slot) => ({ ...slot, diffBytes: null })),
    };
  }

  const allowed = new Uint8Array(compiled.length);
  for (const slot of slots) {
    if (slot.start + slot.length > compiled.length) {
      throw new Error(
        `immutable slot ${slot.sourceId}@${slot.start}+${slot.length} exceeds ${compiled.length}-byte runtime.`
      );
    }
    allowed.fill(1, slot.start, slot.start + slot.length);
  }

  let diffBytes = 0;
  let outsideImmutableSlots = 0;
  const slotDiffCounts = new Map(slots.map((slot) => [slot, 0]));
  for (let offset = 0; offset < compiled.length; offset += 1) {
    if (compiled[offset] === deployed[offset]) continue;
    diffBytes += 1;
    if (allowed[offset] === 0) {
      outsideImmutableSlots += 1;
      continue;
    }
    const slot = slots.find(
      (candidate) => offset >= candidate.start && offset < candidate.start + candidate.length
    );
    slotDiffCounts.set(slot, slotDiffCounts.get(slot) + 1);
  }

  const maskedCompiled = Buffer.from(compiled);
  const maskedDeployed = Buffer.from(deployed);
  for (const slot of slots) {
    maskedCompiled.fill(0, slot.start, slot.start + slot.length);
    maskedDeployed.fill(0, slot.start, slot.start + slot.length);
  }
  const maskedCompiledHash = sha256(maskedCompiled);
  const maskedDeployedHash = sha256(maskedDeployed);

  return {
    matches: maskedCompiledHash === maskedDeployedHash && outsideImmutableSlots === 0,
    lengthsMatch: true,
    compiledBytes: compiled.length,
    deployedBytes: deployed.length,
    immutableSlotCount: slots.length,
    diffBytes,
    outsideImmutableSlots,
    maskedCompiledHash,
    maskedDeployedHash,
    slotDiffs: slots.map((slot) => ({ ...slot, diffBytes: slotDiffCounts.get(slot) })),
  };
}

function trackedContracts(manifest) {
  if (manifest?.contracts === null || typeof manifest?.contracts !== "object") {
    throw new Error("manifest.contracts must be an object.");
  }
  return Object.entries(manifest.contracts).filter(
    ([name, address]) => address !== null && address !== "" && !EXTERNAL_CONTRACT_KEYS.has(name)
  );
}

export function validateProvenanceManifest(manifest) {
  const provenance = manifest?.contractProvenance;
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new Error("manifest.contractProvenance must be an address-keyed object.");
  }

  const byAddress = new Map();
  for (const [address, record] of Object.entries(provenance)) {
    if (!ADDRESS_PATTERN.test(address)) {
      throw new Error(`invalid contractProvenance address: ${address}.`);
    }
    const normalized = address.toLowerCase();
    if (byAddress.has(normalized)) {
      throw new Error(`duplicate contractProvenance address (case-insensitive): ${address}.`);
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`contractProvenance[${address}] must be an object.`);
    }
    if (!COMMIT_PATTERN.test(record.sourceCommit)) {
      throw new Error(`contractProvenance[${address}].sourceCommit must be a full lowercase commit SHA.`);
    }
    for (const field of ["abiHash", "runtimeCodeHash"]) {
      if (!HASH_PATTERN.test(record[field])) {
        throw new Error(`contractProvenance[${address}].${field} must be sha256:<64 lowercase hex>.`);
      }
    }
    if (
      typeof record.verifiedAt !== "string" ||
      Number.isNaN(Date.parse(record.verifiedAt)) ||
      new Date(record.verifiedAt).toISOString() !== record.verifiedAt
    ) {
      throw new Error(`contractProvenance[${address}].verifiedAt must be an ISO-8601 UTC timestamp.`);
    }
    byAddress.set(normalized, { address, record });
  }

  const contracts = trackedContracts(manifest).map(([name, address]) => {
    if (!ADDRESS_PATTERN.test(address)) {
      throw new Error(`manifest.contracts.${name} is not an EVM address.`);
    }
    const entry = byAddress.get(address.toLowerCase());
    if (!entry) {
      throw new Error(`missing contractProvenance for contracts.${name} at ${address}.`);
    }
    return { name, address, provenanceAddress: entry.address, provenance: entry.record };
  });

  return contracts;
}

async function rpc(fetchImpl, rpcUrl, method, params = []) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`${method} failed: ${payload.error.message ?? JSON.stringify(payload.error)}.`);
  }
  return payload.result;
}

export async function checkRuntimeProvenance({
  profile = "mainnet",
  manifest,
  rpcUrl,
  fetchImpl = fetch,
}) {
  const expectedChainId = EXPECTED_CHAIN_IDS[profile];
  if (expectedChainId === undefined) throw new Error(`unknown deployment profile: ${profile}.`);
  const url = rpcUrl ?? manifest?.rpcUrl;
  if (typeof url !== "string" || url.length === 0) throw new Error("missing RPC URL.");
  const contracts = validateProvenanceManifest(manifest);

  const chainIdHex = await rpc(fetchImpl, url, "eth_chainId");
  const chainId = Number(BigInt(chainIdHex));
  if (chainId !== expectedChainId) {
    throw new Error(`RPC chainId ${chainId} does not match ${profile} chainId ${expectedChainId}.`);
  }

  const checks = [];
  const chainCode = new Map();
  for (const contract of contracts) {
    const code = await rpc(fetchImpl, url, "eth_getCode", [contract.address, "latest"]);
    const bytes = hexBytes(code, `eth_getCode(${contract.address})`);
    const actual = runtimeCodeHash(code);
    chainCode.set(contract.name, code);
    checks.push({
      name: contract.name,
      address: contract.address,
      expected: contract.provenance.runtimeCodeHash,
      actual,
      codeBytes: bytes.length,
      ok: bytes.length > 0 && actual === contract.provenance.runtimeCodeHash,
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    profile,
    rpcUrl: url,
    chainId,
    checks,
    chainCode,
  };
}

export function checkArtifactProvenance({ name, artifact, deployedCode, provenance }) {
  const compiledCode = artifact?.deployedBytecode?.object;
  if (typeof compiledCode !== "string") throw new Error(`${name} artifact has no deployed bytecode.`);
  const abiHash = artifactAbiHash(artifact.abi);
  const runtime = compareMaskedRuntime(
    compiledCode,
    deployedCode,
    artifact.deployedBytecode.immutableReferences ?? {}
  );
  const failures = [];
  if (abiHash !== provenance.abiHash) failures.push("ABI hash mismatch");
  if (!runtime.lengthsMatch) failures.push("runtime length mismatch");
  if (runtime.outsideImmutableSlots > 0) failures.push("byte differences outside immutable slots");
  if (!runtime.matches) failures.push("masked runtime hash mismatch");

  let reservationSettled = null;
  if (name === "agentAccountCore") {
    const signature = eventSignature(artifact.abi, "ReservationSettled");
    const fields = eventDefinition(artifact.abi, "ReservationSettled").inputs.map(
      ({ indexed, name: fieldName, type }) => ({
        indexed: indexed === true,
        name: fieldName,
        type,
      })
    );
    const fieldsMatch =
      JSON.stringify(fields) === JSON.stringify(RESERVATION_SETTLED_INPUTS);
    reservationSettled = {
      signature,
      topic0: RESERVATION_SETTLED_TOPIC0,
      fields,
      ok: signature === RESERVATION_SETTLED_SIGNATURE && fieldsMatch,
    };
    if (signature !== RESERVATION_SETTLED_SIGNATURE) {
      failures.push("ReservationSettled signature mismatch");
    }
    if (!fieldsMatch) failures.push("ReservationSettled field/indexing mismatch");
  }

  return {
    ok: failures.length === 0,
    name,
    abiHash,
    expectedAbiHash: provenance.abiHash,
    runtime,
    reservationSettled,
    failures,
  };
}

export function loadDeployment(profile, readFile = readFileSync) {
  return JSON.parse(readFile(join(REPO_ROOT, "deployments", `${profile}.json`), "utf8"));
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

const HELP = `check-contract-provenance.mjs — fail on deployed runtime drift

  --profile <name>   deployments/<name>.json (default: mainnet)
  --rpc <url>        override the manifest RPC URL
  --artifacts <dir>  also verify candidate Foundry artifacts with immutable masking
  --json             print machine-readable evidence

Exit: 0 = all checks match, 1 = provenance drift, 2 = usage/config/RPC error.`;

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

  try {
    const manifest = loadDeployment(args.profile);
    const runtime = await checkRuntimeProvenance({
      profile: args.profile,
      manifest,
      rpcUrl: args.rpcUrl,
    });
    const sourceChecks = [];

    if (args.artifacts) {
      for (const contract of validateProvenanceManifest(manifest)) {
        const artifactDefinition = CONTRACT_ARTIFACTS[contract.name];
        if (!artifactDefinition) {
          throw new Error(`no artifact mapping for contracts.${contract.name}.`);
        }
        const [sourceFile, contractName] = artifactDefinition;
        const artifactPath = join(args.artifacts, sourceFile, `${contractName}.json`);
        const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
        sourceChecks.push(
          checkArtifactProvenance({
            name: contract.name,
            artifact,
            deployedCode: runtime.chainCode.get(contract.name),
            provenance: contract.provenance,
          })
        );
      }
    }

    const ok = runtime.ok && sourceChecks.every((check) => check.ok);
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            ok,
            profile: runtime.profile,
            rpcUrl: runtime.rpcUrl,
            chainId: runtime.chainId,
            runtimeChecks: runtime.checks,
            sourceChecks,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Contract provenance: ${runtime.profile} chainId ${runtime.chainId}`);
      for (const check of runtime.checks) {
        console.log(
          `  [${check.ok ? "ok" : "FAIL"}] ${check.name} ${check.address}: ${check.codeBytes} bytes, ${check.actual}`
        );
      }
      for (const check of sourceChecks) {
        const comparison = check.runtime;
        console.log(
          `  [${check.ok ? "ok" : "FAIL"}] ${check.name} source: ` +
            `${comparison.maskedDeployedHash ?? "length mismatch"}, ` +
            `${comparison.diffBytes ?? "n/a"} diff bytes across ${comparison.immutableSlotCount} immutable slots, ` +
            `${comparison.outsideImmutableSlots ?? "n/a"} outside`
        );
        if (check.reservationSettled) {
          console.log(
            `    ReservationSettled topic0: ${check.reservationSettled.topic0} ` +
              `(${check.reservationSettled.ok ? "declaration verified" : "DECLARATION MISMATCH"})`
          );
        }
        for (const failure of check.failures) console.log(`    - ${failure}`);
      }
    }
    if (!ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Contract provenance check failed: ${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
