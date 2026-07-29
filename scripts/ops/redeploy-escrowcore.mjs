#!/usr/bin/env node

/**
 * Redeploy EscrowCore on a target profile (testnet by default) when the
 * deployed bytecode has drifted from source — e.g. a selector the gateway
 * calls is no longer present, per the audit-launch-readiness
 * deployed-bytecode-selector check.
 *
 * Background:
 *   audit-launch-readiness.mjs reads the EscrowCore ABI from the build
 *   artifact and asserts every selector appears as a PUSH4 in the deployed
 *   bytecode. When source adds a function (e.g. claimJobFor) but the
 *   on-chain contract predates that change, the audit fails. The runbook
 *   is "redeploy EscrowCore and update deployments/<profile>.json".
 *
 * Flow
 * ----
 *   1. deploy    EVM CREATE of a fresh EscrowCore, signed by the explicit
 *                --expected-deployer EOA. One transaction.
 *
 *   2. wire      AgentAccountCore.setEscrowOperator(new, true) plus
 *                TreasuryPolicy settlementBroker/reputationWriter roles.
 *                Keep the old roles while v1 jobs drain; revoke them only
 *                after the drain catalog is empty. The owner is the H160 of
 *                the SS58 2-of-3
 *                multisig 12nHTKYf… — no private key. Generate the Apps
 *                recipe via:
 *                  scripts/ops/redeploy-escrowcore-wire-multisig.mjs
 *                Sign first leg with Hot Wallet (timepoint=None), then
 *                countersign with Ledger using {height,index} from the
 *                first leg's multisig.NewMultisig event.
 *
 *   3. finalize  Read-only verification that the multisig swap landed,
 *                then write the new address into deployments/<profile>.json
 *                and re-run audit-launch-readiness. Use --commit to write.
 *
 * Deployer key handling
 * ---------------------
 *   The deploy phase signs an EVM tx, so it needs the deployer EOA's
 *   private key. To avoid the secret ever sitting in shell state (history,
 *   ps -e, dotenv files on disk), the script spawns `op read` itself and
 *   consumes the secret over stdout pipe — never logs it.
 *
 *   Pass: --signer-secret-ref 'op://prod-critical/admin-eoa-testnet/private key'
 *
 *   Requirements:
 *     - `op` (1Password CLI) on PATH
 *     - Authenticated session (eval $(op signin)) before running
 *
 *   The script derives the address from the loaded key and prints ONLY the
 *   derived address (never the key). If it doesn't match the required
 *   --expected-deployer, broadcast is aborted. The top-level manifest
 *   `deployer` remains historical evidence and is never authorization.
 *
 *   PRIVATE_KEY env var is supported as a CI-only fallback when no
 *   --signer-secret-ref is given; it is not recommended for interactive use.
 *
 * Usage
 * -----
 *   # Inspect the full plan without signing anything:
 *   node scripts/ops/redeploy-escrowcore.mjs --phase all
 *
 *   # Step 1 — deploy (EVM, deployer key from 1Password):
 *   node scripts/ops/redeploy-escrowcore.mjs --phase deploy --commit \
 *     --expected-deployer 0xEXPECTED \
 *     --signer-secret-ref 'op://prod-critical/admin-eoa-testnet/private key'
 *
 *   # Step 2 — wire (multisig recipe; see separate script).
 *
 *   # Step 3 — finalize (after the multisig.MultisigExecuted event lands):
 *   node scripts/ops/redeploy-escrowcore.mjs --phase finalize \
 *     --new-escrow 0xNEW \
 *     --deploy-tx 0xDEPLOY_TX \
 *     --multisig-exec-tx 0xEXEC_TX --commit
 */

import {
  Wallet,
  Contract,
  ContractFactory,
  Interface,
  ZeroAddress,
  formatUnits,
  getCreateAddress
} from "ethers";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { bindSignerToWriteBroadcaster } from "../../mcp-server/src/blockchain/rpc-provider.js";
import {
  createCeremonyRpcContext,
  printCeremonyRpcPreflight
} from "./ceremony-rpc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export const MAINNET_MIN_ESCROW_DEPLOYER_BALANCE_WEI = 2_000_000_000_000_000_000n;

const TREASURY_POLICY_ABI = [
  "function owner() view returns (address)",
  "function settlementBroker(address) view returns (bool)",
  "function reputationWriter(address) view returns (bool)",
  "function setSettlementBroker(address account, bool allowed)",
  "function setReputationWriter(address account, bool allowed)"
];

const AGENT_ACCOUNT_READ_ABI = [
  "function escrowOperators(address escrowOperator) view returns (bool)",
  "function setEscrowOperator(address escrowOperator, bool approved)",
  "function positions(address account, address asset) view returns (uint256 liquid,uint256 reserved,uint256 strategyAllocated,uint256 collateralLocked,uint256 jobStakeLocked,uint256 debtOutstanding)"
];

export const ESCROW_TAIL_SCAN_ABI = [
  "function jobs(bytes32 jobId) view returns (address poster,address worker,address asset,bytes32 verifierMode,bytes32 category,bytes32 specHash,uint256 reward,uint256 opsReserve,uint256 contingencyReserve,uint256 released,uint256 claimExpiry,uint256 claimStake,uint16 claimStakeBps,uint256 claimFee,uint16 claimFeeBps,bool claimEconomicsWaived,address rejectingVerifier,uint256 rejectedAt,uint256 disputedAt,uint8 payoutMode,uint8 state)",
  "event JobCreated(bytes32 indexed jobId,address indexed poster,bytes32 indexed specHash,address asset,uint256 totalReserved,uint8 payoutMode)",
  "event JobFunded(bytes32 indexed jobId,address indexed poster,address indexed asset,uint256 totalReserved,uint8 payoutMode)",
  "event ExternalSchemaRegistered(bytes32 indexed jobId,bytes32 indexed schemaHash,address indexed schemaIssuer,string schemaUrl)",
  "event RecurringJobFundedFromTemplate(bytes32 indexed jobId,bytes32 indexed templateId,address indexed poster,address asset,uint256 totalReserved)",
  "event JobClaimed(bytes32 indexed jobId,address indexed worker,uint256 claimExpiry,uint256 claimStake)",
  "event ClaimEconomicsLocked(bytes32 indexed jobId,address indexed worker,uint256 claimStake,uint256 claimFee,bool waived,uint256 claimNumber)",
  "event OnboardingWaiverEligibilityUpdated(bytes32 indexed jobId,bool eligible)",
  "event ProtocolFeeBpsUpdated(uint16 previousProtocolFeeBps,uint16 newProtocolFeeBps)",
  "event TreasuryAccountUpdated(address indexed previousTreasuryAccount,address indexed newTreasuryAccount)",
  "event SettlementSplit(bytes32 indexed jobId,address indexed worker,address indexed treasuryAccount,address asset,uint256 workerAmount,uint256 protocolFeeAmount,uint16 protocolFeeBps)",
  "event WorkSubmitted(bytes32 indexed jobId,address indexed worker,bytes32 evidenceHash)",
  "event Submitted(bytes32 indexed jobId,address indexed worker,bytes32 indexed payloadHash)",
  "event JobReopened(bytes32 indexed jobId)",
  "event JobRejected(bytes32 indexed jobId,bytes32 reasonCode)",
  "event Verified(bytes32 indexed jobId,address indexed verifier,bool approved,bytes32 reasonCode,bytes32 reasoningHash)",
  "event DisputeOpened(bytes32 indexed jobId,address indexed opener,uint256 disputedAt)",
  "event DisputeResolved(bytes32 indexed jobId,address indexed arbitrator,uint256 workerPayout,bytes32 reasonCode,string metadataURI)",
  "event AutoResolvedOnTimeout(bytes32 indexed jobId,address indexed caller,uint256 workerPayout,bytes32 reasonCode)",
  "event JobClosed(bytes32 indexed jobId,address indexed worker,uint256 releasedAmount)",
  "event Disclosed(bytes32 indexed hash,address indexed byWallet,uint64 timestamp)",
  "event AutoDisclosed(bytes32 indexed hash,uint64 timestamp)"
];

