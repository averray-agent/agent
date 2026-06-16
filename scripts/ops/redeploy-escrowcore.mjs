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
 *   1. deploy    EVM CREATE of a fresh EscrowCore, signed by the deployer
 *                EOA (deployments.deployer). One transaction.
 *
 *   2. wire      AgentAccountCore.setEscrowOperator(new, true) plus
 *                TreasuryPolicy.setServiceOperator(new, true) — and
 *                (recommended) revoke both old roles batched in
 *                utility.batchAll. The owner is the H160 of the SS58 2-of-3
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
 *   derived address (never the key). If it doesn't match
 *   deployments.<profile>.json#deployer, broadcast is aborted.
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
  JsonRpcProvider,
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

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const TREASURY_POLICY_ABI = [
  "function owner() view returns (address)",
  "function serviceOperators(address) view returns (bool)",
  "function setServiceOperator(address account, bool allowed)"
];

const AGENT_ACCOUNT_READ_ABI = [
  "function escrowOperators(address escrowOperator) view returns (bool)",
  "function setEscrowOperator(address escrowOperator, bool approved)",
  "function positions(address account, address asset) view returns (uint256 liquid,uint256 reserved,uint256 strategyAllocated,uint256 collateralLocked,uint256 jobStakeLocked,uint256 debtOutstanding)"
];

const ESCROW_TAIL_SCAN_ABI = [
  "function jobs(bytes32 jobId) view returns (address poster,address worker,address asset,bytes32 verifierMode,bytes32 category,bytes32 specHash,uint256 reward,uint256 opsReserve,uint256 contingencyReserve,uint256 released,uint256 claimExpiry,uint256 claimStake,uint16 claimStakeBps,uint256 claimFee,uint16 claimFeeBps,bool claimEconomicsWaived,address rejectingVerifier,uint256 rejectedAt,uint256 disputedAt,uint8 payoutMode,uint8 state)",
  "event JobCreated(bytes32 indexed jobId,address indexed poster,bytes32 indexed specHash,address asset,uint256 totalReserved,uint8 payoutMode)",
  "event JobFunded(bytes32 indexed jobId,address indexed poster,address indexed asset,uint256 totalReserved,uint8 payoutMode)",
  "event RecurringJobFundedFromTemplate(bytes32 indexed jobId,bytes32 indexed templateId,address indexed poster,address asset,uint256 totalReserved)",
  "event JobClaimed(bytes32 indexed jobId,address indexed worker,uint256 claimExpiry,uint256 claimStake)",
  "event ClaimEconomicsLocked(bytes32 indexed jobId,address indexed worker,uint256 claimStake,uint256 claimFee,bool waived,uint256 claimNumber)",
  "event WorkSubmitted(bytes32 indexed jobId,address indexed worker,bytes32 evidenceHash)",
  "event Submitted(bytes32 indexed jobId,address indexed worker,bytes32 indexed payloadHash)",
  "event JobReopened(bytes32 indexed jobId)",
  "event JobRejected(bytes32 indexed jobId,bytes32 reasonCode)",
  "event Verified(bytes32 indexed jobId,address indexed verifier,bool approved,bytes32 reasonCode,bytes32 reasoningHash)",
  "event DisputeOpened(bytes32 indexed jobId,address indexed opener,uint256 disputedAt)",
  "event DisputeResolved(bytes32 indexed jobId,address indexed arbitrator,uint256 workerPayout,bytes32 reasonCode,string metadataURI)",
  "event AutoResolvedOnTimeout(bytes32 indexed jobId,address indexed caller,uint256 workerPayout,bytes32 reasonCode)",
  "event JobClosed(bytes32 indexed jobId,address indexed worker,uint256 releasedAmount)"
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
    signerSecretRef: undefined,
    skipRevoke: false,
    skipManifestUpdate: false,
    skipAuditRerun: false,
    acknowledgeOrphanedBalances: false,
    orphanScanFromBlock: 0,
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
    else if (arg === "--signer-secret-ref") args.signerSecretRef = argv[++i];
    else if (arg === "--skip-revoke") args.skipRevoke = true;
    else if (arg === "--skip-manifest-update") args.skipManifestUpdate = true;
    else if (arg === "--skip-audit-rerun") args.skipAuditRerun = true;
    else if (arg === "--acknowledge-orphaned-balances") args.acknowledgeOrphanedBalances = true;
    else if (arg === "--orphan-scan-from-block") args.orphanScanFromBlock = Number(argv[++i]);
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
      "  --orphan-scan-from-block <n>",
      "                            First block to scan for old EscrowCore job events",
      "                            (default: 0).",
      "  --orphan-scan-chunk-size <n>",
      `                            getLogs chunk size (default: ${DEFAULT_ORPHAN_SCAN_CHUNK_SIZE}).`,
      "",
      "Phase 1 (deploy) options:",
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
const REQUIRED_BROKERED_FNS = ["claimJobFor", "submitWorkFor", "openDisputeFor"];

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
  return REQUIRED_BROKERED_FNS
    .map((name) => `${name}=${artifact.abi.some((f) => f.name === name)}`)
    .join(" ");
}

