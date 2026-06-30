#!/usr/bin/env node

/**
 * Redeploy the settlement stack when AgentAccountCore and EscrowCore must
 * move together.
 *
 * This is the forward fix for the stale May-2026 testnet stack class:
 * the backend expects current AgentAccountCore selectors such as
 * escrowOperators() and domainSeparator(), while EscrowCore.accounts() is
 * immutable and must point at the fresh AAC.
 *
 * Flow:
 *   1. deploy    CREATE new AgentAccountCore, then CREATE new EscrowCore
 *                whose constructor points at the fresh AAC.
 *   2. wire      Use redeploy-escrowcore-wire-multisig.mjs with
 *                --new-agent-account and --new-escrow so the multisig
 *                approves both fresh contracts.
 *   3. finalize  Verify chain state, update deployments/<profile>.json
 *                plus deploy/backend.env.template, then re-run launch audit.
 */

import {
  JsonRpcProvider,
  Wallet,
  Contract,
  ContractFactory,
  getCreateAddress
} from "ethers";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

import {
  loadKeyFromOp,
  assertArtifactHasBrokeredSelectors,
  findUnsettledOldEscrowBalances,
  evaluateOrphanedBalancePreflight
} from "./redeploy-escrowcore.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const PHASES = new Set(["deploy", "finalize", "all"]);
const PRIVATE_KEY_RE = /^0x[a-fA-F0-9]{64}$/u;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/u;
const DEFAULT_ORPHAN_SCAN_CHUNK_SIZE = 25_000;

const TREASURY_POLICY_ABI = [
  "function owner() view returns (address)",
  "function serviceOperators(address) view returns (bool)"
];

const AGENT_ACCOUNT_READ_ABI = [
  "function domainSeparator() view returns (bytes32)",
  "function escrowOperators(address escrowOperator) view returns (bool)",
  "function positions(address account, address asset) view returns (uint256 liquid,uint256 reserved,uint256 strategyAllocated,uint256 collateralLocked,uint256 jobStakeLocked,uint256 debtOutstanding)"
];

const ESCROW_READ_ABI = [
  "function accounts() view returns (address)"
];

const REQUIRED_AGENT_ACCOUNT_FNS = [
  "escrowOperators",
  "setEscrowOperator",
  "domainSeparator",
  "sendToAgentFor",
  "hashSendToAgentAuthorization",
  "sendToAgentAuthorizationUsed",
  "cancelRecurringTemplateReserve"
];