const ESCROW_V2_READ_ABI = [
  "function policy() view returns (address)",
  "function accounts() view returns (address)",
  "function reputation() view returns (address)",
  "function treasuryAccount() view returns (address)",
  "function protocolFeeBps() view returns (uint16)",
  "function MAX_PROTOCOL_FEE_BPS() view returns (uint16)"
];

const PHASES = new Set(["deploy", "finalize", "all"]);
const PRIVATE_KEY_RE = /^0x[a-fA-F0-9]{64}$/u;
const DEFAULT_ORPHAN_SCAN_CHUNK_SIZE = 25_000;
const JOB_STATE_NAMES = ["None", "Open", "Claimed", "Submitted", "Rejected", "Disputed", "Closed"];
const PAYOUT_MODE_NAMES = ["Single", "Milestone"];

/**
 * Spawn `op read <ref>` and capture stdout. The secret is consumed via
 * pipe and never logged. No shell expansion happens — the ref is passed
 * as an argv element. If the 1Password CLI is missing or unauthenticated,
 * the caller gets a clear actionable error.
 */
export function loadKeyFromOp(secretRef) {
  if (typeof secretRef !== "string" || !secretRef.startsWith("op://")) {
    throw new Error(`--signer-secret-ref must be an 'op://...' reference. Got: ${String(secretRef).slice(0, 24)}…`);
  }
  let result;
  try {
    result = spawnSync("op", ["read", secretRef], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8"
    });
  } catch (error) {
    throw new Error(`Failed to spawn 'op': ${error?.message ?? error}`);
  }
  if (result.error && result.error.code === "ENOENT") {
    throw new Error(
      "1Password CLI 'op' not found on PATH. Install it (brew install --cask 1password-cli) and run 'eval $(op signin)' before retrying."
    );
  }
  if (result.error) {
    throw new Error(`'op read' failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    const looksUnauthed =
      /not\s+(?:currently\s+)?signed in|authorization|session (?:expired|invalid|not found)|op signin/i.test(stderr);
    if (looksUnauthed) {
      throw new Error("1Password CLI is not authenticated. Please run 'eval $(op signin)' first, then re-run this script.");
    }
    throw new Error(`'op read' exited ${result.status}: ${stderr || "no stderr output"}`);
  }
  const raw = String(result.stdout ?? "").trim();
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!PRIVATE_KEY_RE.test(hex)) {
    throw new Error(
      `Secret at ${secretRef} is not a valid 32-byte hex private key ` +
      `(got ${raw.length} chars). Check the item / field path.`
    );
  }
  return hex;
}

export function parseArgs(argv) {
  const args = {
    dryRun: true,
    profile: "testnet",
    phase: "all",
    newEscrow: undefined,
    deployTx: undefined,
    multisigExecTx: undefined,
    expectedDeployer: undefined,
    signerSecretRef: undefined,
    skipRevoke: false,
    skipManifestUpdate: false,
    skipAuditRerun: false,
    acknowledgeOrphanedBalances: false,
    orphanScanFromBlock: undefined,
    orphanScanChunkSize: DEFAULT_ORPHAN_SCAN_CHUNK_SIZE
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--commit") args.dryRun = false;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--profile") args.profile = argv[++i];
    else if (arg === "--phase") args.phase = argv[++i];
    else if (arg === "--new-escrow") args.newEscrow = argv[++i];
    else if (arg === "--deploy-tx") args.deployTx = argv[++i];
    else if (arg === "--multisig-exec-tx") args.multisigExecTx = argv[++i];
    else if (arg === "--expected-deployer") args.expectedDeployer = argv[++i];
    else if (arg === "--signer-secret-ref") args.signerSecretRef = argv[++i];
    else if (arg === "--skip-revoke") args.skipRevoke = true;
    else if (arg === "--skip-manifest-update") args.skipManifestUpdate = true;
    else if (arg === "--skip-audit-rerun") args.skipAuditRerun = true;
    else if (arg === "--acknowledge-orphaned-balances") args.acknowledgeOrphanedBalances = true;
    else if (arg === "--from-block" || arg === "--orphan-scan-from-block") {
      args.orphanScanFromBlock = Number(argv[++i]);
    }
    else if (arg === "--orphan-scan-chunk-size") args.orphanScanChunkSize = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/ops/redeploy-escrowcore.mjs [options]",
      "",
      "Phases:",
      "  --phase deploy            Phase 1: EVM CREATE the new EscrowCore (deployer key).",
      "  --phase finalize          Phase 3: verify wiring on-chain, update manifest, re-run audit.",
      "  --phase all               (default) Print the whole plan as a sequence overview.",
      "",
      "Modes:",
      "  --dry-run                 (default) Print plan, no side effects.",
      "  --commit                  Send/write side effects for the chosen phase.",
      "",
      "Pre-Phase-2 safety check:",
      "  --acknowledge-orphaned-balances",
      "                            Allow the deploy/all plan to proceed even if the",
      "                            old EscrowCore still has unsettled jobs tied to",
      "                            AAC reserved/jobStakeLocked balances. This means",
      "                            those balances may become orphaned after Phase 2",
      "                            revokes the old EscrowCore service-operator role.",
      "  --from-block <n>",
      "                            First block to scan for old EscrowCore job events",
      "                            (default: deployments/<profile>.json",
      "                            #deploymentBlocks.escrowCore).",
      "  --orphan-scan-from-block <n>",
      "                            Backwards-compatible alias for --from-block.",
      "  --orphan-scan-chunk-size <n>",
      `                            getLogs chunk size (default: ${DEFAULT_ORPHAN_SCAN_CHUNK_SIZE}).`,
      "",
      "Phase 1 (deploy) options:",
      "  --expected-deployer <addr>",
      "                            EOA used for nonce/address prediction and signer",
      "                            verification. Required with --commit; pass it in",
      "                            dry-runs for an actionable CREATE prediction.",
      "  --signer-secret-ref <ref> 1Password secret reference, e.g.",
      "                            'op://prod-critical/admin-eoa-testnet/private key'.",
      "                            Script spawns `op read` itself; secret never enters the shell.",
      "                            Requires `op` on PATH and a signed-in session.",
      "                            Fallback (CI only): PRIVATE_KEY env var.",
      "",
      "Phase 3 (finalize) options:",
      "  --new-escrow <addr>       Required. Address from Phase 1 receipt.",
      "  --deploy-tx <hash>        Required. Deploy tx hash from Phase 1.",
      "  --multisig-exec-tx <h>    Required. multisig.MultisigExecuted tx hash from Phase 2.",
      "  --skip-revoke             Manifest audit-trail uses 'wired-only' label.",
      "  --skip-manifest-update    Don't edit deployments/<profile>.json.",
      "  --skip-audit-rerun        Don't re-run audit-launch-readiness at the end."
    ].join("\n")
  );
}

async function loadDeployments(profile) {
  const path = resolve(repoRoot, "deployments", `${profile}.json`);
  return { path, manifest: JSON.parse(await readFile(path, "utf8")) };
}

// Operator-brokered entrypoints the gateway calls on behalf of the worker /
// participant. Every redeploy MUST ship an artifact that defines all of them,
// or the deployed-bytecode-selector audit fails and the worker loop reverts
// Unauthorized (claimJobFor #357/#525, submitWorkFor/openDisputeFor this PR).
const REQUIRED_ESCROW_V2_FNS = [
  "claimJobFor",
  "submitWorkFor",
  "openDisputeFor",
  "previewProtocolFee",
  "setProtocolFeeBps",
  "setTreasuryAccount",
  "createSinglePayoutJobFeeWaived"
];

async function loadEscrowArtifact() {
  const path = resolve(repoRoot, "out", "EscrowCore.sol", "EscrowCore.json");
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`Build artifact not found at ${path}. Run \`forge build\` first.`);
  }
  const artifact = JSON.parse(raw);
  return {
    bytecode: artifact.bytecode.object,
    abi: artifact.abi
  };
}

