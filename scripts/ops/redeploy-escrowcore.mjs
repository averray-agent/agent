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
 *   2. wire      TreasuryPolicy.setServiceOperator(new, true) — and
 *                (recommended) setServiceOperator(old, false) batched in
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

import { JsonRpcProvider, Wallet, Contract, ContractFactory, Interface, formatEther, getCreateAddress } from "ethers";
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

const PHASES = new Set(["deploy", "finalize", "all"]);
const PRIVATE_KEY_RE = /^0x[a-fA-F0-9]{64}$/u;

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
    skipAuditRerun: false
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
  const [owner, oldIsOperator] = await Promise.all([
    treasury.owner(),
    treasury.serviceOperators(manifest.contracts.escrowCore)
  ]);
  return { owner, oldIsOperator };
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
  const iface = new Interface(TREASURY_POLICY_ABI);
  const approveData = iface.encodeFunctionData("setServiceOperator", [placeholder, true]);
  const revokeData = iface.encodeFunctionData("setServiceOperator", [manifest.contracts.escrowCore, false]);

  console.log(`\n## Phase 2: wire (multisig.asMulti via Apps, NOT this script)`);
  console.log(`  owner is the H160 of SS58 multisig — no private key. Generate the recipe with:`);
  console.log(`    node scripts/ops/redeploy-escrowcore-wire-multisig.mjs \\`);
  console.log(`      --new-escrow ${placeholder} --signer hot`);
  console.log(`  then sign in polkadot-js-apps, record {height, index}, run again with --signer ledger.`);
  console.log("");
  console.log(`  Inner EVM calldata that the recipe will wrap (for review):`);
  console.log(`    [1] setServiceOperator(${placeholder}, true)`);
  console.log(`        data: ${approveData}`);
  console.log(`    [2] setServiceOperator(${manifest.contracts.escrowCore}, false)`);
  console.log(`        data: ${revokeData}`);
  console.log("");
  console.log(`  Owner (multisig SS58):           12nHTKYfV64pnxsVRB6Cjn6kQPPH64Ehnr8zgqZxvfa8hJvQ`);
  console.log(`  Owner (H160 onchain):            ${wiringState.owner}`);
  console.log(`  Old escrow operator currently:   ${wiringState.oldIsOperator}`);
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
  const [newIsOperator, oldIsOperator, newCode] = await Promise.all([
    treasury.serviceOperators(newEscrow),
    treasury.serviceOperators(oldEscrow),
    provider.getCode(newEscrow)
  ]);
  console.log("");
  console.log(`  serviceOperators[newEscrow]: ${newIsOperator}  (expected: true)`);
  console.log(`  serviceOperators[oldEscrow]: ${oldIsOperator}  (expected: false unless --skip-revoke)`);
  console.log(`  newEscrow code size:         ${newCode === "0x" ? 0 : (newCode.length - 2) / 2} bytes`);

  if (!newIsOperator) {
    throw new Error(
      `On-chain check failed: serviceOperators[${newEscrow}] is false. ` +
      `The multisig swap has not landed yet — re-run finalize after multisig.MultisigExecuted fires.`
    );
  }
  if (!args.skipRevoke && oldIsOperator) {
    throw new Error(
      `On-chain check failed: serviceOperators[${oldEscrow}] is still true. ` +
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
  console.log(`old escrow operator?:  ${wiringState.oldIsOperator}`);
  console.log(`deployer (manifest):   ${manifest.deployer}`);
  console.log(`phase:                 ${args.phase}`);
  console.log(`mode:                  ${args.dryRun ? "dry-run" : "commit"}`);

  // --phase finalize: read-only verify + manifest write + audit re-run.
  if (args.phase === "finalize") {
    await runFinalize({ args, deploymentsPath, manifest, provider, wiringState });
    return;
  }

  // --phase deploy: print plan; with --commit, send EVM CREATE.
  if (args.phase === "deploy") {
    const artifact = await loadEscrowArtifact();
    console.log(`build runtime size:    ${(artifact.bytecode.length - 2) / 2} bytes creation / artifact ABI has claimJobFor: ${artifact.abi.some(f => f.name === "claimJobFor")}`);
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
    console.log(`build runtime size:    ${(artifact.bytecode.length - 2) / 2} bytes creation / artifact ABI has claimJobFor: ${artifact.abi.some(f => f.name === "claimJobFor")}`);
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