export function parseArgs(argv) {
  const args = {
    dryRun: true,
    profile: "testnet",
    phase: "all",
    signerSecretRef: undefined,
    newAgentAccount: undefined,
    newEscrow: undefined,
    agentAccountDeployTx: undefined,
    escrowDeployTx: undefined,
    multisigExecTx: undefined,
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
    else if (arg === "--signer-secret-ref") args.signerSecretRef = argv[++i];
    else if (arg === "--new-agent-account") args.newAgentAccount = argv[++i];
    else if (arg === "--new-escrow") args.newEscrow = argv[++i];
    else if (arg === "--agent-account-deploy-tx") args.agentAccountDeployTx = argv[++i];
    else if (arg === "--escrow-deploy-tx") args.escrowDeployTx = argv[++i];
    else if (arg === "--multisig-exec-tx") args.multisigExecTx = argv[++i];
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
  console.log([
    "Usage: node scripts/ops/redeploy-agent-account-escrow-stack.mjs [options]",
    "",
    "Phases:",
    "  --phase all       (default) dry-run overview for deploy + multisig + finalize",
    "  --phase deploy    deploy new AgentAccountCore and new EscrowCore",
    "  --phase finalize  verify wiring, write manifest/env template, rerun audit",
    "",
    "Modes:",
    "  --dry-run         (default) print/read only",
    "  --commit          send/write for deploy/finalize phases",
    "",
    "Deploy:",
    "  --signer-secret-ref <op://...> 1Password deployer key reference",
    "  PRIVATE_KEY=0x...              CI fallback if no --signer-secret-ref",
    "",
    "Finalize:",
    "  --new-agent-account 0xADDR",
    "  --new-escrow 0xADDR",
    "  --agent-account-deploy-tx 0xHASH",
    "  --escrow-deploy-tx 0xHASH",
    "  --multisig-exec-tx 0xHASH",
    "  --skip-revoke                  tolerate old EscrowCore roles still wired",
    "  --skip-manifest-update",
    "  --skip-audit-rerun",
    "",
    "Old-stack reserve safety:",
    "  --acknowledge-orphaned-balances",
    "  --orphan-scan-from-block <n>",
    `  --orphan-scan-chunk-size <n>    default ${DEFAULT_ORPHAN_SCAN_CHUNK_SIZE}`
  ].join("\n"));
}

function assertAddress(label, value) {
  if (!ADDRESS_RE.test(String(value))) throw new Error(`${label} is not a valid address: ${value}`);
}

function assertTxHash(label, value) {
  if (!TX_HASH_RE.test(String(value))) throw new Error(`${label} is not a valid tx hash: ${value}`);
}

function ciEqual(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

async function loadDeployments(profile) {
  const path = resolve(repoRoot, "deployments", `${profile}.json`);
  return { path, manifest: JSON.parse(await readFile(path, "utf8")) };
}

async function loadContractArtifact(contractName) {
  const path = resolve(repoRoot, "out", `${contractName}.sol`, `${contractName}.json`);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`Build artifact not found at ${path}. Run \`forge build\` first.`);
  }
  const artifact = JSON.parse(raw);
  const bytecode = artifact.bytecode?.object ?? artifact.bytecode;
  if (!bytecode || bytecode === "0x") throw new Error(`${contractName} artifact has empty bytecode.`);
  return { abi: artifact.abi, bytecode };
}

function artifactFunctionNames(artifact) {
  return new Set(artifact.abi.filter((entry) => entry.type === "function").map((entry) => entry.name));
}

export function assertArtifactHasAgentAccountSelectors(artifact) {
  const names = artifactFunctionNames(artifact);
  const missing = REQUIRED_AGENT_ACCOUNT_FNS.filter((name) => !names.has(name));
  if (missing.length) {
    throw new Error(
      `AgentAccountCore artifact is missing selector(s): ${missing.join(", ")}. ` +
      "Run `forge build` against current main before redeploying."
    );
  }
}

function summarizeSelectors(label, artifact, required) {
  const names = artifactFunctionNames(artifact);
  return `${label}: ${required.map((name) => `${name}=${names.has(name)}`).join(" ")}`;
}

export function rewriteSettlementAddressesInTemplate(text, { newAgentAccount, newEscrow }) {
  const replacements = [
    ["AGENT_ACCOUNT_ADDRESS", newAgentAccount],
    ["ESCROW_CORE_ADDRESS", newEscrow]
  ];
  let next = text;
  const previousValues = {};
  const missing = [];
  let changed = false;

  for (const [key, value] of replacements) {
    const re = new RegExp(`^(${key}=)(.*)$`, "m");
    const match = next.match(re);
    if (!match) {
      missing.push(key);
      continue;
    }
    previousValues[key] = match[2].trim();
    if (previousValues[key] === value) continue;
    next = next.replace(re, `$1${value}`);
    changed = true;
  }

  return { changed, text: next, previousValues, missing };
}

async function syncEnvTemplate({ newAgentAccount, newEscrow, dryRun }) {
  const templatePath = resolve(repoRoot, "deploy", "backend.env.template");
  const text = await readFile(templatePath, "utf8");
  const result = rewriteSettlementAddressesInTemplate(text, { newAgentAccount, newEscrow });
  if (result.missing.length) {
    throw new Error(`deploy/backend.env.template is missing: ${result.missing.join(", ")}`);
  }
  if (result.changed && !dryRun) await writeFile(templatePath, result.text, "utf8");
  return { templatePath, ...result };
}

