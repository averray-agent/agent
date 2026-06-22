#!/usr/bin/env node
//
// Batch-fund testnet beta wallets with USDC + native PAS gas, from a pool wallet.
//
// Why this exists: Polkadot Hub TestNet has NO USDC faucet and USDC (asset 1337,
// precompile 0x…01200000) is NOT mintable — the only way to acquire it is a
// PAS→USDC swap (AssetConversion pallet) or a transfer from a holder (see
// fund-signer-usdc-deposit.mjs). So instead of every closed-beta tester doing that
// day-long swap, seed ONE pool wallet with USDC + PAS once, then run this to drip a
// starter balance to each invited wallet in seconds.
//
// What it does: from the pool wallet, send native PAS (gas) + an ERC20 USDC.transfer
// to each target EOA. It does NOT deposit into AgentAccountCore — the tester's first
// product action is a deposit (account/fund) once they hold USDC.
//
// Dry-run by default; --commit to send. Pool key via POOL_PRIVATE_KEY env (a dry-run
// without the key can read pool balances via POOL_ADDRESS_OVERRIDE).
//
// Usage:
//   POOL_PRIVATE_KEY=0x… node scripts/ops/fund-test-wallets.mjs \
//     --wallets 0xAAA…,0xBBB… --usdc 5 --pas 1            # preview, signs nothing
//   POOL_PRIVATE_KEY=0x… node scripts/ops/fund-test-wallets.mjs \
//     --wallets 0xAAA…,0xBBB… --usdc 5 --pas 1 --commit   # send
//
//   --usdc is in USDC (6dp), --pas is in PAS (18dp), each PER wallet.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const USDC_DECIMALS = 6;
const PAS_DECIMALS = 18;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;
// Pool gas headroom kept back beyond the PAS actually handed out (covers the
// 2 txs per wallet the pool itself signs).
const POOL_GAS_HEADROOM_WEI = 500_000_000_000_000_000n; // 0.5 PAS

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)"
];

