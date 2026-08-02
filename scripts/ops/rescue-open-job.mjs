#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  Contract,
  Interface,
  Wallet,
  encodeBytes32String,
  getAddress,
  isAddress,
  keccak256,
  toUtf8Bytes
} from "ethers";

import { KmsSigner } from "../../mcp-server/src/blockchain/kms-signer.js";
import { bindSignerToWriteBroadcaster } from "../../mcp-server/src/blockchain/rpc-provider.js";
import {
  createCeremonyRpcContext,
  printCeremonyRpcPreflight
} from "./ceremony-rpc.mjs";
import { loadKeyFromOp } from "./redeploy-escrowcore.mjs";

export const MIN_OPEN_AGE_SECONDS = 60 * 60;
export const REASON_OPERATOR_RESCUE = encodeBytes32String("OPERATOR_RESCUE");
export const TOMBSTONE_METADATA_URI =
  "https://github.com/averray-agent/agent/blob/main/docs/OPERATOR_RESCUE_TOMBSTONE.md";
export const JOB_STATE_NAMES = Object.freeze([
  "None",
  "Open",
  "Claimed",
  "Submitted",
  "Rejected",
  "Disputed",
  "Closed"
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOMBSTONE_DOCUMENT_PATH = path.resolve(
  HERE,
  "../../docs/OPERATOR_RESCUE_TOMBSTONE.md"
);
const BYTES32_RE = /^0x[0-9a-f]{64}$/iu;
const HASH_RE = /^0x[0-9a-f]{64}$/iu;
const DEFAULT_LOG_SCAN_CHUNK_SIZE = 25_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const ESCROW_ABI = [
  "function policy() view returns (address)",
  "function accounts() view returns (address)",
  "function DISPUTE_WINDOW() view returns (uint256)",
  "function claimTtls(bytes32 jobId) view returns (uint256)",
  "function workerClaimCount(address worker) view returns (uint256)",
  "function onboardingWaiverEligibleJobs(bytes32 jobId) view returns (bool)",
  "function latestEvidence(bytes32 jobId) view returns (bytes32)",
  "function previewClaimEconomics(address worker,bytes32 jobId) view returns (uint256 claimStake,uint16 claimStakeBps,uint256 claimFee,uint16 claimFeeBps,bool waived,uint256 claimNumber)",
  "function jobs(bytes32 jobId) view returns (tuple(address poster,address worker,address asset,bytes32 verifierMode,bytes32 category,bytes32 specHash,uint256 reward,uint256 opsReserve,uint256 contingencyReserve,uint256 released,uint256 claimExpiry,uint256 claimStake,uint16 claimStakeBps,uint256 claimFee,uint16 claimFeeBps,bool claimEconomicsWaived,address rejectingVerifier,uint256 rejectedAt,uint256 disputedAt,uint8 payoutMode,uint8 state,uint256 protocolFee,uint256 protocolFeeReleased,uint16 protocolFeeBps,bool protocolFeeWaived))",
  "function setOnboardingWaiverEligible(bytes32 jobId,bool eligible)",
  "function claimJobFor(bytes32 jobId,address worker)",
  "function submitWorkFor(bytes32 jobId,address worker,bytes32 evidenceHash)",
  "function resolveSinglePayout(bytes32 jobId,bool approved,bytes32 reasonCode,string metadataURI,bytes32 reasoningHash)",
  "function finalizeRejectedJob(bytes32 jobId)",
  "event JobCreated(bytes32 indexed jobId,address indexed poster,bytes32 indexed specHash,address asset,uint256 totalReserved,uint8 payoutMode)",
  "event JobRejected(bytes32 indexed jobId,bytes32 reasonCode)",
  "event JobClosed(bytes32 indexed jobId,address indexed worker,uint256 releasedAmount)"
];
const POLICY_ABI = [
  "function paused() view returns (bool)",
  "function settlementBroker(address account) view returns (bool)",
  "function verifiers(address account) view returns (bool)",
  "function onboardingWaiverClaimCount() view returns (uint256)"
];
const ACCOUNT_ABI = [
  "function positions(address account,address asset) view returns (uint256 liquid,uint256 reserved,uint256 strategyAllocated,uint256 collateralLocked,uint256 jobStakeLocked,uint256 debtOutstanding)"
];
const ESCROW_INTERFACE = new Interface(ESCROW_ABI);

export function parseArgs(argv) {
  const args = {
    profile: undefined,
    escrow: "current",
    phase: "prepare",
    jobId: undefined,
    janitor: undefined,
    expectedSigner: undefined,
    expectedPlanHash: undefined,
    signerSecretRef: undefined,
    useKms: false,
    execute: false,
    resume: false,
    confirm: undefined,
    minOpenAgeSeconds: MIN_OPEN_AGE_SECONDS,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value.`);
      }
      index += 1;
      return value;
    };
    switch (flag) {
      case "--profile": args.profile = next(); break;
      case "--escrow": args.escrow = next(); break;
      case "--phase": args.phase = next(); break;
      case "--job-id": args.jobId = next(); break;
      case "--janitor": args.janitor = next(); break;
      case "--expected-signer": args.expectedSigner = next(); break;
      case "--expected-plan-hash": args.expectedPlanHash = next(); break;
      case "--signer-secret-ref": args.signerSecretRef = next(); break;
      case "--confirm": args.confirm = next(); break;
      case "--min-open-age-seconds":
        args.minOpenAgeSeconds = parsePositiveInteger(next(), flag);
        break;
      case "--use-kms": args.useKms = true; break;
      case "--execute": args.execute = true; break;
      case "--dry-run": args.execute = false; break;
      case "--resume": args.resume = true; break;
      case "--help":
      case "-h": args.help = true; break;
      default: throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

export function validateArgs(args) {
  if (!new Set(["mainnet", "testnet"]).has(args.profile)) {
    throw new Error("--profile is required and must be mainnet or testnet.");
  }
  if (!new Set(["current", "legacy"]).has(args.escrow)) {
    throw new Error("--escrow must be current or legacy.");
  }
  if (!new Set(["prepare", "finalize"]).has(args.phase)) {
    throw new Error("--phase must be prepare or finalize.");
  }
  if (!BYTES32_RE.test(String(args.jobId ?? ""))) {
    throw new Error("--job-id must be an explicit 32-byte hex job ID.");
  }
  if (!isAddress(String(args.janitor ?? "")) || getAddress(args.janitor) === ZERO_ADDRESS) {
    throw new Error("--janitor must be the nonzero dedicated averray-janitor EVM address.");
  }
  if (args.expectedSigner !== undefined && !isAddress(String(args.expectedSigner))) {
    throw new Error("--expected-signer must be a valid EVM address.");
  }
  if (args.expectedPlanHash !== undefined && !HASH_RE.test(String(args.expectedPlanHash))) {
    throw new Error("--expected-plan-hash must be a 32-byte hex hash.");
  }
  if (args.minOpenAgeSeconds < MIN_OPEN_AGE_SECONDS) {
    throw new Error(
      `--min-open-age-seconds cannot be lower than the ${MIN_OPEN_AGE_SECONDS}-second safety floor.`
    );
  }
  if (args.resume && args.phase !== "prepare") {
    throw new Error("--resume applies only to --phase prepare.");
  }
  if (args.useKms && args.signerSecretRef) {
    throw new Error("Choose exactly one signer backend: --use-kms or --signer-secret-ref.");
  }
  if (args.execute) {
    if (!args.expectedPlanHash) {
      throw new Error("--execute requires --expected-plan-hash from a reviewed dry-run.");
    }
    if (!args.useKms && !args.signerSecretRef) {
      throw new Error("--execute requires --use-kms or --signer-secret-ref.");
    }
    if (args.signerSecretRef && !args.signerSecretRef.startsWith("op://")) {
      throw new Error("--signer-secret-ref must be an op:// item field reference.");
    }
    const expectedConfirmation = `${args.phase === "prepare" ? "RESCUE" : "FINALIZE"} ${args.jobId}`;
    if (args.confirm !== expectedConfirmation) {
      throw new Error(`--execute requires --confirm '${expectedConfirmation}'.`);
    }
  }
}

export function hashTombstoneDocument(content) {
  return keccak256(toUtf8Bytes(String(content)));
}

export async function loadTombstoneDocument(file = TOMBSTONE_DOCUMENT_PATH) {
  const content = await readFile(file, "utf8");
  return { file, content, hash: hashTombstoneDocument(content) };
}

export function resolveEscrowTarget(manifest, selection) {
  const contractKey = selection === "legacy" ? "legacyEscrowCore" : "escrowCore";
  const rawAddress = manifest?.contracts?.[contractKey];
  if (!isAddress(String(rawAddress ?? ""))) {
    throw new Error(`Deployment manifest has no valid contracts.${contractKey}.`);
  }
  const deploymentKey = selection === "legacy"
    ? "escrowCore"
    : (manifest?.deploymentBlocks?.escrowCoreV2 ? "escrowCoreV2" : "escrowCore");
  const deploymentBlock = Number(manifest?.deploymentBlocks?.[deploymentKey]);
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock <= 0) {
    throw new Error(`Deployment manifest has no valid deploymentBlocks.${deploymentKey}.`);
  }
  return {
    contractKey,
    address: getAddress(rawAddress),
    deploymentKey,
    deploymentBlock
  };
}

export async function findJobCreated({
  provider,
  escrowAddress,
  jobId,
  fromBlock,
  toBlock,
  chunkSize = DEFAULT_LOG_SCAN_CHUNK_SIZE,
  log = () => {}
}) {
  const event = ESCROW_INTERFACE.getEvent("JobCreated");
  const head = toBlock ?? await provider.getBlockNumber();
  if (fromBlock > head) {
    throw new Error(`JobCreated scan starts at ${fromBlock}, above chain head ${head}.`);
  }
  const chunks = Math.ceil((head - fromBlock + 1) / chunkSize);
  for (let cursor = fromBlock, index = 1; cursor <= head; cursor += chunkSize, index += 1) {
    const end = Math.min(head, cursor + chunkSize - 1);
    log(`JobCreated scan ${index}/${chunks}: blocks ${cursor}-${end}`);
    const logs = await provider.getLogs({
      address: escrowAddress,
      fromBlock: cursor,
      toBlock: end,
      topics: [event.topicHash, jobId]
    });
    if (logs.length > 1) {
      throw new Error(`Found ${logs.length} JobCreated events for ${jobId} in one escrow; refusing ambiguity.`);
    }
    if (logs.length === 1) {
      const parsed = ESCROW_INTERFACE.parseLog(logs[0]);
      if (!parsed) throw new Error("Matched JobCreated topic could not be decoded.");
      const block = await provider.getBlock(logs[0].blockNumber);
      if (!block) throw new Error(`Could not read JobCreated block ${logs[0].blockNumber}.`);
      return {
        blockNumber: logs[0].blockNumber,
        blockHash: logs[0].blockHash,
        transactionHash: logs[0].transactionHash,
        timestamp: Number(block.timestamp),
        poster: getAddress(parsed.args.poster),
        specHash: parsed.args.specHash
      };
    }
  }
  throw new Error(`No JobCreated event found for ${jobId} from deployment block ${fromBlock}.`);
}

export async function findRescueRejection({ provider, escrowAddress, jobId, fromBlock, toBlock }) {
  const event = ESCROW_INTERFACE.getEvent("JobRejected");
  const logs = await provider.getLogs({
    address: escrowAddress,
    fromBlock,
    toBlock: toBlock ?? "latest",
    topics: [event.topicHash, jobId]
  });
  const matching = logs
    .map((entry) => ({ entry, parsed: ESCROW_INTERFACE.parseLog(entry) }))
    .filter(({ parsed }) => parsed && parsed.args.reasonCode.toLowerCase() === REASON_OPERATOR_RESCUE.toLowerCase());
  if (matching.length !== 1) {
    throw new Error(
      `Expected exactly one JobRejected(${jobId}, OPERATOR_RESCUE) event; found ${matching.length}.`
    );
  }
  return {
    blockNumber: matching[0].entry.blockNumber,
    transactionHash: matching[0].entry.transactionHash,
    reasonCode: matching[0].parsed.args.reasonCode
  };
}

export function buildCallPlan({
  phase,
  jobId,
  janitor,
  escrowAddress,
  tombstoneHash,
  waiverEligible,
  state,
  resume = false
}) {
  const calls = [];
  const add = (label, functionName, args, authority) => calls.push({
    label,
    authority,
    to: escrowAddress,
    value: 0n,
    functionName,
    args,
    data: ESCROW_INTERFACE.encodeFunctionData(functionName, args)
  });
  if (phase === "finalize") {
    add("finalize rejected rescue", "finalizeRejectedJob", [jobId], "permissionless");
    return calls;
  }
  if (state === 1) {
    if (!waiverEligible) {
      add("enable onboarding waiver", "setOnboardingWaiverEligible", [jobId, true], "settlementBroker");
    }
    add("claim for janitor", "claimJobFor", [jobId, janitor], "settlementBroker");
    add("submit canonical tombstone", "submitWorkFor", [jobId, janitor, tombstoneHash], "settlementBroker");
    add(
      "reject as operator rescue",
      "resolveSinglePayout",
      [jobId, false, REASON_OPERATOR_RESCUE, TOMBSTONE_METADATA_URI, tombstoneHash],
      "verifier"
    );
    return calls;
  }
  if (!resume) return calls;
  if (state === 2) {
    add("submit canonical tombstone", "submitWorkFor", [jobId, janitor, tombstoneHash], "settlementBroker");
    add(
      "reject as operator rescue",
      "resolveSinglePayout",
      [jobId, false, REASON_OPERATOR_RESCUE, TOMBSTONE_METADATA_URI, tombstoneHash],
      "verifier"
    );
  } else if (state === 3) {
    add(
      "reject as operator rescue",
      "resolveSinglePayout",
      [jobId, false, REASON_OPERATOR_RESCUE, TOMBSTONE_METADATA_URI, tombstoneHash],
      "verifier"
    );
  }
  return calls;
}

export function assertPrepareEligible(snapshot, {
  janitor,
  minOpenAgeSeconds = MIN_OPEN_AGE_SECONDS,
  resume = false,
  tombstoneHash
}) {
  const state = Number(snapshot.job.state);
  if (!resume && state !== 1) {
    throw new Error(
      `Prepare requires Open (1); job is ${JOB_STATE_NAMES[state] ?? state}. ` +
      "Refusing to adopt an existing lifecycle."
    );
  }
  if (resume && !new Set([1, 2, 3, 4]).has(state)) {
    throw new Error(`Rescue resume cannot continue from ${JOB_STATE_NAMES[state] ?? state}.`);
  }
  if (Number(snapshot.job.payoutMode) !== 0) {
    throw new Error("Operator rescue supports Single payout jobs only.");
  }
  if (BigInt(snapshot.claimTtl) <= 0n) {
    throw new Error("claimTtls(jobId) is zero; tombstone submission cannot beat claim expiry.");
  }
  if (snapshot.paused) throw new Error("TreasuryPolicy is paused; rescue writes would revert.");
  if (!snapshot.signerIsSettlementBroker || !snapshot.signerIsVerifier) {
    throw new Error(
      "Expected signer must hold both settlementBroker and verifier roles for the prepare phase."
    );
  }
  if (getAddress(snapshot.job.poster) === getAddress(janitor)) {
    throw new Error("The dedicated janitor must be distinct from the recorded poster.");
  }
  if (state === 1 && BigInt(snapshot.workerClaimCount) >= BigInt(snapshot.waiverClaimCount)) {
    throw new Error(
      `Janitor waiver headroom exhausted: workerClaimCount=${snapshot.workerClaimCount}, ` +
      `onboardingWaiverClaimCount=${snapshot.waiverClaimCount}.`
    );
  }
  if (state === 1) {
    if (getAddress(snapshot.job.worker) !== ZERO_ADDRESS) {
      throw new Error("Open job unexpectedly has a recorded worker.");
    }
    if (snapshot.openAgeSeconds < minOpenAgeSeconds) {
      throw new Error(
        `Job is ${snapshot.openAgeSeconds}s old; minimum rescue safety floor is ${minOpenAgeSeconds}s.`
      );
    }
  }
  if (state === 2 || state === 3 || state === 4) {
    if (getAddress(snapshot.job.worker) !== getAddress(janitor)) {
      throw new Error("Partial rescue is bound to a different worker; refusing resume.");
    }
    if (!snapshot.job.claimEconomicsWaived || BigInt(snapshot.job.claimStake) !== 0n || BigInt(snapshot.job.claimFee) !== 0n) {
      throw new Error("Partial rescue is not fully waiver-backed; refusing resume.");
    }
  }
  if (state === 2 && Number(snapshot.job.claimExpiry) < Number(snapshot.chainTimestamp)) {
    throw new Error("Janitor claim already expired; tombstone submission is no longer safe.");
  }
  if ((state === 3 || state === 4) && String(snapshot.latestEvidence).toLowerCase() !== tombstoneHash.toLowerCase()) {
    throw new Error("Submitted evidence is not the canonical operator-rescue tombstone.");
  }
}

export function assertFinalizeEligible(snapshot, {
  janitor,
  tombstoneHash,
  requireWindowElapsed = true
}) {
  const state = Number(snapshot.job.state);
  if (state !== 4) {
    throw new Error(`Finalize requires Rejected (4); job is ${JOB_STATE_NAMES[state] ?? state}.`);
  }
  if (getAddress(snapshot.job.worker) !== getAddress(janitor)) {
    throw new Error("Rejected job worker is not the designated janitor.");
  }
  if (!snapshot.job.claimEconomicsWaived || BigInt(snapshot.job.claimStake) !== 0n || BigInt(snapshot.job.claimFee) !== 0n) {
    throw new Error("Rejected job is not a zero-economics janitor rescue.");
  }
  if (String(snapshot.latestEvidence).toLowerCase() !== tombstoneHash.toLowerCase()) {
    throw new Error("Rejected job does not carry the canonical operator-rescue tombstone.");
  }
  if (!snapshot.rescueRejection) {
    throw new Error("Canonical OPERATOR_RESCUE rejection event is missing.");
  }
  if (BigInt(snapshot.job.rejectedAt) <= 0n) {
    throw new Error("Rejected job has no rejection timestamp.");
  }
  const finalizeAfter = BigInt(snapshot.job.rejectedAt) + BigInt(snapshot.disputeWindow);
  const windowElapsed = BigInt(snapshot.chainTimestamp) > finalizeAfter;
  const secondsRemaining = windowElapsed
    ? 0n
    : finalizeAfter - BigInt(snapshot.chainTimestamp) + 1n;
  if (requireWindowElapsed && !windowElapsed) {
    throw new Error(
      `Dispute window is still active for ${secondsRemaining}s; ` +
      "finalizeRejectedJob is not yet callable."
    );
  }
  return { finalizeAfter, windowElapsed, secondsRemaining };
}

export function buildPlanHash({ chainId, escrowAddress, phase, jobId, janitor, calls }) {
  const canonical = JSON.stringify({
    version: "operator-rescue-plan-v1",
    chainId: Number(chainId),
    escrowAddress: getAddress(escrowAddress).toLowerCase(),
    phase,
    jobId: jobId.toLowerCase(),
    janitor: getAddress(janitor).toLowerCase(),
    calls: calls.map((call) => ({
      authority: call.authority,
      to: getAddress(call.to).toLowerCase(),
      value: String(call.value),
      data: call.data.toLowerCase()
    }))
  });
  return keccak256(toUtf8Bytes(canonical));
}

export function refundableTotal(job) {
  return (BigInt(job.reward) - BigInt(job.released))
    + (BigInt(job.protocolFee) - BigInt(job.protocolFeeReleased))
    + BigInt(job.opsReserve)
    + BigInt(job.contingencyReserve);
}

async function loadDeploymentManifest(profile) {
  const manifestPath = path.resolve(process.cwd(), `deployments/${profile}.json`);
  return { path: manifestPath, manifest: JSON.parse(await readFile(manifestPath, "utf8")) };
}

async function readSnapshot({
  provider,
  target,
  jobId,
  janitor,
  expectedSigner,
  phase,
  log
}) {
  const escrow = new Contract(target.address, ESCROW_ABI, provider);
  const [job, claimTtl, workerClaimCount, waiverEligible, latestEvidence, disputeWindow, policyAddress, accountsAddress, head] =
    await Promise.all([
      escrow.jobs(jobId),
      escrow.claimTtls(jobId),
      escrow.workerClaimCount(janitor),
      escrow.onboardingWaiverEligibleJobs(jobId),
      escrow.latestEvidence(jobId),
      escrow.DISPUTE_WINDOW(),
      escrow.policy(),
      escrow.accounts(),
      provider.getBlock("latest")
    ]);
  if (!head) throw new Error("Could not read the latest block.");
  const policy = new Contract(policyAddress, POLICY_ABI, provider);
  const [paused, signerIsSettlementBroker, signerIsVerifier, waiverClaimCount] = await Promise.all([
    policy.paused(),
    policy.settlementBroker(expectedSigner),
    policy.verifiers(expectedSigner),
    policy.onboardingWaiverClaimCount()
  ]);
  const creation = await findJobCreated({
    provider,
    escrowAddress: target.address,
    jobId,
    fromBlock: target.deploymentBlock,
    toBlock: head.number,
    log
  });
  if (getAddress(job.poster) !== creation.poster) {
    throw new Error(`JobCreated poster ${creation.poster} differs from live job poster ${job.poster}.`);
  }
  const accounts = new Contract(accountsAddress, ACCOUNT_ABI, provider);
  const posterPosition = await accounts.positions(job.poster, job.asset);
  let rescueRejection;
  if (phase === "finalize" || Number(job.state) === 4) {
    rescueRejection = await findRescueRejection({
      provider,
      escrowAddress: target.address,
      jobId,
      fromBlock: creation.blockNumber,
      toBlock: head.number
    });
  }
  return {
    escrow,
    accounts,
    policyAddress: getAddress(policyAddress),
    accountsAddress: getAddress(accountsAddress),
    job,
    claimTtl,
    workerClaimCount,
    waiverEligible,
    latestEvidence,
    disputeWindow,
    paused,
    signerIsSettlementBroker,
    signerIsVerifier,
    waiverClaimCount,
    creation,
    chainTimestamp: Number(head.timestamp),
    chainBlock: Number(head.number),
    openAgeSeconds: Number(head.timestamp) - creation.timestamp,
    posterPosition,
    rescueRejection
  };
}

async function createWriteSigner(args, rpc, dependencies) {
  const makeKmsSigner = dependencies.makeKmsSigner
    ?? ((options) => new KmsSigner(options));
  const makeWallet = dependencies.makeWallet
    ?? ((privateKey) => new Wallet(privateKey));
  if (args.useKms) {
    const keyId = String(process.env.KMS_KEY_ID ?? "").trim();
    const region = String(process.env.AWS_REGION ?? "").trim();
    if (!keyId || !region) {
      throw new Error("--use-kms requires KMS_KEY_ID and AWS_REGION.");
    }
    return bindSignerToWriteBroadcaster(
      makeKmsSigner({ keyId, region, provider: rpc.provider }),
      rpc.provider,
      rpc.writeBroadcaster
    );
  }
  const privateKey = (dependencies.loadSecret ?? loadKeyFromOp)(args.signerSecretRef);
  return bindSignerToWriteBroadcaster(
    makeWallet(privateKey),
    rpc.provider,
    rpc.writeBroadcaster
  );
}

function assertReceipt(receipt, label) {
  if (!receipt || Number(receipt.status) !== 1) {
    throw new Error(`${label} transaction did not succeed.`);
  }
}

async function sendCall(signer, call, log) {
  log(`sending:                  ${call.label}`);
  const tx = await signer.sendTransaction({ to: call.to, data: call.data, value: call.value });
  const receipt = await tx.wait();
  assertReceipt(receipt, call.label);
  log(`tx:                       ${receipt.hash} (block ${receipt.blockNumber})`);
  return receipt;
}

async function executePrepare({ args, signer, snapshot, calls, tombstoneHash, log }) {
  const escrowRead = snapshot.escrow;
  const receipts = [];
  for (const call of calls) {
    const receipt = await sendCall(signer, call, log);
    receipts.push({ label: call.label, hash: receipt.hash, blockNumber: receipt.blockNumber });
    const live = await escrowRead.jobs(args.jobId);
    if (call.functionName === "setOnboardingWaiverEligible") {
      const [eligible, economics] = await Promise.all([
        escrowRead.onboardingWaiverEligibleJobs(args.jobId),
        escrowRead.previewClaimEconomics(args.janitor, args.jobId)
      ]);
      if (!eligible || !economics.waived || BigInt(economics.claimStake) !== 0n || BigInt(economics.claimFee) !== 0n) {
        throw new Error("Waiver write landed but claim preview is not fully waived; stopping before claim.");
      }
    } else if (call.functionName === "claimJobFor") {
      if (Number(live.state) !== 2 || getAddress(live.worker) !== getAddress(args.janitor)
        || !live.claimEconomicsWaived || BigInt(live.claimStake) !== 0n || BigInt(live.claimFee) !== 0n) {
        throw new Error("claimJobFor landed without the exact zero-economics janitor claim.");
      }
    } else if (call.functionName === "submitWorkFor") {
      const evidence = await escrowRead.latestEvidence(args.jobId);
      if (Number(live.state) !== 3 || String(evidence).toLowerCase() !== tombstoneHash.toLowerCase()) {
        throw new Error("submitWorkFor landed without the canonical tombstone in Submitted state.");
      }
    } else if (call.functionName === "resolveSinglePayout") {
      if (Number(live.state) !== 4 || BigInt(live.rejectedAt) <= 0n) {
        throw new Error("Rescue rejection did not reach Rejected with a timestamp.");
      }
      const parsed = (receipt.logs ?? [])
        .map((entry) => ESCROW_INTERFACE.parseLog(entry))
        .find((entry) => entry?.name === "JobRejected");
      if (!parsed || String(parsed.args.reasonCode).toLowerCase() !== REASON_OPERATOR_RESCUE.toLowerCase()) {
        throw new Error("Rejection receipt is missing the canonical OPERATOR_RESCUE reason.");
      }
    }
  }
  return receipts;
}

async function executeFinalize({ args, signer, snapshot, calls, log }) {
  const before = snapshot.posterPosition;
  const expectedRefund = refundableTotal(snapshot.job);
  const receipt = await sendCall(signer, calls[0], log);
  const [jobAfter, positionAfter] = await Promise.all([
    snapshot.escrow.jobs(args.jobId),
    snapshot.accounts.positions(snapshot.job.poster, snapshot.job.asset)
  ]);
  if (Number(jobAfter.state) !== 6) throw new Error("finalizeRejectedJob did not close the job.");
  if (getAddress(jobAfter.poster) !== getAddress(snapshot.job.poster)) {
    throw new Error("Recorded poster changed during finalization.");
  }
  const liquidDelta = BigInt(positionAfter.liquid) - BigInt(before.liquid);
  const reservedDelta = BigInt(before.reserved) - BigInt(positionAfter.reserved);
  if (liquidDelta !== expectedRefund || reservedDelta !== expectedRefund) {
    throw new Error(
      `Poster refund mismatch: expected ${expectedRefund}, liquid delta ${liquidDelta}, ` +
      `reserved delta ${reservedDelta}.`
    );
  }
  log(`recorded poster:          ${getAddress(jobAfter.poster)} ✓`);
  log(`poster liquid before:     ${before.liquid}`);
  log(`poster liquid after:      ${positionAfter.liquid}`);
  log(`poster reserved before:   ${before.reserved}`);
  log(`poster reserved after:    ${positionAfter.reserved}`);
  log(`refunded raw:             ${expectedRefund} ✓`);
  return { hash: receipt.hash, blockNumber: receipt.blockNumber, expectedRefund };
}

export async function runRescue(args, dependencies = {}) {
  validateArgs(args);
  const loadManifest = dependencies.loadManifest ?? loadDeploymentManifest;
  const createRpc = dependencies.createRpc ?? createCeremonyRpcContext;
  const log = dependencies.log ?? console.log;
  const { path: manifestPath, manifest } = await loadManifest(args.profile);
  const target = resolveEscrowTarget(manifest, args.escrow);
  const expectedSigner = getAddress(args.expectedSigner ?? manifest.verifier ?? "");
  const tombstone = await (dependencies.loadTombstone ?? loadTombstoneDocument)();
  const rpc = await createRpc({
    manifest,
    phase: `rescue-open-job-${args.phase}`,
    write: args.execute,
    fetchImpl: dependencies.fetchImpl ?? fetch
  });
  try {
    log("# rescue-open-job");
    log(`profile:                  ${args.profile}`);
    log(`mode:                     ${args.execute ? "execute" : "dry-run"}`);
    log(`phase:                    ${args.phase}${args.resume ? " (resume)" : ""}`);
    log(`manifest:                 ${manifestPath}`);
    log(`escrow selection:         ${args.escrow} (${target.contractKey})`);
    log(`escrow:                   ${target.address}`);
    log(`deployment anchor:        ${target.deploymentBlock} (${target.deploymentKey})`);
    printCeremonyRpcPreflight(rpc, log);
    log(`job id:                   ${args.jobId}`);
    log(`janitor:                  ${getAddress(args.janitor)}`);
    log(`expected signer:          ${expectedSigner}`);
    log(`tombstone document:       ${path.relative(process.cwd(), tombstone.file)}`);
    log(`tombstone hash:           ${tombstone.hash}`);
    log(`rescue reason:            OPERATOR_RESCUE (${REASON_OPERATOR_RESCUE})`);

    const read = dependencies.readSnapshot ?? readSnapshot;
    const snapshot = await read({
      provider: rpc.provider,
      target,
      jobId: args.jobId,
      janitor: getAddress(args.janitor),
      expectedSigner,
      phase: args.phase,
      log
    });
    if (args.phase === "prepare") {
      assertPrepareEligible(snapshot, {
        janitor: args.janitor,
        minOpenAgeSeconds: args.minOpenAgeSeconds,
        resume: args.resume,
        tombstoneHash: tombstone.hash
      });
    } else {
      snapshot.finalizeReadiness = assertFinalizeEligible(snapshot, {
        janitor: args.janitor,
        tombstoneHash: tombstone.hash,
        requireWindowElapsed: args.execute
      });
    }

    const calls = buildCallPlan({
      phase: args.phase,
      jobId: args.jobId,
      janitor: getAddress(args.janitor),
      escrowAddress: target.address,
      tombstoneHash: tombstone.hash,
      waiverEligible: snapshot.waiverEligible,
      state: Number(snapshot.job.state),
      resume: args.resume
    });
    if (calls.length === 0) {
      throw new Error("Reviewed rescue phase contains no remaining call; refusing an empty execution.");
    }
    const planHash = buildPlanHash({
      chainId: rpc.chainId,
      escrowAddress: target.address,
      phase: args.phase,
      jobId: args.jobId,
      janitor: args.janitor,
      calls
    });
    printPlan({ args, snapshot, calls, planHash, log });

    if (!args.execute) {
      log("\nDry-run complete: no secret was read and no transaction was signed or sent.");
      return { mode: "dry-run", target, expectedSigner, tombstone, snapshot, calls, planHash };
    }
    if (args.expectedPlanHash.toLowerCase() !== planHash.toLowerCase()) {
      throw new Error(
        `Reviewed plan hash ${args.expectedPlanHash} does not match live plan ${planHash}; re-run dry-run and review.`
      );
    }
    const signer = await createWriteSigner(args, rpc, dependencies);
    const actualSigner = getAddress(await signer.getAddress());
    if (actualSigner !== expectedSigner) {
      throw new Error(`Signer resolves to ${actualSigner}; expected ${expectedSigner}. Refusing broadcast.`);
    }
    log(`signer derived:           ${actualSigner} ✓`);
    const result = args.phase === "prepare"
      ? await executePrepare({ args, signer, snapshot, calls, tombstoneHash: tombstone.hash, log })
      : await executeFinalize({ args, signer, snapshot, calls, log });
    log("\nRescue phase completed with all post-write assertions green.");
    return { mode: "execute", target, expectedSigner, tombstone, snapshot, calls, planHash, result };
  } finally {
    await rpc.writeBroadcaster?.destroy?.();
    await rpc.provider?.destroy?.();
  }
}

export function printPlan({ args, snapshot, calls, planHash, log = console.log }) {
  const state = Number(snapshot.job.state);
  log("\n## Live preconditions");
  log(`chain head:               ${snapshot.chainBlock} (${snapshot.chainTimestamp})`);
  log(`job state:                ${JOB_STATE_NAMES[state] ?? state} (${state})`);
  log(`payout mode:              ${snapshot.job.payoutMode} (Single=0)`);
  log(`recorded poster:          ${getAddress(snapshot.job.poster)}`);
  log(`recorded worker:          ${getAddress(snapshot.job.worker)}`);
  log(`asset:                    ${getAddress(snapshot.job.asset)}`);
  log(`reward raw:               ${snapshot.job.reward}`);
  log(`protocol fee raw:         ${snapshot.job.protocolFee}`);
  log(`ops reserve raw:          ${snapshot.job.opsReserve}`);
  log(`contingency reserve raw:  ${snapshot.job.contingencyReserve}`);
  log(`refundable raw:           ${refundableTotal(snapshot.job)}`);
  log(`claim TTL:                ${snapshot.claimTtl}s ✓`);
  log(`created block:            ${snapshot.creation.blockNumber}`);
  log(`open age:                 ${snapshot.openAgeSeconds}s`);
  log(`minimum open age:         ${args.minOpenAgeSeconds}s`);
  log(`waiver eligible now:      ${snapshot.waiverEligible}`);
  log(`janitor claims/cap:       ${snapshot.workerClaimCount}/${snapshot.waiverClaimCount}`);
  log(`policy paused:            ${snapshot.paused}`);
  if (args.phase === "prepare") {
    log(`signer settlementBroker: ${snapshot.signerIsSettlementBroker} ✓`);
    log(`signer verifier:         ${snapshot.signerIsVerifier} ✓`);
  } else {
    log(`rejected at:              ${snapshot.job.rejectedAt}`);
    log(`dispute window:           ${snapshot.disputeWindow}s`);
    log(`finalize after:           ${snapshot.finalizeReadiness.finalizeAfter}`);
    log(`window status:            ${snapshot.finalizeReadiness.windowElapsed
      ? "elapsed ✓"
      : `active (${snapshot.finalizeReadiness.secondsRemaining}s remaining)`}`);
    log(`rescue rejection tx:      ${snapshot.rescueRejection.transactionHash}`);
  }
  log("\n## Exact intended calls");
  calls.forEach((call, index) => {
    log(`${index + 1}. ${call.label}`);
    log(`   authority: ${call.authority}`);
    log(`   to:        ${call.to}`);
    log(`   value:     ${call.value}`);
    log(`   function:  ${call.functionName}`);
    log(`   args:      [${call.args.map(formatCallArgument).join(", ")}]`);
    log(`   calldata:  ${call.data}`);
  });
  if (args.phase === "prepare") {
    const finalData = ESCROW_INTERFACE.encodeFunctionData("finalizeRejectedJob", [args.jobId]);
    log(`${calls.length + 1}. future permissionless finalization (deferred until rejectedAt + live DISPUTE_WINDOW)`);
    log("   authority: permissionless");
    log(`   to:        ${calls[0].to}`);
    log("   value:     0");
    log("   function:  finalizeRejectedJob");
    log(`   calldata:  ${finalData}`);
  }
  log(`\nplan hash:                ${planHash}`);
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function formatCallArgument(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  return String(value);
}

function printUsage() {
  console.log(`Usage:
  node scripts/ops/rescue-open-job.mjs \\
    --profile mainnet --escrow current --phase prepare \\
    --job-id 0x... --janitor 0x... --expected-signer 0x...

Default mode is dry-run. It reads live state and prints every exact call plus a
plan hash, but reads no secret and signs nothing. Execution additionally needs:
  --expected-plan-hash 0x... --confirm 'RESCUE 0x...' --execute
  --use-kms
or:
  --signer-secret-ref 'op://vault/item/field'

After the live dispute window, use --phase finalize and confirmation
'FINALIZE 0x...'. Use --resume only after reviewing a partial prepare that is
already bound on-chain to the same janitor and canonical tombstone.`);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      return;
    }
    await runRescue(args);
  } catch (error) {
    console.error(`rescue-open-job failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