function resolveSignerKey(args) {
  if (args.signerSecretRef) return loadKeyFromOp(args.signerSecretRef);
  const value = String(process.env.PRIVATE_KEY ?? "").trim();
  if (!PRIVATE_KEY_RE.test(value)) {
    throw new Error(
      "Provide the deployer key via --signer-secret-ref 'op://...' or PRIVATE_KEY env."
    );
  }
  return value;
}

async function planDeployStack({ provider, manifest, accountArtifact, escrowArtifact }) {
  const treasury = manifest.contracts.treasuryPolicy;
  const strategyRegistry = manifest.contracts.strategyAdapterRegistry;
  const reputation = manifest.contracts.reputationSbt;
  const deployer = manifest.deployer;
  assertAddress("contracts.treasuryPolicy", treasury);
  assertAddress("contracts.strategyAdapterRegistry", strategyRegistry);
  assertAddress("contracts.reputationSbt", reputation);
  assertAddress("deployments.deployer", deployer);

  const nonce = await provider.getTransactionCount(deployer);
  const predictedAgentAccount = getCreateAddress({ from: deployer, nonce });
  const predictedEscrow = getCreateAddress({ from: deployer, nonce: nonce + 1 });
  const accountConstructorArgs = [treasury, strategyRegistry];
  const escrowConstructorArgs = [treasury, predictedAgentAccount, reputation];
  const accountFactory = new ContractFactory(accountArtifact.abi, accountArtifact.bytecode, undefined);
  const escrowFactory = new ContractFactory(escrowArtifact.abi, escrowArtifact.bytecode, undefined);
  const accountDeployTx = await accountFactory.getDeployTransaction(...accountConstructorArgs);
  const escrowDeployTx = await escrowFactory.getDeployTransaction(...escrowConstructorArgs);

  return {
    deployer,
    nonce,
    predictedAgentAccount,
    predictedEscrow,
    accountConstructorArgs,
    escrowConstructorArgs,
    accountCreationBytes: (accountDeployTx.data.length - 2) / 2,
    escrowCreationBytes: (escrowDeployTx.data.length - 2) / 2
  };
}

function printDeployPlan(plan) {
  console.log("\n## Phase 1: deploy fresh settlement stack");
  console.log(`  deployer:             ${plan.deployer}`);
  console.log(`  deployer nonce:       ${plan.nonce}`);
  console.log(`  AgentAccountCore:     CREATE nonce ${plan.nonce} -> ${plan.predictedAgentAccount}`);
  console.log(`  AAC constructor:      AgentAccountCore(${plan.accountConstructorArgs.join(", ")})`);
  console.log(`  AAC creation size:    ${plan.accountCreationBytes} bytes`);
  console.log(`  EscrowCore:           CREATE nonce ${plan.nonce + 1} -> ${plan.predictedEscrow}`);
  console.log(`  Escrow constructor:   EscrowCore(${plan.escrowConstructorArgs.join(", ")})`);
  console.log(`  Escrow creation size: ${plan.escrowCreationBytes} bytes`);
  console.log("  Prediction assumes no other tx from the deployer lands between dry-run and commit.");
}

async function commitDeployStack({ wallet, manifest, accountArtifact, escrowArtifact }) {
  const accountFactory = new ContractFactory(accountArtifact.abi, accountArtifact.bytecode, wallet);
  const escrowFactory = new ContractFactory(escrowArtifact.abi, escrowArtifact.bytecode, wallet);
  const accountArgs = [manifest.contracts.treasuryPolicy, manifest.contracts.strategyAdapterRegistry];

  console.log("\nSending AgentAccountCore deploy tx...");
  const account = await accountFactory.deploy(...accountArgs);
  const accountTx = account.deploymentTransaction();
  console.log(`  tx: ${accountTx?.hash}`);
  await account.waitForDeployment();
  const newAgentAccount = await account.getAddress();
  const accountReceipt = await accountTx.wait();
  console.log(`  deployed: ${newAgentAccount}`);

  const escrowArgs = [manifest.contracts.treasuryPolicy, newAgentAccount, manifest.contracts.reputationSbt];
  console.log("\nSending EscrowCore deploy tx...");
  const escrow = await escrowFactory.deploy(...escrowArgs);
  const escrowTx = escrow.deploymentTransaction();
  console.log(`  tx: ${escrowTx?.hash}`);
  await escrow.waitForDeployment();
  const newEscrow = await escrow.getAddress();
  const escrowReceipt = await escrowTx.wait();
  console.log(`  deployed: ${newEscrow}`);

  return {
    newAgentAccount,
    newEscrow,
    agentAccountDeployTx: accountTx.hash,
    escrowDeployTx: escrowTx.hash,
    accountBlockNumber: accountReceipt?.blockNumber ?? null,
    escrowBlockNumber: escrowReceipt?.blockNumber ?? null
  };
}

