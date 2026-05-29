#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));

export const SCHEMA_VERSION = "mainnet-env-secrets-proof-v1";
export const EXPECTED_MAINNET_RPC_URL = "https://eth-rpc.polkadot.io/";
export const MAX_MAINNET_JWT_TTL_SECONDS = 30 * 24 * 60 * 60;

const FUTURE_SKEW_MS = 5 * 60 * 1000;
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/u;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SHA256_PATTERN = /^sha256:[a-fA-F0-9]{64}$/u;
const FINGERPRINT_PATTERN = /^sha256:[a-fA-F0-9]{32,128}$/u;
const REQUIRED_CONTRACTS = [
  "escrowCore",
  "agentAccountCore",
  "treasuryPolicy",
  "reputationSbt",
  "discoveryRegistry"
];
const REQUIRED_SERVICE_TOKENS = [
  "ciDeploy",
  "vpsBackend",
  "vpsIndexer",
  "smokeTests"
];
const REQUIRED_FALSE_FLAGS = [
  "signerPrivateKeyRendered",
  "arbitratorPrivateKeyRendered",
  "awsStaticAccessKeysRendered",
  "awsJwtStaticAccessKeysRendered",
  "authJwtSecretsRendered",
  "rawJwtSigningSecretRendered"
];
const REQUIRED_POLKADOT_DOCS = [
  "smart-contracts/precompiles/erc20.md",
  "reference/polkadot-hub/assets.md"
];

function usage() {
  return `Usage: node scripts/ops/${SCRIPT_NAME} --file docs/evidence/mainnet-env-secrets-YYYY-MM-DD.json [--json] [--max-completed-age-hours N] [--now <iso>]

Validates a redacted mainnet env/secrets proof artifact. This check is offline
and read-only: it does not render secrets, call providers, call chain RPC, or
store raw credentials.

The evidence file must use schema ${SCHEMA_VERSION}. Use --max-completed-age-hours
when validating launch evidence so a stale artifact cannot be reused. Use --now to
pin the freshness clock to an ISO-8601 date/time (deterministic tests).
`;
}

export function parseArgs(argv) {
  const args = {
    file: undefined,
    json: false,
    maxCompletedAgeHours: undefined,
    now: undefined,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      args.file = argv[index + 1];
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--max-completed-age-hours") {
      args.maxCompletedAgeHours = parsePositiveInteger(argv[index + 1], "--max-completed-age-hours");
      index += 1;
    } else if (arg === "--now") {
      args.now = parseIsoDate(argv[index + 1]);
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (!args.file && !arg.startsWith("-")) {
      args.file = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function parsePositiveInteger(value, flag) {
  if (!/^[1-9][0-9]*$/u.test(String(value ?? ""))) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(value);
}

function parseIsoDate(value) {
  const raw = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/u.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new Error("--now must be an ISO-8601 date/time");
  }
  return new Date(Date.parse(raw));
}

function assertObject(value, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }
  return value;
}

function requireString(value, path, errors, { pattern = undefined } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} must be a non-empty string`);
    return "";
  }
  const trimmed = value.trim();
  if (pattern && !pattern.test(trimmed)) {
    errors.push(`${path} has an invalid format`);
  }
  return trimmed;
}

function requireBoolean(value, path, errors) {
  if (typeof value !== "boolean") {
    errors.push(`${path} must be boolean`);
    return undefined;
  }
  return value;
}

function requireNumber(value, path, errors, { integer = false, min = undefined, max = undefined } = {}) {
  const ok = integer ? Number.isInteger(value) : Number.isFinite(value);
  if (!ok) {
    errors.push(`${path} must be ${integer ? "an integer" : "a finite number"}`);
    return undefined;
  }
  if (min !== undefined && value < min) {
    errors.push(`${path} must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    errors.push(`${path} must be <= ${max}`);
  }
  return value;
}

function requireArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  return value;
}