function summarizeBrokeredSelectors(artifact) {
  return REQUIRED_ESCROW_V2_FNS
    .map((name) => `${name}=${artifact.abi.some((f) => f.name === name)}`)
    .join(" ");
}

export function assertArtifactHasBrokeredSelectors(artifact) {
  const missing = REQUIRED_ESCROW_V2_FNS.filter((name) => !artifact.abi.some((f) => f.name === name));
  if (missing.length) {
    throw new Error(
      `Build artifact is missing required EscrowCore-v2 selector(s): ${missing.join(", ")}. ` +
      "Run `forge build` on the protocol-fee source before redeploying."
    );
  }
  const constructor = artifact.abi.find((entry) => entry.type === "constructor");
  if (constructor?.inputs?.length !== 4) {
    throw new Error(
      `Build artifact has ${constructor?.inputs?.length ?? 0} EscrowCore constructor inputs; ` +
      "v2 requires policy, accounts, reputation, treasuryAccount."
    );
  }
}

function resolveSignerKey(args) {
  if (args.signerSecretRef) {
    return loadKeyFromOp(args.signerSecretRef);
  }
  const value = String(process.env.PRIVATE_KEY ?? "").trim();
  if (!PRIVATE_KEY_RE.test(value)) {
    throw new Error(
      "Provide the deployer key via --signer-secret-ref 'op://...' (recommended), " +
      "or set PRIVATE_KEY env (CI fallback)."
    );
  }
  return value;
}

function assertAddress(label, value) {
  if (!/^0x[a-fA-F0-9]{40}$/u.test(value)) {
    throw new Error(`${label} is not a valid address: ${value}`);
  }
}

export async function assertMainnetPhaseOneDeployerBalance({
  provider,
  deployer,
  minimumWei = MAINNET_MIN_ESCROW_DEPLOYER_BALANCE_WEI
}) {
  assertAddress("Phase 1 deployer", deployer);
  let balanceWei;
  try {
    balanceWei = BigInt(await provider.getBalance(deployer));
  } catch (error) {
    throw new Error(
      `Phase 1 deployer balance preflight could not read ${deployer}: ` +
      `${error?.shortMessage ?? error?.message ?? error}`,
      { cause: error }
    );
  }
  if (balanceWei < minimumWei) {
    throw new Error(
      `Phase 1 deployer balance preflight failed: ${deployer} has ` +
      `${formatUnits(balanceWei, 18)} DOT; requires at least ` +
      `${formatUnits(minimumWei, 18)} DOT before CREATE. ` +
      `Below-floor balances can be rejected by Polkadot Hub as Substrate 1010 ` +
      `"Invalid Transaction", which ethers may surface as "could not coalesce error".`
    );
  }
  return {
    deployer,
    balanceWei,
    minimumWei
  };
}

function assertTxHash(label, value) {
  if (!/^0x[a-fA-F0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is not a valid 32-byte tx hash: ${value}`);
  }
}

export function resolveDeployPredictionDeployer({
  expectedDeployer,
  historicalDeployer,
  commit
}) {
  if (expectedDeployer !== undefined && expectedDeployer !== null && expectedDeployer !== "") {
    assertAddress("--expected-deployer", expectedDeployer);
    return {
      address: expectedDeployer,
      source: "--expected-deployer"
    };
  }
  if (commit) {
    throw new Error(
      "--expected-deployer is required for --commit. " +
      "manifest.deployer is historical deployment evidence, not authorization."
    );
  }
  assertAddress("historical manifest.deployer", historicalDeployer);
  return {
    address: historicalDeployer,
    source: "manifest.deployer (historical dry-run fallback)"
  };
}

export async function planDeploy({ provider, manifest, artifact, deployer }) {
  const treasury = manifest.contracts.treasuryPolicy;
  const accounts = manifest.contracts.agentAccountCore;
  const reputation = manifest.contracts.reputationSbt;
  const treasuryAccount = manifest.treasuryAccount ?? manifest.treasuryReserve;
  assertAddress("contracts.treasuryPolicy", treasury);
  assertAddress("contracts.agentAccountCore", accounts);
  assertAddress("contracts.reputationSbt", reputation);
  assertAddress("treasuryAccount", treasuryAccount);

  const constructorArgs = [treasury, accounts, reputation, treasuryAccount];
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, undefined);
  const deployTx = await factory.getDeployTransaction(...constructorArgs);

  assertAddress("CREATE prediction deployer", deployer);
  const nonce = await provider.getTransactionCount(deployer, "pending");
  const predicted = getCreateAddress({ from: deployer, nonce });

  return {
    constructorArgs,
    deployer,
    nonce,
    predicted,
    creationDataLength: (deployTx.data.length - 2) / 2,
    creationDataPrefix: deployTx.data.slice(0, 22) + "…",
    deployTx
  };
}

export async function verifyExpectedDeployerAndBroadcast({
  expectedDeployer,
  derivedSigner,
  predictionDeployer,
  predictedAddress,
  broadcast
}) {
  assertAddress("--expected-deployer", expectedDeployer);
  assertAddress("derived signer", derivedSigner);
  assertAddress("CREATE prediction deployer", predictionDeployer);
  assertAddress("predicted CREATE address", predictedAddress);
  if (derivedSigner.toLowerCase() !== expectedDeployer.toLowerCase()) {
    throw new Error(
      `The derived signer ${derivedSigner} does not match --expected-deployer ${expectedDeployer}; ` +
      "refusing to broadcast."
    );
  }
  if (predictionDeployer.toLowerCase() !== expectedDeployer.toLowerCase()) {
    throw new Error(
      `CREATE prediction used ${predictionDeployer}, not --expected-deployer ${expectedDeployer}; ` +
      "refusing to broadcast."
    );
  }

  const result = await broadcast();
  assertAddress("deployed contract address", result?.newAddress);
  if (result.newAddress.toLowerCase() !== predictedAddress.toLowerCase()) {
    throw new Error(
      `Deployment landed at ${result.newAddress}, not reviewed CREATE prediction ${predictedAddress}.`
    );
  }
  return result;
}

async function readWiringState({ provider, manifest }) {
  const treasury = new Contract(manifest.contracts.treasuryPolicy, TREASURY_POLICY_ABI, provider);
  const accounts = new Contract(manifest.contracts.agentAccountCore, AGENT_ACCOUNT_READ_ABI, provider);
  const [owner, oldIsSettlementBroker, oldIsReputationWriter, oldIsEscrowOperator] = await Promise.all([
    treasury.owner(),
    treasury.settlementBroker(manifest.contracts.escrowCore),
    treasury.reputationWriter(manifest.contracts.escrowCore),
    accounts.escrowOperators(manifest.contracts.escrowCore)
  ]);
  return { owner, oldIsSettlementBroker, oldIsReputationWriter, oldIsEscrowOperator };
}

function assertPositiveInteger(label, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer. Got: ${value}`);
  }
}

function normalizePosition(position) {
  return {
    liquid: BigInt(position.liquid),
    reserved: BigInt(position.reserved),
    strategyAllocated: BigInt(position.strategyAllocated),
    collateralLocked: BigInt(position.collateralLocked),
    jobStakeLocked: BigInt(position.jobStakeLocked),
    debtOutstanding: BigInt(position.debtOutstanding)
  };
}

