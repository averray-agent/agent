import { Contract, JsonRpcProvider, Wallet, NonceManager, formatUnits, id, parseUnits } from "ethers";
import { AGENT_ACCOUNT_ABI, ESCROW_CORE_ABI, REPUTATION_SBT_ABI } from "../blockchain/abis.js";
import { loadBlockchainConfig } from "../blockchain/config.js";
import { loadLocalEnv } from "../services/env-loader.js";

const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)"
];

const JOB_REWARD = parseUnits("100", 18);
const OPS_RESERVE = parseUnits("10", 18);
const CONTINGENCY_RESERVE = parseUnits("5", 18);
const POSTER_DEPOSIT = parseUnits("1000", 18);
const WORKER_DEPOSIT = parseUnits("25", 18);
const DEFAULT_ANVIL_WORKER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requireEnv(config) {
  assert(config.enabled, "Blockchain config is incomplete. Source mcp-server/.env.local first.");
  assert(config.signerPrivateKey, "SIGNER_PRIVATE_KEY is required for the e2e demo.");
  assert(config.supportedAssets.length > 0, "SUPPORTED_ASSETS must contain at least one asset.");
}

async function wait(tx) {
  const receipt = await tx.wait();
  return receipt.hash;
}

async function main() {
  loadLocalEnv();
  const config = loadBlockchainConfig();
  requireEnv(config);

  const provider = new JsonRpcProvider(config.rpcUrl);
  const posterWallet = new Wallet(config.signerPrivateKey, provider);
  const poster = new NonceManager(posterWallet);
  const workerWallet = new Wallet(process.env.WORKER_PRIVATE_KEY ?? DEFAULT_ANVIL_WORKER_KEY, provider);
  const worker = new NonceManager(workerWallet);
  const asset = config.supportedAssets[0];

  const dot = new Contract(asset.address, ERC20_ABI, poster);
  const account = new Contract(config.agentAccountAddress, AGENT_ACCOUNT_ABI, poster);
  const escrow = new Contract(config.escrowCoreAddress, ESCROW_CORE_ABI, poster);
  const reputation = new Contract(config.reputationSbtAddress, REPUTATION_SBT_ABI, provider);

  const jobId = `local-e2e-${Date.now()}`;
  const jobIdBytes = id(jobId);

  console.log(`Poster: ${posterWallet.address}`);
  console.log(`Worker: ${workerWallet.address}`);
  console.log(`Job: ${jobId}`);

  const startingWorkerBalance = await dot.balanceOf(workerWallet.address);
  const startingBadgeBalance = await reputation.balanceOf(workerWallet.address);
  const startingPosterPosition = await account.positions(posterWallet.address, asset.address);
  const startingWorkerPosition = await account.positions(workerWallet.address, asset.address);

  console.log("Minting mock DOT to poster");
  await wait(await dot.mint(posterWallet.address, POSTER_DEPOSIT));

  console.log("Approving AgentAccountCore");
  await wait(await dot.approve(config.agentAccountAddress, POSTER_DEPOSIT));

  console.log("Depositing into AgentAccountCore");
  await wait(await account.deposit(asset.address, POSTER_DEPOSIT));

  console.log("Funding worker claim stake");
  const dotAsWorker = dot.connect(worker);
  const accountAsWorker = account.connect(worker);
  await wait(await dot.mint(workerWallet.address, WORKER_DEPOSIT));
  await wait(await dotAsWorker.approve(config.agentAccountAddress, WORKER_DEPOSIT));
  await wait(await accountAsWorker.deposit(asset.address, WORKER_DEPOSIT));

  console.log("Creating funded single-payout job");
  await wait(await escrow.createSinglePayoutJob(
    jobIdBytes,
    asset.address,
    JOB_REWARD,
    OPS_RESERVE,
    CONTINGENCY_RESERVE,
    3600,
    id("benchmark"),
    id("coding"),
    id("local-e2e-spec")
  ));

  console.log("Claiming job as worker");
  const escrowAsWorker = escrow.connect(worker);
  await wait(await escrowAsWorker.claimJob(jobIdBytes));

  const workerPositionAfterClaim = await account.positions(workerWallet.address, asset.address);
  assert(workerPositionAfterClaim.jobStakeLocked > startingWorkerPosition.jobStakeLocked, "Expected worker claim stake to lock on claim");

  console.log("Submitting work as worker");
  await wait(await escrowAsWorker.submitWork(jobIdBytes, id("complete verified output")));

  console.log("Resolving through verifier role");
  await wait(await escrow.resolveSinglePayout(jobIdBytes, true, id("AUTO_VERIFIER_PASS"), "ipfs://badge/local-e2e", id("local-e2e-reasoning")));

  const workerBalance = await dot.balanceOf(workerWallet.address);
  const badgeBalance = await reputation.balanceOf(workerWallet.address);
  const posterPosition = await account.positions(posterWallet.address, asset.address);
  const workerPosition = await account.positions(workerWallet.address, asset.address);

  assert(workerBalance - startingWorkerBalance === JOB_REWARD, `Expected worker payout delta ${JOB_REWARD}, got ${workerBalance - startingWorkerBalance}`);
  assert(badgeBalance - startingBadgeBalance === 1n, `Expected one new SBT badge, got ${badgeBalance - startingBadgeBalance}`);
  assert(posterPosition.reserved === startingPosterPosition.reserved, `Expected reserved balance to return to ${startingPosterPosition.reserved}, got ${posterPosition.reserved}`);
  assert(workerPosition.jobStakeLocked === 0n, `Expected worker stake to be released, got ${workerPosition.jobStakeLocked}`);

  console.log("E2E demo passed");
  console.log(JSON.stringify({
    jobId,
    asset: asset.symbol,
    workerPayout: formatUnits(workerBalance, 18),
    workerBadges: badgeBalance.toString(),
    posterLiquid: formatUnits(posterPosition.liquid, 18),
    posterReserved: formatUnits(posterPosition.reserved, 18),
    posterReservedDelta: formatUnits(posterPosition.reserved - startingPosterPosition.reserved, 18)
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