function requireIsoTimestamp(value, path, errors) {
  const raw = requireString(value, path, errors);
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(raw) || !Number.isFinite(Date.parse(raw))) {
    errors.push(`${path} must be an ISO-8601 date/time`);
    return undefined;
  }
  return Date.parse(raw);
}

function requireAddress(value, path, errors) {
  const address = requireString(value, path, errors, { pattern: ADDRESS_PATTERN }).toLowerCase();
  if (address === ZERO_ADDRESS) {
    errors.push(`${path} must not be the zero address`);
  }
  return address;
}

function containsSecretLikeValue(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (SHA256_PATTERN.test(trimmed) || FINGERPRINT_PATTERN.test(trimmed)) {
    return false;
  }
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\b0x[a-fA-F0-9]{64}\b/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bASIA[0-9A-Z]{16}\b/u,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/u,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
    /\bre_[A-Za-z0-9_]{20,}\b/u,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u
  ];
  return patterns.some((pattern) => pattern.test(trimmed));
}

function scanForSecretLikeValues(value, path, errors) {
  if (containsSecretLikeValue(value)) {
    errors.push(`${path} appears to contain a secret value; store raw secrets outside this evidence file`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForSecretLikeValues(entry, `${path}[${index}]`, errors));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      scanForSecretLikeValues(entry, `${path}.${key}`, errors);
    }
  }
}

function validateFreshness(timestamp, path, options, errors) {
  if (!Number.isFinite(timestamp)) return;
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    errors.push("now must be a valid Date or timestamp");
    return;
  }
  if (timestamp > nowMs + FUTURE_SKEW_MS) {
    errors.push(`${path} must not be in the future`);
  }
  if (options.maxCompletedAgeHours !== undefined) {
    const maxAgeMs = options.maxCompletedAgeHours * 60 * 60 * 1000;
    if (nowMs - timestamp > maxAgeMs) {
      errors.push(`${path} must be within ${options.maxCompletedAgeHours} hour(s)`);
    }
  }
}

function validatePolkadotDocs(rawDocs, errors) {
  const docs = requireArray(rawDocs, "polkadotDocs", errors);
  for (const requiredPath of REQUIRED_POLKADOT_DOCS) {
    if (!docs.includes(requiredPath)) {
      errors.push(`polkadotDocs must include ${requiredPath}`);
    }
  }
  return docs;
}

function validateEnvironment(rawEnvironment, errors) {
  const environment = assertObject(rawEnvironment, "environment", errors);
  if (environment.chainEnv !== "mainnet") {
    errors.push("environment.chainEnv must be mainnet");
  }
  if (environment.profile !== "mainnet") {
    errors.push("environment.profile must be mainnet");
  }
  const rpcUrl = requireString(environment.rpcUrl, "environment.rpcUrl", errors);
  if (rpcUrl && rpcUrl !== EXPECTED_MAINNET_RPC_URL) {
    errors.push(`environment.rpcUrl must be ${EXPECTED_MAINNET_RPC_URL}`);
  }
  for (const [index, rawUrl] of requireArray(environment.additionalRpcUrls ?? [], "environment.additionalRpcUrls", errors).entries()) {
    const url = requireString(rawUrl, `environment.additionalRpcUrls[${index}]`, errors);
    if (url && looksLikeNonMainnetUrl(url)) {
      errors.push(`environment.additionalRpcUrls[${index}] must not point at testnet, Paseo, localhost, or a private endpoint`);
    }
  }
  requireString(environment.privateEnvSource, "environment.privateEnvSource", errors);
  requireString(environment.renderedEnvChecksum, "environment.renderedEnvChecksum", errors, {
    pattern: SHA256_PATTERN
  });
  if (environment.deployEnvExample !== "deployments/mainnet.env.example") {
    errors.push("environment.deployEnvExample must be deployments/mainnet.env.example");
  }
  return {
    rpcUrl,
    privateEnvSource: environment.privateEnvSource,
    renderedEnvChecksum: environment.renderedEnvChecksum
  };
}

