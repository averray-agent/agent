#!/usr/bin/env node

/**
 * Guarded DepositPool venue ceremony driver (Packet 6).
 *
 * Read-only is the default. The only write mode is the production KMS signer:
 *   --commit --use-kms --expected-signer 0x...
 *
 * The script owns the pool-level calls only. The existing v2.2 dispatcher and
 * observer own the asynchronous lane between request creation and settlement.
 * It deliberately never accepts a private key.
 */

import {
  Contract,
  Interface,
  ZeroAddress,
  getAddress,
} from "ethers";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCeremonyRpcContext } from "./ceremony-rpc.mjs";
import { importCeremonyModule } from "./ceremony-module-loader.mjs";

const { KmsSigner } = await importCeremonyModule({
  label: "KMS signer",
  candidates: [
    new URL("../../mcp-server/src/blockchain/kms-signer.js", import.meta.url),
    "file:///app/src/blockchain/kms-signer.js"
  ]
});
const {
  buildKmsCredentialsProvider,
  PROFILE_BLOCKCHAIN_SIGNER
} = await importCeremonyModule({
  label: "Roles Anywhere credentials provider",
  candidates: [
    new URL("../../mcp-server/src/services/aws-credentials.js", import.meta.url),
    "file:///app/src/services/aws-credentials.js"
  ]
});

const here = dirname(fileURLToPath(import.meta.url));

export const PROOF_RETURN_WINDOW_SECONDS = 48 * 60 * 60;
// Packet 6 originally said 14 days; Codex's gate finding (recorded in the
// packet 2026-08-12) corrected it to the contract's own ceiling — a deadline
// may never exceed the shortest redemption notice tier (NOTICE_7_DAYS), so
// capital is always recallable before any depositor's exit matures. The
// refusal guard below stays: if the contract ever tightens further, refuse
// rather than silently changing policy.
export const STANDING_RETURN_WINDOW_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_FINALITY_CONFIRMATIONS = 12;
export const MIN_FINALITY_CONFIRMATIONS = 8;
export const FINALITY_TIMEOUT_MS = 10 * 60 * 1_000;
export const FINALITY_POLL_INTERVAL_MS = 6_000;
const OBSERVABILITY_MAX_AGE_SECONDS = 10 * 60;
const ASSET_DECIMALS = 6n;
const ASSET_SCALE = 10n ** ASSET_DECIMALS;

const POOL_ABI = [
  "function asset() view returns (address)",
  "function operator() view returns (address)",
  "function venueAdapter() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function bufferAssets() view returns (uint256)",
  "function bufferFloor() view returns (uint256)",
  "function venuePrincipalCostBasis() view returns (uint256)",
  "function TOTAL_ASSET_CAP() view returns (uint256)",
  "function PER_AGENT_ASSET_CAP() view returns (uint256)",
  "function NOTICE_7_DAYS() view returns (uint256)",
  "function nextRedeemRequestId() view returns (uint256)",
  "function nextVenueDeploymentId() view returns (uint256)",
  "function nextVenueRecallId() view returns (uint256)",
  "function activeVenueDeploymentId() view returns (uint256)",
  "function activeVenueRecallId() view returns (uint256)",
  "function redeemRequests(uint256) view returns (address owner,address receiver,uint256 shares,uint64 unlockAt,uint8 tier,bool fulfilled)",
  "function venueDeployments(uint256) view returns (uint256 principalAssets,uint256 recalledPrincipalAssets,uint64 returnBy,bytes32 adapterRequestId,uint8 status)",
  "function venueRecalls(uint256) view returns (uint256 deploymentId,uint256 requestedAssets,uint256 returnedAssets,bytes32 adapterRequestId,uint8 status)",
  "function deployToVenue(uint256 assets,uint64 returnBy) returns (uint256 deploymentId)",
  "function settleVenueDeployment(uint256 deploymentId) returns (uint8 status,uint256 settledAssets)",
  "function recallVenueDeployment(uint256 deploymentId,uint256 requestedAssets) returns (uint256 recallId)",
  "function settleVenueRecall(uint256 recallId) returns (uint8 status,uint256 returnedAssets)",
  "event VenueDeploymentCreated(uint256 indexed deploymentId,bytes32 indexed adapterRequestId,uint256 assets,uint64 returnBy)",
  "event VenueDeploymentSettled(uint256 indexed deploymentId,uint8 status,uint256 settledAssets)",
  "event VenueRecallRequested(uint256 indexed recallId,uint256 indexed deploymentId,bytes32 indexed adapterRequestId,uint256 requestedAssets)",
  "event VenueRecallSettled(uint256 indexed recallId,uint256 indexed deploymentId,uint8 status,uint256 returnedAssets)",
  "event VenuePrincipalReturned(uint256 indexed deploymentId,uint256 returnedAssets,uint256 principalReduction)",
];

const poolInterface = new Interface(POOL_ABI);

