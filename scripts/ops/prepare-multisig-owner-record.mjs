#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createKeyMulti,
  cryptoWaitReady,
  decodeAddress,
  encodeAddress,
  keccakAsU8a,
  sortAddresses
} from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";

const DEFAULT_SS58_PREFIX = 0;

export async function buildMultisigOwnerRecord({
  profile = "testnet",
  threshold = 2,
  signatories,
  ss58Prefix = DEFAULT_SS58_PREFIX,
  mapAccountTxHash = null,
  ownershipTransferTxHash = null,
  adminRehearsalTxHash = null,
  verifyDeploymentRun = null,
  final = false
} = {}) {
  await cryptoWaitReady();
  const normalizedSignatories = normalizeSignatories(signatories);
  const numericThreshold = normalizePositiveInteger(threshold, "threshold");
  const numericSs58Prefix = normalizeNonNegativeInteger(ss58Prefix, "ss58Prefix");
  if (numericThreshold > normalizedSignatories.length) {
    throw new Error(`threshold (${numericThreshold}) cannot exceed signatory count (${normalizedSignatories.length})`);
  }

  const sortedSignatories = sortAddresses(normalizedSignatories, numericSs58Prefix);
  const decodedSignatories = sortedSignatories.map((address) => decodeAddress(address));
  const accountIds = decodedSignatories.map((accountId) => u8aToHex(accountId));
  if (new Set(accountIds).size !== accountIds.length) {
    throw new Error("signatories must be unique accounts");
  }

  const multisigAccountId = createKeyMulti(decodedSignatories, numericThreshold);
  const ownerEnvValue = u8aToHex(keccakAsU8a(multisigAccountId).slice(-20));
  const evidence = {
    mapAccountTxHash: normalizeNullableString(mapAccountTxHash),
    ownershipTransferTxHash: normalizeNullableString(ownershipTransferTxHash),
    adminRehearsalTxHash: normalizeNullableString(adminRehearsalTxHash),
    verifyDeploymentRun: normalizeNullableString(verifyDeploymentRun)
  };
  const status = evidence.mapAccountTxHash
    && evidence.ownershipTransferTxHash
    && evidence.adminRehearsalTxHash
    && evidence.verifyDeploymentRun
    ? "verified"
    : "draft";
  if (final && status !== "verified") {
    throw new Error(
      "--final requires --map-account-tx, --ownership-transfer-tx, --admin-rehearsal-tx, and --verify-deployment-run"
    );
  }

  return {
    schemaVersion: 1,
    kind: "averray.multisigOwnerRecord",
    status,
    profile: String(profile),
    threshold: numericThreshold,
    ss58Prefix: numericSs58Prefix,
    signatories: sortedSignatories.map((address, index) => ({
      index: index + 1,
      address,
      accountId32: accountIds[index]
    })),
    multisig: {
      ss58Address: encodeAddress(multisigAccountId, numericSs58Prefix),
      accountId32: u8aToHex(multisigAccountId),
      ownerEnvValue,
      ownerEnvVar: "OWNER"
    },
    mapAccount: {
      required: true,
      extrinsic: "pallet_revive.map_account()",
      status: evidence.mapAccountTxHash ? "recorded" : "pending",
      txHash: evidence.mapAccountTxHash
    },
    testnetRehearsal: {
      ownershipTransferTxHash: evidence.ownershipTransferTxHash,
      adminRehearsalTxHash: evidence.adminRehearsalTxHash,
      verifyDeploymentRun: evidence.verifyDeploymentRun
    },
    launchGate: {
      readyForOwnerUse: status === "verified",
      reason: status === "verified"
        ? "map_account, ownership transfer, verify_deployment, and multisig admin rehearsal are recorded"
        : "do not use multisig.ownerEnvValue as OWNER until map_account and testnet ownership/admin rehearsals are recorded"
    },
    polkadotDocsCheck: {
      source: "https://docs.polkadot.com/smart-contracts/for-eth-devs/accounts/#account-mapping-for-native-polkadot-accounts",
      note: "Native AccountId32 accounts need pallet_revive.map_account() before Ethereum-compatible smart-contract tooling can safely control them."
    }
  };
}

export function normalizeSignatories(value) {
  const signatories = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  const normalized = signatories.map((entry) => String(entry).trim()).filter(Boolean);
  if (normalized.length < 2) {
    throw new Error("at least two signatories are required");
  }
  for (const address of normalized) {
    decodeAddress(address);
  }
  return normalized;
}

function normalizePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function normalizeNullableString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function parseArgs(argv) {
  const args = {
    profile: "testnet",
    threshold: 2,
    ss58Prefix: DEFAULT_SS58_PREFIX,
    final: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    switch (arg) {
      case "--profile":
        args.profile = next();
        break;
      case "--threshold":
        args.threshold = next();
        break;
      case "--ss58-prefix":
        args.ss58Prefix = next();
        break;
      case "--signatories":
        args.signatories = next();
        break;
      case "--map-account-tx":
        args.mapAccountTxHash = next();
        break;
      case "--ownership-transfer-tx":
        args.ownershipTransferTxHash = next();
        break;
      case "--admin-rehearsal-tx":
        args.adminRehearsalTxHash = next();
        break;
      case "--verify-deployment-run":
        args.verifyDeploymentRun = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--final":
        args.final = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/ops/${basename(fileURLToPath(import.meta.url))} \\
    --signatories <HOT_SS58>,<WARM_SS58>,<COLD_SS58> \\
    [--threshold 2] [--ss58-prefix 0] [--profile testnet] \\
    [--map-account-tx 0x...] [--ownership-transfer-tx 0x...] \\
    [--admin-rehearsal-tx 0x...] [--verify-deployment-run <url-or-id>] \\
    [--final] [--out deployments/testnet-multisig-owner.json]

The output is a public operator record. It does not contain private keys or seeds.
Use --final only after map_account, ownership transfer, verify_deployment, and
one multisig admin rehearsal have all completed on Polkadot Hub TestNet.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const record = await buildMultisigOwnerRecord(args);
  const json = `${JSON.stringify(record, null, 2)}\n`;
  if (args.out) {
    await writeFile(args.out, json, { mode: 0o644 });
  }
  process.stdout.write(json);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  });
}