function looksLikeNonMainnetUrl(value) {
  const lower = value.toLowerCase();
  return (
    lower.includes("testnet")
    || lower.includes("paseo")
    || lower.includes("localhost")
    || lower.includes("127.0.0.1")
    || lower.includes("0.0.0.0")
    || lower.startsWith("http://")
  );
}

function validateContracts(rawContracts, errors) {
  const contracts = assertObject(rawContracts, "contracts", errors);
  const addresses = new Map();
  for (const name of REQUIRED_CONTRACTS) {
    const address = requireAddress(contracts[name], `contracts.${name}`, errors);
    if (!address || address === ZERO_ADDRESS) continue;
    const previous = addresses.get(address);
    if (previous) {
      errors.push(`contracts.${name} must not reuse contracts.${previous}`);
    }
    addresses.set(address, name);
  }
  return Object.fromEntries(addresses.entries());
}

function validateRoleSigners(rawSigners, errors) {
  const signers = assertObject(rawSigners, "roleSigners", errors);
  for (const name of ["owner", "pauser", "verifier", "arbitrator"]) {
    const signer = assertObject(signers[name], `roleSigners.${name}`, errors);
    requireAddress(signer.address, `roleSigners.${name}.address`, errors);
    if (requireBoolean(signer.freshMainnetKey, `roleSigners.${name}.freshMainnetKey`, errors) !== true) {
      errors.push(`roleSigners.${name}.freshMainnetKey must be true`);
    }
    if (requireBoolean(signer.reusedTestnetKey, `roleSigners.${name}.reusedTestnetKey`, errors) !== false) {
      errors.push(`roleSigners.${name}.reusedTestnetKey must be false`);
    }
    if (requireBoolean(signer.rawPrivateKeyFallback, `roleSigners.${name}.rawPrivateKeyFallback`, errors) !== false) {
      errors.push(`roleSigners.${name}.rawPrivateKeyFallback must be false`);
    }
  }
  const owner = assertObject(signers.owner, "roleSigners.owner", errors);
  if (owner.kind !== "multisig_mapped_evm") {
    errors.push("roleSigners.owner.kind must be multisig_mapped_evm");
  }
  requireNumber(owner.hardwareBackedSignerCount, "roleSigners.owner.hardwareBackedSignerCount", errors, {
    integer: true,
    min: 2
  });
  return {
    owner: signers.owner?.address,
    verifier: signers.verifier?.address,
    arbitrator: signers.arbitrator?.address
  };
}

function validateKms(rawKms, errors) {
  const kms = assertObject(rawKms, "kms", errors);
  validateKmsSigner(kms.blockchainSigner, "kms.blockchainSigner", errors, {
    expectedKeySpec: "ECC_SECG_P256K1"
  });
  validateKmsSigner(kms.jwtSigner, "kms.jwtSigner", errors, {
    expectedKeySpec: "ECC_NIST_P256",
    requirePublicKey: true
  });
}

function validateKmsSigner(rawSigner, path, errors, { expectedKeySpec, requirePublicKey = false }) {
  const signer = assertObject(rawSigner, path, errors);
  requireString(signer.keyId, `${path}.keyId`, errors);
  if (signer.keySpec !== expectedKeySpec) {
    errors.push(`${path}.keySpec must be ${expectedKeySpec}`);
  }
  if (requireBoolean(signer.multiRegion, `${path}.multiRegion`, errors) !== true) {
    errors.push(`${path}.multiRegion must be true`);
  }
  if (requireBoolean(signer.rolesAnywhere, `${path}.rolesAnywhere`, errors) !== true) {
    errors.push(`${path}.rolesAnywhere must be true`);
  }
  if (requireBoolean(signer.staticAccessKeysRendered, `${path}.staticAccessKeysRendered`, errors) !== false) {
    errors.push(`${path}.staticAccessKeysRendered must be false`);
  }
  if (requireBoolean(signer.reusedTestnetKey, `${path}.reusedTestnetKey`, errors) !== false) {
    errors.push(`${path}.reusedTestnetKey must be false`);
  }
  if (requirePublicKey) {
    requireString(signer.publicKeyFingerprint, `${path}.publicKeyFingerprint`, errors, {
      pattern: FINGERPRINT_PATTERN
    });
    if (requireBoolean(signer.publicKeyPemBase64Present, `${path}.publicKeyPemBase64Present`, errors) !== true) {
      errors.push(`${path}.publicKeyPemBase64Present must be true`);
    }
  }
}