function serializePosition(position, decimals = 6) {
  const normalized = normalizePosition(position);
  return {
    liquid: normalized.liquid.toString(),
    reserved: normalized.reserved.toString(),
    strategyAllocated: normalized.strategyAllocated.toString(),
    collateralLocked: normalized.collateralLocked.toString(),
    jobStakeLocked: normalized.jobStakeLocked.toString(),
    debtOutstanding: normalized.debtOutstanding.toString(),
    formatted: {
      liquid: formatUnits(normalized.liquid, decimals),
      reserved: formatUnits(normalized.reserved, decimals),
      jobStakeLocked: formatUnits(normalized.jobStakeLocked, decimals),
      debtOutstanding: formatUnits(normalized.debtOutstanding, decimals)
    }
  };
}

function hasReservedOrLockedStake(position) {
  const normalized = normalizePosition(position);
  return normalized.reserved > 0n || normalized.jobStakeLocked > 0n;
}

function serializeJobEscrow(jobId, job) {
  return {
    jobId,
    poster: job.poster,
    worker: job.worker,
    asset: job.asset,
    reward: job.reward.toString(),
    opsReserve: job.opsReserve.toString(),
    contingencyReserve: job.contingencyReserve.toString(),
    released: job.released.toString(),
    claimExpiry: job.claimExpiry.toString(),
    claimStake: job.claimStake.toString(),
    claimFee: job.claimFee.toString(),
    rejectedAt: job.rejectedAt.toString(),
    disputedAt: job.disputedAt.toString(),
    payoutMode: PAYOUT_MODE_NAMES[Number(job.payoutMode)] ?? String(job.payoutMode),
    state: JOB_STATE_NAMES[Number(job.state)] ?? String(job.state),
    stateIndex: Number(job.state)
  };
}

function getNamedArg(args, name) {
  try {
    const value = args[name];
    return value === undefined ? undefined : value;
  } catch {
    return undefined;
  }
}

function isTimeoutError(error) {
  const candidates = [
    error,
    error?.cause,
    error?.info?.error
  ].filter(Boolean);
  return candidates.some((candidate) => {
    const code = String(candidate?.code ?? "").toUpperCase();
    const message = [
      candidate?.message,
      candidate?.shortMessage,
      candidate?.reason,
      candidate?.operation
    ].filter(Boolean).join(" ");
    return code === "TIMEOUT" || /\btime(?:d)?\s*out\b|\bTIMEOUT\b/iu.test(message);
  });
}

function scanFailureMessage({ error, fromBlock, toBlock, latest, chunkIndex, totalChunks }) {
  const prefix = isTimeoutError(error)
    ? "Escrow orphan scan timed out"
    : "Escrow orphan scan failed";
  const detail = String(error?.shortMessage ?? error?.message ?? error);
  return (
    `${prefix} at block ${fromBlock} of ${latest} ` +
    `(chunk ${chunkIndex}/${totalChunks}, blocks ${fromBlock}-${toBlock}). ` +
    `${detail}`
  );
}

export function resolveOrphanScanFromBlock({ manifest, fromBlock }) {
  if (fromBlock !== undefined && fromBlock !== null) {
    assertPositiveInteger("fromBlock", fromBlock);
    return {
      fromBlock,
      source: "--from-block"
    };
  }
  const manifestBlockKey = manifest?.deploymentBlocks?.escrowCoreV2 !== undefined
    ? "escrowCoreV2"
    : "escrowCore";
  const manifestBlock = Number(manifest?.deploymentBlocks?.[manifestBlockKey]);
  if (!Number.isSafeInteger(manifestBlock) || manifestBlock < 1) {
    throw new Error(
      "Missing deployments manifest deploymentBlocks.escrowCore or escrowCoreV2. " +
      "Record the EscrowCore deployment block or pass --from-block explicitly; " +
      "refusing to scan from genesis."
    );
  }
  return {
    fromBlock: manifestBlock,
    source: `deploymentBlocks.${manifestBlockKey}`
  };
}

export async function collectOldEscrowJobIds({
  provider,
  escrowAddress,
  fromBlock,
  toBlock,
  chunkSize = DEFAULT_ORPHAN_SCAN_CHUNK_SIZE,
  onProgress
}) {
  assertPositiveInteger("fromBlock", fromBlock);
  assertPositiveInteger("chunkSize", chunkSize);
  if (chunkSize === 0) throw new Error("chunkSize must be greater than 0.");
  const latest = toBlock ?? await provider.getBlockNumber();
  assertPositiveInteger("toBlock", latest);
  if (fromBlock > latest) {
    throw new Error(`fromBlock ${fromBlock} exceeds current chain head ${latest}.`);
  }

  const iface = new Interface(ESCROW_TAIL_SCAN_ABI);
  const jobIds = new Set();
  let scannedLogCount = 0;
  let unmatchedLogCount = 0;
  const unmatchedTopics = new Map();
  const totalChunks = Math.ceil((latest - fromBlock + 1) / chunkSize);
  let chunkIndex = 0;

  for (let from = fromBlock; from <= latest; from += chunkSize) {
    chunkIndex += 1;
    const to = Math.min(latest, from + chunkSize - 1);
    onProgress?.({
      chunkIndex,
      totalChunks,
      fromBlock: from,
      toBlock: to,
      latestBlock: latest
    });
    let logs;
    try {
      logs = await provider.getLogs({
        address: escrowAddress,
        fromBlock: from,
        toBlock: to
      });
    } catch (error) {
      throw new Error(
        scanFailureMessage({
          error,
          fromBlock: from,
          toBlock: to,
          latest,
          chunkIndex,
          totalChunks
        }),
        { cause: error }
      );
    }
    scannedLogCount += logs.length;
    for (const log of logs) {
      let parsed;
      try {
        parsed = iface.parseLog(log);
      } catch {
        parsed = null;
      }
      if (!parsed) {
        unmatchedLogCount += 1;
        const topic0 = log.topics?.[0] ?? "(missing topic0)";
        unmatchedTopics.set(topic0, (unmatchedTopics.get(topic0) ?? 0) + 1);
        continue;
      }
      const jobId = getNamedArg(parsed.args, "jobId");
      if (jobId) jobIds.add(jobId);
    }
  }

  return {
    fromBlock,
    toBlock: latest,
    chunkSize,
    scannedLogCount,
    unmatchedLogCount,
    unmatchedTopics: [...unmatchedTopics.entries()]
      .map(([topic0, count]) => ({ topic0, count }))
      .sort((a, b) => a.topic0.localeCompare(b.topic0)),
    jobIds: [...jobIds].sort()
  };
}

export async function findUnsettledOldEscrowBalances({
  provider,
  manifest,
  fromBlock,
  chunkSize = DEFAULT_ORPHAN_SCAN_CHUNK_SIZE,
  onProgress
}) {
  const oldEscrow = manifest.contracts.escrowCore;
  const accountCore = manifest.contracts.agentAccountCore;
  assertAddress("contracts.escrowCore", oldEscrow);
  assertAddress("contracts.agentAccountCore", accountCore);
  const scanStart = resolveOrphanScanFromBlock({ manifest, fromBlock });

  const scan = await collectOldEscrowJobIds({
    provider,
    escrowAddress: oldEscrow,
    fromBlock: scanStart.fromBlock,
    chunkSize,
    onProgress
  });
  const escrow = new Contract(oldEscrow, ESCROW_TAIL_SCAN_ABI, provider);
  const accounts = new Contract(accountCore, AGENT_ACCOUNT_READ_ABI, provider);
  const findings = [];

  for (const jobId of scan.jobIds) {
    const job = await escrow.jobs(jobId);
    const jobJson = serializeJobEscrow(jobId, job);
    if (jobJson.state === "None" || jobJson.state === "Closed") {
      continue;
    }

    const [posterPositionRaw, workerPositionRaw] = await Promise.all([
      accounts.positions(job.poster, job.asset),
      job.worker === ZeroAddress
        ? Promise.resolve(null)
        : accounts.positions(job.worker, job.asset)
    ]);

    const posterHasTail = hasReservedOrLockedStake(posterPositionRaw);
    const workerHasTail = workerPositionRaw ? hasReservedOrLockedStake(workerPositionRaw) : false;
    if (!posterHasTail && !workerHasTail) {
      continue;
    }

    findings.push({
      ...jobJson,
      posterPosition: serializePosition(posterPositionRaw),
      workerPosition: workerPositionRaw ? serializePosition(workerPositionRaw) : null,
      nonZeroTails: {
        poster: posterHasTail,
        worker: workerHasTail
      }
    });
  }

  return {
    oldEscrow,
    agentAccountCore: accountCore,
    scan: {
      fromBlock: scan.fromBlock,
      fromBlockSource: scanStart.source,
      toBlock: scan.toBlock,
      chunkSize: scan.chunkSize,
      scannedLogCount: scan.scannedLogCount,
      unmatchedLogCount: scan.unmatchedLogCount,
      unmatchedTopics: scan.unmatchedTopics,
      scannedJobCount: scan.jobIds.length
    },
    findings
  };
}

