#!/usr/bin/env node

/**
 * Drain the leaked admin EOA's AgentAccountCore position into the new
 * admin EOA's position. Sequence:
 *
 *   0. OLD admin signs   native PAS transfer to new admin (gas pre-fund)
 *        -> ensures new admin can pay gas for txs 3 & 4. Defaults to 0
 *           (no prefund) — pass `--prefund-pas-wei` to enable.
 *   1. OLD admin signs   AgentAccountCore.withdraw(USDC, amount)
 *        -> moves `amount` from old admin's position.liquid to old admin's EOA wallet
 *   2. OLD admin signs   USDC.transfer(newAdmin, amount)
 *        -> moves USDC from old admin's EOA wallet to new admin's EOA wallet
 *   3. NEW admin signs   USDC.approve(AAC, amount)
 *        -> grants AAC the allowance it needs to pull on deposit
 *   4. NEW admin signs   AgentAccountCore.deposit(USDC, amount)
 *        -> pulls USDC into new admin's position.liquid
 *
 * Both keys are loaded in-process. Only addresses + tx hashes + state
 * deltas are printed; key material never reaches stdout or process env.
 *
 * Modes
 * -----
 *   --dry-run (default)   Reads chain state, prints calldata + planned txs.
 *                         Does not sign or broadcast anything.
 *   --commit              Signs and broadcasts all four txs sequentially.
 *
 * Usage
 * -----
 *   node scripts/ops/rotate-admin-drain.mjs \
 *     --old-env-file /Users/pascalkuriger/repo/Polkadot/mcp-server/.env.local \
 *     --new-key-file .keys/new-admin-eoa.txt \
 *     --amount 9339999
 *
 *   # Add --commit when ready to send.
 *   # --amount is in USDC base units (6 decimals).
 */

import { JsonRpcProvider, Wallet, Contract, Interface } from "ethers";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadKeyFromEnvFile,
  loadKeyFromKeysFile,
  loadDeployments,
  formatUsdc,
  isAddress,
  ciEqual
} from "./rotate-admin-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)"
];
const AGENT_ACCOUNT_ABI = [
  "function withdraw(address asset, uint256 amount)",
  "function deposit(address asset, uint256 amount)",
  "function positions(address account, address asset) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)"
];

