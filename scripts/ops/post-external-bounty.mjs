#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  Contract,
  Interface,
  Wallet,
  formatUnits,
  getAddress,
  isAddress
} from "ethers";

import { bindSignerToWriteBroadcaster } from "../../mcp-server/src/blockchain/rpc-provider.js";
import { hashCanonicalContent } from "../../mcp-server/src/core/canonical-content.js";
import {
  createCeremonyRpcContext,
  printCeremonyRpcPreflight
} from "./ceremony-rpc.mjs";
import { loadKeyFromOp } from "./redeploy-escrowcore.mjs";

export const CREATE_SINGLE_PAYOUT_SIGNATURE =
  "createSinglePayoutJob(bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32)";
export const EXPECTED_PROTOCOL_FEE_BPS = 500n;
export const USDC_DECIMALS = 6;

const DEFAULT_API_BASE_URL = "https://api.averray.com";
const DEFAULT_WATCH_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_WATCH_INTERVAL_MS = 10_000;
const BYTES32_RE = /^0x[0-9a-f]{64}$/iu;

const ESCROW_ABI = [
  `function ${CREATE_SINGLE_PAYOUT_SIGNATURE}`,
  "function protocolFeeBps() view returns (uint16)",
  "function previewProtocolFee(uint256 reward) view returns (uint256)",
  "function treasuryAccount() view returns (address)",
  "function jobs(bytes32 jobId) view returns (tuple(address poster,address worker,address asset,bytes32 verifierMode,bytes32 category,bytes32 specHash,uint256 reward,uint256 opsReserve,uint256 contingencyReserve,uint256 released,uint256 claimExpiry,uint256 claimStake,uint16 claimStakeBps,uint256 claimFee,uint16 claimFeeBps,bool claimEconomicsWaived,address rejectingVerifier,uint256 rejectedAt,uint256 disputedAt,uint8 payoutMode,uint8 state,uint256 protocolFee,uint256 protocolFeeReleased,uint16 protocolFeeBps,bool protocolFeeWaived))",
  "event JobFunded(bytes32 indexed jobId,address indexed poster,address indexed asset,uint256 totalReserved,uint8 payoutMode)",
  "event JobCreated(bytes32 indexed jobId,address indexed poster,bytes32 indexed specHash,address asset,uint256 totalReserved,uint8 payoutMode)"
];
const AGENT_ACCOUNT_ABI = [
  "function positions(address account,address asset) view returns (uint256 liquid,uint256 reserved,uint256 strategyAllocated,uint256 collateralLocked,uint256 jobStakeLocked,uint256 debtOutstanding)",
  "function deposit(address asset,uint256 amount)"
];
const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

const CREATE_INTERFACE = new Interface(ESCROW_ABI);