export function parseArgs(argv) {
  const args = {
    command: argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined,
    profile: undefined,
    pool: undefined,
    assets: undefined,
    returnBy: undefined,
    deploymentKind: "proof",
    deploymentId: undefined,
    recallId: undefined,
    expectedSigner: undefined,
    observabilityUrl: undefined,
    confirmations: DEFAULT_FINALITY_CONFIRMATIONS,
    useKms: false,
    commit: false,
    help: false,
  };
  const start = args.command ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      return value;
    };
    if (arg === "--profile") args.profile = next();
    else if (arg === "--pool") args.pool = next();
    else if (arg === "--assets") args.assets = next();
    else if (arg === "--return-by") args.returnBy = next();
    else if (arg === "--deployment-kind") args.deploymentKind = next();
    else if (arg === "--deployment-id") args.deploymentId = next();
    else if (arg === "--recall-id") args.recallId = next();
    else if (arg === "--expected-signer") args.expectedSigner = next();
    else if (arg === "--observability-url") args.observabilityUrl = next();
    else if (arg === "--confirmations") args.confirmations = finalityConfirmations(next());
    else if (arg === "--use-kms") args.useKms = true;
    else if (arg === "--commit") args.commit = true;
    else if (arg === "--dry-run") args.commit = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function finalityConfirmations(value) {
  if (!/^[0-9]+$/u.test(String(value ?? ""))) {
    throw new Error("--confirmations must be an unsigned integer.");
  }
  const confirmations = Number(value);
  if (!Number.isSafeInteger(confirmations) || confirmations < MIN_FINALITY_CONFIRMATIONS) {
    throw new Error(`--confirmations must be at least ${MIN_FINALITY_CONFIRMATIONS}.`);
  }
  return confirmations;
}

export function resolvePoolTarget({ requestedPool, manifestPool, log = console.log }) {
  let poolAddress;
  try {
    poolAddress = getAddress(requestedPool ?? manifestPool);
  } catch {
    throw new Error(`${requestedPool === undefined ? "Manifest depositPool" : "--pool"} must be a 20-byte EVM address.`);
  }
  const source = requestedPool === undefined ? "manifest contracts.depositPool" : "explicit --pool";
  log(`POOL TARGET: ${poolAddress} (${source})`);
  return { poolAddress, source };
}

export function assertVenueAdapterBound(venueAdapter, poolAddress) {
  let resolvedAdapter;
  try {
    resolvedAdapter = getAddress(venueAdapter);
  } catch {
    throw new Error(`venue_adapter_unreadable: pool ${poolAddress} returned an invalid venueAdapter address.`);
  }
  if (resolvedAdapter === ZeroAddress) {
    const error = new Error(`venue_adapter_not_bound: pool ${getAddress(poolAddress)} has venueAdapter() == address(0); refusing before building a ceremony plan.`);
    error.code = "venue_adapter_not_bound";
    throw error;
  }
  return resolvedAdapter;
}

export function resolvePoolVenuePair(manifest, poolAddress) {
  const target = getAddress(poolAddress);
  const contracts = manifest.contracts ?? {};
  // depositPool and depositPoolV2 are movable current-pool aliases. Only
  // generation-specific pool identities can select a generation's venue pair.
  const entries = [
    ["legacyDepositPoolV2", "hydrationDepositPoolAdapterV2", "depositPoolLaneV2"],
    ["depositPoolV21", "hydrationDepositPoolAdapterV21", "depositPoolLaneV21"],
  ].filter(([poolKey]) => String(contracts[poolKey] ?? "").toLowerCase() === target.toLowerCase());
  if (entries.length !== 1) {
    throw new Error(`Pool ${target} has ${entries.length === 0 ? "no" : "ambiguous"} manifest venue pair; refusing without an explicit pool-specific entry.`);
  }
  const [, adapterKey, laneKey] = entries[0];
  const address = (key) => {
    try {
      const value = getAddress(contracts[key]);
      if (value !== ZeroAddress) return value;
    } catch { /* Name the targeted pool and missing/invalid key below. */ }
    throw new Error(`Pool ${target} has no valid manifest contracts.${key}; refusing to use another pool's venue pair.`);
  };
  const adapterAddress = address(adapterKey);
  const laneAddress = address(laneKey);
  const adapterDeploymentBlock = manifest.deploymentBlocks?.[adapterKey];
  if (!Number.isSafeInteger(adapterDeploymentBlock) || adapterDeploymentBlock < 0) {
    throw new Error(`Pool ${target} has no valid manifest deploymentBlocks.${adapterKey}.`);
  }
  return { adapterAddress, laneAddress, adapterDeploymentBlock };
}

export function assertPoolVenueAdapter({ poolAddress, venueAdapter, expectedAdapter }) {
  const liveAdapter = assertVenueAdapterBound(venueAdapter, poolAddress);
  if (liveAdapter !== getAddress(expectedAdapter)) {
    throw new Error(`Pool ${getAddress(poolAddress)} venueAdapter ${liveAdapter} != manifest ${expectedAdapter}.`);
  }
  return liveAdapter;
}

export function buildPoolObservabilityUrl(url, poolAddress) {
  let resolved;
  try {
    resolved = new URL(url);
  } catch {
    throw new Error("--observability-url must be an absolute URL.");
  }
  resolved.searchParams.set("pool", getAddress(poolAddress));
  return resolved.toString();
}

export function deploymentManifestPaths(profile, moduleUrl = import.meta.url) {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  return [
    resolve(moduleDirectory, "..", "..", "deployments", `${profile}.json`),
    resolve("/deployments", `${profile}.json`),
  ];
}