function validateAuth(rawAuth, errors) {
  const auth = assertObject(rawAuth, "auth", errors);
  if (auth.jwtBackend !== "kms") {
    errors.push("auth.jwtBackend must be kms");
  }
  if (auth.jwtPrimaryAlg !== "kms") {
    errors.push("auth.jwtPrimaryAlg must be kms");
  }
  if (requireBoolean(auth.hmacVerifyAccepted, "auth.hmacVerifyAccepted", errors) !== false) {
    errors.push("auth.hmacVerifyAccepted must be false for mainnet proof");
  }
  requireNumber(auth.maxTtlSeconds, "auth.maxTtlSeconds", errors, {
    integer: true,
    min: 1,
    max: MAX_MAINNET_JWT_TTL_SECONDS
  });
}

function validateRawFallbacks(rawFallbacks, errors) {
  const rawFallbacksObject = assertObject(rawFallbacks, "rawFallbacks", errors);
  for (const flag of REQUIRED_FALSE_FLAGS) {
    if (requireBoolean(rawFallbacksObject[flag], `rawFallbacks.${flag}`, errors) !== false) {
      errors.push(`rawFallbacks.${flag} must be false`);
    }
  }
}

function validateServiceTokens(rawServiceTokens, errors) {
  const serviceTokens = assertObject(rawServiceTokens, "serviceTokens", errors);
  for (const tokenId of REQUIRED_SERVICE_TOKENS) {
    validateServiceToken(serviceTokens[tokenId], `serviceTokens.${tokenId}`, errors);
  }
}

function validateServiceToken(rawToken, path, errors) {
  const token = assertObject(rawToken, path, errors);
  if (requireBoolean(token.mainnetOnly, `${path}.mainnetOnly`, errors) !== true) {
    errors.push(`${path}.mainnetOnly must be true`);
  }
  if (requireBoolean(token.reusedTestnetToken, `${path}.reusedTestnetToken`, errors) !== false) {
    errors.push(`${path}.reusedTestnetToken must be false`);
  }
  if (requireBoolean(token.rawTokenRendered, `${path}.rawTokenRendered`, errors) !== false) {
    errors.push(`${path}.rawTokenRendered must be false`);
  }
  const vaults = requireArray(token.vaults, `${path}.vaults`, errors);
  if (vaults.length === 0) {
    errors.push(`${path}.vaults must not be empty`);
  }
  const seenVaults = new Set();
  for (const [index, rawVault] of vaults.entries()) {
    const vault = requireString(rawVault, `${path}.vaults[${index}]`, errors);
    if (!vault) continue;
    if (seenVaults.has(vault)) {
      errors.push(`${path}.vaults must not contain duplicate ${vault}`);
    }
    seenVaults.add(vault);
    const lower = vault.toLowerCase();
    if (vault === "*" || lower === "all") {
      errors.push(`${path}.vaults[${index}] must not be wildcard scoped`);
    }
    if (lower === "prod-critical") {
      errors.push(`${path}.vaults[${index}] must not grant prod-critical`);
    }
  }
}