export function parseArgs(argv) {
  const args = {
    profile: undefined,
    apiBaseUrl: DEFAULT_API_BASE_URL,
    definitionFile: undefined,
    draftId: undefined,
    signerSecretRef: undefined,
    expectedPoster: undefined,
    execute: false,
    task: undefined,
    repo: undefined,
    rewardUsdc: undefined,
    verifierMode: undefined,
    acceptanceCriteria: [],
    watchTimeoutMs: DEFAULT_WATCH_TIMEOUT_MS,
    watchIntervalMs: DEFAULT_WATCH_INTERVAL_MS,
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
      case "--profile":
        args.profile = next();
        break;
      case "--api-base-url":
        args.apiBaseUrl = next();
        break;
      case "--definition-file":
        args.definitionFile = next();
        break;
      case "--draft-id":
        args.draftId = next();
        break;
      case "--signer-secret-ref":
        args.signerSecretRef = next();
        break;
      case "--expected-poster":
        args.expectedPoster = next();
        break;
      case "--task":
        args.task = next();
        break;
      case "--repo":
        args.repo = next();
        break;
      case "--reward-usdc":
        args.rewardUsdc = next();
        break;
      case "--verifier-mode":
        args.verifierMode = next();
        break;
      case "--acceptance-criterion":
        args.acceptanceCriteria.push(next());
        break;
      case "--watch-timeout-ms":
        args.watchTimeoutMs = parsePositiveInteger(next(), flag);
        break;
      case "--watch-interval-ms":
        args.watchIntervalMs = parsePositiveInteger(next(), flag);
        break;
      case "--execute":
        args.execute = true;
        break;
      case "--dry-run":
        args.execute = false;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

export function validateArgs(args) {
  if (!args.profile) {
    throw new Error("--profile is required; refusing to default an ops transfer to testnet or mainnet.");
  }
  if (!new Set(["mainnet", "testnet"]).has(args.profile)) {
    throw new Error("--profile must be mainnet or testnet.");
  }
  if (!args.signerSecretRef?.startsWith("op://")) {
    throw new Error("--signer-secret-ref must be an op:// item field reference.");
  }
  if (!isAddress(String(args.expectedPoster ?? ""))) {
    throw new Error("--expected-poster must be a valid EVM address.");
  }
  if (args.draftId && !BYTES32_RE.test(args.draftId)) {
    throw new Error("--draft-id must be a 32-byte hex value.");
  }
  if (args.execute && !args.draftId) {
    throw new Error(
      "--execute requires --draft-id from a reviewed dry-run; refusing to create and fund unreviewed calldata."
    );
  }
  if (!args.definitionFile && !(args.task && args.repo && args.rewardUsdc && args.verifierMode)) {
    throw new Error(
      "Pass --definition-file, or all of --task, --repo, --reward-usdc, and --verifier-mode."
    );
  }
  if (!args.definitionFile && args.acceptanceCriteria.length === 0) {
    throw new Error("Inline definitions require at least one --acceptance-criterion.");
  }
  const url = new URL(args.apiBaseUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("--api-base-url must use HTTPS except for localhost.");
  }
}

export async function loadDefinition(args, { cwd = process.cwd() } = {}) {
  if (args.definitionFile) {
    const absolutePath = path.resolve(cwd, args.definitionFile);
    const definition = JSON.parse(await readFile(absolutePath, "utf8"));
    return { definition, definitionPath: absolutePath };
  }
  const definition = {
    title: `Audit and report on ${args.repo}`,
    description: args.task,
    category: "coding",
    tier: "starter",
    jobType: "work",
    requiredRole: "worker",
    rewardAsset: "USDC",
    rewardAmount: String(args.rewardUsdc),
    verifierMode: String(args.verifierMode),
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    input: {
      task: args.task,
      acceptanceCriteria: args.acceptanceCriteria,
      repo: args.repo
    },
    acceptanceCriteria: args.acceptanceCriteria,
    claimTtlSeconds: 86_400,
    retryLimit: 1,
    requiresSponsoredGas: true
  };
  return { definition, definitionPath: "inline flags" };
}

export function buildFundingMath({
  rewardRaw,
  opsReserveRaw,
  contingencyReserveRaw,
  protocolFeeBps,
  previewProtocolFeeRaw,
  expectedProtocolFeeBps = EXPECTED_PROTOCOL_FEE_BPS
}) {
  const reward = BigInt(rewardRaw);
  const opsReserve = BigInt(opsReserveRaw);
  const contingencyReserve = BigInt(contingencyReserveRaw);
  const feeBps = BigInt(protocolFeeBps);
  const previewFee = BigInt(previewProtocolFeeRaw);
  if (reward <= 0n) throw new Error("Draft reward must be positive.");
  if (feeBps !== BigInt(expectedProtocolFeeBps)) {
    throw new Error(
      `Live EscrowCore protocolFeeBps is ${feeBps}; expected ${expectedProtocolFeeBps}. ` +
      "Refusing to fund under different economics."
    );
  }
  const calculatedFee = (reward * feeBps) / 10_000n;
  if (previewFee !== calculatedFee) {
    throw new Error(
      `EscrowCore previewProtocolFee returned ${previewFee}, but reward × bps / 10,000 is ` +
      `${calculatedFee}. Refusing to fund unreconciled fee math.`
    );
  }
  return Object.freeze({
    rewardRaw: reward,
    workerOwedRaw: reward,
    protocolFeeRaw: previewFee,
    opsReserveRaw: opsReserve,
    contingencyReserveRaw: contingencyReserve,
    posterReservedRaw: reward + previewFee + opsReserve + contingencyReserve,
    protocolFeeBps: feeBps
  });
}

export function validateAndEncodeDraftCalldata({ draft, manifest }) {
  if (!draft || typeof draft !== "object") throw new Error("Draft response is missing.");
  if (!BYTES32_RE.test(String(draft.draftId ?? ""))) throw new Error("Draft response has no valid draftId.");
  if (!BYTES32_RE.test(String(draft.jobId ?? ""))) throw new Error("Draft response has no valid jobId.");
  if (!BYTES32_RE.test(String(draft.specHash ?? ""))) throw new Error("Draft response has no valid specHash.");
  const calldata = draft.calldata;
  if (calldata?.function !== CREATE_SINGLE_PAYOUT_SIGNATURE) {
    throw new Error(
      `Draft selected ${String(calldata?.function)}; expected the non-waived ${CREATE_SINGLE_PAYOUT_SIGNATURE}.`
    );
  }
  const escrow = requireManifestAddress(manifest, "escrowCore");
  const token = requireManifestAddress(manifest, "token");
  if (getAddress(calldata.to) !== escrow) {
    throw new Error(`Draft targets ${calldata.to}; manifest EscrowCore is ${escrow}.`);
  }
  if (!Array.isArray(calldata.args) || calldata.args.length !== 9) {
    throw new Error("Draft createSinglePayoutJob calldata must contain exactly 9 arguments.");
  }
  if (String(calldata.value) !== "0") throw new Error("Draft calldata must send zero native value.");
  if (String(calldata.args[0]).toLowerCase() !== String(draft.jobId).toLowerCase()) {
    throw new Error("Draft calldata jobId does not match the returned jobId.");
  }
  if (getAddress(calldata.args[1]) !== token) {
    throw new Error(`Draft asset ${calldata.args[1]} does not match manifest token ${token}.`);
  }
  if (String(calldata.args[8]).toLowerCase() !== String(draft.specHash).toLowerCase()) {
    throw new Error("Draft calldata specHash does not match the returned specHash.");
  }
  const encoded = CREATE_INTERFACE.encodeFunctionData(CREATE_SINGLE_PAYOUT_SIGNATURE, calldata.args);
  const decoded = CREATE_INTERFACE.decodeFunctionData(CREATE_SINGLE_PAYOUT_SIGNATURE, encoded);
  return {
    to: escrow,
    token,
    encoded,
    decoded: {
      jobId: decoded[0],
      asset: getAddress(decoded[1]),
      rewardRaw: decoded[2],
      opsReserveRaw: decoded[3],
      contingencyReserveRaw: decoded[4],
      claimTtlSeconds: decoded[5],
      verifierModeHash: decoded[6],
      categoryHash: decoded[7],
      specHash: decoded[8]
    }
  };
}

export function findMatchingExternalCatalogJob(payload, { jobId, poster }) {
  const jobs = Array.isArray(payload) ? payload : payload?.jobs;
  if (!Array.isArray(jobs)) return undefined;
  const normalizedPoster = getAddress(poster).toLowerCase();
  return jobs.find((job) => {
    const jobPoster = job?.poster?.wallet
      ?? job?.sourceDetails?.wallet
      ?? job?.source?.poster?.wallet;
    return String(job?.id ?? "").toLowerCase() === String(jobId).toLowerCase()
      && String(job?.source ?? job?.source?.type ?? "").toLowerCase() === "external"
      && isAddress(String(jobPoster ?? ""))
      && getAddress(jobPoster).toLowerCase() === normalizedPoster;
  });
}

export async function loginPoster({ apiBaseUrl, wallet, fetchImpl = fetch }) {
  const noncePayload = await requestJson(fetchImpl, `${apiBaseUrl}/auth/nonce`, {
    method: "POST",
    body: { wallet: wallet.address }
  });
  if (typeof noncePayload?.message !== "string" || !noncePayload.message) {
    throw new Error("/auth/nonce did not return a SIWE message.");
  }
  const signature = await wallet.signMessage(noncePayload.message);
  const verified = await requestJson(fetchImpl, `${apiBaseUrl}/auth/verify`, {
    method: "POST",
    body: { message: noncePayload.message, signature }
  });
  if (typeof verified?.token !== "string" || !verified.token) {
    throw new Error("/auth/verify did not return a session token.");
  }
  if (verified.wallet && getAddress(verified.wallet) !== getAddress(wallet.address)) {
    throw new Error(`/auth/verify returned unexpected wallet ${verified.wallet}.`);
  }
  return { token: verified.token, expiresAt: verified.expiresAt };
}

export async function createExternalDraft({ apiBaseUrl, token, definition, fetchImpl = fetch }) {
  return requestJson(fetchImpl, `${apiBaseUrl}/jobs/draft`, {
    method: "POST",
    token,
    body: { definition }
  });
}

export async function getExternalDraft({ apiBaseUrl, token, draftId, fetchImpl = fetch }) {
  return requestJson(
    fetchImpl,
    `${apiBaseUrl}/jobs/draft/${encodeURIComponent(draftId)}`,
    { token }
  );
}

export function assertDefinitionMatchesDraft(definition, draft) {
  const localSpecHash = hashCanonicalContent(definition);
  if (localSpecHash.toLowerCase() !== String(draft?.specHash ?? "").toLowerCase()) {
    throw new Error(
      `Local definition hashes to ${localSpecHash}, but reviewed draft ${draft?.draftId ?? "unknown"} ` +
      `carries ${draft?.specHash ?? "no specHash"}. Refusing to continue.`
    );
  }
  if (draft?.definition && hashCanonicalContent(draft.definition).toLowerCase() !== localSpecHash.toLowerCase()) {
    throw new Error("Server-returned draft definition differs from the committed definition.");
  }
  return localSpecHash;
}

export async function inspectFundingState({ manifest, provider, poster, draft }) {
  const calldata = validateAndEncodeDraftCalldata({ draft, manifest });
  const escrow = new Contract(calldata.to, ESCROW_ABI, provider);
  const agentAccountAddress = requireManifestAddress(manifest, "agentAccountCore");
  const agentAccount = new Contract(agentAccountAddress, AGENT_ACCOUNT_ABI, provider);
  const token = new Contract(calldata.token, ERC20_ABI, provider);
  const [
    protocolFeeBps,
    previewProtocolFeeRaw,
    treasuryAccount,
    position,
    walletUsdcRaw,
    allowanceRaw,
    existingJob
  ] = await Promise.all([
    escrow.protocolFeeBps(),
    escrow.previewProtocolFee(calldata.decoded.rewardRaw),
    escrow.treasuryAccount(),
    agentAccount.positions(poster, calldata.token),
    token.balanceOf(poster),
    token.allowance(poster, agentAccountAddress),
    escrow.jobs(draft.jobId)
  ]);
  if (Number(existingJob.state) !== 0) {
    throw new Error(`EscrowCore job ${draft.jobId} already has state ${existingJob.state}; refusing duplicate funding.`);
  }
  const fundingMath = buildFundingMath({
    rewardRaw: calldata.decoded.rewardRaw,
    opsReserveRaw: calldata.decoded.opsReserveRaw,
    contingencyReserveRaw: calldata.decoded.contingencyReserveRaw,
    protocolFeeBps,
    previewProtocolFeeRaw
  });
  const liquidRaw = BigInt(position.liquid);
  return {
    calldata,
    fundingMath,
    agentAccountAddress,
    treasuryAccount: getAddress(treasuryAccount),
    liquidRaw,
    walletUsdcRaw: BigInt(walletUsdcRaw),
    allowanceRaw: BigInt(allowanceRaw),
    depositRequiredRaw: fundingMath.posterReservedRaw > liquidRaw
      ? fundingMath.posterReservedRaw - liquidRaw
      : 0n
  };
}

export async function executeFunding({
  manifest,
  rpc,
  privateKey,
  poster,
  draft,
  plan,
  log = console.log
}) {
  if (!rpc.writeBroadcaster) throw new Error("Write broadcaster was not created for --execute.");
  const signer = bindSignerToWriteBroadcaster(
    new Wallet(privateKey),
    rpc.provider,
    rpc.writeBroadcaster
  );
  if (getAddress(await signer.getAddress()) !== getAddress(poster)) {
    throw new Error("Write signer changed after the SIWE address check.");
  }
  const token = new Contract(plan.calldata.token, ERC20_ABI, signer);
  const agentAccount = new Contract(plan.agentAccountAddress, AGENT_ACCOUNT_ABI, signer);
  const txs = {};

  if (plan.depositRequiredRaw > 0n) {
    if (plan.walletUsdcRaw < plan.depositRequiredRaw) {
      throw new Error(
        `Poster wallet has ${formatUsdc(plan.walletUsdcRaw)} USDC, but the AAC deposit shortfall is ` +
        `${formatUsdc(plan.depositRequiredRaw)} USDC.`
      );
    }
    if (plan.allowanceRaw < plan.depositRequiredRaw) {
      log(`approving AAC deposit: ${formatUsdc(plan.depositRequiredRaw)} USDC`);
      const approval = await token.approve(plan.agentAccountAddress, plan.depositRequiredRaw);
      const approvalReceipt = await approval.wait();
      assertSuccessfulReceipt(approvalReceipt, "USDC approval");
      txs.approve = approvalReceipt.hash;
    }
    log(`depositing to poster AAC position: ${formatUsdc(plan.depositRequiredRaw)} USDC`);
    const deposit = await agentAccount.deposit(plan.calldata.token, plan.depositRequiredRaw);
    const depositReceipt = await deposit.wait();
    assertSuccessfulReceipt(depositReceipt, "AAC deposit");
    txs.deposit = depositReceipt.hash;
  }

  const positionAfterDeposit = await new Contract(
    plan.agentAccountAddress,
    AGENT_ACCOUNT_ABI,
    rpc.provider
  ).positions(poster, plan.calldata.token);
  if (BigInt(positionAfterDeposit.liquid) < plan.fundingMath.posterReservedRaw) {
    throw new Error(
      `AAC liquid is ${positionAfterDeposit.liquid} after deposit; ` +
      `${plan.fundingMath.posterReservedRaw} is required. Refusing job creation.`
    );
  }

  log(`creating non-waived external job: ${draft.jobId}`);
  const creation = await signer.sendTransaction({
    to: plan.calldata.to,
    data: plan.calldata.encoded,
    value: 0n
  });
  const creationReceipt = await creation.wait();
  assertSuccessfulReceipt(creationReceipt, "createSinglePayoutJob");
  assertCreationEvents(creationReceipt, {
    jobId: draft.jobId,
    poster,
    specHash: draft.specHash,
    totalReservedRaw: plan.fundingMath.posterReservedRaw
  });
  txs.createJob = creationReceipt.hash;

  const liveJob = await new Contract(plan.calldata.to, ESCROW_ABI, rpc.provider).jobs(draft.jobId);
  if (getAddress(liveJob.poster) !== getAddress(poster)) throw new Error("Created job poster mismatch.");
  if (String(liveJob.specHash).toLowerCase() !== String(draft.specHash).toLowerCase()) {
    throw new Error("Created job specHash mismatch.");
  }
  if (BigInt(liveJob.reward) !== plan.fundingMath.rewardRaw) throw new Error("Created job reward mismatch.");
  if (BigInt(liveJob.protocolFee) !== plan.fundingMath.protocolFeeRaw) {
    throw new Error("Created job protocol fee mismatch.");
  }
  if (liveJob.protocolFeeWaived !== false || BigInt(liveJob.protocolFeeBps) !== EXPECTED_PROTOCOL_FEE_BPS) {
    throw new Error("Created job did not snapshot the required non-waived 500 bps fee.");
  }
  if (Number(liveJob.state) !== 1) throw new Error(`Created job state is ${liveJob.state}; expected Open (1).`);
  return { txs, blockNumber: creationReceipt.blockNumber };
}

export async function waitForExternalJobLive({
  apiBaseUrl,
  token,
  draftId,
  jobId,
  poster,
  timeoutMs,
  intervalMs,
  fetchImpl = fetch,
  sleepImpl = sleep,
  log = console.log
}) {
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    const draft = await requestJson(fetchImpl, `${apiBaseUrl}/jobs/draft/${encodeURIComponent(draftId)}`, {
      token
    });
    if (String(draft.status).startsWith("mismatch") || draft.status === "expired") {
      throw new Error(`Watcher returned terminal draft status ${draft.status}.`);
    }
    if (draft.status === "live") {
      const catalog = await requestJson(
        fetchImpl,
        `${apiBaseUrl}/jobs?source=external&limit=100`
      );
      const job = findMatchingExternalCatalogJob(catalog, { jobId, poster });
      if (job) return { draft, job, attempts: attempt, elapsedMs: Date.now() - startedAt };
    }
    log(`watcher poll ${attempt}: draft status=${draft.status}; elapsed=${Date.now() - startedAt}ms`);
    await sleepImpl(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for external draft ${draftId} to enter the catalog.`);
}

export async function runPosterBounty(args, dependencies = {}) {
  validateArgs(args);
  const {
    loadManifest = loadDeploymentManifest,
    createRpc = createCeremonyRpcContext,
    loadSecret = loadKeyFromOp,
    makeWallet = (privateKey) => new Wallet(privateKey),
    login = loginPoster,
    postDraft = createExternalDraft,
    readDraft = getExternalDraft,
    inspect = inspectFundingState,
    execute = executeFunding,
    watch = waitForExternalJobLive,
    fetchImpl = fetch,
    log = console.log
  } = dependencies;
  const { definition, definitionPath } = await loadDefinition(args);
  const { path: manifestPath, manifest } = await loadManifest(args.profile);
  const rpc = await createRpc({
    manifest,
    phase: "post-external-bounty",
    write: args.execute,
    fetchImpl
  });
  try {
    log("# post-external-bounty");
    log(`profile:                 ${args.profile}`);
    log(`mode:                    ${args.execute ? "execute" : "dry-run"}`);
    log(`api:                     ${stripTrailingSlash(args.apiBaseUrl)}`);
    log(`manifest:                ${manifestPath}`);
    log(`definition:              ${definitionPath}`);
    printCeremonyRpcPreflight(rpc, log);

    // Secret access happens only after the RPC chain gate. The key is never logged.
    const privateKey = loadSecret(args.signerSecretRef);
    const wallet = makeWallet(privateKey);
    const poster = getAddress(wallet.address ?? await wallet.getAddress());
    const expectedPoster = getAddress(args.expectedPoster);
    if (poster !== expectedPoster) {
      throw new Error(`Signer resolves to ${poster}; expected poster ${expectedPoster}. Refusing SIWE or funding.`);
    }
    log(`poster:                  ${poster} ✓`);

    const session = await login({
      apiBaseUrl: stripTrailingSlash(args.apiBaseUrl),
      wallet,
      fetchImpl
    });
    log(`SIWE session:            authenticated (expires ${session.expiresAt ?? "not reported"})`);
    const draft = args.draftId
      ? await readDraft({
          apiBaseUrl: stripTrailingSlash(args.apiBaseUrl),
          token: session.token,
          draftId: args.draftId,
          fetchImpl
        })
      : await postDraft({
          apiBaseUrl: stripTrailingSlash(args.apiBaseUrl),
          token: session.token,
          definition,
          fetchImpl
        });
    if (args.draftId && String(draft.draftId).toLowerCase() !== args.draftId.toLowerCase()) {
      throw new Error(`Draft lookup returned ${draft.draftId}; expected ${args.draftId}.`);
    }
    assertDefinitionMatchesDraft(definition, draft);
    const plan = await inspect({ manifest, provider: rpc.provider, poster, draft });
    printDryRunPlan({ draft, plan, log });

    if (!args.execute) {
      log("\nDry-run complete: SIWE + draft creation only; no on-chain transaction was signed or sent.");
      log(
        `Re-run the reviewed command with --execute --draft-id ${draft.draftId} ` +
        "to fund this exact calldata."
      );
      return { mode: "dry-run", poster, draft, plan };
    }

    const funding = await execute({ manifest, rpc, privateKey, poster, draft, plan, log });
    const live = await watch({
      apiBaseUrl: stripTrailingSlash(args.apiBaseUrl),
      token: session.token,
      draftId: draft.draftId,
      jobId: draft.jobId,
      poster,
      timeoutMs: args.watchTimeoutMs,
      intervalMs: args.watchIntervalMs,
      fetchImpl,
      log
    });
    log("\n## Live external catalog entry");
    log(`draft status:            ${live.draft.status}`);
    log(`job id:                  ${draft.jobId}`);
    log(`source:                  ${live.job.source}`);
    log(`poster:                  ${live.job.poster?.wallet ?? live.job.sourceDetails?.wallet}`);
    log(`funding tx:              ${live.draft.txHash}`);
    log(`watcher elapsed:         ${live.elapsedMs}ms (${live.attempts} poll(s))`);
    log(`approve tx:              ${funding.txs.approve ?? "not needed"}`);
    log(`deposit tx:              ${funding.txs.deposit ?? "not needed"}`);
    log(`create job tx:           ${funding.txs.createJob}`);
    return { mode: "execute", poster, draft, plan, funding, live };
  } finally {
    if (rpc.writeBroadcaster) await rpc.writeBroadcaster.destroy();
    await rpc.provider?.destroy?.();
  }
}

export function printDryRunPlan({ draft, plan, log = console.log }) {
  const math = plan.fundingMath;
  log("\n## Draft");
  log(`draftId:                 ${draft.draftId}`);
  log(`jobId:                   ${draft.jobId}`);
  log(`specHash:                ${draft.specHash}`);
  log(`status:                  ${draft.status}`);
  log("\n## Live funding math (poster-side additive fee)");
  log(`protocol fee:            ${math.protocolFeeBps} bps ✓`);
  log(`worker owed:             ${formatUsdc(math.workerOwedRaw)} USDC`);
  log(`treasury fee:            ${formatUsdc(math.protocolFeeRaw)} USDC`);
  log(`ops reserve:             ${formatUsdc(math.opsReserveRaw)} USDC`);
  log(`contingency reserve:     ${formatUsdc(math.contingencyReserveRaw)} USDC`);
  log(`poster reserved:         ${formatUsdc(math.posterReservedRaw)} USDC`);
  log(`treasury recipient:      ${plan.treasuryAccount}`);
  log(`poster AAC liquid:       ${formatUsdc(plan.liquidRaw)} USDC`);
  log(`deposit required:        ${formatUsdc(plan.depositRequiredRaw)} USDC`);
  log(`poster wallet USDC:      ${formatUsdc(plan.walletUsdcRaw)} USDC`);
  log("\n## Decoded createSinglePayoutJob calldata (non-waived path)");
  log(`to:                      ${plan.calldata.to}`);
  log(`function:                ${CREATE_SINGLE_PAYOUT_SIGNATURE}`);
  for (const [label, value] of Object.entries(plan.calldata.decoded)) {
    log(`${`${label}:`.padEnd(25)}${value}`);
  }
  log(`value:                   0`);
  log(`encoded calldata:        ${plan.calldata.encoded}`);
}

async function loadDeploymentManifest(profile) {
  const manifestPath = path.resolve(process.cwd(), `deployments/${profile}.json`);
  return {
    path: manifestPath,
    manifest: JSON.parse(await readFile(manifestPath, "utf8"))
  };
}

async function requestJson(fetchImpl, url, { method = "GET", token, body } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = payload?.code ?? payload?.error ?? "request_failed";
    const message = payload?.message ?? response.statusText ?? "unknown error";
    throw new Error(`${method} ${new URL(url).pathname} failed (${response.status}, ${code}): ${message}`);
  }
  return payload;
}

function requireManifestAddress(manifest, key) {
  const value = manifest?.contracts?.[key];
  if (!isAddress(String(value ?? ""))) {
    throw new Error(`deployments/${manifest?.profile ?? "profile"}.json has no valid contracts.${key}.`);
  }
  return getAddress(value);
}

function assertSuccessfulReceipt(receipt, label) {
  if (!receipt || Number(receipt.status) !== 1) {
    throw new Error(`${label} transaction did not succeed.`);
  }
}

function assertCreationEvents(receipt, expected) {
  let funded;
  let created;
  for (const log of receipt.logs ?? []) {
    const parsed = CREATE_INTERFACE.parseLog(log);
    if (!parsed) continue;
    if (parsed.name === "JobFunded") funded = parsed;
    if (parsed.name === "JobCreated") created = parsed;
  }
  if (!funded || !created) throw new Error("Creation receipt is missing JobFunded or JobCreated.");
  for (const parsed of [funded, created]) {
    if (String(parsed.args.jobId).toLowerCase() !== String(expected.jobId).toLowerCase()) {
      throw new Error(`${parsed.name} jobId mismatch.`);
    }
    if (getAddress(parsed.args.poster) !== getAddress(expected.poster)) {
      throw new Error(`${parsed.name} poster mismatch.`);
    }
    if (BigInt(parsed.args.totalReserved) !== expected.totalReservedRaw) {
      throw new Error(`${parsed.name} totalReserved mismatch.`);
    }
  }
  if (String(created.args.specHash).toLowerCase() !== String(expected.specHash).toLowerCase()) {
    throw new Error("JobCreated specHash mismatch.");
  }
}

function formatUsdc(raw) {
  const formatted = formatUnits(BigInt(raw), USDC_DECIMALS);
  const [whole, fraction = ""] = formatted.split(".");
  const trimmed = fraction.replace(/0+$/u, "");
  return `${whole}.${trimmed.padEnd(2, "0")}`;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage() {
  console.log(`Usage:
  node scripts/ops/post-external-bounty.mjs \\
    --profile mainnet \\
    --definition-file scripts/ops/external-bounties/<job>.json \\
    --expected-poster 0x... \\
    --signer-secret-ref 'op://vault/item/field' [--execute --draft-id 0x...]

Default mode is dry-run: it performs SIWE and creates the off-chain draft, then
prints live fee math and exact non-waived createSinglePayoutJob calldata. It
does not sign or send an on-chain transaction. --execute opts into the AAC
approve/deposit (if needed), job creation, and watcher wait. Execution requires
the --draft-id emitted by the reviewed dry-run, so it cannot fund a new nonce.

Inline definition flags: --task, --repo, --reward-usdc, --verifier-mode, and
one or more --acceptance-criterion values.`);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      return;
    }
    await runPosterBounty(args);
  } catch (error) {
    console.error(`post-external-bounty failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