export async function readDeploymentManifest(profile, {
  paths = deploymentManifestPaths(profile),
  readFileImpl = readFile,
} = {}) {
  const attempted = [];
  for (const path of paths) {
    attempted.push(path);
    try {
      return JSON.parse(await readFileImpl(path, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  const error = new Error(
    `ceremony_manifest_resolution_failed: deployments/${profile}.json was not found. `
    + `Attempted paths: ${attempted.join(", ")}.`,
  );
  error.code = "ceremony_manifest_resolution_failed";
  throw error;
}

export function assertExpectedSigner(resolvedSigner, expectedSigner) {
  let resolved;
  let expected;
  try {
    resolved = getAddress(resolvedSigner);
    expected = getAddress(expectedSigner);
  } catch {
    throw new Error("--expected-signer and the resolved signer must both be 20-byte EVM addresses.");
  }
  if (resolved !== expected) {
    throw new Error(
      `Resolved signer ${resolved} does not match --expected-signer ${expected}; refusing before chain reads or writes.`,
    );
  }
  return resolved;
}

export function assertObservability(snapshot, { poolAddress, chainTimestamp }) {
  if (!snapshot || snapshot.available !== true) {
    throw new Error(`Deposit-pool observability is unavailable (${snapshot?.reason ?? "no snapshot"}).`);
  }
  if (getAddress(snapshot.pool) !== getAddress(poolAddress)) {
    throw new Error(`Observability describes a different pool generation (${snapshot.pool}).`);
  }
  if (snapshot.reconciled !== true) throw new Error("Deposit-pool observability is not reconciled.");
  if (snapshot.flows?.status !== "ok") throw new Error("Deposit-pool observability event flow is unavailable.");
  const observedAt = BigInt(snapshot.block?.timestamp ?? 0);
  const age = BigInt(chainTimestamp) - observedAt;
  if (observedAt <= 0n || age < 0n || age > BigInt(OBSERVABILITY_MAX_AGE_SECONDS)) {
    throw new Error(`Deposit-pool observability is stale or future-dated (age ${age.toString()} seconds).`);
  }
}

export function assertDeployAdmission(input) {
  const {
    assets,
    totalAssets,
    bufferAssets,
    venuePrincipalCostBasis,
    totalAssetCap,
    pendingRedemptionIds,
    blockTimestamp,
    returnBy,
    contractMaxReturnSeconds,
    deploymentKind,
  } = input;
  if (totalAssets === 0n) throw new Error("Deposit pool is empty; refusing a yield ceremony with no assets.");
  if (assets <= 0n) throw new Error("Deployment assets must be positive.");
  if (totalAssets > totalAssetCap) throw new Error("Live totalAssets exceeds the contract cap; refusing.");
  if (assets > bufferAssets) throw new Error("Deployment assets exceed the live pool buffer.");
  if (pendingRedemptionIds.length !== 0) {
    throw new Error(`Pool has pending redemption request(s): ${pendingRedemptionIds.join(", ")}; refusing Leg A.`);
  }
  if ((venuePrincipalCostBasis + assets) * 2n > totalAssets) {
    throw new Error(
      `Deployment would exceed the 50% deployment policy: ${(venuePrincipalCostBasis + assets).toString()} deployed after vs ${totalAssets.toString()} total.`,
    );
  }
  if (returnBy <= blockTimestamp) throw new Error("returnBy must be in the future at the live chain head.");
  const delay = returnBy - blockTimestamp;
  if (deploymentKind === "proof") {
    if (delay > BigInt(PROOF_RETURN_WINDOW_SECONDS)) {
      throw new Error("returnBy exceeds the 48-hour proof policy.");
    }
  } else if (deploymentKind === "standing") {
    if (contractMaxReturnSeconds < STANDING_RETURN_WINDOW_SECONDS) {
      throw new Error(
        `Standing policy requires ${STANDING_RETURN_WINDOW_SECONDS} seconds, but the live contract permits only ${contractMaxReturnSeconds}; refusing rather than silently changing policy.`,
      );
    }
    if (delay > BigInt(STANDING_RETURN_WINDOW_SECONDS)) {
      throw new Error("returnBy exceeds the 7-day standing policy.");
    }
  } else {
    throw new Error(`Unknown --deployment-kind ${deploymentKind}; expected proof or standing.`);
  }
  if (delay > BigInt(contractMaxReturnSeconds)) {
    throw new Error(`returnBy exceeds the live contract maximum of ${contractMaxReturnSeconds} seconds.`);
  }
}

export function assertAccountingPostcondition({
  beforePrincipalCostBasis,
  afterPrincipalCostBasis,
  expectedPrincipalIncrease = 0n,
  emittedPrincipalReduction,
  afterBufferAssets,
  afterTotalAssets,
}) {
  const expectedAfter = beforePrincipalCostBasis + expectedPrincipalIncrease - emittedPrincipalReduction;
  if (afterPrincipalCostBasis !== expectedAfter) {
    throw new Error(
      `Postcondition failed: principal cost-basis delta is not exact; expected ${expectedAfter.toString()} after `
      + `(${beforePrincipalCostBasis.toString()} + ${expectedPrincipalIncrease.toString()} - ${emittedPrincipalReduction.toString()}), `
      + `read ${afterPrincipalCostBasis.toString()}.`,
    );
  }
  if (afterBufferAssets + afterPrincipalCostBasis !== afterTotalAssets) {
    throw new Error(
      `Postcondition failed: buffer + deployed != totalAssets (${afterBufferAssets.toString()} + ${afterPrincipalCostBasis.toString()} != ${afterTotalAssets.toString()}).`,
    );
  }
}

export function assertCeremonyEffectPostcondition({ command, parameters, after, event }) {
  const eventArg = (name) => BigInt(event.args[name]);
  if (command === "deploy") {
    const deploymentId = BigInt(parameters.predictedDeploymentId);
    if (
      eventArg("deploymentId") !== deploymentId
      || eventArg("assets") !== BigInt(parameters.assetsRaw)
      || after.activeVenueDeploymentId !== deploymentId
      || after.nextVenueDeploymentId !== deploymentId + 1n
      || after.venueDeployment?.id !== deploymentId
      || after.venueDeployment?.principalAssets !== BigInt(parameters.assetsRaw)
      || after.venueDeployment?.returnBy !== BigInt(parameters.returnBy)
      || normalizedHash(after.venueDeployment?.adapterRequestId) !== normalizedHash(event.args.adapterRequestId)
      || after.venueDeployment?.status !== 1
    ) {
      throw new Error("Postcondition failed: confirmed deploy receipt and re-read deployment state diverge.");
    }
    return;
  }
  if (command === "recall") {
    const recallId = BigInt(parameters.predictedRecallId);
    if (
      eventArg("recallId") !== recallId
      || eventArg("deploymentId") !== BigInt(parameters.deploymentId)
      || eventArg("requestedAssets") !== BigInt(parameters.assetsRaw)
      || after.activeVenueRecallId !== recallId
      || after.nextVenueRecallId !== recallId + 1n
      || after.venueRecall?.id !== recallId
      || after.venueRecall?.deploymentId !== BigInt(parameters.deploymentId)
      || after.venueRecall?.requestedAssets !== BigInt(parameters.assetsRaw)
      || normalizedHash(after.venueRecall?.adapterRequestId) !== normalizedHash(event.args.adapterRequestId)
      || after.venueRecall?.status !== 1
    ) {
      throw new Error("Postcondition failed: confirmed recall receipt and re-read recall state diverge.");
    }
    return;
  }
  if (parameters.settlementKind === "deployment") {
    const deploymentId = BigInt(parameters.deploymentId);
    if (
      eventArg("deploymentId") !== deploymentId
      || after.venueDeployment?.id !== deploymentId
      || after.venueDeployment?.status !== Number(eventArg("status"))
      || after.venueDeployment.status < 2
    ) {
      throw new Error("Postcondition failed: confirmed deployment-settlement receipt and re-read state diverge.");
    }
    return;
  }
  const recallId = BigInt(parameters.recallId);
  if (
    eventArg("recallId") !== recallId
    || after.venueRecall?.id !== recallId
    || after.venueRecall?.deploymentId !== eventArg("deploymentId")
    || after.venueRecall?.status !== Number(eventArg("status"))
    || after.venueRecall?.returnedAssets !== eventArg("returnedAssets")
    || after.venueRecall.status < 2
    || after.activeVenueRecallId !== 0n
  ) {
    throw new Error("Postcondition failed: confirmed recall-settlement receipt and re-read state diverge.");
  }
}

function usage() {
  return [
    "Usage:",
    "  node scripts/ops/pool-venue-ceremony.mjs deploy --profile mainnet [--pool 0x...] --assets 2000000 --return-by <unix> --deployment-kind proof --observability-url <internal-url> --expected-signer 0x... [--confirmations N] [--use-kms] [--commit]",
    "  node scripts/ops/pool-venue-ceremony.mjs settle --profile mainnet [--pool 0x...] (--deployment-id <id> | --recall-id <id>) --expected-signer 0x... [--confirmations N] [--use-kms] [--commit]",
    "  node scripts/ops/pool-venue-ceremony.mjs recall --profile mainnet [--pool 0x...] --deployment-id <id> --assets 500000 --expected-signer 0x... [--confirmations N] [--use-kms] [--commit]",
    "",
    "Dry-run is the default. --commit requires --use-kms, KMS_KEY_ID, and AWS_REGION.",
    `Committed evidence waits for at least ${MIN_FINALITY_CONFIRMATIONS} confirmations (default ${DEFAULT_FINALITY_CONFIRMATIONS}).`,
    "--pool is required when targeting any pool other than manifest contracts.depositPool.",
    "No private-key signer path exists. --expected-signer is mandatory in every mode.",
  ].join("\n");
}

function normalizedHash(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function finalityDivergence(message) {
  const error = new Error(`REORG WARNING — COMMITTED EVIDENCE WITHHELD: ${message}`);
  error.code = "ceremony_finality_diverged";
  return error;
}

async function rereadCanonicalReceipt(provider, transactionHash, initialReceipt) {
  const receipt = await provider.getTransactionReceipt(transactionHash);
  if (!receipt) {
    throw finalityDivergence(
      `transaction ${transactionHash} was initially included at block ${initialReceipt.blockNumber} `
      + `with hash ${initialReceipt.blockHash}, but its receipt is now absent.`,
    );
  }
  if (receipt.status !== 1) {
    throw finalityDivergence(
      `transaction ${transactionHash} was initially successful, but its re-read status is ${receipt.status}.`,
    );
  }
  if (
    receipt.blockNumber !== initialReceipt.blockNumber
    || normalizedHash(receipt.blockHash) !== normalizedHash(initialReceipt.blockHash)
  ) {
    throw finalityDivergence(
      `transaction ${transactionHash} moved from block ${initialReceipt.blockNumber} hash ${initialReceipt.blockHash} `
      + `to block ${receipt.blockNumber} hash ${receipt.blockHash}.`,
    );
  }
  const block = await provider.getBlock(initialReceipt.blockNumber);
  const rereadBlockHash = block?.hash ?? "missing";
  if (normalizedHash(rereadBlockHash) !== normalizedHash(initialReceipt.blockHash)) {
    throw finalityDivergence(
      `block ${initialReceipt.blockNumber} changed from receipt hash ${initialReceipt.blockHash} `
      + `to canonical re-read hash ${rereadBlockHash}.`,
    );
  }
  return { receipt, block };
}

/**
 * Treat the first successful receipt as a reference, not evidence. The receipt
 * and its canonical block must remain byte-identical through the requested
 * depth and on both sides of the post-state read.
 */
export async function confirmCanonicalPostState({
  provider,
  transactionHash,
  initialReceipt,
  readPostState,
  confirmations = DEFAULT_FINALITY_CONFIRMATIONS,
  timeoutMs = FINALITY_TIMEOUT_MS,
  pollIntervalMs = FINALITY_POLL_INTERVAL_MS,
  log = console.error,
  now = Date.now,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
}) {
  const requiredConfirmations = finalityConfirmations(confirmations);
  if (!initialReceipt || initialReceipt.status !== 1) {
    throw new Error(`Transaction ${transactionHash} did not produce a successful reference receipt.`);
  }
  if (typeof readPostState !== "function") throw new Error("Finality verification requires a post-state reader.");
  const startedAt = now();
  log(
    `FINALITY WAIT: transaction ${transactionHash} is in block ${initialReceipt.blockNumber}; `
    + `waiting for ${requiredConfirmations} confirmations before evidence.`,
  );

  while (true) {
    if (now() - startedAt >= timeoutMs) {
      const error = new Error(
        `FINALITY TIMEOUT — COMMITTED EVIDENCE WITHHELD: transaction ${transactionHash} `
        + `did not reach ${requiredConfirmations} canonical confirmations within ${timeoutMs}ms.`,
      );
      error.code = "ceremony_finality_timeout";
      throw error;
    }
    const canonical = await rereadCanonicalReceipt(provider, transactionHash, initialReceipt);
    const head = await provider.getBlockNumber();
    const observedConfirmations = Math.max(0, head - initialReceipt.blockNumber + 1);
    log(`FINALITY WAIT: ${Math.min(observedConfirmations, requiredConfirmations)}/${requiredConfirmations} confirmations.`);

    if (observedConfirmations >= requiredConfirmations) {
      log("FINALITY WAIT: target reached; re-reading post-state and canonical receipt.");
      const postState = await readPostState(canonical.receipt.blockNumber);
      const verified = await rereadCanonicalReceipt(provider, transactionHash, initialReceipt);
      const rereadHead = await provider.getBlockNumber();
      const confirmationsWaited = Math.max(0, rereadHead - verified.receipt.blockNumber + 1);
      if (confirmationsWaited >= requiredConfirmations) {
        return {
          receipt: verified.receipt,
          block: verified.block,
          postState,
          confirmationsRequired: requiredConfirmations,
          confirmationsWaited,
          rereadBlockHash: verified.block.hash,
          receiptReconfirmed: true,
          postStateReconfirmed: true,
        };
      }
    }

    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) continue;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

export function buildFinalityEvidence(initialReceipt, finality) {
  return {
    transaction: {
      confirmationsWaited: finality.confirmationsWaited,
      rereadBlockHash: finality.rereadBlockHash,
    },
    finality: {
      confirmationsRequired: finality.confirmationsRequired,
      confirmationsWaited: finality.confirmationsWaited,
      initialReceiptBlockHash: initialReceipt.blockHash,
      rereadReceiptBlockHash: finality.receipt.blockHash,
      rereadBlockHash: finality.rereadBlockHash,
      receiptReconfirmed: finality.receiptReconfirmed,
      postStateReconfirmed: finality.postStateReconfirmed,
    },
  };
}

function positiveBigInt(value, flag) {
  if (!/^[0-9]+$/u.test(String(value ?? ""))) throw new Error(`${flag} must be an unsigned integer.`);
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`${flag} must be positive.`);
  return parsed;
}

export async function resolveSigner(args, provider, {
  env = process.env,
  KmsSignerClass = KmsSigner,
  credentialsProviderBuilder = buildKmsCredentialsProvider,
} = {}) {
  if (!args.expectedSigner) throw new Error("--expected-signer is mandatory; the ceremony never guesses its operator.");
  if (args.commit && !args.useKms) throw new Error("--commit requires --use-kms; raw private keys are not accepted.");
  if (!args.useKms) {
    const address = assertExpectedSigner(args.expectedSigner, args.expectedSigner);
    return { address, signer: null, backend: "expected-signer (dry-run only)" };
  }
  const keyId = String(env.KMS_KEY_ID ?? "").trim();
  const region = String(env.AWS_REGION ?? "").trim();
  if (!keyId) throw new Error("--use-kms requires KMS_KEY_ID.");
  if (!region) throw new Error("--use-kms requires AWS_REGION.");
  const credentialsProvider = credentialsProviderBuilder({
    profile: PROFILE_BLOCKCHAIN_SIGNER,
    env,
  });
  const signer = new KmsSignerClass({ keyId, region, provider, credentialsProvider });
  const address = assertExpectedSigner(await signer.getAddress(), args.expectedSigner);
  return { address, signer, backend: "aws-kms" };
}

async function fetchObservability(url) {
  if (!url) throw new Error("deploy requires --observability-url; an unobserved yield ceremony is refused.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    throw new Error(`Could not read deposit-pool observability at ${url}: ${error?.message ?? error}`);
  } finally {
    clearTimeout(timeout);
  }
}

function ceremonyStateFocus(command, parameters) {
  if (command === "deploy") return { deploymentId: parameters.predictedDeploymentId };
  if (command === "recall") {
    return { deploymentId: parameters.deploymentId, recallId: parameters.predictedRecallId };
  }
  return parameters.settlementKind === "deployment"
    ? { deploymentId: parameters.deploymentId }
    : { recallId: parameters.recallId };
}

async function readPoolState(pool, blockTag, focus = {}) {
  const overrides = { blockTag };
  const [
    asset,
    operator,
    venueAdapter,
    totalAssets,
    totalSupply,
    bufferAssets,
    bufferFloor,
    venuePrincipalCostBasis,
    totalAssetCap,
    perAgentAssetCap,
    notice7Days,
    nextRedeemRequestId,
    nextVenueDeploymentId,
    nextVenueRecallId,
    activeVenueDeploymentId,
    activeVenueRecallId,
  ] = await Promise.all([
    pool.asset(overrides),
    pool.operator(overrides),
    pool.venueAdapter(overrides),
    pool.totalAssets(overrides),
    pool.totalSupply(overrides),
    pool.bufferAssets(overrides),
    pool.bufferFloor(overrides),
    pool.venuePrincipalCostBasis(overrides),
    pool.TOTAL_ASSET_CAP(overrides),
    pool.PER_AGENT_ASSET_CAP(overrides),
    pool.NOTICE_7_DAYS(overrides),
    pool.nextRedeemRequestId(overrides),
    pool.nextVenueDeploymentId(overrides),
    pool.nextVenueRecallId(overrides),
    pool.activeVenueDeploymentId(overrides),
    pool.activeVenueRecallId(overrides),
  ]);
  const requests = [];
  for (let id = 1n; id < BigInt(nextRedeemRequestId); id += 1n) requests.push(pool.redeemRequests(id, overrides));
  const redemptionRows = await Promise.all(requests);
  const pendingRedemptionIds = redemptionRows
    .map((row, index) => ({ id: BigInt(index + 1), owner: row.owner, shares: BigInt(row.shares), fulfilled: row.fulfilled }))
    .filter((row) => row.owner !== "0x0000000000000000000000000000000000000000" && !row.fulfilled && row.shares > 0n)
    .map((row) => row.id);
  let venueDeployment;
  if (focus.deploymentId !== undefined) {
    const id = BigInt(focus.deploymentId);
    const row = await pool.venueDeployments(id, overrides);
    venueDeployment = {
      id,
      principalAssets: BigInt(row.principalAssets),
      recalledPrincipalAssets: BigInt(row.recalledPrincipalAssets),
      returnBy: BigInt(row.returnBy),
      adapterRequestId: row.adapterRequestId,
      status: Number(row.status),
    };
  }
  let venueRecall;
  if (focus.recallId !== undefined) {
    const id = BigInt(focus.recallId);
    const row = await pool.venueRecalls(id, overrides);
    venueRecall = {
      id,
      deploymentId: BigInt(row.deploymentId),
      requestedAssets: BigInt(row.requestedAssets),
      returnedAssets: BigInt(row.returnedAssets),
      adapterRequestId: row.adapterRequestId,
      status: Number(row.status),
    };
  }
  return {
    asset: getAddress(asset),
    operator: getAddress(operator),
    venueAdapter: getAddress(venueAdapter),
    totalAssets: BigInt(totalAssets),
    totalSupply: BigInt(totalSupply),
    bufferAssets: BigInt(bufferAssets),
    bufferFloor: BigInt(bufferFloor),
    venuePrincipalCostBasis: BigInt(venuePrincipalCostBasis),
    totalAssetCap: BigInt(totalAssetCap),
    perAgentAssetCap: BigInt(perAgentAssetCap),
    notice7Days: Number(notice7Days),
    nextRedeemRequestId: BigInt(nextRedeemRequestId),
    nextVenueDeploymentId: BigInt(nextVenueDeploymentId),
    nextVenueRecallId: BigInt(nextVenueRecallId),
    activeVenueDeploymentId: BigInt(activeVenueDeploymentId),
    activeVenueRecallId: BigInt(activeVenueRecallId),
    pendingRedemptionIds,
    ...(venueDeployment ? { venueDeployment } : {}),
    ...(venueRecall ? { venueRecall } : {}),
  };
}

function serialize(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function amount(raw) {
  const whole = raw / ASSET_SCALE;
  const fraction = (raw % ASSET_SCALE).toString().padStart(Number(ASSET_DECIMALS), "0");
  return `${whole}.${fraction}`;
}

function parseReceiptEvents(receipt) {
  const events = [];
  for (const log of receipt.logs ?? []) {
    try {
      const event = poolInterface.parseLog(log);
      if (event) events.push(event);
    } catch {
      // Other contracts' logs are part of the transaction but not pool evidence.
    }
  }
  return events;
}

function eventByName(events, name) {
  const matches = events.filter((event) => event.name === name);
  if (matches.length !== 1) throw new Error(`Postcondition failed: expected exactly one ${name} event; found ${matches.length}.`);
  return matches[0];
}

function principalReduction(events) {
  return events
    .filter((event) => event.name === "VenuePrincipalReturned")
    .reduce((sum, event) => sum + BigInt(event.args.principalReduction), 0n);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!["deploy", "settle", "recall"].includes(args.command)) throw new Error(`${usage()}\n\nA subcommand is required.`);
  if (!args.profile) throw new Error("--profile is mandatory; a money-moving script never guesses its chain.");
  if (args.profile !== "mainnet") throw new Error("Packet 6 is a mainnet ceremony; only --profile mainnet is accepted.");
  if (args.commit && !args.useKms) throw new Error("--commit requires --use-kms; raw private keys are not accepted.");
  const deployments = await readDeploymentManifest(args.profile);
  const { poolAddress, source: poolAddressSource } = resolvePoolTarget({
    requestedPool: args.pool,
    manifestPool: deployments.contracts?.depositPool,
  });
  if (!args.expectedSigner) throw new Error("--expected-signer is mandatory; the ceremony never guesses its operator.");
  // The manifest identity check is deliberately before RPC creation. The live
  // immutable operator is checked again after the chain-id-gated provider is up.
  assertExpectedSigner(args.expectedSigner, deployments.verifier);
  const { adapterAddress: manifestAdapter } = resolvePoolVenuePair(deployments, poolAddress);
  const rpc = await createCeremonyRpcContext({
    manifest: deployments,
    phase: `pool-yield-${args.command}`,
    write: args.commit,
  });
  const provider = rpc.provider;
  const identity = await resolveSigner(args, provider);
  const pool = new Contract(poolAddress, POOL_ABI, provider);
  const latest = await provider.getBlock("latest");
  if (!latest) throw new Error("Could not read the live chain head.");
  const before = await readPoolState(pool, latest.number);
  assertExpectedSigner(before.operator, args.expectedSigner);
  assertPoolVenueAdapter({ poolAddress, venueAdapter: before.venueAdapter, expectedAdapter: manifestAdapter });

  const common = {
    schemaVersion: 1,
    kind: "averray.poolVenueCeremonyEvidence",
    capturedAt: new Date().toISOString(),
    mode: args.commit ? "commit" : "dry-run",
    command: args.command,
    profile: args.profile,
    rpc: rpc.selectedUrl,
    rpcFailoverOrder: rpc.rpcUrls,
    chainId: rpc.chainId,
    chainHead: { number: latest.number, hash: latest.hash, timestamp: latest.timestamp },
    pool: poolAddress,
    poolAddressSource,
    venueAdapter: before.venueAdapter,
    signer: identity.address,
    signerBackend: identity.backend,
    liveState: before,
  };

  let data;
  let staticResult;
  let expectedEvent;
  let parameters;
  if (args.command === "deploy") {
    const assets = positiveBigInt(args.assets, "--assets");
    const returnBy = positiveBigInt(args.returnBy, "--return-by");
    assertDeployAdmission({
      assets,
      totalAssets: before.totalAssets,
      bufferAssets: before.bufferAssets,
      venuePrincipalCostBasis: before.venuePrincipalCostBasis,
      totalAssetCap: before.totalAssetCap,
      pendingRedemptionIds: before.pendingRedemptionIds,
      blockTimestamp: BigInt(latest.timestamp),
      returnBy,
      contractMaxReturnSeconds: before.notice7Days,
      deploymentKind: args.deploymentKind,
    });
    const observabilityUrl = buildPoolObservabilityUrl(args.observabilityUrl, poolAddress);
    const observability = await fetchObservability(observabilityUrl);
    assertObservability(observability, { poolAddress, chainTimestamp: BigInt(latest.timestamp) });
    if (before.activeVenueDeploymentId !== 0n) throw new Error(`Active venue deployment ${before.activeVenueDeploymentId} already exists.`);
    data = poolInterface.encodeFunctionData("deployToVenue", [assets, returnBy]);
    staticResult = await pool.getFunction("deployToVenue").staticCall(assets, returnBy, { from: identity.address });
    expectedEvent = "VenueDeploymentCreated";
    parameters = {
      assetsRaw: assets,
      assetsUsdc: amount(assets),
      returnBy,
      returnByIso: new Date(Number(returnBy) * 1_000).toISOString(),
      deploymentKind: args.deploymentKind,
      predictedDeploymentId: before.nextVenueDeploymentId,
      observability: {
        url: observabilityUrl,
        block: observability.block,
        reconciled: observability.reconciled,
        flowsStatus: observability.flows.status,
      },
    };
  } else if (args.command === "recall") {
    const assets = positiveBigInt(args.assets, "--assets");
    const deploymentId = positiveBigInt(args.deploymentId, "--deployment-id");
    if (before.activeVenueDeploymentId !== deploymentId) {
      throw new Error(`Active venue deployment is ${before.activeVenueDeploymentId}, not ${deploymentId}.`);
    }
    if (before.activeVenueRecallId !== 0n) throw new Error(`Active venue recall ${before.activeVenueRecallId} already exists.`);
    data = poolInterface.encodeFunctionData("recallVenueDeployment", [deploymentId, assets]);
    staticResult = await pool.getFunction("recallVenueDeployment").staticCall(deploymentId, assets, { from: identity.address });
    expectedEvent = "VenueRecallRequested";
    parameters = { deploymentId, assetsRaw: assets, assetsUsdc: amount(assets), predictedRecallId: before.nextVenueRecallId };
  } else {
    const hasDeployment = args.deploymentId !== undefined;
    const hasRecall = args.recallId !== undefined;
    if (hasDeployment === hasRecall) throw new Error("settle requires exactly one of --deployment-id or --recall-id.");
    if (hasDeployment) {
      const deploymentId = positiveBigInt(args.deploymentId, "--deployment-id");
      data = poolInterface.encodeFunctionData("settleVenueDeployment", [deploymentId]);
      staticResult = await pool.getFunction("settleVenueDeployment").staticCall(deploymentId, { from: identity.address });
      expectedEvent = "VenueDeploymentSettled";
      parameters = { settlementKind: "deployment", deploymentId };
    } else {
      const recallId = positiveBigInt(args.recallId, "--recall-id");
      data = poolInterface.encodeFunctionData("settleVenueRecall", [recallId]);
      staticResult = await pool.getFunction("settleVenueRecall").staticCall(recallId, { from: identity.address });
      expectedEvent = "VenueRecallSettled";
      parameters = { settlementKind: "recall", recallId };
    }
  }

  const plan = {
    ...common,
    parameters,
    transaction: { to: poolAddress, value: "0", data },
    preflight: { staticCall: "success", result: staticResult },
    guards: {
      signerMatchesOperator: true,
      poolAdapterMatchesManifest: true,
      accountingReconciled: before.bufferAssets + before.venuePrincipalCostBasis === before.totalAssets,
      pendingRedemptions: before.pendingRedemptionIds,
      policyFractionBpsAfter: args.command === "deploy"
        ? ((before.venuePrincipalCostBasis + BigInt(args.assets)) * 10_000n / before.totalAssets).toString()
        : (before.totalAssets === 0n ? null : (before.venuePrincipalCostBasis * 10_000n / before.totalAssets).toString()),
    },
  };
  if (!plan.guards.accountingReconciled) throw new Error("Precondition failed: buffer + deployed != totalAssets.");
  console.log(serialize(plan));
  if (!args.commit) {
    console.log("\nDRY RUN ONLY — no signature requested and no transaction broadcast.");
    return;
  }

  const tx = await identity.signer.sendTransaction({ to: poolAddress, data, value: 0n });
  const initialReceipt = await tx.wait(1, FINALITY_TIMEOUT_MS);
  if (!initialReceipt || initialReceipt.status !== 1) throw new Error(`Transaction ${tx.hash} did not succeed.`);
  const finality = await confirmCanonicalPostState({
    provider,
    transactionHash: tx.hash,
    initialReceipt,
    confirmations: args.confirmations,
    readPostState: (blockNumber) => readPoolState(
      pool,
      blockNumber,
      ceremonyStateFocus(args.command, parameters),
    ),
  });
  const receipt = finality.receipt;
  const events = parseReceiptEvents(receipt);
  const primary = eventByName(events, expectedEvent);
  const afterBlock = finality.block;
  const after = finality.postState;
  assertCeremonyEffectPostcondition({ command: args.command, parameters, after, event: primary });
  const reduction = principalReduction(events);
  assertAccountingPostcondition({
    beforePrincipalCostBasis: before.venuePrincipalCostBasis,
    afterPrincipalCostBasis: after.venuePrincipalCostBasis,
    expectedPrincipalIncrease: args.command === "deploy" ? BigInt(args.assets) : 0n,
    emittedPrincipalReduction: reduction,
    afterBufferAssets: after.bufferAssets,
    afterTotalAssets: after.totalAssets,
  });
  if (args.command === "deploy") {
    if (after.venuePrincipalCostBasis - before.venuePrincipalCostBasis !== BigInt(args.assets)) {
      throw new Error("Postcondition failed: deploy did not increase principal cost basis by exactly --assets.");
    }
    if (before.bufferAssets - after.bufferAssets !== BigInt(args.assets)) {
      throw new Error("Postcondition failed: deploy did not reduce the buffer by exactly --assets.");
    }
  } else if (args.command === "recall") {
    if (after.venuePrincipalCostBasis !== before.venuePrincipalCostBasis || after.bufferAssets !== before.bufferAssets) {
      throw new Error("Postcondition failed: recall request creation changed pool accounting before assets returned.");
    }
  }
  const finalityEvidence = buildFinalityEvidence(initialReceipt, finality);
  const evidence = {
    ...common,
    capturedAt: new Date().toISOString(),
    parameters,
    transaction: {
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed,
      status: receipt.status,
      ...finalityEvidence.transaction,
    },
    event: { name: primary.name, args: primary.args.toObject() },
    principalReturnEvents: events
      .filter((event) => event.name === "VenuePrincipalReturned")
      .map((event) => ({ name: event.name, args: event.args.toObject() })),
    postState: after,
    postcondition: {
      accountingReconciled: true,
      principalCostBasisReductionRaw: reduction,
      chainTimestamp: afterBlock?.timestamp ?? null,
    },
    finality: finalityEvidence.finality,
  };
  console.log("\n# COMMITTED EVIDENCE");
  console.log(serialize(evidence));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`pool-venue-ceremony failed: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