function parseArgs(argv) {
  const args = {
    dryRun: true,
    profile: "testnet",
    oldEnvKey: "SIGNER_PRIVATE_KEY",
    expectedOldAddress: "0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519",
    evidenceOut: undefined,
    prefundPasWei: "0"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--commit") args.dryRun = false;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--old-env-file") args.oldEnvFile = resolve(argv[++i]);
    else if (arg === "--old-env-key") args.oldEnvKey = argv[++i];
    else if (arg === "--new-key-file") args.newKeyFile = resolve(argv[++i]);
    else if (arg === "--amount") args.amount = argv[++i];
    else if (arg === "--profile") args.profile = argv[++i];
    else if (arg === "--expected-old") args.expectedOldAddress = argv[++i];
    else if (arg === "--evidence-out") args.evidenceOut = resolve(argv[++i]);
    else if (arg === "--prefund-pas-wei") args.prefundPasWei = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/ops/rotate-admin-drain.mjs [options]",
      "",
      "Options:",
      "  --old-env-file PATH     dotenv file holding the leaked admin key (required)",
      "  --old-env-key NAME      env var name (default SIGNER_PRIVATE_KEY)",
      "  --new-key-file PATH     file holding the new admin's hex private key (required for --commit)",
      "  --amount BASEUNITS      USDC amount in base units (6 decimals). Required.",
      "  --profile NAME          deployments/<profile>.json (default testnet)",
      "  --expected-old ADDR     required derivation of the old key (default 0xFd2EAE…6519)",
      "  --evidence-out PATH     write JSON evidence here on --commit (default stdout only)",
      "  --dry-run               (default) read-only; prints planned txs",
      "  --commit                sign and send the four transactions"
    ].join("\n")
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.oldEnvFile) {
    console.error("--old-env-file is required.");
    process.exitCode = 1;
    return;
  }
  if (!args.amount) {
    console.error("--amount is required (USDC base units).");
    process.exitCode = 1;
    return;
  }

  let amountWei;
  try {
    amountWei = BigInt(args.amount);
  } catch {
    console.error(`--amount must be an integer. Got: ${args.amount}`);
    process.exitCode = 1;
    return;
  }
  if (amountWei <= 0n) {
    console.error("--amount must be positive.");
    process.exitCode = 1;
    return;
  }

  // --- Load deployments ------------------------------------------------------
  const { deployments } = await loadDeployments(repoRoot, args.profile);
  const rpcUrl = deployments.rpcUrl;
  const usdcAddress = deployments.contracts.token;
  const aacAddress = deployments.contracts.agentAccountCore;

  if (!isAddress(args.expectedOldAddress)) {
    console.error(`--expected-old must be a valid address. Got: ${args.expectedOldAddress}`);
    process.exitCode = 1;
    return;
  }

  // --- Load OLD admin key in-process, derive & verify ------------------------
  let oldPrivateKey;
  try {
    oldPrivateKey = loadKeyFromEnvFile(args.oldEnvFile, args.oldEnvKey);
  } catch (error) {
    console.error(`old-env-file load failed: ${error?.message ?? error}`);
    process.exitCode = 1;
    return;
  }
  const provider = new JsonRpcProvider(rpcUrl);
  const oldWallet = new Wallet(oldPrivateKey, provider);
  if (!ciEqual(oldWallet.address, args.expectedOldAddress)) {
    console.error(
      `Old admin key derives to ${oldWallet.address}, expected ${args.expectedOldAddress}. Refusing to continue.`
    );
    process.exitCode = 2;
    return;
  }

  // --- Load NEW admin key (only required for --commit; address-only for dry-run if absent)
  let newWallet = null;
  let newAddress = null;
  if (args.newKeyFile) {
    let newPrivateKey;
    try {
      newPrivateKey = loadKeyFromKeysFile(args.newKeyFile);
    } catch (error) {
      console.error(`new-key-file load failed: ${error?.message ?? error}`);
      process.exitCode = 1;
      return;
    }
    newWallet = new Wallet(newPrivateKey, provider);
    newAddress = newWallet.address;
  } else if (!args.dryRun) {
    console.error("--new-key-file is required for --commit.");
    process.exitCode = 1;
    return;
  }

  // --- Pre-state -------------------------------------------------------------
  const usdc = new Contract(usdcAddress, ERC20_ABI, provider);
  const aac = new Contract(aacAddress, AGENT_ACCOUNT_ABI, provider);

  const [oldEoaBal, oldPos, newEoaBal, newPos, oldAllowance] = await Promise.all([
    usdc.balanceOf(oldWallet.address),
    aac.positions(oldWallet.address, usdcAddress),
    newAddress ? usdc.balanceOf(newAddress) : Promise.resolve(0n),
    newAddress ? aac.positions(newAddress, usdcAddress) : Promise.resolve({ liquid: 0n }),
    newAddress ? usdc.allowance(newAddress, aacAddress) : Promise.resolve(0n)
  ]);

  let prefundPasWei;
  try {
    prefundPasWei = BigInt(args.prefundPasWei);
  } catch {
    console.error(`--prefund-pas-wei must be an integer. Got: ${args.prefundPasWei}`);
    process.exitCode = 1;
    return;
  }
  if (prefundPasWei < 0n) {
    console.error("--prefund-pas-wei must be non-negative.");
    process.exitCode = 1;
    return;
  }

  const oldPasBalance = await provider.getBalance(oldWallet.address);
  const newPasBalance = newAddress ? await provider.getBalance(newAddress) : 0n;

  console.log("# rotate-admin-drain");
  console.log(`mode:                  ${args.dryRun ? "dry-run" : "commit"}`);
  console.log(`profile:               ${args.profile}`);
  console.log(`rpc:                   ${rpcUrl}`);
  console.log(`usdc:                  ${usdcAddress}`);
  console.log(`agentAccountCore:      ${aacAddress}`);
  console.log(`old admin:             ${oldWallet.address}`);
  console.log(`new admin:             ${newAddress ?? "(not loaded — dry-run without --new-key-file)"}`);
  console.log(`amount (base units):   ${amountWei.toString()}`);
  console.log(`amount (USDC):         ${formatUsdc(amountWei)}`);
  console.log(`prefund PAS (wei):     ${prefundPasWei.toString()}  (~${(Number(prefundPasWei) / 1e18).toFixed(6)} PAS)`);
  console.log(`old PAS balance:       ${oldPasBalance.toString()}  (~${(Number(oldPasBalance) / 1e18).toFixed(6)} PAS)`);
  console.log(`new PAS balance:       ${newPasBalance.toString()}  (~${(Number(newPasBalance) / 1e18).toFixed(6)} PAS)`);
  console.log("");

  if (prefundPasWei > 0n && prefundPasWei >= oldPasBalance) {
    console.error(
      `--prefund-pas-wei (${prefundPasWei.toString()}) is >= old admin's PAS balance (${oldPasBalance.toString()}). ` +
        `Leave at least a few PAS dust for gas on txs 1 & 2.`
    );
    process.exitCode = 2;
    return;
  }

  console.log("## Pre-state");
  console.log(`old EOA USDC.balanceOf:                ${oldEoaBal.toString()}  (${formatUsdc(oldEoaBal)} USDC)`);
  console.log(`old AAC.positions.liquid:              ${oldPos.liquid.toString()}  (${formatUsdc(oldPos.liquid)} USDC)`);
  console.log(`old AAC.positions.reserved:            ${oldPos.reserved.toString()}`);
  console.log(`old AAC.positions.debtOutstanding:     ${oldPos.debtOutstanding.toString()}`);
  if (newAddress) {
    console.log(`new EOA USDC.balanceOf:                ${newEoaBal.toString()}  (${formatUsdc(newEoaBal)} USDC)`);
    console.log(`new AAC.positions.liquid:              ${newPos.liquid.toString()}`);
    console.log(`new USDC.allowance(new, AAC):          ${oldAllowance.toString()}`);
  }
  console.log("");

  const withdrawable = BigInt(oldPos.liquid) - BigInt(oldPos.debtOutstanding);
  if (withdrawable < amountWei) {
    console.error(
      `Old admin's withdrawable liquid (${withdrawable.toString()}) is less than --amount (${amountWei.toString()}). ` +
        `Lower --amount or check on-chain state.`
    );
    process.exitCode = 2;
    return;
  }

  // --- Planned calldata ------------------------------------------------------
  const aacIface = new Interface(AGENT_ACCOUNT_ABI);
  const erc20Iface = new Interface(ERC20_ABI);
  const withdrawData = aacIface.encodeFunctionData("withdraw", [usdcAddress, amountWei]);
  const transferData = newAddress
    ? erc20Iface.encodeFunctionData("transfer", [newAddress, amountWei])
    : null;
  const approveData = erc20Iface.encodeFunctionData("approve", [aacAddress, amountWei]);
  const depositData = aacIface.encodeFunctionData("deposit", [usdcAddress, amountWei]);

  console.log("## Planned transactions");
  if (prefundPasWei > 0n) {
    console.log("### 0. OLD admin → NEW admin native PAS transfer (gas prefund)");
    console.log(`     to:    ${newAddress ?? "(new admin)"}`);
    console.log(`     from:  ${oldWallet.address}`);
    console.log(`     value: ${prefundPasWei.toString()} wei  (~${(Number(prefundPasWei) / 1e18).toFixed(6)} PAS)`);
    console.log("");
  }
  console.log("### 1. OLD admin → AgentAccountCore.withdraw(USDC, amount)");
  console.log(`     to:    ${aacAddress}`);
  console.log(`     from:  ${oldWallet.address}`);
  console.log(`     data:  ${withdrawData}`);
  console.log("");
  if (transferData) {
    console.log("### 2. OLD admin → USDC.transfer(newAdmin, amount)");
    console.log(`     to:    ${usdcAddress}`);
    console.log(`     from:  ${oldWallet.address}`);
    console.log(`     data:  ${transferData}`);
    console.log("");
  }
  console.log("### 3. NEW admin → USDC.approve(AAC, amount)");
  console.log(`     to:    ${usdcAddress}`);
  console.log(`     from:  ${newAddress ?? "(new admin)"}`);
  console.log(`     data:  ${approveData}`);
  console.log("");
  console.log("### 4. NEW admin → AgentAccountCore.deposit(USDC, amount)");
  console.log(`     to:    ${aacAddress}`);
  console.log(`     from:  ${newAddress ?? "(new admin)"}`);
  console.log(`     data:  ${depositData}`);
  console.log("");

  if (args.dryRun) {
    console.log("Dry-run only. Re-run with --commit (and --new-key-file) to broadcast.");
    return;
  }

  // --- Commit phase ----------------------------------------------------------
  const aacOld = new Contract(aacAddress, AGENT_ACCOUNT_ABI, oldWallet);
  const usdcOld = new Contract(usdcAddress, ERC20_ABI, oldWallet);
  const aacNew = new Contract(aacAddress, AGENT_ACCOUNT_ABI, newWallet);
  const usdcNew = new Contract(usdcAddress, ERC20_ABI, newWallet);

  console.log("## Sending");

  let tx0 = null;
  let r0 = null;
  if (prefundPasWei > 0n) {
    console.log("0. prefund PAS…");
    tx0 = await oldWallet.sendTransaction({ to: newAddress, value: prefundPasWei });
    r0 = await tx0.wait();
    console.log(`   tx: ${tx0.hash}  block: ${r0?.blockNumber}`);
  }

  console.log("1. withdraw…");
  const tx1 = await aacOld.withdraw(usdcAddress, amountWei);
  const r1 = await tx1.wait();
  console.log(`   tx: ${tx1.hash}  block: ${r1?.blockNumber}`);

  console.log("2. transfer…");
  const tx2 = await usdcOld.transfer(newAddress, amountWei);
  const r2 = await tx2.wait();
  console.log(`   tx: ${tx2.hash}  block: ${r2?.blockNumber}`);

  console.log("3. approve…");
  const tx3 = await usdcNew.approve(aacAddress, amountWei);
  const r3 = await tx3.wait();
  console.log(`   tx: ${tx3.hash}  block: ${r3?.blockNumber}`);

  console.log("4. deposit…");
  const tx4 = await aacNew.deposit(usdcAddress, amountWei);
  const r4 = await tx4.wait();
  console.log(`   tx: ${tx4.hash}  block: ${r4?.blockNumber}`);

  // --- Post-state ------------------------------------------------------------
  const [postOldEoa, postOldPos, postNewEoa, postNewPos, postAllowance] = await Promise.all([
    usdc.balanceOf(oldWallet.address),
    aac.positions(oldWallet.address, usdcAddress),
    usdc.balanceOf(newAddress),
    aac.positions(newAddress, usdcAddress),
    usdc.allowance(newAddress, aacAddress)
  ]);

  console.log("");
  console.log("## Post-state");
  console.log(`old EOA USDC.balanceOf:                ${postOldEoa.toString()}  (expected 0)`);
  console.log(`old AAC.positions.liquid:              ${postOldPos.liquid.toString()}  (expected ${(BigInt(oldPos.liquid) - amountWei).toString()})`);
  console.log(`new EOA USDC.balanceOf:                ${postNewEoa.toString()}  (expected 0)`);
  console.log(`new AAC.positions.liquid:              ${postNewPos.liquid.toString()}  (expected ${(BigInt(newPos.liquid) + amountWei).toString()})`);
  console.log(`new USDC.allowance(new, AAC):          ${postAllowance.toString()}  (expected 0 after deposit pulls)`);

  const evidence = {
    profile: args.profile,
    chain: { rpcUrl, agentAccountAddress: aacAddress, usdcAddress },
    oldAdmin: oldWallet.address,
    newAdmin: newAddress,
    amountBaseUnits: amountWei.toString(),
    prefundPasWei: prefundPasWei.toString(),
    txs: [
      tx0 ? { step: "0_prefund_pas", from: oldWallet.address, to: newAddress, txHash: tx0.hash, blockNumber: r0?.blockNumber ?? null, valueWei: prefundPasWei.toString() } : null,
      { step: "1_withdraw_old", from: oldWallet.address, to: aacAddress, txHash: tx1.hash, blockNumber: r1?.blockNumber ?? null, calldata: withdrawData },
      { step: "2_transfer_old_to_new", from: oldWallet.address, to: usdcAddress, txHash: tx2.hash, blockNumber: r2?.blockNumber ?? null, calldata: transferData },
      { step: "3_approve_new", from: newAddress, to: usdcAddress, txHash: tx3.hash, blockNumber: r3?.blockNumber ?? null, calldata: approveData },
      { step: "4_deposit_new", from: newAddress, to: aacAddress, txHash: tx4.hash, blockNumber: r4?.blockNumber ?? null, calldata: depositData }
    ].filter(Boolean),
    before: {
      oldEoa: oldEoaBal.toString(),
      oldPositionLiquid: oldPos.liquid.toString(),
      newEoa: newEoaBal.toString(),
      newPositionLiquid: newPos.liquid.toString()
    },
    after: {
      oldEoa: postOldEoa.toString(),
      oldPositionLiquid: postOldPos.liquid.toString(),
      newEoa: postNewEoa.toString(),
      newPositionLiquid: postNewPos.liquid.toString()
    }
  };

  console.log("");
  console.log("## Evidence JSON");
  const evidenceJson = JSON.stringify(evidence, null, 2);
  console.log(evidenceJson);

  if (args.evidenceOut) {
    writeFileSync(args.evidenceOut, evidenceJson + "\n");
    console.log("");
    console.log(`Written to: ${args.evidenceOut}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`rotate-admin-drain failed: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
