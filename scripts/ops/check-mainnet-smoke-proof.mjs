#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_ESCROW_ASSET } from "../../mcp-server/src/core/assets.js";

const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));

export const SCHEMA_VERSION = "mainnet-smoke-proof-v1";
export const EXPECTED_MAINNET_RPC_URL = "https://eth-rpc.polkadot.io/";
export const DEFAULT_MIN_RUNS = 3;
export const DEFAULT_MAX_REWARD_RAW = 1_000_000n;

const FUTURE_SKEW_MS = 5 * 60 * 1000;
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/u;
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/u;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SHA256_PATTERN = /^sha256:[a-fA-F0-9]{64}$/u;
const FINGERPRINT_PATTERN = /^sha256:[a-fA-F0-9]{32,128}$/u;
const REQUIRED_POLKADOT_DOCS = [
  "smart-contracts/precompiles/erc20.md",
  "reference/polkadot-hub/assets.md",
  "smart-contracts/explorers.md"
];
const REQUIRED_CONTRACTS = [
  "escrowCore",
  "agentAccountCore",
  "treasuryPolicy",
  "reputationSbt",
  "discoveryRegistry"
];
const MAINNET_EXPLORER_HOSTS = new Set([
  "blockscout.polkadot.io",
  "polkadot.routescan.io",
  "assethub-polkadot.subscan.io"
]);
const SAFE_HEX64_KEYS = new Set([
  "blockHash",
  "callHash",
  "contentHash",
  "deploymentHash",
  "eventsHash",
  "explorerUrl",
  "proofHash",
  "receiptHash",
  "reasoningHash",
  "schemaHash",
  "settlementHash",
  "transactionHash",
  "txHash"
]);
const CANONICAL_USDC = Object.freeze({
  symbol: DEFAULT_ESCROW_ASSET.symbol,
  assetClass: DEFAULT_ESCROW_ASSET.assetClass,
  assetId: DEFAULT_ESCROW_ASSET.assetId,
  address: DEFAULT_ESCROW_ASSET.address.toLowerCase(),
  decimals: DEFAULT_ESCROW_ASSET.decimals,
  minBalanceRaw: String(DEFAULT_ESCROW_ASSET.minBalanceRaw)
});

function usage() {
  return `Usage: node scripts/ops/${SCRIPT_NAME} --file docs/evidence/mainnet-smoke-YYYY-MM-DD.json [--json] [--max-completed-age-hours N] [--min-runs N] [--max-reward-raw N] [--now <iso>]

Validates a redacted mainnet smoke proof artifact. This check is offline and
read-only: it does not call chain RPC, mutate jobs, or settle funds.

The evidence file must use schema ${SCHEMA_VERSION}. Use --max-completed-age-hours
when validating launch evidence so stale smoke artifacts cannot be reused.
--now <iso> pins the freshness clock (ISO-8601); defaults to the current time.
`;
}

export function parseArgs(argv) {
  const args = {
    file: undefined,
    json: false,
    maxCompletedAgeHours: undefined,
    minRuns: DEFAULT_MIN_RUNS,
    maxRewardRaw: DEFAULT_MAX_REWARD_RAW,
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
    } else if (arg === "--min-runs") {
      args.minRuns = parsePositiveInteger(argv[index + 1], "--min-runs");
      index += 1;
    } else if (arg === "--max-reward-raw") {
      args.maxRewardRaw = parsePositiveBigInt(argv[index + 1], "--max-reward-raw");
      index += 1;
    } else if (arg === "--now") {
      args.now = parseTimestampArg(argv[index + 1], "--now");
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

function parseTimestampArg(value, flag) {
  const text = String(value ?? "");
  const parsed = new Date(text);
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(text) || Number.isNaN(parsed.getTime())) {
    throw new Error(`${flag} must be an ISO-8601 date/time`);
  }
  return parsed;
}

function parsePositiveBigInt(value, flag) {
  if (!/^[1-9][0-9]*$/u.test(String(value ?? ""))) {
    throw new Error(`${flag} must be a positive integer raw amount`);
  }
  return BigInt(value);
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

function requireHash(value, path, errors) {
  return requireString(value, path, errors, { pattern: HASH_PATTERN }).toLowerCase();
}

function parseRawAmount(value, path, errors) {
  const raw = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : String(value ?? "").trim();
  if (!/^[0-9]+$/u.test(raw)) {
    errors.push(`${path} must be a non-negative integer raw amount`);
    return undefined;
  }
  return BigInt(raw);
}

function containsSecretLikeValue(value, key) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (SHA256_PATTERN.test(trimmed) || FINGERPRINT_PATTERN.test(trimmed)) {
    return false;
  }
  const isSafeHashField = SAFE_HEX64_KEYS.has(key);
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bASIA[0-9A-Z]{16}\b/u,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/u,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
    /\bre_[A-Za-z0-9_]{20,}\b/u,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u
  ];
  if (!isSafeHashField && /\b0x[a-fA-F0-9]{64}\b/u.test(trimmed)) {
    return true;
  }
  return patterns.some((pattern) => pattern.test(trimmed));
}