function validateNoReuse(rawNoReuse, errors) {
  const noReuse = assertObject(rawNoReuse, "noTestnetReuse", errors);
  for (const key of ["reusedVaultItems", "reusedKmsKeys", "reusedServiceTokens", "reusedWalletSeeds"]) {
    const values = requireArray(noReuse[key], `noTestnetReuse.${key}`, errors);
    if (values.length !== 0) {
      errors.push(`noTestnetReuse.${key} must be empty`);
    }
  }
}

function validateVendorKeys(rawVendorKeys, errors) {
  const vendorKeys = requireArray(rawVendorKeys ?? [], "vendorKeys", errors);
  for (const [index, rawVendor] of vendorKeys.entries()) {
    const path = `vendorKeys[${index}]`;
    const vendor = assertObject(rawVendor, path, errors);
    requireString(vendor.name, `${path}.name`, errors);
    if (requireBoolean(vendor.enabled, `${path}.enabled`, errors) !== true) {
      continue;
    }
    if (requireBoolean(vendor.mainnetDedicated, `${path}.mainnetDedicated`, errors) !== true) {
      errors.push(`${path}.mainnetDedicated must be true when enabled`);
    }
    if (requireBoolean(vendor.reusedTestnetKey, `${path}.reusedTestnetKey`, errors) !== false) {
      errors.push(`${path}.reusedTestnetKey must be false when enabled`);
    }
    if (requireBoolean(vendor.rawKeyRendered, `${path}.rawKeyRendered`, errors) !== false) {
      errors.push(`${path}.rawKeyRendered must be false when enabled`);
    }
  }
}

export function validateEvidence(evidence, options = {}) {
  const errors = [];
  const warnings = [];
  const doc = assertObject(evidence, "evidence", errors);

  if (doc.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const completedAt = requireIsoTimestamp(doc.completedAt, "completedAt", errors);
  validateFreshness(completedAt, "completedAt", options, errors);
  validatePolkadotDocs(doc.polkadotDocs, errors);
  validateEnvironment(doc.environment, errors);
  validateContracts(doc.contracts, errors);
  validateRoleSigners(doc.roleSigners, errors);
  validateKms(doc.kms, errors);
  validateAuth(doc.auth, errors);
  validateRawFallbacks(doc.rawFallbacks, errors);
  validateServiceTokens(doc.serviceTokens, errors);
  validateNoReuse(doc.noTestnetReuse, errors);
  validateVendorKeys(doc.vendorKeys, errors);
  scanForSecretLikeValues(doc, "evidence", errors);

  if (!errors.length && options.maxCompletedAgeHours === undefined) {
    warnings.push("completedAt freshness was not enforced; use --max-completed-age-hours for launch proof");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      schemaVersion: doc.schemaVersion,
      completedAt: doc.completedAt,
      rpcUrl: doc.environment?.rpcUrl,
      contractCount: REQUIRED_CONTRACTS.length,
      serviceTokenCount: REQUIRED_SERVICE_TOKENS.length,
      jwtBackend: doc.auth?.jwtBackend,
      kmsBlockchainKeySpec: doc.kms?.blockchainSigner?.keySpec,
      kmsJwtKeySpec: doc.kms?.jwtSigner?.keySpec
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.file) {
    throw new Error("--file is required");
  }

  const parsed = JSON.parse(await readFile(args.file, "utf8"));
  const result = validateEvidence(parsed, {
    maxCompletedAgeHours: args.maxCompletedAgeHours,
    now: args.now
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      status: result.ok ? "ok" : "not_ok",
      file: args.file,
      summary: result.summary,
      warnings: result.warnings,
      errors: result.errors
    }, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`Mainnet env/secrets proof ok: ${args.file}\n`);
    for (const warning of result.warnings) {
      process.stderr.write(`- warning: ${warning}\n`);
    }
  } else {
    process.stderr.write(`Mainnet env/secrets proof invalid: ${args.file}\n`);
    for (const error of result.errors) {
      process.stderr.write(`- ${error}\n`);
    }
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