async function runOldStackReservePreflight({ args, provider, manifest }) {
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
  log("\n## Old-stack reserve check");
  log(decision.message);
  return { report, decision };
}

function printWireOverview({ plan, manifest, recommendSkipRevoke }) {
  console.log("\n## Phase 2: wire via multisig");
  console.log("  Generate the first-leg recipe:");
  console.log("    node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \\");
  console.log(`      --new-agent-account ${plan.predictedAgentAccount} \\`);
  console.log(`      --new-escrow ${plan.predictedEscrow} --signer hot${recommendSkipRevoke ? " --skip-revoke" : ""}`);
  if (recommendSkipRevoke) {
    console.log("");
    console.log("  Old AAC reserve tails are still present, so --skip-revoke is recommended");
    console.log("  until those posted-job escrows are reconciled. This moves the backend to");
    console.log("  the fresh stack without immediately orphaning old EscrowCore release paths.");
  }
  console.log("");
  console.log("  The batch approves:");
  console.log(`    TreasuryPolicy.setServiceOperator(${plan.predictedAgentAccount}, true)`);
  console.log(`    AgentAccountCore(${plan.predictedAgentAccount}).setEscrowOperator(${plan.predictedEscrow}, true)`);
  console.log(`    TreasuryPolicy.setServiceOperator(${plan.predictedEscrow}, true)`);
  if (recommendSkipRevoke) {
    console.log("  The batch leaves old EscrowCore roles wired for old-balance reconciliation.");
  } else {
    console.log(`    AgentAccountCore(${manifest.contracts.agentAccountCore}).setEscrowOperator(${manifest.contracts.escrowCore}, false)`);
    console.log(`    TreasuryPolicy.setServiceOperator(${manifest.contracts.escrowCore}, false)`);
  }
}

function printFinalizeOverview() {
  console.log("\n## Phase 3: finalize and fund");
  console.log("  After multisig.MultisigExecuted:");
  console.log("    node scripts/ops/redeploy-agent-account-escrow-stack.mjs --phase finalize \\");
  console.log("      --new-agent-account 0xNEW_AAC --new-escrow 0xNEW_ESCROW \\");
  console.log("      --agent-account-deploy-tx 0xAAC_DEPLOY \\");
  console.log("      --escrow-deploy-tx 0xESCROW_DEPLOY \\");
  console.log("      --multisig-exec-tx 0xEXEC --commit");
  console.log("");
  console.log("  Then fund the new AAC reward bank:");
  console.log("    KMS_KEY_ID=<blockchain-signer-key-arn> AWS_REGION=<region> \\");
  console.log("      node scripts/ops/fund-signer-usdc-deposit.mjs --amount 100000000 --use-kms --commit");
}