function scanForSecretLikeValues(value, path, errors, key = "") {
  if (containsSecretLikeValue(value, key)) {
    errors.push(`${path} appears to contain a secret value; store raw secrets outside this evidence file`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForSecretLikeValues(entry, `${path}[${index}]`, errors, String(index)));
    return;
  }
  if (value && typeof value === "object") {
    for (const [entryKey, entry] of Object.entries(value)) {
      scanForSecretLikeValues(entry, `${path}.${entryKey}`, errors, entryKey);
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

function looksLikeNonMainnetValue(value) {
  const lower = String(value ?? "").toLowerCase();
  return (
    lower.includes("testnet")
    || lower.includes("paseo")
    || lower.includes("westend")
    || lower.includes("localhost")
    || lower.includes("127.0.0.1")
    || lower.includes("[::1]")
  );
}

function requireHttpsMainnetUrl(value, path, errors) {
  const raw = requireString(value, path, errors);
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    errors.push(`${path} must be a valid URL`);
    return raw;
  }
  if (url.protocol !== "https:") {
    errors.push(`${path} must use https`);
  }
  if (looksLikeNonMainnetValue(raw)) {
    errors.push(`${path} must not point at testnet, Paseo, localhost, or a private endpoint`);
  }
  return raw;
}

function requireExplorerUrl(value, path, errors) {
  const raw = requireHttpsMainnetUrl(value, path, errors);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!MAINNET_EXPLORER_HOSTS.has(url.hostname)) {
      errors.push(`${path} must use a Polkadot Hub mainnet explorer host`);
    }
  } catch {
    // requireHttpsMainnetUrl already reported this.
  }
  return raw;
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
  if (environment.network !== "polkadot-hub-mainnet") {
    errors.push("environment.network must be polkadot-hub-mainnet");
  }
  const apiBaseUrl = requireHttpsMainnetUrl(environment.apiBaseUrl, "environment.apiBaseUrl", errors);
  const rpcUrl = requireString(environment.rpcUrl, "environment.rpcUrl", errors);
  if (rpcUrl && rpcUrl !== EXPECTED_MAINNET_RPC_URL) {
    errors.push(`environment.rpcUrl must be ${EXPECTED_MAINNET_RPC_URL}`);
  }
  if (looksLikeNonMainnetValue(rpcUrl)) {
    errors.push("environment.rpcUrl must not point at testnet, Paseo, localhost, or a private endpoint");
  }
  return {
    apiBaseUrl,
    rpcUrl
  };
}

function validateContracts(rawContracts, errors) {
  const contracts = assertObject(rawContracts, "contracts", errors);
  const seen = new Map();
  for (const key of REQUIRED_CONTRACTS) {
    const address = requireAddress(contracts[key], `contracts.${key}`, errors);
    if (address && seen.has(address)) {
      errors.push(`contracts.${key} must not reuse contracts.${seen.get(address)}`);
    } else if (address) {
      seen.set(address, key);
    }
  }
}

function validateAsset(rawAsset, errors, path = "asset") {
  const asset = assertObject(rawAsset, path, errors);
  if (asset.symbol !== CANONICAL_USDC.symbol) {
    errors.push(`${path}.symbol must be ${CANONICAL_USDC.symbol}`);
  }
  if (asset.assetClass !== CANONICAL_USDC.assetClass) {
    errors.push(`${path}.assetClass must be ${CANONICAL_USDC.assetClass}`);
  }
  if (Number(asset.assetId) !== CANONICAL_USDC.assetId) {
    errors.push(`${path}.assetId must be ${CANONICAL_USDC.assetId}`);
  }
  if (String(asset.address ?? "").toLowerCase() !== CANONICAL_USDC.address) {
    errors.push(`${path}.address must be ${CANONICAL_USDC.address}`);
  }
  if (Number(asset.decimals) !== CANONICAL_USDC.decimals) {
    errors.push(`${path}.decimals must be ${CANONICAL_USDC.decimals}`);
  }
  if (String(asset.minBalanceRaw ?? "") !== CANONICAL_USDC.minBalanceRaw) {
    errors.push(`${path}.minBalanceRaw must be ${CANONICAL_USDC.minBalanceRaw}`);
  }
  if (asset.erc20MetadataFunctionsImplemented !== false) {
    errors.push(`${path}.erc20MetadataFunctionsImplemented must be false`);
  }
}

