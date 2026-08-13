#!/usr/bin/env node

/**
 * Fork-only EscrowCore v3 ceremony proof. Never broadcasts to mainnet.
 *
 * The script starts an isolated anvil fork, impersonates the explicitly named
 * mainnet deployer and policy owner, then proves the same state transition the
 * later operator ceremony will perform through EVM CREATE + Nova Spektr.
 *
 * Usage:
 *   node scripts/ops/simulate-escrowcore-v3-ceremony.mjs \
 *     --fork-url https://... \
 *     --expected-deployer 0x9Ab8531FBb0948C542a31298FD61335f30064239 \
 *     [--fork-block-number N] [--port 18547]
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Contract, ContractFactory, Interface, JsonRpcProvider, getAddress, getCreateAddress } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export const MAINNET_ADMIN_DEPLOYER = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
export const EIP170_RUNTIME_CODE_LIMIT_BYTES = 24_576;
export const RATIFIED_V3_SCHEDULE = Object.freeze({
  retentionFlatRaw: 50_000n,
  retentionCapBps: 2_000,
  posterFeeBps: 500,
  posterFeeFloorRaw: 50_000n
});

const POLICY_ABI = [
  "function owner() view returns (address)",
  "function settlementBroker(address) view returns (bool)",
  "function reputationWriter(address) view returns (bool)",
  "function verifiers(address) view returns (bool)",
  "function setSettlementBroker(address,bool)",
  "function setReputationWriter(address,bool)"
];
const ACCOUNT_ABI = [
  "function escrowOperators(address) view returns (bool)",
  "function setEscrowOperator(address,bool)"
];

export function parseArgs(argv) {
  const args = { port: 18_547, profile: "mainnet" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fork-url") args.forkUrl = argv[++index];
    else if (arg === "--expected-deployer") args.expectedDeployer = argv[++index];
    else if (arg === "--fork-block-number") args.forkBlockNumber = Number(argv[++index]);
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--profile") args.profile = argv[++index];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function validateSimulationArgs(args) {
  if (!args.forkUrl) throw new Error("--fork-url is required.");
  if (!args.expectedDeployer) throw new Error("--expected-deployer is required.");
  const deployer = getAddress(args.expectedDeployer);
  if (args.profile !== "mainnet") throw new Error("EscrowCore v3 acceptance is pinned to --profile mainnet.");
  if (deployer !== MAINNET_ADMIN_DEPLOYER) {
    throw new Error(`--expected-deployer must be the ratified mainnet admin EOA ${MAINNET_ADMIN_DEPLOYER}.`);
  }
  if (!Number.isSafeInteger(args.port) || args.port < 1024 || args.port > 65_535) {
    throw new Error("--port must be an unprivileged TCP port.");
  }
  if (args.forkBlockNumber !== undefined
    && (!Number.isSafeInteger(args.forkBlockNumber) || args.forkBlockNumber <= 0)) {
    throw new Error("--fork-block-number must be a positive integer.");
  }
  return { ...args, expectedDeployer: deployer };
}

export function assertCeremonyPostconditions(state) {
  const failures = [];
  if (state.deployedAddress?.toLowerCase() !== state.predictedAddress?.toLowerCase()) {
    failures.push("deployed address does not match the pending-nonce CREATE prediction");
  }
  if (!Number.isSafeInteger(state.runtimeCodeBytes)
    || state.runtimeCodeBytes <= 0
    || state.runtimeCodeBytes > EIP170_RUNTIME_CODE_LIMIT_BYTES) {
    failures.push(`runtime code exceeds the EIP-170 ${EIP170_RUNTIME_CODE_LIMIT_BYTES}-byte ceiling`);
  }
  for (const [field, expected] of Object.entries({
    boundPolicy: state.manifestPolicy,
    boundAccounts: state.manifestAccounts,
    boundReputation: state.manifestReputation,
    treasuryAccount: state.manifestTreasury
  })) {
    if (state[field]?.toLowerCase() !== expected?.toLowerCase()) failures.push(`${field} mismatch`);
  }
  for (const field of ["newSettlementBroker", "newReputationWriter", "newEscrowOperator"] ) {
    if (state[field] !== true) failures.push(`${field} is not true`);
  }
  for (const field of ["oldSettlementBroker", "oldReputationWriter", "oldEscrowOperator"] ) {
    if (state[field] !== true) failures.push(`${field} must remain true for the v2 drain`);
  }
  if (state.kmsSettlementBroker !== true || state.kmsVerifier !== true) {
    failures.push("KMS signer settlementBroker/verifier roles are not both true");
  }
  if (state.adminSettlementBroker !== false || state.adminVerifier !== false) {
    failures.push("admin EOA unexpectedly holds an operational role");
  }
  if (state.schedule.retentionFlatRaw !== RATIFIED_V3_SCHEDULE.retentionFlatRaw
    || state.schedule.retentionCapBps !== RATIFIED_V3_SCHEDULE.retentionCapBps
    || state.schedule.posterFeeBps !== RATIFIED_V3_SCHEDULE.posterFeeBps
    || state.schedule.posterFeeFloorRaw !== RATIFIED_V3_SCHEDULE.posterFeeFloorRaw) {
    failures.push("fee schedule does not match D4 ratified values");
  }
  if (state.feeScheduleEvent?.newRetentionFlatRaw !== RATIFIED_V3_SCHEDULE.retentionFlatRaw
    || state.feeScheduleEvent?.newRetentionCapBps !== RATIFIED_V3_SCHEDULE.retentionCapBps
    || state.feeScheduleEvent?.newPosterFeeBps !== RATIFIED_V3_SCHEDULE.posterFeeBps
    || state.feeScheduleEvent?.newPosterFeeFloorRaw !== RATIFIED_V3_SCHEDULE.posterFeeFloorRaw) {
    failures.push("FeeScheduleChanged did not decode to the D4 ratified values");
  }
  if (failures.length) throw new Error(`EscrowCore v3 fork simulation failed:\n- ${failures.join("\n- ")}`);
  return state;
}

async function startAnvil({ forkUrl, forkBlockNumber, port }) {
  const argv = [
    "--silent",
    "--port",
    String(port),
    "--fork-url",
    forkUrl
  ];
  if (forkBlockNumber !== undefined) argv.push("--fork-block-number", String(forkBlockNumber));
  const child = spawn("anvil", argv, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", (error) => { stderr += error.message; });
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await provider.getBlockNumber();
      return { child, provider };
    } catch {
      if (child.exitCode !== null) throw new Error(`anvil exited ${child.exitCode}: ${stderr.trim()}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  child.kill("SIGTERM");
  throw new Error(`anvil did not become ready: ${stderr.trim()}`);
}

async function impersonatedSigner(provider, address) {
  await provider.send("anvil_impersonateAccount", [address]);
  await provider.send("anvil_setBalance", [address, "0x56BC75E2D63100000"]); // 100 native
  return provider.getSigner(address);
}

async function loadInputs(profile) {
  const [manifestRaw, artifactRaw] = await Promise.all([
    readFile(resolve(repoRoot, "deployments", `${profile}.json`), "utf8"),
    readFile(resolve(repoRoot, "out", "EscrowCore.sol", "EscrowCore.json"), "utf8")
  ]);
  const manifest = JSON.parse(manifestRaw);
  const artifact = JSON.parse(artifactRaw);
  return { manifest, artifact };
}

async function run(args) {
  const { manifest, artifact } = await loadInputs(args.profile);
  const { child, provider } = await startAnvil(args);
  try {
    const deployer = args.expectedDeployer;
    const pendingNonce = await provider.getTransactionCount(deployer, "pending");
    const predictedAddress = getCreateAddress({ from: deployer, nonce: pendingNonce });
    const deployerSigner = await impersonatedSigner(provider, deployer);
    const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, deployerSigner);
    const deployed = await factory.deploy(
      manifest.contracts.treasuryPolicy,
      manifest.contracts.agentAccountCore,
      manifest.contracts.reputationSbt,
      manifest.treasuryAccount
    );
    const deployReceipt = await deployed.deploymentTransaction().wait();
    const deployedAddress = await deployed.getAddress();

    const policy = new Contract(manifest.contracts.treasuryPolicy, POLICY_ABI, provider);
    const accounts = new Contract(manifest.contracts.agentAccountCore, ACCOUNT_ABI, provider);
    const owner = getAddress(await policy.owner());
    const ownerSigner = await impersonatedSigner(provider, owner);
    const ownedPolicy = policy.connect(ownerSigner);
    const ownedAccounts = accounts.connect(ownerSigner);
    const ownedEscrow = deployed.connect(ownerSigner);

    const scheduleTx = await ownedEscrow.setFeeSchedule(
      RATIFIED_V3_SCHEDULE.retentionFlatRaw,
      RATIFIED_V3_SCHEDULE.retentionCapBps,
      RATIFIED_V3_SCHEDULE.posterFeeBps,
      RATIFIED_V3_SCHEDULE.posterFeeFloorRaw
    );
    const scheduleReceipt = await scheduleTx.wait();
    await (await ownedAccounts.setEscrowOperator(deployedAddress, true)).wait();
    await (await ownedPolicy.setSettlementBroker(deployedAddress, true)).wait();
    await (await ownedPolicy.setReputationWriter(deployedAddress, true)).wait();

    const scheduleInterface = new Interface(artifact.abi);
    const decodedSchedule = scheduleReceipt.logs
      .map((log) => {
        try { return scheduleInterface.parseLog(log); } catch { return undefined; }
      })
      .find((event) => event?.name === "FeeScheduleChanged");
    const oldEscrow = manifest.contracts.escrowCore;
    const kmsSigner = manifest.verifier;
    const state = {
      profile: args.profile,
      forkBlockNumber: await provider.getBlockNumber(),
      pendingNonce,
      predictedAddress,
      deployedAddress,
      deployTxHash: deployReceipt.hash,
      deployBlockNumber: deployReceipt.blockNumber,
      runtimeCodeBytes: (artifact.deployedBytecode.object.length - 2) / 2,
      policyOwner: owner,
      manifestPolicy: manifest.contracts.treasuryPolicy,
      manifestAccounts: manifest.contracts.agentAccountCore,
      manifestReputation: manifest.contracts.reputationSbt,
      manifestTreasury: manifest.treasuryAccount,
      boundPolicy: await deployed.policy(),
      boundAccounts: await deployed.accounts(),
      boundReputation: await deployed.reputation(),
      treasuryAccount: await deployed.treasuryAccount(),
      newSettlementBroker: await policy.settlementBroker(deployedAddress),
      newReputationWriter: await policy.reputationWriter(deployedAddress),
      newEscrowOperator: await accounts.escrowOperators(deployedAddress),
      oldSettlementBroker: await policy.settlementBroker(oldEscrow),
      oldReputationWriter: await policy.reputationWriter(oldEscrow),
      oldEscrowOperator: await accounts.escrowOperators(oldEscrow),
      kmsSettlementBroker: await policy.settlementBroker(kmsSigner),
      kmsVerifier: await policy.verifiers(kmsSigner),
      adminSettlementBroker: await policy.settlementBroker(deployer),
      adminVerifier: await policy.verifiers(deployer),
      schedule: {
        retentionFlatRaw: await deployed.retentionFlatRaw(),
        retentionCapBps: Number(await deployed.retentionCapBps()),
        posterFeeBps: Number(await deployed.posterFeeBps()),
        posterFeeFloorRaw: await deployed.posterFeeFloorRaw()
      },
      feeScheduleEvent: decodedSchedule ? {
        newRetentionFlatRaw: decodedSchedule.args.newRetentionFlatRaw,
        newRetentionCapBps: Number(decodedSchedule.args.newRetentionCapBps),
        newPosterFeeBps: Number(decodedSchedule.args.newPosterFeeBps),
        newPosterFeeFloorRaw: decodedSchedule.args.newPosterFeeFloorRaw
      } : undefined
    };
    assertCeremonyPostconditions(state);
    console.log(JSON.stringify(state, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
  } finally {
    await provider.destroy();
    child.kill("SIGTERM");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rawArgs = parseArgs(process.argv.slice(2));
  if (rawArgs.help) {
    console.log("See the usage block at the top of this script.");
  } else {
    run(validateSimulationArgs(rawArgs)).catch((error) => {
      console.error(`simulate-escrowcore-v3-ceremony failed: ${error?.message ?? error}`);
      process.exitCode = 1;
    });
  }
}