export function parseArgs(argv) {
  const args = { dryRun: true, wallets: [], usdc: "5", pas: "1", profile: "testnet", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--commit") args.dryRun = false;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--wallets") {
      args.wallets = String(argv[++i] ?? "")
        .split(",")
        .map((w) => w.trim())
        .filter(Boolean);
    } else if (arg === "--usdc") args.usdc = argv[++i];
    else if (arg === "--pas") args.pas = argv[++i];
    else if (arg === "--profile") args.profile = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

// Pure: validate + dedupe targets, total the spend, flag shortfalls. No ethers, so
// the unit test runs without node_modules. Amounts are BigInt base units.
export function planBatchFund({ wallets, usdcPerWallet, pasPerWallet, poolUsdc, poolPas, gasHeadroom = POOL_GAS_HEADROOM_WEI }) {
  if (!Array.isArray(wallets) || wallets.length === 0) {
    throw new Error("No target wallets. Pass --wallets 0xA,0xB,…");
  }
  if (usdcPerWallet <= 0n || pasPerWallet <= 0n) {
    throw new Error("--usdc and --pas must both be positive.");
  }
  const seen = new Set();
  const targets = [];
  for (const w of wallets) {
    if (!ADDRESS_RE.test(w)) throw new Error(`Not a valid 0x address: ${w}`);
    const key = w.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate target wallet: ${w}`);
    seen.add(key);
    targets.push(w);
  }
  const n = BigInt(targets.length);
  const totalUsdc = usdcPerWallet * n;
  const totalPas = pasPerWallet * n;
  return {
    targets,
    totalUsdc,
    totalPas,
    usdcShort: poolUsdc < totalUsdc,
    pasShort: poolPas < totalPas + gasHeadroom
  };
}

function formatUnits(baseUnits, decimals) {
  const big = BigInt(baseUnits);
  const divisor = 10n ** BigInt(decimals);
  const whole = big / divisor;
  const fraction = (big % divisor).toString().padStart(decimals, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("See the header comment in scripts/ops/fund-test-wallets.mjs for usage.");
    return;
  }

  const { JsonRpcProvider, Wallet, Contract, parseUnits } = await import("ethers");

  const deployments = JSON.parse(
    await readFile(resolve(repoRoot, "deployments", `${args.profile}.json`), "utf8")
  );
  const rpcUrl = deployments.rpcUrl;
  const usdcAddress = deployments.contracts.token;
  const provider = new JsonRpcProvider(rpcUrl);

  const usdcPerWallet = parseUnits(String(args.usdc), USDC_DECIMALS);
  const pasPerWallet = parseUnits(String(args.pas), PAS_DECIMALS);

  // Resolve the pool wallet: key for commit (and dry-run), or an address override
  // for a key-less dry-run.
  let pool = null;
  let poolAddress = "";
  const poolKey = String(process.env.POOL_PRIVATE_KEY ?? "").trim();
  if (poolKey) {
    if (!/^0x[a-fA-F0-9]{64}$/u.test(poolKey)) {
      throw new Error("POOL_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key.");
    }
    pool = new Wallet(poolKey, provider);
    poolAddress = pool.address;
  } else {
    poolAddress = String(process.env.POOL_ADDRESS_OVERRIDE ?? "").trim();
    if (!ADDRESS_RE.test(poolAddress)) {
      throw new Error(
        "No pool wallet. Set POOL_PRIVATE_KEY (commit or dry-run), or POOL_ADDRESS_OVERRIDE for a key-less dry-run."
      );
    }
    if (!args.dryRun) throw new Error("--commit requires POOL_PRIVATE_KEY (POOL_ADDRESS_OVERRIDE is dry-run only).");
  }

  const usdcRead = new Contract(usdcAddress, ERC20_ABI, provider);
  const [poolUsdc, poolPas] = await Promise.all([
    usdcRead.balanceOf(poolAddress),
    provider.getBalance(poolAddress)
  ]);

  const plan = planBatchFund({
    wallets: args.wallets,
    usdcPerWallet,
    pasPerWallet,
    poolUsdc: BigInt(poolUsdc),
    poolPas: BigInt(poolPas)
  });

  console.log("# fund-test-wallets");
  console.log(`profile:        ${args.profile}`);
  console.log(`rpc:            ${rpcUrl}`);
  console.log(`pool:           ${poolAddress}`);
  console.log(`pool USDC:      ${formatUnits(poolUsdc, USDC_DECIMALS)}`);
  console.log(`pool PAS:       ${formatUnits(poolPas, PAS_DECIMALS)}`);
  console.log(`targets:        ${plan.targets.length}`);
  console.log(`per wallet:     ${formatUnits(usdcPerWallet, USDC_DECIMALS)} USDC + ${formatUnits(pasPerWallet, PAS_DECIMALS)} PAS`);
  console.log(`total:          ${formatUnits(plan.totalUsdc, USDC_DECIMALS)} USDC + ${formatUnits(plan.totalPas, PAS_DECIMALS)} PAS`);
  console.log(`mode:           ${args.dryRun ? "dry-run" : "commit"}`);
  console.log("");

  if (plan.usdcShort || plan.pasShort) {
    if (plan.usdcShort) {
      console.error(
        `Pool USDC (${formatUnits(poolUsdc, USDC_DECIMALS)}) < total needed (${formatUnits(plan.totalUsdc, USDC_DECIMALS)}). ` +
          "Seed the pool with more USDC (PAS→USDC swap, or transfer from a holder)."
      );
    }
    if (plan.pasShort) {
      console.error(
        `Pool PAS (${formatUnits(poolPas, PAS_DECIMALS)}) < total + gas headroom. ` +
          "Top up PAS from the Polkadot faucet (https://faucet.polkadot.io/?parachain=1000)."
      );
    }
    process.exitCode = 2;
    return;
  }

  if (args.dryRun) {
    console.log("## Would send (per target): native PAS, then USDC.transfer");
    for (const t of plan.targets) {
      console.log(`  ${t}  ← ${formatUnits(pasPerWallet, PAS_DECIMALS)} PAS + ${formatUnits(usdcPerWallet, USDC_DECIMALS)} USDC`);
    }
    console.log("");
    console.log("Dry-run only. Re-run with --commit (and POOL_PRIVATE_KEY) to send.");
    return;
  }

  const usdcWrite = new Contract(usdcAddress, ERC20_ABI, pool);
  console.log("## Sending");
  for (const t of plan.targets) {
    const pasTx = await pool.sendTransaction({ to: t, value: pasPerWallet });
    await pasTx.wait();
    const usdcTx = await usdcWrite.transfer(t, usdcPerWallet);
    await usdcTx.wait();
    console.log(`  ${t}  PAS:${pasTx.hash}  USDC:${usdcTx.hash}`);
  }
  console.log("");
  console.log(`✅ Funded ${plan.targets.length} wallet(s). Each can now SIWE in and deposit via the product.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`fund-test-wallets failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