function validateAuth(rawAuth, errors) {
  const auth = assertObject(rawAuth, "auth", errors);
  const allowedTokenKinds = new Set(["service_token", "delegated_wallet", "refresh_flow"]);
  if (!allowedTokenKinds.has(auth.tokenKind)) {
    errors.push("auth.tokenKind must be service_token, delegated_wallet, or refresh_flow");
  }
  const ttlSeconds = Number(auth.accessTokenTtlSeconds);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) {
    errors.push("auth.accessTokenTtlSeconds must be an integer between 1 and 3600");
  }
  if (auth.longLivedAdminJwtUsed !== false) {
    errors.push("auth.longLivedAdminJwtUsed must be false");
  }
}

function validateProofReferences(rawReferences, errors) {
  const references = assertObject(rawReferences, "proofReferences", errors);
  requireString(references.mainnetAssetConfig, "proofReferences.mainnetAssetConfig", errors);
  requireString(references.mainnetEnvSecrets, "proofReferences.mainnetEnvSecrets", errors);
}

function validateGuardrails(rawGuardrails, errors) {
  const guardrails = assertObject(rawGuardrails, "guardrails", errors);
  if (guardrails.testnetEvidenceMixedIn !== false) {
    errors.push("guardrails.testnetEvidenceMixedIn must be false");
  }
  if (guardrails.mainnetContractsMatchEnvProof !== true) {
    errors.push("guardrails.mainnetContractsMatchEnvProof must be true");
  }
  if (guardrails.serviceOperatorApproved !== true) {
    errors.push("guardrails.serviceOperatorApproved must be true");
  }
  if (guardrails.directWikipediaEditClaimed !== false) {
    errors.push("guardrails.directWikipediaEditClaimed must be false");
  }
}

function requireTimeline(rawTimeline, path, expectedCorrelationId, errors) {
  const timeline = assertObject(rawTimeline, path, errors);
  const correlationId = requireString(timeline.correlationId, `${path}.correlationId`, errors);
  if (correlationId && correlationId !== expectedCorrelationId) {
    errors.push(`${path}.correlationId must match ${expectedCorrelationId}`);
  }
  if (timeline.containsClaim !== true) {
    errors.push(`${path}.containsClaim must be true`);
  }
  if (timeline.containsSubmit !== true) {
    errors.push(`${path}.containsSubmit must be true`);
  }
  if (timeline.containsSettlement !== true) {
    errors.push(`${path}.containsSettlement must be true`);
  }
}

function validateClaim(rawClaim, path, run, errors) {
  const claim = assertObject(rawClaim, path, errors);
  if (claim.status !== "claimed") {
    errors.push(`${path}.status must be claimed`);
  }
  if (claim.sessionId !== undefined && claim.sessionId !== run.sessionId) {
    errors.push(`${path}.sessionId must match ${run.sessionId}`);
  }
  requireHash(claim.txHash, `${path}.txHash`, errors);
  requireExplorerUrl(claim.explorerUrl, `${path}.explorerUrl`, errors);
  requirePositiveInteger(claim.blockNumber, `${path}.blockNumber`, errors);
  requireIsoTimestamp(claim.claimExpiresAt, `${path}.claimExpiresAt`, errors);
}

function validateSubmit(rawSubmit, path, run, errors) {
  const submit = assertObject(rawSubmit, path, errors);
  if (submit.status !== "submitted") {
    errors.push(`${path}.status must be submitted`);
  }
  requireIsoTimestamp(submit.submittedAt, `${path}.submittedAt`, errors);
  if (submit.sessionId !== undefined && submit.sessionId !== run.sessionId) {
    errors.push(`${path}.sessionId must match ${run.sessionId}`);
  }
}