function formatOrphanedBalanceFinding(finding) {
  const worker = finding.worker === ZeroAddress ? "(none)" : finding.worker;
  const posterTail = `${finding.posterPosition.formatted.reserved} reserved / ${finding.posterPosition.formatted.jobStakeLocked} stake`;
  const workerTail = finding.workerPosition
    ? `${finding.workerPosition.formatted.reserved} reserved / ${finding.workerPosition.formatted.jobStakeLocked} stake`
    : "n/a";
  return [
    `- ${finding.jobId}`,
    `  state=${finding.state} claimExpiry=${finding.claimExpiry}`,
    `  poster=${finding.poster} (${posterTail})`,
    `  worker=${worker} (${workerTail})`,
    `  reward=${formatUnits(finding.reward, 6)} USDC claimStake=${formatUnits(finding.claimStake, 6)} claimFee=${formatUnits(finding.claimFee, 6)}`
  ].join("\n");
}

export function evaluateOrphanedBalancePreflight(report, { acknowledge = false } = {}) {
  const unmatchedLogCount = Number(report.scan.unmatchedLogCount ?? 0);
  const decodedLogCount = Math.max(0, report.scan.scannedLogCount - unmatchedLogCount);
  const coverage = unmatchedLogCount === 0
    ? `Scan ABI covered all ${report.scan.scannedLogCount} old EscrowCore event log(s).`
    : [
        `WARNING: ${unmatchedLogCount} old EscrowCore event log(s) are not covered by the scan ABI (${decodedLogCount}/${report.scan.scannedLogCount} decoded).`,
        ...((report.scan.unmatchedTopics ?? []).map(
          ({ topic0, count }) => `  unmatched topic0 ${topic0}: ${count} log(s)`
        ))
      ].join("\n");

  if (!report.findings.length) {
    return {
      ok: true,
      acknowledged: false,
      unmatchedLogCount,
      message: [
        coverage,
        `No unsettled old EscrowCore jobs with non-zero AAC reserved/jobStakeLocked tails found across ${report.scan.scannedJobCount} scanned job(s).`
      ].join("\n")
    };
  }

  const body = report.findings.map(formatOrphanedBalanceFinding).join("\n");
  const message = [
    coverage,
    `${report.findings.length} unsettled old EscrowCore job(s) still touch AAC reserved/jobStakeLocked balances.`,
    `Retiring ${report.oldEscrow} from AgentAccountCore.escrowOperators can orphan those balances because normal escrow release paths must call escrow-only AgentAccountCore mutation functions.`,
    "",
    body
  ].join("\n");

  if (acknowledge) {
    return {
      ok: true,
      acknowledged: true,
      unmatchedLogCount,
      message: `${message}\n\nAcknowledged via --acknowledge-orphaned-balances; continuing.`
    };
  }

  throw new Error(
    `${message}\n\nAbort: settle or finalize these jobs first, or pass --acknowledge-orphaned-balances to record that the operator accepts the orphaning risk.`
  );
}

async function runOrphanedBalancePreflight({ args, provider, manifest }) {
  const report = await findUnsettledOldEscrowBalances({
    provider,
    manifest,
    fromBlock: args.orphanScanFromBlock,
    chunkSize: args.orphanScanChunkSize,
    onProgress: ({ chunkIndex, totalChunks, fromBlock, toBlock }) => {
      console.log(
        `orphan scan:           chunk ${chunkIndex}/${totalChunks}, blocks ${fromBlock}-${toBlock}`
      );
    }
  });
  console.log(
    `orphan scan anchor:    ${report.scan.fromBlock} (${report.scan.fromBlockSource})`
  );
  const decision = evaluateOrphanedBalancePreflight(report, {
    acknowledge: args.acknowledgeOrphanedBalances
  });
  const log = decision.acknowledged || decision.unmatchedLogCount > 0 ? console.warn : console.log;
  log(`\n## Pre-Phase-2 orphaned balance check`);
  log(decision.message);
  return { report, decision };
}

function runAudit(profile) {
  return new Promise((res, rej) => {
    const child = spawn(
      process.execPath,
      [resolve(repoRoot, "scripts/ops/audit-launch-readiness.mjs"), "--profile", profile],
      { stdio: "inherit", cwd: repoRoot }
    );
    child.on("error", rej);
    child.on("exit", (code) => res(code ?? 1));
  });
}

async function commitDeploy({ wallet, plan, artifact, writeBroadcaster }) {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
  console.log(`\nSending deploy tx…`);
  const contract = await factory.deploy(...plan.constructorArgs, {
    nonce: plan.nonce
  });
  const tx = contract.deploymentTransaction();
  console.log(`  tx:        ${tx?.hash}`);
  await contract.waitForDeployment();
  const newAddress = await contract.getAddress();
  console.log(`  deployed:  ${newAddress}`);
  const receipt = await tx.wait();
  return {
    newAddress,
    txHash: tx.hash,
    blockNumber: receipt?.blockNumber ?? null,
    providerUsed: writeBroadcaster?.takeProviderUsed(tx.hash) ?? "unknown"
  };
}

function printDeployPlan(plan) {
  console.log(`\n## Phase 1: deploy (EVM CREATE, deployer EOA)`);
  console.log(`  CREATE sender: ${plan.deployer}`);
  console.log(`  signer nonce:  ${plan.nonce}`);
  console.log(`  to:            (CREATE — no recipient)`);
  console.log(`  data length:   ${plan.creationDataLength} bytes (bytecode + abi.encode(constructor args))`);
  console.log(`  data prefix:   ${plan.creationDataPrefix}`);
  console.log(`  constructor:   EscrowCore(${plan.constructorArgs.join(", ")})`);
  console.log(`  predicted addr: ${plan.predicted}`);
  console.log(`  (commit pins this nonce; a conflicting pending tx fails instead of changing the address.)`);
}

