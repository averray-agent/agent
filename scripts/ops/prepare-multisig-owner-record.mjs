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
  mapAccountMechanism = "extrinsic",
  mapAccountTxHash = null,
  autoMapVerified = false,
  accountCreationBlock = null,
  accountCreationTxHash = null,
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
  const mechanism = normalizeMapAccountMechanism(mapAccountMechanism);
  const evidence = {
    mapAccountTxHash: normalizeNullableString(mapAccountTxHash),
    ownershipTransferTxHash: normalizeNullableString(ownershipTransferTxHash),
    adminRehearsalTxHash: normalizeNullableString(adminRehearsalTxHash),
    verifyDeploymentRun: normalizeNullableString(verifyDeploymentRun),
    accountCreationBlock: normalizeNullableString(accountCreationBlock),
    accountCreationTxHash: normalizeNullableString(accountCreationTxHash)
  };

  // Under `Config::AutoMap` the runtime maps accounts on creation and
  // `revive.map_account()` is a documented no-op, so no mapping extrinsic can
  // ever exist. Refuse to file an unrelated hash (e.g. the funding transfer
  // that created the account) in the mapping slot -- that would record a
  // transaction as proof of something it did not do.
  if (mechanism === "auto_map" && evidence.mapAccountTxHash) {
    throw new Error(
      "--map-account-tx is invalid with --map-account-mechanism auto_map: "
      + "map_account() is a no-op under AutoMap, so no mapping extrinsic exists. "
      + "Record the on-chain mapping with --auto-map-verified, and pass the account-creating "
      + "transfer as --account-creation-tx (never as the mapping hash)."
    );
  }

  const mapAccountSatisfied = mechanism === "auto_map"
    ? Boolean(autoMapVerified)
    : Boolean(evidence.mapAccountTxHash);

  const status = mapAccountSatisfied
    && evidence.ownershipTransferTxHash
    && evidence.adminRehearsalTxHash
    && evidence.verifyDeploymentRun
    ? "verified"
    : "draft";
  if (final && status !== "verified") {
    throw new Error(
      `--final requires ${mechanism === "auto_map" ? "--auto-map-verified" : "--map-account-tx"}`
      + ", --ownership-transfer-tx, --admin-rehearsal-tx, and --verify-deployment-run"
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
      mechanism,
      required: mechanism === "extrinsic",
      extrinsic: mechanism === "extrinsic" ? "pallet_revive.map_account()" : null,
      status: mapAccountSatisfied
        ? (mechanism === "auto_map" ? "auto_mapped" : "recorded")
        : "pending",
      txHash: evidence.mapAccountTxHash,
      autoMap: mechanism === "auto_map"
        ? {
          note: "Config::AutoMap is enabled on this runtime. revive.map_account() is a "
            + "documented no-op; accounts are mapped automatically on creation (and unmapped "
            + "on kill) by AutoMapper. No mapping extrinsic exists or is needed.",
          accountCreationBlock: evidence.accountCreationBlock,
          accountCreationTxHash: evidence.accountCreationTxHash,
          originalAccountVerified: Boolean(autoMapVerified),
          // The proof is chain state, not a transaction. Anyone can re-check it:
          verify: {
            storage: `revive.originalAccount(${ownerEnvValue})`,
            expect: u8aToHex(multisigAccountId)
          },
          operationalWarning: "AutoMapper unmaps an account when it is killed. Keep the "
            + "multisig funded above the existential deposit for as long as it owns contracts."
        }
        : null
    },
    testnetRehearsal: {
      ownershipTransferTxHash: evidence.ownershipTransferTxHash,
      adminRehearsalTxHash: evidence.adminRehearsalTxHash,
      verifyDeploymentRun: evidence.verifyDeploymentRun
    },
    launchGate: {
      readyForOwnerUse: status === "verified",
      reason: status === "verified"
        ? `account mapping (${mechanism}), ownership transfer, verify_deployment, and multisig admin rehearsal are recorded`
        : `do not use multisig.ownerEnvValue as OWNER until the account mapping (${mechanism}) and ownership/admin rehearsals are recorded`
    },
    polkadotDocsCheck: {
      source: "https://docs.polkadot.com/smart-contracts/for-eth-devs/accounts/#account-mapping-for-native-polkadot-accounts",
      note: "A native AccountId32 must be mapped before Ethereum-compatible tooling can control it. "
        + "The address itself is always keccak256(accountId32)[12..32]; mapping stores the reverse "
        + "lookup and does not change the derived address. Runtimes with Config::AutoMap perform the "
        + "mapping automatically on account creation, making map_account() a no-op."
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

export function normalizeMapAccountMechanism(value) {
  const normalized = String(value ?? "extrinsic").trim();
  if (normalized !== "extrinsic" && normalized !== "auto_map") {
    throw new Error(`mapAccountMechanism must be "extrinsic" or "auto_map" (got "${normalized}")`);
  }
  return normalized;
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
      case "--map-account-mechanism":
        args.mapAccountMechanism = next();
        break;
      case "--map-account-tx":
        args.mapAccountTxHash = next();
        break;
      case "--auto-map-verified":
        args.autoMapVerified = true;
        break;
      case "--account-creation-block":
        args.accountCreationBlock = next();
        break;
      case "--account-creation-tx":
        args.accountCreationTxHash = next();
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
    [--map-account-mechanism extrinsic|auto_map] \\
    [--map-account-tx 0x...] \\
    [--auto-map-verified] [--account-creation-block N] [--account-creation-tx 0x...] \\
    [--ownership-transfer-tx 0x...] \\
    [--admin-rehearsal-tx 0x...] [--verify-deployment-run <url-or-id>] \\
    [--final] [--out deployments/testnet-multisig-owner.json]

Account mapping has two mechanisms:
  extrinsic  (default) the account called pallet_revive.map_account(); record
             the extrinsic hash with --map-account-tx.
  auto_map   the runtime has Config::AutoMap, so map_account() is a no-op and
             the account was mapped automatically on creation. There is no
             mapping extrinsic. Confirm on chain that
             revive.originalAccount(<ownerEnvValue>) == <multisig accountId32>,
             then pass --auto-map-verified. Use --account-creation-tx for the
             transfer that created the account -- never as --map-account-tx,
             which is refused under auto_map.

The output is a public operator record. It does not contain private keys or seeds.
Use --final only after the account mapping, ownership transfer, verify_deployment,
and one multisig admin rehearsal have all been recorded.`;
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