function validateVerification(rawVerification, path, errors) {
  const verification = assertObject(rawVerification, path, errors);
  if (verification.outcome !== "approved") {
    errors.push(`${path}.outcome must be approved`);
  }
  if (verification.storedSubmissionUsed !== true) {
    errors.push(`${path}.storedSubmissionUsed must be true`);
  }
  requireString(verification.reasonCode, `${path}.reasonCode`, errors);
}

function validateSettlement(rawSettlement, path, rewardRaw, options, errors) {
  const settlement = assertObject(rawSettlement, path, errors);
  if (!["resolved", "settled"].includes(settlement.status)) {
    errors.push(`${path}.status must be resolved or settled`);
  }
  if (settlement.chainStatus !== "confirmed") {
    errors.push(`${path}.chainStatus must be confirmed`);
  }
  requireHash(settlement.txHash, `${path}.txHash`, errors);
  requireExplorerUrl(settlement.explorerUrl, `${path}.explorerUrl`, errors);
  requirePositiveInteger(settlement.blockNumber, `${path}.blockNumber`, errors);
  if (settlement.asset !== undefined) {
    validateAsset(settlement.asset, errors, `${path}.asset`);
  }
  const payoutRaw = parseRawAmount(settlement.payoutRaw, `${path}.payoutRaw`, errors);
  if (payoutRaw !== undefined) {
    if (payoutRaw <= 0n) {
      errors.push(`${path}.payoutRaw must be > 0`);
    }
    if (rewardRaw !== undefined && payoutRaw > rewardRaw) {
      errors.push(`${path}.payoutRaw must be <= runs rewardRaw`);
    }
    if (payoutRaw > options.maxRewardRaw) {
      errors.push(`${path}.payoutRaw must be <= maxRewardRaw ${options.maxRewardRaw.toString()}`);
    }
  }
}

function requirePositiveInteger(value, path, errors) {
  if (!Number.isInteger(value) || value < 1) {
    errors.push(`${path} must be a positive integer`);
  }
}

function validateRuns(rawRuns, options, errors) {
  const runs = requireArray(rawRuns, "runs", errors);
  if (runs.length < options.minRuns) {
    errors.push(`runs must include at least ${options.minRuns} completed smoke run(s)`);
  }

  const seenRunIds = new Set();
  const seenJobIds = new Set();
  const seenSessionIds = new Set();
  let totalRewardRaw = 0n;
  let maxSingleRewardRaw = 0n;

  runs.forEach((rawRun, index) => {
    const path = `runs[${index}]`;
    const run = assertObject(rawRun, path, errors);
    const runId = requireString(run.runId, `${path}.runId`, errors);
    const jobId = requireString(run.jobId, `${path}.jobId`, errors);
    const sessionId = requireString(run.sessionId, `${path}.sessionId`, errors);
    requireAddress(run.workerWallet, `${path}.workerWallet`, errors);
    checkUnique(seenRunIds, runId, `${path}.runId`, errors);
    checkUnique(seenJobIds, jobId, `${path}.jobId`, errors);
    checkUnique(seenSessionIds, sessionId, `${path}.sessionId`, errors);

    const rewardRaw = parseRawAmount(run.rewardRaw, `${path}.rewardRaw`, errors);
    if (rewardRaw !== undefined) {
      const minBalanceRaw = BigInt(CANONICAL_USDC.minBalanceRaw);
      totalRewardRaw += rewardRaw;
      if (rewardRaw > maxSingleRewardRaw) maxSingleRewardRaw = rewardRaw;
      if (rewardRaw < minBalanceRaw) {
        errors.push(`${path}.rewardRaw must be >= ${CANONICAL_USDC.minBalanceRaw} (${CANONICAL_USDC.symbol} minBalanceRaw)`);
      }
      if (rewardRaw > options.maxRewardRaw) {
        errors.push(`${path}.rewardRaw must be <= maxRewardRaw ${options.maxRewardRaw.toString()}`);
      }
    }

    validateClaim(run.claim, `${path}.claim`, { sessionId }, errors);
    validateSubmit(run.submit, `${path}.submit`, { sessionId }, errors);
    validateVerification(run.verification, `${path}.verification`, errors);
    validateSettlement(run.settlement, `${path}.settlement`, rewardRaw, options, errors);
    requireTimeline(run.timeline, `${path}.timeline`, sessionId, errors);
    if (!["resolved", "settled"].includes(run.finalSessionStatus)) {
      errors.push(`${path}.finalSessionStatus must be resolved or settled`);
    }
    if (requireBoolean(run.badgeVerified, `${path}.badgeVerified`, errors) !== true) {
      errors.push(`${path}.badgeVerified must be true`);
    }
    if (requireBoolean(run.profileVerified, `${path}.profileVerified`, errors) !== true) {
      errors.push(`${path}.profileVerified must be true`);
    }
  });

  return {
    runCount: runs.length,
    totalRewardRaw,
    maxSingleRewardRaw
  };
}