async function updateManifest({ deploymentsPath, manifest, newAgentAccount, newEscrow, args }) {
  const oldAgentAccount = manifest.contracts.agentAccountCore;
  const oldEscrow = manifest.contracts.escrowCore;
  manifest.contracts.agentAccountCore = newAgentAccount;
  manifest.contracts.escrowCore = newEscrow;
  manifest.agentAccountRedeployedAt = new Date().toISOString();
  manifest.escrowRedeployedAt = manifest.agentAccountRedeployedAt;
  manifest.agentAccountRedeployTxHashes = {
    deploy: args.agentAccountDeployTx,
    multisigExec: args.multisigExecTx,
    previousAgentAccount: oldAgentAccount
  };
  manifest.escrowRedeployTxHashes = {
    deploy: args.escrowDeployTx,
    multisigExec: args.multisigExecTx,
    revokeOld: args.skipRevoke ? null : "batched-in-multisig-exec",
    previousEscrow: oldEscrow
  };
  await writeFile(deploymentsPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

async function runAudit(profile) {
  return new Promise((resolveAudit, rejectAudit) => {
    const child = spawn(process.execPath, [
      resolve(repoRoot, "scripts/ops/audit-launch-readiness.mjs"),
      "--profile",
      profile
    ], { stdio: "inherit", cwd: repoRoot });
    child.on("error", rejectAudit);
    child.on("exit", (code) => resolveAudit(code ?? 1));
  });
}

function normalizePosition(position) {
  return {
    liquid: BigInt(position.liquid).toString(),
    reserved: BigInt(position.reserved).toString(),
    debtOutstanding: BigInt(position.debtOutstanding).toString()
  };
}

async function runFinalize({ args, deploymentsPath, manifest, provider }) {
  assertAddress("--new-agent-account", args.newAgentAccount);
  assertAddress("--new-escrow", args.newEscrow);
  assertTxHash("--agent-account-deploy-tx", args.agentAccountDeployTx);
  assertTxHash("--escrow-deploy-tx", args.escrowDeployTx);
  assertTxHash("--multisig-exec-tx", args.multisigExecTx);

  const oldAgentAccount = manifest.contracts.agentAccountCore;
  const oldEscrow = manifest.contracts.escrowCore;
  if (ciEqual(args.newAgentAccount, oldAgentAccount)) {
    throw new Error("--new-agent-account matches current manifest AgentAccountCore; nothing to finalize.");
  }
  if (ciEqual(args.newEscrow, oldEscrow)) {
    throw new Error("--new-escrow matches current manifest EscrowCore; nothing to finalize.");
  }

  const treasury = new Contract(manifest.contracts.treasuryPolicy, TREASURY_POLICY_ABI, provider);
  const newAccount = new Contract(args.newAgentAccount, AGENT_ACCOUNT_READ_ABI, provider);
  const oldAccount = new Contract(oldAgentAccount, AGENT_ACCOUNT_READ_ABI, provider);
  const newEscrow = new Contract(args.newEscrow, ESCROW_READ_ABI, provider);
  const signer = manifest.verifier;
  const asset = manifest.contracts.token;

  const [
    newAgentCode,
    newEscrowCode,
    domainSeparator,
    escrowAccounts,
    newAgentIsOperator,
    newEscrowIsOperator,
    oldEscrowIsOperator,
    newAacEscrowOperator,
    oldAacOldEscrowOperator,
    signerIsOperator,
    signerPosition
  ] = await Promise.all([
    provider.getCode(args.newAgentAccount),
    provider.getCode(args.newEscrow),
    newAccount.domainSeparator(),
    newEscrow.accounts(),
    treasury.serviceOperators(args.newAgentAccount),
    treasury.serviceOperators(args.newEscrow),
    treasury.serviceOperators(oldEscrow),
    newAccount.escrowOperators(args.newEscrow),
    oldAccount.escrowOperators(oldEscrow),
    treasury.serviceOperators(signer),
    newAccount.positions(signer, asset)
  ]);

  console.log("\n## Phase 3: finalize fresh settlement stack");
  console.log(`  new AgentAccountCore:                   ${args.newAgentAccount}`);
  console.log(`  new EscrowCore:                         ${args.newEscrow}`);
  console.log(`  old AgentAccountCore:                   ${oldAgentAccount}`);
  console.log(`  old EscrowCore:                         ${oldEscrow}`);
  console.log("");
  console.log(`  new AAC code bytes:                     ${newAgentCode === "0x" ? 0 : (newAgentCode.length - 2) / 2}`);
  console.log(`  new Escrow code bytes:                  ${newEscrowCode === "0x" ? 0 : (newEscrowCode.length - 2) / 2}`);
  console.log(`  AgentAccountCore.domainSeparator():     ${domainSeparator}`);
  console.log(`  EscrowCore.accounts():                  ${escrowAccounts}`);
  console.log(`  serviceOperators[new AAC]:              ${newAgentIsOperator}`);
  console.log(`  serviceOperators[new Escrow]:           ${newEscrowIsOperator}`);
  console.log(`  newAAC.escrowOperators[new Escrow]:     ${newAacEscrowOperator}`);
  console.log(`  serviceOperators[signer]:               ${signerIsOperator}`);
  console.log(`  newAAC.positions(signer, USDC):         ${JSON.stringify(normalizePosition(signerPosition))}`);
  console.log(`  serviceOperators[old Escrow]:           ${oldEscrowIsOperator} (expected false unless --skip-revoke)`);
  console.log(`  oldAAC.escrowOperators[old Escrow]:     ${oldAacOldEscrowOperator} (expected false unless --skip-revoke)`);

  if (newAgentCode === "0x") throw new Error(`No code at new AgentAccountCore ${args.newAgentAccount}.`);
  if (newEscrowCode === "0x") throw new Error(`No code at new EscrowCore ${args.newEscrow}.`);
  if (!ciEqual(escrowAccounts, args.newAgentAccount)) {
    throw new Error(`EscrowCore.accounts()=${escrowAccounts} does not match new AgentAccountCore ${args.newAgentAccount}.`);
  }
  if (!newAgentIsOperator) throw new Error("TreasuryPolicy.serviceOperators(new AgentAccountCore) is false.");
  if (!newEscrowIsOperator) throw new Error("TreasuryPolicy.serviceOperators(new EscrowCore) is false.");
  if (!newAacEscrowOperator) throw new Error("new AgentAccountCore.escrowOperators(new EscrowCore) is false.");
  if (!signerIsOperator) throw new Error(`TreasuryPolicy.serviceOperators(signer ${signer}) is false.`);
  if (!args.skipRevoke && oldEscrowIsOperator) throw new Error("Old EscrowCore is still a TreasuryPolicy serviceOperator.");
  if (!args.skipRevoke && oldAacOldEscrowOperator) throw new Error("Old EscrowCore is still wired on old AgentAccountCore.");

  if (args.skipManifestUpdate) {
    console.log("\n  Manifest/env template update skipped (--skip-manifest-update).");
  } else if (!args.dryRun) {
    await updateManifest({
      deploymentsPath,
      manifest,
      newAgentAccount: args.newAgentAccount,
      newEscrow: args.newEscrow,
      args
    });
    console.log(`\n  Wrote ${deploymentsPath}#contracts.agentAccountCore = ${args.newAgentAccount}`);
    console.log(`  Wrote ${deploymentsPath}#contracts.escrowCore = ${args.newEscrow}`);

    const tpl = await syncEnvTemplate({
      newAgentAccount: args.newAgentAccount,
      newEscrow: args.newEscrow,
      dryRun: false
    });
    if (tpl.changed) {
      console.log(`  Wrote ${tpl.templatePath} settlement addresses`);
    } else {
      console.log(`  ${tpl.templatePath}: no address changes needed`);
    }
  } else {
    console.log("\n  Dry-run: would update deployments manifest and deploy/backend.env.template.");
  }

  let auditExitCode = null;
  if (args.skipAuditRerun) {
    console.log("\n  Audit re-run skipped (--skip-audit-rerun).");
  } else if (!args.dryRun) {
    console.log(`\n  Running audit-launch-readiness --profile ${args.profile}...`);
    auditExitCode = await runAudit(args.profile);
  } else {
    console.log(`\n  Dry-run: would run audit-launch-readiness --profile ${args.profile}.`);
  }

  console.log("\n## Summary");
  console.log(JSON.stringify({
    profile: args.profile,
    newAgentAccount: args.newAgentAccount,
    newEscrow: args.newEscrow,
    txHashes: {
      agentAccountDeploy: args.agentAccountDeployTx,
      escrowDeploy: args.escrowDeployTx,
      multisigExec: args.multisigExecTx
    },
    onchainAfter: {
      domainSeparator,
      escrowAccounts,
      newAgentIsOperator,
      newEscrowIsOperator,
      newAacEscrowOperator,
      signerIsOperator,
      signerPosition: normalizePosition(signerPosition)
    },
    auditExitCode
  }, null, 2));

  if (auditExitCode !== null && auditExitCode !== 0) process.exitCode = 3;
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

  console.log("# redeploy-agent-account-escrow-stack");
  console.log(`profile:             ${args.profile}`);
  console.log(`manifest:            ${deploymentsPath}`);
  console.log(`rpc:                 ${manifest.rpcUrl}`);
  console.log(`old AgentAccountCore:${manifest.contracts.agentAccountCore}`);
  console.log(`old EscrowCore:      ${manifest.contracts.escrowCore}`);
  console.log(`treasury:            ${manifest.contracts.treasuryPolicy}`);
  console.log(`strategy registry:   ${manifest.contracts.strategyAdapterRegistry}`);
  console.log(`reputation SBT:      ${manifest.contracts.reputationSbt}`);
  console.log(`deployer:            ${manifest.deployer}`);
  console.log(`phase:               ${args.phase}`);
  console.log(`mode:                ${args.dryRun ? "dry-run" : "commit"}`);

  if (args.phase === "finalize") {
    await runFinalize({ args, deploymentsPath, manifest, provider });
    return;
  }

  const reservePreflight = await runOldStackReservePreflight({ args, provider, manifest });
  const recommendSkipRevoke = reservePreflight.report.findings.length > 0;

  const [accountArtifact, escrowArtifact] = await Promise.all([
    loadContractArtifact("AgentAccountCore"),
    loadContractArtifact("EscrowCore")
  ]);
  assertArtifactHasAgentAccountSelectors(accountArtifact);
  assertArtifactHasBrokeredSelectors(escrowArtifact);
  console.log(summarizeSelectors("AgentAccountCore selectors", accountArtifact, REQUIRED_AGENT_ACCOUNT_FNS));
  console.log("EscrowCore brokered selectors verified.");

  const plan = await planDeployStack({ provider, manifest, accountArtifact, escrowArtifact });
  printDeployPlan(plan);

  if (args.phase === "deploy") {
    if (!args.dryRun) {
      const key = resolveSignerKey(args);
      const wallet = new Wallet(key, provider);
      console.log("\n## Signer verification");
      console.log(`  derived address: ${wallet.address}`);
      console.log(`  manifest.deployer: ${manifest.deployer}`);
      if (!ciEqual(wallet.address, manifest.deployer)) {
        console.error(`Signer ${wallet.address} does not match manifest.deployer ${manifest.deployer}. Aborting.`);
        process.exitCode = 2;
        return;
      }
      const result = await commitDeployStack({ wallet, manifest, accountArtifact, escrowArtifact });
      console.log("\n## Deploy result");
      console.log(JSON.stringify({ phase: "deploy", profile: args.profile, deployer: wallet.address, ...result }, null, 2));
      console.log("\nNext: generate the multisig recipe:");
      console.log("  node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \\");
      console.log(`    --new-agent-account ${result.newAgentAccount} \\`);
      console.log(`    --new-escrow ${result.newEscrow} --signer hot${recommendSkipRevoke ? " --skip-revoke" : ""}`);
      if (recommendSkipRevoke) {
        console.log("  (--skip-revoke recommended until old AAC reserved balances are reconciled.)");
      }
      return;
    }
    console.log("\nDry-run only. Re-run with --phase deploy --commit + deployer key to send.");
    return;
  }

  if (!args.dryRun) {
    console.error("\n--phase all is dry-run only; pick deploy / finalize for --commit.");
    process.exitCode = 1;
    return;
  }
  printWireOverview({ plan, manifest, recommendSkipRevoke });
  printFinalizeOverview();
  console.log("\nDry-run only. Use --phase deploy --commit / --phase finalize --commit to act.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`redeploy-agent-account-escrow-stack failed: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