function printWireOverview({ manifest, wiringState, predictedNewEscrow }) {
  const placeholder = predictedNewEscrow ?? "<NEW_ESCROW>";
  const policyIface = new Interface(TREASURY_POLICY_ABI);
  const accountIface = new Interface(AGENT_ACCOUNT_READ_ABI);
  const approveAccountData = accountIface.encodeFunctionData("setEscrowOperator", [placeholder, true]);
  const approveSettlementData = policyIface.encodeFunctionData("setSettlementBroker", [placeholder, true]);
  const approveReputationData = policyIface.encodeFunctionData("setReputationWriter", [placeholder, true]);

  console.log(`\n## Phase 2: wire (multisig.asMulti via Apps, NOT this script)`);
  console.log(`  owner is the H160 of SS58 multisig — no private key. Generate the recipe with:`);
  console.log(`    node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \\`);
  console.log(`      --new-escrow ${placeholder} --signer hot --skip-revoke`);
  console.log(`  then sign in polkadot-js-apps, record {height, index}, run again with --signer ledger.`);
  console.log("");
  console.log(`  Inner EVM calldata that the recipe will wrap (for review):`);
  console.log(`    [1] AgentAccountCore.setEscrowOperator(${placeholder}, true)`);
  console.log(`        to:   ${manifest.contracts.agentAccountCore}`);
  console.log(`        data: ${approveAccountData}`);
  console.log(`    [2] TreasuryPolicy.setSettlementBroker(${placeholder}, true)`);
  console.log(`        to:   ${manifest.contracts.treasuryPolicy}`);
  console.log(`        data: ${approveSettlementData}`);
  console.log(`    [3] TreasuryPolicy.setReputationWriter(${placeholder}, true)`);
  console.log(`        to:   ${manifest.contracts.treasuryPolicy}`);
  console.log(`        data: ${approveReputationData}`);
  console.log(`    Old Escrow roles remain enabled until all v1 jobs have drained.`);
  console.log("");
  console.log(`  Owner (multisig SS58):           12nHTKYfV64pnxsVRB6Cjn6kQPPH64Ehnr8zgqZxvfa8hJvQ`);
  console.log(`  Owner (H160 onchain):            ${wiringState.owner}`);
  console.log(`  Old settlement broker now:       ${wiringState.oldIsSettlementBroker}`);
  console.log(`  Old reputation writer now:       ${wiringState.oldIsReputationWriter}`);
  console.log(`  Old AAC escrow operator now:     ${wiringState.oldIsEscrowOperator}`);
}

function printFinalizeOverview() {
  console.log(`\n## Phase 3: finalize (verify, update manifest, re-run audit)`);
  console.log(`  After the multisig.MultisigExecuted event lands on chain:`);
  console.log(`    node scripts/ops/redeploy-escrowcore.mjs --phase finalize \\`);
  console.log(`      --new-escrow 0xNEW \\`);
  console.log(`      --deploy-tx 0xDEPLOY \\`);
  console.log(`      --multisig-exec-tx 0xEXEC --skip-revoke --commit`);
  console.log(`  This re-reads on-chain state to confirm the swap, then updates`);
  console.log(`  deployments/<profile>.json and runs audit-launch-readiness.`);
}

export function applyEscrowRedeployManifest({
  manifest,
  oldEscrow,
  newEscrow,
  deployer,
  deployBlock,
  deployTx,
  multisigExecTx,
  skipRevoke,
  redeployedAt = new Date().toISOString()
}) {
  assertAddress("v2 deployer", deployer);
  manifest.contracts.escrowCore = newEscrow;
  if (skipRevoke) {
    manifest.contracts.legacyEscrowCore = oldEscrow;
  } else {
    delete manifest.contracts.legacyEscrowCore;
  }
  manifest.parameters = {
    ...(manifest.parameters ?? {}),
    protocolFeeBps: "0"
  };
  manifest.deployers = {
    ...(manifest.deployers ?? {}),
    escrowCoreV2: deployer
  };
  manifest.deploymentBlocks = {
    ...(manifest.deploymentBlocks ?? {}),
    escrowCoreV2: deployBlock
  };
  manifest.escrowRedeployedAt = redeployedAt;
  manifest.escrowRedeployTxHashes = {
    deploy: deployTx,
    multisigExec: multisigExecTx,
    revokeOld: skipRevoke ? null : "batched-in-multisig-exec"
  };
  return manifest;
}

async function updateManifest({
  deploymentsPath,
  manifest,
  oldEscrow,
  newEscrow,
  deployer,
  deployBlock,
  deployTx,
  multisigExecTx,
  skipRevoke
}) {
  applyEscrowRedeployManifest({
    manifest,
    oldEscrow,
    newEscrow,
    deployer,
    deployBlock,
    deployTx,
    multisigExecTx,
    skipRevoke
  });
  const text = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(deploymentsPath, text, "utf8");
}

/**
 * Rewrite the ESCROW_CORE_ADDRESS= line in deploy/<envFile>.template to
 * track the manifest. Phase 2 PR 2.6 made the template the single source
 * of truth at deploy time and added check-template-matches-manifest.mjs
 * as a CI guard — if finalize only writes the manifest, that lint fails.
 *
 * Returns true if the template was rewritten, false if no change was
 * needed (already up to date or no ESCROW_CORE_ADDRESS line found).
 * Exported for direct testing.
 */
export function rewriteEscrowAddressInTemplate(text, newEscrow) {
  const re = /^(ESCROW_CORE_ADDRESS=)(.*)$/m;
  const match = text.match(re);
  if (!match) return { changed: false, reason: "no ESCROW_CORE_ADDRESS line" };
  if (match[2].trim() === newEscrow) return { changed: false, reason: "already up to date" };
  const next = text.replace(re, `$1${newEscrow}`);
  return { changed: true, text: next, previousValue: match[2].trim() };
}

function rewriteEnvValue(text, key, value) {
  const re = new RegExp(`^(${key}=)(.*)$`, "m");
  if (!re.test(text)) return text;
  return text.replace(re, `$1${value}`);
}