function checkUnique(seen, value, path, errors) {
  if (!value) return;
  if (seen.has(value)) {
    errors.push(`${path} must be unique`);
  }
  seen.add(value);
}

function makeOptions(options = {}) {
  return {
    now: options.now,
    maxCompletedAgeHours: options.maxCompletedAgeHours,
    minRuns: options.minRuns ?? DEFAULT_MIN_RUNS,
    maxRewardRaw: typeof options.maxRewardRaw === "bigint"
      ? options.maxRewardRaw
      : parsePositiveBigInt(options.maxRewardRaw ?? DEFAULT_MAX_REWARD_RAW.toString(), "maxRewardRaw")
  };
}

export function validateEvidence(evidence, options = {}) {
  const normalizedOptions = makeOptions(options);
  const errors = [];
  const warnings = [];

  const root = assertObject(evidence, "evidence", errors);
  if (root.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const completedAt = requireIsoTimestamp(root.completedAt, "completedAt", errors);
  validateFreshness(completedAt, "completedAt", normalizedOptions, errors);
  if (normalizedOptions.maxCompletedAgeHours === undefined) {
    warnings.push("completedAt freshness was not enforced; pass --max-completed-age-hours for launch proof validation");
  }

  scanForSecretLikeValues(root, "evidence", errors);
  validatePolkadotDocs(root.polkadotDocs, errors);
  const environment = validateEnvironment(root.environment, errors);
  validateContracts(root.contracts, errors);
  validateAsset(root.asset, errors);
  validateAuth(root.auth, errors);
  validateProofReferences(root.proofReferences, errors);
  validateGuardrails(root.guardrails, errors);
  const runSummary = validateRuns(root.runs, normalizedOptions, errors);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      schemaVersion: root.schemaVersion,
      completedAt: root.completedAt,
      environment,
      asset: CANONICAL_USDC,
      minRuns: normalizedOptions.minRuns,
      maxRewardRaw: normalizedOptions.maxRewardRaw.toString(),
      runCount: runSummary.runCount,
      totalRewardRaw: runSummary.totalRewardRaw.toString(),
      maxSingleRewardRaw: runSummary.maxSingleRewardRaw.toString()
    }
  };
}

export async function run(args) {
  if (!args.file) {
    throw new Error("missing required --file <path>");
  }
  const text = await readFile(args.file, "utf8");
  const evidence = JSON.parse(text);
  return validateEvidence(evidence, args);
}

function printHuman(result, file) {
  console.log("Mainnet smoke proof check");
  console.log(`file: ${file}`);
  console.log(`schema: ${result.summary.schemaVersion}`);
  console.log(`completedAt: ${result.summary.completedAt}`);
  console.log(`environment: ${result.summary.environment?.apiBaseUrl ?? "unknown"}`);
  console.log(`asset: ${result.summary.asset.symbol} assetId=${result.summary.asset.assetId} address=${result.summary.asset.address} decimals=${result.summary.asset.decimals}`);
  console.log(`runs: ${result.summary.runCount}/${result.summary.minRuns}`);
  console.log(`totalRewardRaw: ${result.summary.totalRewardRaw}`);
  console.log(`maxSingleRewardRaw: ${result.summary.maxSingleRewardRaw}/${result.summary.maxRewardRaw}`);
  if (result.warnings.length) {
    console.log("");
    console.log("warnings:");
    for (const warning of result.warnings) console.log(`  - ${warning}`);
  }
  if (!result.ok) {
    console.log("");
    console.log("errors:");
    for (const error of result.errors) console.log(`  - ${error}`);
  } else {
    console.log("");
    console.log("ok: mainnet smoke proof evidence is valid");
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(2);
  }

  if (args.help) {
    console.log(usage());
    return;
  }

  try {
    const result = await run(args);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHuman(result, args.file);
    }
    if (!result.ok) process.exit(1);
  } catch (error) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    } else {
      console.error(error.message);
    }
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