export function assertArtifactHasBrokeredSelectors(artifact) {
  const missing = REQUIRED_BROKERED_FNS.filter((name) => !artifact.abi.some((f) => f.name === name));
  if (missing.length) {
    throw new Error(
      `Build artifact is missing operator-brokered selector(s): ${missing.join(", ")}. ` +
      "Run `forge build` on a source tree that defines them before redeploying " +
      "(else the new EscrowCore would reproduce the Unauthorized worker-loop blocker)."
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

function assertTxHash(label, value) {
  if (!/^0x[a-fA-F0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is not a valid 32-byte tx hash: ${value}`);
  }
}

async function planDeploy({ provider, manifest, artifact }) {
  const treasury = manifest.contracts.treasuryPolicy;
  const accounts = manifest.contracts.agentAccountCore;
  const reputation = manifest.contracts.reputationSbt;
  assertAddress("contracts.treasuryPolicy", treasury);
  assertAddress("contracts.agentAccountCore", accounts);
  assertAddress("contracts.reputationSbt", reputation);

  const constructorArgs = [treasury, accounts, reputation];
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, undefined);
  const deployTx = await factory.getDeployTransaction(...constructorArgs);

  const deployer = manifest.deployer;
  assertAddress("deployments.deployer", deployer);
  const nonce = await provider.getTransactionCount(deployer);
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

async function readWiringState({ provider, manifest }) {
  const treasury = new Contract(manifest.contracts.treasuryPolicy, TREASURY_POLICY_ABI, provider);
  const accounts = new Contract(manifest.contracts.agentAccountCore, AGENT_ACCOUNT_READ_ABI, provider);
  const [owner, oldIsOperator, oldIsEscrowOperator] = await Promise.all([
    treasury.owner(),
    treasury.serviceOperators(manifest.contracts.escrowCore),
    accounts.escrowOperators(manifest.contracts.escrowCore)
  ]);
  return { owner, oldIsOperator, oldIsEscrowOperator };
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

export async function collectOldEscrowJobIds({ provider, escrowAddress, fromBlock = 0, toBlock, chunkSize = DEFAULT_ORPHAN_SCAN_CHUNK_SIZE }) {
  assertPositiveInteger("fromBlock", fromBlock);
  assertPositiveInteger("chunkSize", chunkSize);
  if (chunkSize === 0) throw new Error("chunkSize must be greater than 0.");
  const latest = toBlock ?? await provider.getBlockNumber();
  assertPositiveInteger("toBlock", latest);

  const iface = new Interface(ESCROW_TAIL_SCAN_ABI);
  const jobIds = new Set();
  let scannedLogCount = 0;

  for (let from = fromBlock; from <= latest; from += chunkSize) {
    const to = Math.min(latest, from + chunkSize - 1);
    const logs = await provider.getLogs({ address: escrowAddress, fromBlock: from, toBlock: to });
    scannedLogCount += logs.length;
    for (const log of logs) {
      let parsed;
      try {
        parsed = iface.parseLog(log);
      } catch {
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
    jobIds: [...jobIds].sort()
  };
}

export async function findUnsettledOldEscrowBalances({ provider, manifest, fromBlock = 0, chunkSize = DEFAULT_ORPHAN_SCAN_CHUNK_SIZE }) {
  const oldEscrow = manifest.contracts.escrowCore;
  const accountCore = manifest.contracts.agentAccountCore;
  assertAddress("contracts.escrowCore", oldEscrow);
  assertAddress("contracts.agentAccountCore", accountCore);

  const scan = await collectOldEscrowJobIds({ provider, escrowAddress: oldEscrow, fromBlock, chunkSize });
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
      toBlock: scan.toBlock,
      chunkSize: scan.chunkSize,
      scannedLogCount: scan.scannedLogCount,
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
  if (!report.findings.length) {
    return {
      ok: true,
      acknowledged: false,
      message: `No unsettled old EscrowCore jobs with non-zero AAC reserved/jobStakeLocked tails found across ${report.scan.scannedJobCount} scanned job(s).`
    };
  }

  const body = report.findings.map(formatOrphanedBalanceFinding).join("\n");
  const message = [
    `${report.findings.length} unsettled old EscrowCore job(s) still touch AAC reserved/jobStakeLocked balances.`,
    `Retiring ${report.oldEscrow} from AgentAccountCore.escrowOperators can orphan those balances because normal escrow release paths must call escrow-only AgentAccountCore mutation functions.`,
    "",
    body
  ].join("\n");

  if (acknowledge) {
    return {
      ok: true,
      acknowledged: true,
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
    chunkSize: args.orphanScanChunkSize
  });
  const decision = evaluateOrphanedBalancePreflight(report, {
    acknowledge: args.acknowledgeOrphanedBalances
  });
  const log = decision.acknowledged ? console.warn : console.log;
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

async function commitDeploy({ wallet, plan, artifact }) {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
  console.log(`\nSending deploy tx…`);
  const contract = await factory.deploy(...plan.constructorArgs);
  const tx = contract.deploymentTransaction();
  console.log(`  tx:        ${tx?.hash}`);
  await contract.waitForDeployment();
  const newAddress = await contract.getAddress();
  console.log(`  deployed:  ${newAddress}`);
  const receipt = await tx.wait();
  return { newAddress, txHash: tx.hash, blockNumber: receipt?.blockNumber ?? null };
}

function printDeployPlan(plan) {
  console.log(`\n## Phase 1: deploy (EVM CREATE, deployer EOA)`);
  console.log(`  signer:        deployer ${plan.deployer}`);
  console.log(`  signer nonce:  ${plan.nonce}`);
  console.log(`  to:            (CREATE — no recipient)`);
  console.log(`  data length:   ${plan.creationDataLength} bytes (bytecode + abi.encode(constructor args))`);
  console.log(`  data prefix:   ${plan.creationDataPrefix}`);
  console.log(`  constructor:   EscrowCore(${plan.constructorArgs.join(", ")})`);
  console.log(`  predicted addr: ${plan.predicted}`);
  console.log(`  (prediction assumes no other tx from the deployer lands between dry-run and commit.)`);
}

function printWireOverview({ manifest, wiringState, predictedNewEscrow }) {
  const placeholder = predictedNewEscrow ?? "<NEW_ESCROW>";
  const policyIface = new Interface(TREASURY_POLICY_ABI);
  const accountIface = new Interface(AGENT_ACCOUNT_READ_ABI);
  const approveAccountData = accountIface.encodeFunctionData("setEscrowOperator", [placeholder, true]);
  const approvePolicyData = policyIface.encodeFunctionData("setServiceOperator", [placeholder, true]);
  const revokeAccountData = accountIface.encodeFunctionData("setEscrowOperator", [manifest.contracts.escrowCore, false]);
  const revokePolicyData = policyIface.encodeFunctionData("setServiceOperator", [manifest.contracts.escrowCore, false]);

  console.log(`\n## Phase 2: wire (multisig.asMulti via Apps, NOT this script)`);
  console.log(`  owner is the H160 of SS58 multisig — no private key. Generate the recipe with:`);
  console.log(`    node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \\`);
  console.log(`      --new-escrow ${placeholder} --signer hot`);
  console.log(`  then sign in polkadot-js-apps, record {height, index}, run again with --signer ledger.`);
  console.log("");
  console.log(`  Inner EVM calldata that the recipe will wrap (for review):`);
  console.log(`    [1] AgentAccountCore.setEscrowOperator(${placeholder}, true)`);
  console.log(`        to:   ${manifest.contracts.agentAccountCore}`);
  console.log(`        data: ${approveAccountData}`);
  console.log(`    [2] TreasuryPolicy.setServiceOperator(${placeholder}, true)`);
  console.log(`        to:   ${manifest.contracts.treasuryPolicy}`);
  console.log(`        data: ${approvePolicyData}`);
  console.log(`    [3] AgentAccountCore.setEscrowOperator(${manifest.contracts.escrowCore}, false)`);
  console.log(`        to:   ${manifest.contracts.agentAccountCore}`);
  console.log(`        data: ${revokeAccountData}`);
  console.log(`    [4] TreasuryPolicy.setServiceOperator(${manifest.contracts.escrowCore}, false)`);
  console.log(`        to:   ${manifest.contracts.treasuryPolicy}`);
  console.log(`        data: ${revokePolicyData}`);
  console.log("");
  console.log(`  Owner (multisig SS58):           12nHTKYfV64pnxsVRB6Cjn6kQPPH64Ehnr8zgqZxvfa8hJvQ`);
  console.log(`  Owner (H160 onchain):            ${wiringState.owner}`);
  console.log(`  Old policy operator currently:   ${wiringState.oldIsOperator}`);
  console.log(`  Old AAC escrow operator now:     ${wiringState.oldIsEscrowOperator}`);
}

function printFinalizeOverview() {
  console.log(`\n## Phase 3: finalize (verify, update manifest, re-run audit)`);
  console.log(`  After the multisig.MultisigExecuted event lands on chain:`);
  console.log(`    node scripts/ops/redeploy-escrowcore.mjs --phase finalize \\`);
  console.log(`      --new-escrow 0xNEW \\`);
  console.log(`      --deploy-tx 0xDEPLOY \\`);
  console.log(`      --multisig-exec-tx 0xEXEC --commit`);
  console.log(`  This re-reads on-chain state to confirm the swap, then updates`);
  console.log(`  deployments/<profile>.json and runs audit-launch-readiness.`);
}

async function updateManifest({ deploymentsPath, manifest, newEscrow, deployTx, multisigExecTx, skipRevoke }) {
  manifest.contracts.escrowCore = newEscrow;
  manifest.escrowRedeployedAt = new Date().toISOString();
  manifest.escrowRedeployTxHashes = {
    deploy: deployTx,
    multisigExec: multisigExecTx,
    revokeOld: skipRevoke ? null : "batched-in-multisig-exec"
  };
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

async function syncEnvTemplate({ templatePath, newEscrow, dryRun }) {
  let text;
  try {
    text = await readFile(templatePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { skipped: true, reason: "template file not found" };
    throw error;
  }
  const result = rewriteEscrowAddressInTemplate(text, newEscrow);
  if (!result.changed) return { skipped: true, reason: result.reason };
  if (!dryRun) await writeFile(templatePath, result.text, "utf8");
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
  const [newIsOperator, oldIsOperator, newIsEscrowOperator, oldIsEscrowOperator, newCode] = await Promise.all([
    treasury.serviceOperators(newEscrow),
    treasury.serviceOperators(oldEscrow),
    accounts.escrowOperators(newEscrow),
    accounts.escrowOperators(oldEscrow),
    provider.getCode(newEscrow)
  ]);
  console.log("");
  console.log(`  serviceOperators[newEscrow]:             ${newIsOperator}  (expected: true)`);
  console.log(`  serviceOperators[oldEscrow]:             ${oldIsOperator}  (expected: false unless --skip-revoke)`);
  console.log(`  AgentAccountCore.escrowOperators[new]:   ${newIsEscrowOperator}  (expected: true)`);
  console.log(`  AgentAccountCore.escrowOperators[old]:   ${oldIsEscrowOperator}  (expected: false unless --skip-revoke)`);
  console.log(`  newEscrow code size:                     ${newCode === "0x" ? 0 : (newCode.length - 2) / 2} bytes`);

  if (!newIsOperator) {
    throw new Error(
      `On-chain check failed: serviceOperators[${newEscrow}] is false. ` +
      `The multisig swap has not landed yet — re-run finalize after multisig.MultisigExecuted fires.`
    );
  }
  if (!newIsEscrowOperator) {
    throw new Error(
      `On-chain check failed: AgentAccountCore.escrowOperators[${newEscrow}] is false. ` +
      `The multisig swap has not granted the escrow-only ledger role yet.`
    );
  }
  if (!args.skipRevoke && oldIsOperator) {
    throw new Error(
      `On-chain check failed: serviceOperators[${oldEscrow}] is still true. ` +
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

  // 2. Manifest update.
  if (args.skipManifestUpdate) {
    console.log(`\n  Manifest update skipped (--skip-manifest-update).`);
  } else if (!args.dryRun) {
    await updateManifest({
      deploymentsPath,
      manifest,
      newEscrow,
      deployTx: args.deployTx,
      multisigExecTx: args.multisigExecTx,
      skipRevoke: args.skipRevoke
    });
    console.log(`\n  Wrote ${deploymentsPath}#contracts.escrowCore = ${newEscrow}`);

    // Phase 2 PR 2.6 made deploy/backend.env.template the single source of
    // truth at deploy time; check-template-matches-manifest.mjs is the CI
    // guard. Keep the template in sync with the new escrow address or that
    // lint will fail on the next push.
    const templatePath = resolve(repoRoot, "deploy", "backend.env.template");
    const tplResult = await syncEnvTemplate({ templatePath, newEscrow, dryRun: false });
    if (tplResult.changed) {
      console.log(`  Wrote ${templatePath}#ESCROW_CORE_ADDRESS = ${newEscrow}  (was ${tplResult.previousValue})`);
    } else {
      console.log(`  ${templatePath}: no change needed (${tplResult.reason})`);
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
    txHashes: {
      deploy: args.deployTx,
      multisigExec: args.multisigExecTx,
      revokeOld: args.skipRevoke ? null : "batched-in-multisig-exec"
    },
    onchainAfter: {
      newEscrowIsOperator: newIsOperator,
      oldEscrowIsOperator: oldIsOperator,
      newEscrowIsAgentAccountEscrowOperator: newIsEscrowOperator,
      oldEscrowIsAgentAccountEscrowOperator: oldIsEscrowOperator,
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
  const provider = new JsonRpcProvider(manifest.rpcUrl);
  const wiringState = await readWiringState({ provider, manifest });

  console.log(`# redeploy-escrowcore`);
  console.log(`profile:               ${args.profile}`);
  console.log(`manifest:              ${deploymentsPath}`);
  console.log(`rpc:                   ${manifest.rpcUrl}`);
  console.log(`old escrow:            ${manifest.contracts.escrowCore}`);
  console.log(`treasury:              ${manifest.contracts.treasuryPolicy}`);
  console.log(`treasury.owner():      ${wiringState.owner} (multisig 12nHTKYf… H160 mapping)`);
  console.log(`old policy operator?:  ${wiringState.oldIsOperator}`);
  console.log(`old AAC escrow op?:    ${wiringState.oldIsEscrowOperator}`);
  console.log(`deployer (manifest):   ${manifest.deployer}`);
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
    const plan = await planDeploy({ provider, manifest, artifact });
    printDeployPlan(plan);

    if (!args.dryRun) {
      const key = resolveSignerKey(args);
      const wallet = new Wallet(key, provider);
      console.log(`\n## Signer verification`);
      console.log(`  derived address: ${wallet.address}`);
      console.log(`  manifest.deployer: ${plan.deployer}`);
      if (wallet.address.toLowerCase() !== plan.deployer.toLowerCase()) {
        console.error(`\nSigner ${wallet.address} does not match manifest.deployer ${plan.deployer}. Aborting.`);
        process.exitCode = 2;
        return;
      }
      console.log(`  ✓ match — broadcasting`);
      const result = await commitDeploy({ wallet, plan, artifact });
      console.log("");
      console.log(JSON.stringify({
        phase: "deploy",
        profile: args.profile,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        newEscrow: result.newAddress,
        deployer: wallet.address,
        constructorArgs: plan.constructorArgs
      }, null, 2));
      console.log("");
      console.log("Next: generate the multisig wire recipe:");
      console.log(`  node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \\`);
      console.log(`    --new-escrow ${result.newAddress} --signer hot`);
      return;
    }
    console.log("\nDry-run only. Re-run with --commit + deployer key to send.");
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
    const plan = await planDeploy({ provider, manifest, artifact });
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