async function syncEnvTemplate({ templatePath, newEscrow, oldEscrow, keepV1Drain, dryRun }) {
  let text;
  try {
    text = await readFile(templatePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { skipped: true, reason: "template file not found" };
    throw error;
  }
  const result = rewriteEscrowAddressInTemplate(text, newEscrow);
  let next = result.changed ? result.text : text;
  next = rewriteEnvValue(next, "PONDER_ESCROW_CORE_ADDRESS", newEscrow);
  next = rewriteEnvValue(next, "LEGACY_ESCROW_CORE_ADDRESS", keepV1Drain ? oldEscrow : "");
  next = rewriteEnvValue(next, "PONDER_LEGACY_ESCROW_CORE_ADDRESS", keepV1Drain ? oldEscrow : "");
  if (next === text) return { skipped: true, reason: result.reason ?? "already up to date" };
  if (!dryRun) await writeFile(templatePath, next, "utf8");
  return { changed: true, previousValue: result.previousValue };
}

async function runFinalize({ args, deploymentsPath, manifest, provider, wiringState }) {
  if (!args.newEscrow || !/^0x[a-fA-F0-9]{40}$/u.test(args.newEscrow)) {
    throw new Error("--phase finalize requires --new-escrow 0xADDRESS.");
  }
  if (!args.deployTx || !/^0x[a-fA-F0-9]{64}$/u.test(args.deployTx)) {
    throw new Error("--phase finalize requires --deploy-tx 0xHASH (32-byte hex).");
  }
  if (!args.multisigExecTx || !/^0x[a-fA-F0-9]{64}$/u.test(args.multisigExecTx)) {
    throw new Error("--phase finalize requires --multisig-exec-tx 0xHASH (32-byte hex).");
  }
  const newEscrow = args.newEscrow;
  const oldEscrow = manifest.contracts.escrowCore;
  if (newEscrow.toLowerCase() === oldEscrow.toLowerCase()) {
    throw new Error(`--new-escrow ${newEscrow} matches current manifest.contracts.escrowCore — nothing to finalize.`);
  }

  console.log(`\n## Phase 3: finalize`);
  console.log(`  new escrow:        ${newEscrow}`);
  console.log(`  old escrow:        ${oldEscrow}`);
  console.log(`  deploy tx:         ${args.deployTx}`);
  console.log(`  multisig exec tx:  ${args.multisigExecTx}`);

  // 1. Read-only verification.
  const treasury = new Contract(manifest.contracts.treasuryPolicy, TREASURY_POLICY_ABI, provider);
  const accounts = new Contract(manifest.contracts.agentAccountCore, AGENT_ACCOUNT_READ_ABI, provider);
  const escrowV2 = new Contract(newEscrow, ESCROW_V2_READ_ABI, provider);
  const [
    newIsSettlementBroker,
    oldIsSettlementBroker,
    newIsReputationWriter,
    oldIsReputationWriter,
    newIsEscrowOperator,
    oldIsEscrowOperator,
    newCode,
    boundPolicy,
    boundAccounts,
    boundReputation,
    protocolFeeBps,
    maxProtocolFeeBps,
    treasuryAccount,
    deployReceipt
  ] = await Promise.all([
    treasury.settlementBroker(newEscrow),
    treasury.settlementBroker(oldEscrow),
    treasury.reputationWriter(newEscrow),
    treasury.reputationWriter(oldEscrow),
    accounts.escrowOperators(newEscrow),
    accounts.escrowOperators(oldEscrow),
    provider.getCode(newEscrow),
    escrowV2.policy(),
    escrowV2.accounts(),
    escrowV2.reputation(),
    escrowV2.protocolFeeBps(),
    escrowV2.MAX_PROTOCOL_FEE_BPS(),
    escrowV2.treasuryAccount(),
    provider.getTransactionReceipt(args.deployTx)
  ]);
  console.log("");
  console.log(`  settlementBroker[newEscrow]:             ${newIsSettlementBroker}  (expected: true)`);
  console.log(`  reputationWriter[newEscrow]:             ${newIsReputationWriter}  (expected: true)`);
  console.log(`  settlementBroker[oldEscrow]:             ${oldIsSettlementBroker}  (expected: --skip-revoke)`);
  console.log(`  reputationWriter[oldEscrow]:             ${oldIsReputationWriter}  (expected: --skip-revoke)`);
  console.log(`  AgentAccountCore.escrowOperators[new]:   ${newIsEscrowOperator}  (expected: true)`);
  console.log(`  AgentAccountCore.escrowOperators[old]:   ${oldIsEscrowOperator}  (expected: --skip-revoke)`);
  console.log(`  protocolFeeBps:                          ${protocolFeeBps}  (expected: 0)`);
  console.log(`  MAX_PROTOCOL_FEE_BPS:                    ${maxProtocolFeeBps}  (expected: 1000)`);
  console.log(`  treasuryAccount:                         ${treasuryAccount}`);
  console.log(`  newEscrow code size:                     ${newCode === "0x" ? 0 : (newCode.length - 2) / 2} bytes`);

  if (!newIsSettlementBroker) throw new Error(`TreasuryPolicy.settlementBroker[${newEscrow}] is false.`);
  if (!newIsReputationWriter) throw new Error(`TreasuryPolicy.reputationWriter[${newEscrow}] is false.`);
  if (!newIsEscrowOperator) {
    throw new Error(
      `On-chain check failed: AgentAccountCore.escrowOperators[${newEscrow}] is false. ` +
      `The multisig swap has not granted the escrow-only ledger role yet.`
    );
  }
  if (!args.skipRevoke && (oldIsSettlementBroker || oldIsReputationWriter)) {
    throw new Error(
      `On-chain check failed: TreasuryPolicy roles for ${oldEscrow} are still enabled. ` +
      `Either run revoke-old via the multisig (re-run the wire recipe without --skip-revoke) ` +
      `or pass --skip-revoke here to acknowledge.`
    );
  }
  if (!args.skipRevoke && oldIsEscrowOperator) {
    throw new Error(
      `On-chain check failed: AgentAccountCore.escrowOperators[${oldEscrow}] is still true. ` +
      `Either run revoke-old via the multisig (re-run the wire recipe without --skip-revoke) ` +
      `or pass --skip-revoke here to acknowledge.`
    );
  }
  if (newCode === "0x") {
    throw new Error(`No code at ${newEscrow}. Deploy did not land or address is wrong.`);
  }
  if (!deployReceipt || Number(deployReceipt.status) !== 1) {
    throw new Error(`Deploy transaction ${args.deployTx} is missing or unsuccessful.`);
  }
  assertAddress("deploy transaction sender", deployReceipt.from);
  const actualV2Deployer = deployReceipt.from;
  if (deployReceipt.contractAddress?.toLowerCase() !== newEscrow.toLowerCase()) {
    throw new Error(`Deploy transaction created ${deployReceipt.contractAddress}, not ${newEscrow}.`);
  }
  if (boundPolicy.toLowerCase() !== manifest.contracts.treasuryPolicy.toLowerCase()
    || boundAccounts.toLowerCase() !== manifest.contracts.agentAccountCore.toLowerCase()
    || boundReputation.toLowerCase() !== manifest.contracts.reputationSbt.toLowerCase()) {
    throw new Error("EscrowCore-v2 immutable constructor bindings do not match the deployment manifest.");
  }
  const expectedTreasuryAccount = manifest.treasuryAccount ?? manifest.treasuryReserve;
  if (treasuryAccount.toLowerCase() !== expectedTreasuryAccount.toLowerCase()) {
    throw new Error(`EscrowCore.treasuryAccount()=${treasuryAccount}; expected ${expectedTreasuryAccount}.`);
  }
  if (Number(protocolFeeBps) !== 0 || Number(maxProtocolFeeBps) !== 1_000) {
    throw new Error("EscrowCore-v2 must finalize with protocolFeeBps=0 and MAX_PROTOCOL_FEE_BPS=1000.");
  }
  if (args.skipRevoke && (!oldIsSettlementBroker || !oldIsReputationWriter || !oldIsEscrowOperator)) {
    throw new Error("v1 drain requested, but the old EscrowCore no longer has every role needed to settle open jobs.");
  }

  // 2. Manifest update.
  if (args.skipManifestUpdate) {
    console.log(`\n  Manifest update skipped (--skip-manifest-update).`);
  } else if (!args.dryRun) {
    await updateManifest({
      deploymentsPath,
      manifest,
      oldEscrow,
      newEscrow,
      deployer: actualV2Deployer,
      deployBlock: Number(deployReceipt.blockNumber),
      deployTx: args.deployTx,
      multisigExecTx: args.multisigExecTx,
      skipRevoke: args.skipRevoke
    });
    console.log(`\n  Wrote ${deploymentsPath}#contracts.escrowCore = ${newEscrow}`);
    console.log(`  Recorded deployers.escrowCoreV2 = ${actualV2Deployer}`);
    console.log(`  Recorded deploymentBlocks.escrowCoreV2 = ${Number(deployReceipt.blockNumber)}`);

    // Phase 2 PR 2.6 made deploy/backend.env.template the single source of
    // truth at deploy time; check-template-matches-manifest.mjs is the CI
    // guard. Keep the template in sync with the new escrow address or that
    // lint will fail on the next push.
    const templateNames = args.profile === "mainnet"
      ? ["backend.mainnet.env.template", "indexer.mainnet.env.template"]
      : ["backend.env.template", "indexer.env.template"];
    for (const templateName of templateNames) {
      const templatePath = resolve(repoRoot, "deploy", templateName);
      const tplResult = await syncEnvTemplate({
        templatePath,
        newEscrow,
        oldEscrow,
        keepV1Drain: args.skipRevoke,
        dryRun: false
      });
      console.log(`  ${templatePath}: ${tplResult.changed ? "updated current + drain addresses" : tplResult.reason}`);
    }
  } else {
    console.log(`\n  Manifest update planned (dry-run): would write contracts.escrowCore = ${newEscrow}`);
    console.log(`  Env template update planned (dry-run): would rewrite ESCROW_CORE_ADDRESS in deploy/backend.env.template`);
  }

  // 3. Audit re-run.
  let auditExitCode = null;
  if (args.skipAuditRerun) {
    console.log(`\n  Audit re-run skipped (--skip-audit-rerun).`);
  } else if (!args.dryRun) {
    console.log(`\n  Running audit-launch-readiness --profile ${args.profile}…`);
    console.log(`  --- audit output ---`);
    auditExitCode = await runAudit(args.profile);
    console.log(`  --- audit exit code: ${auditExitCode} ---`);
  } else {
    console.log(`\n  Audit re-run planned (dry-run): would invoke audit-launch-readiness --profile ${args.profile}`);
  }

  // 4. Summary.
  console.log(`\n## Summary`);
  console.log(JSON.stringify({
    profile: args.profile,
    newEscrow,
    oldEscrow,
    deployer: actualV2Deployer,
    txHashes: {
      deploy: args.deployTx,
      multisigExec: args.multisigExecTx,
      revokeOld: args.skipRevoke ? null : "batched-in-multisig-exec"
    },
    onchainAfter: {
      newEscrowIsSettlementBroker: newIsSettlementBroker,
      oldEscrowIsSettlementBroker: oldIsSettlementBroker,
      newEscrowIsReputationWriter: newIsReputationWriter,
      oldEscrowIsReputationWriter: oldIsReputationWriter,
      newEscrowIsAgentAccountEscrowOperator: newIsEscrowOperator,
      oldEscrowIsAgentAccountEscrowOperator: oldIsEscrowOperator,
      protocolFeeBps: Number(protocolFeeBps),
      treasuryAccount,
      newEscrowCodeBytes: newCode === "0x" ? 0 : (newCode.length - 2) / 2
    },
    auditExitCode
  }, null, 2));

  if (auditExitCode !== null && auditExitCode !== 0) {
    process.exitCode = 3;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!PHASES.has(args.phase)) {
    console.error(`--phase must be one of: ${[...PHASES].join(", ")}. Got: ${args.phase}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const { path: deploymentsPath, manifest } = await loadDeployments(args.profile);
  const deployPrediction = args.phase === "finalize"
    ? null
    : resolveDeployPredictionDeployer({
        expectedDeployer: args.expectedDeployer,
        historicalDeployer: manifest.deployer,
        commit: args.phase === "deploy" && !args.dryRun
      });
  const rpc = await createCeremonyRpcContext({
    manifest,
    phase: args.phase,
    write: args.phase === "deploy" && !args.dryRun
  });
  const { provider, writeBroadcaster } = rpc;

  console.log(`# redeploy-escrowcore`);
  console.log(`profile:               ${args.profile}`);
  console.log(`manifest:              ${deploymentsPath}`);
  printCeremonyRpcPreflight(rpc, (line) => console.log(line));
  const shouldCheckMainnetDeployerBalance =
    args.profile === "mainnet" &&
    (args.phase === "deploy" || (args.phase === "all" && args.expectedDeployer));
  if (shouldCheckMainnetDeployerBalance) {
    const balancePreflight = await assertMainnetPhaseOneDeployerBalance({
      provider,
      deployer: deployPrediction.address
    });
    console.log(
      `deployer balance:      ${formatUnits(balancePreflight.balanceWei, 18)} DOT ` +
      `(required >= ${formatUnits(balancePreflight.minimumWei, 18)} DOT) ✓`
    );
  } else if (args.profile === "mainnet" && args.phase === "all") {
    console.warn(
      "deployer balance:      not checked in overview without --expected-deployer"
    );
  }
  const wiringState = await readWiringState({ provider, manifest });
  console.log(`old escrow:            ${manifest.contracts.escrowCore}`);
  console.log(`treasury:              ${manifest.contracts.treasuryPolicy}`);
  console.log(`treasury.owner():      ${wiringState.owner} (multisig 12nHTKYf… H160 mapping)`);
  console.log(`old settlement broker? ${wiringState.oldIsSettlementBroker}`);
  console.log(`old reputation writer? ${wiringState.oldIsReputationWriter}`);
  console.log(`old AAC escrow op?:    ${wiringState.oldIsEscrowOperator}`);
  console.log(`historical v1 deployer: ${manifest.deployer}`);
  console.log(`phase:                 ${args.phase}`);
  console.log(`mode:                  ${args.dryRun ? "dry-run" : "commit"}`);

  // --phase finalize: read-only verify + manifest write + audit re-run.
  if (args.phase === "finalize") {
    await runFinalize({ args, deploymentsPath, manifest, provider, wiringState });
    return;
  }

  await runOrphanedBalancePreflight({ args, provider, manifest });

  // --phase deploy: print plan; with --commit, send EVM CREATE.
  if (args.phase === "deploy") {
    const artifact = await loadEscrowArtifact();
    assertArtifactHasBrokeredSelectors(artifact);
    console.log(`build runtime size:    ${(artifact.bytecode.length - 2) / 2} bytes creation`);
    console.log(`artifact brokered selectors: ${summarizeBrokeredSelectors(artifact)}`);
    if (deployPrediction.source !== "--expected-deployer") {
      console.warn(
        "warning: dry-run prediction uses historical manifest.deployer; " +
        "pass --expected-deployer for the actionable ceremony address."
      );
    }
    const plan = await planDeploy({
      provider,
      manifest,
      artifact,
      deployer: deployPrediction.address
    });
    printDeployPlan(plan);

    if (!args.dryRun) {
      const key = resolveSignerKey(args);
      const wallet = bindSignerToWriteBroadcaster(
        new Wallet(key),
        provider,
        writeBroadcaster
      );
      try {
        const walletAddress = await wallet.getAddress();
        console.log(`\n## Signer verification`);
        console.log(`  derived address: ${walletAddress}`);
        console.log(`  expected deployer: ${args.expectedDeployer}`);
        console.log(`  prediction sender: ${plan.deployer}`);
        const result = await verifyExpectedDeployerAndBroadcast({
          expectedDeployer: args.expectedDeployer,
          derivedSigner: walletAddress,
          predictionDeployer: plan.deployer,
          predictedAddress: plan.predicted,
          broadcast: async () => {
            console.log(`  ✓ signer and CREATE prediction match — broadcasting`);
            return commitDeploy({
              wallet,
              plan,
              artifact,
              writeBroadcaster
            });
          }
        });
        console.log("");
        console.log(JSON.stringify({
          phase: "deploy",
          profile: args.profile,
          txHash: result.txHash,
          blockNumber: result.blockNumber,
          providerUsed: result.providerUsed,
          newEscrow: result.newAddress,
          deployer: walletAddress,
          constructorArgs: plan.constructorArgs
        }, null, 2));
        console.log("");
        console.log("Next: generate the multisig wire recipe:");
        console.log(`  node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \\`);
        console.log(`    --new-escrow ${result.newAddress} --signer hot`);
        return;
      } finally {
        await writeBroadcaster.destroy();
      }
    }
    console.log(
      "\nDry-run only. Re-run with --commit + --expected-deployer + deployer key to send."
    );
    return;
  }

  // --phase all: print overview of every step (dry-run only).
  if (args.phase === "all") {
    if (!args.dryRun) {
      console.error("\n--phase all is dry-run only; pick deploy / finalize for --commit.");
      printUsage();
      process.exitCode = 1;
      return;
    }
    const artifact = await loadEscrowArtifact();
    assertArtifactHasBrokeredSelectors(artifact);
    console.log(`build runtime size:    ${(artifact.bytecode.length - 2) / 2} bytes creation`);
    console.log(`artifact brokered selectors: ${summarizeBrokeredSelectors(artifact)}`);
    if (deployPrediction.source !== "--expected-deployer") {
      console.warn(
        "warning: dry-run prediction uses historical manifest.deployer; " +
        "pass --expected-deployer for the actionable ceremony address."
      );
    }
    const plan = await planDeploy({
      provider,
      manifest,
      artifact,
      deployer: deployPrediction.address
    });
    printDeployPlan(plan);
    printWireOverview({ manifest, wiringState, predictedNewEscrow: plan.predicted });
    printFinalizeOverview();
    console.log("\nDry-run only. Use --phase deploy --commit / --phase finalize --commit to act.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`redeploy-escrowcore failed: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
