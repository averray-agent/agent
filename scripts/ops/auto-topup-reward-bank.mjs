/**
 * auto-topup-reward-bank.mjs
 *
 * Layer-2 automation #1 from docs/MAINNET_AUTOMATION_PLAN.md.
 *
 * Keeps the reward bank funded so the self-driving loop never stalls on
 * `409 insufficient_liquidity`. The reward bank is the backend signer's
 * `AgentAccountCore.positions(signer, USDC).liquid` — it drains as agents earn.
 *
 * What it does each run:
 *   1. Reads the signer's current AAC.liquid (the reward bank).
 *   2. Reads the signer wallet's USDC balance (the operational float).
 *   3. Plans a BOUNDED top-up (see planRewardBankTopup): refill toward a target,
 *      capped per run, never exceeding the float.
 *   4. Dry-run (default): prints the plan + the exact deposit command.
 *      --commit: invokes the audited `fund-signer-usdc-deposit.mjs --use-kms --commit`
 *      with the planned amount (no key handling here — reuse the signed path).
 *
 * Designed to run on a schedule (GitHub Actions cron / VPS timer). Safe by
 * default: dry-run, and every action is bounded so a bug tops up a little, not
 * the whole treasury. Emits `treasuryLow` when the float can't cover the refill
 * so monitoring can page a human to refill the treasury (a Layer-3 decision).
 *
 * Usage:
 *   node scripts/ops/auto-topup-reward-bank.mjs [options]
 *     --low-water-mark <baseUnits>   refill when liquid drops below this (default 20 USDC)
 *     --target <baseUnits>           refill liquid back up to this (default 100 USDC)
 *     --max-per-topup <baseUnits>    hard cap per run (default = target)
 *     --profile <name>               deployments/<profile>.json for addresses (default testnet)
 *     --signer 0x… / SIGNER_ADDRESS  reward-bank holder (default: deployments verifier)
 *     --rpc <url> / RPC_URL          EVM RPC (default Polkadot Hub TestNet)
 *     --commit                       actually deposit (default: dry-run)
 *     --use-kms                      pass through to the deposit script (KMS signing)
 *
 * Amounts are USDC base units (6 decimals). 10000000 = 10 USDC.
 */

const DEFAULT_RPC = "https://eth-rpc-testnet.polkadot.io";
const USDC_DECIMALS = 6n;
const DEFAULT_LOW_WATER = 20_000000n; // 20 USDC
const DEFAULT_TARGET = 100_000000n; // 100 USDC
const USDC_PRECOMPILE = "0x0000053900000000000000000000000001200000";

const AAC_POSITIONS_ABI = [
  "function positions(address account, address asset) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)",
];
const ERC20_BALANCE_ABI = ["function balanceOf(address account) view returns (uint256)"];

/**
 * Pure, dependency-free top-up planner — the heart of the automation.
 * All inputs/outputs are bigint USDC base units.
 *
 * @returns {{ shouldTopup: boolean, amount: bigint, reason: string, treasuryLow: boolean }}
 */
export function planRewardBankTopup({ liquidNow, lowWaterMark, targetLevel, maxPerTopup, walletAvailable }) {
  if (targetLevel <= lowWaterMark) {
    throw new Error(`target (${targetLevel}) must be > lowWaterMark (${lowWaterMark})`);
  }
  if (liquidNow >= lowWaterMark) {
    return {
      shouldTopup: false,
      amount: 0n,
      reason: `liquid ${liquidNow} >= lowWaterMark ${lowWaterMark}; no top-up needed`,
      treasuryLow: false,
    };
  }
  const desired = targetLevel - liquidNow; // refill back to target
  const cappedByPolicy = desired < maxPerTopup ? desired : maxPerTopup; // bound per run
  const amount = cappedByPolicy < walletAvailable ? cappedByPolicy : walletAvailable; // bound by float
  if (amount <= 0n) {
    return {
      shouldTopup: false,
      amount: 0n,
      reason: `liquid ${liquidNow} below lowWaterMark but float is empty (${walletAvailable}); refill the treasury`,
      treasuryLow: true,
    };
  }
  return {
    shouldTopup: true,
    amount,
    reason: `liquid ${liquidNow} < lowWaterMark ${lowWaterMark}; top up ${amount} toward target ${targetLevel}`,
    treasuryLow: walletAvailable < desired, // float couldn't fully cover → flag for a human refill
  };
}

export function parseArgs(argv) {
  const args = { dryRun: true, useKms: false, profile: "testnet" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--commit") args.dryRun = false;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--use-kms") args.useKms = true;
    else if (arg === "--low-water-mark") args.lowWaterMark = argv[++i];
    else if (arg === "--target") args.target = argv[++i];
    else if (arg === "--max-per-topup") args.maxPerTopup = argv[++i];
    else if (arg === "--profile") args.profile = argv[++i];
    else if (arg === "--signer") args.signer = argv[++i];
    else if (arg === "--rpc") args.rpc = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return args;
}

function usdc(baseUnits) {
  return `${(Number(baseUnits) / Number(10n ** USDC_DECIMALS)).toFixed(2)} USDC`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("See the header of scripts/ops/auto-topup-reward-bank.mjs for usage.");
    return;
  }

  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");

  const deployments = JSON.parse(
    await readFile(resolve(repoRoot, "deployments", `${args.profile}.json`), "utf8"),
  );
  const aac = deployments.agentAccountCore || deployments.AgentAccountCore;
  const usdcAddress = deployments.token || USDC_PRECOMPILE;
  const signer = args.signer || process.env.SIGNER_ADDRESS || deployments.verifier;
  const rpc = args.rpc || process.env.RPC_URL || DEFAULT_RPC;
  if (!aac || !signer) throw new Error("could not resolve agentAccountCore + signer from deployments/env");

  const lowWaterMark = args.lowWaterMark != null ? BigInt(args.lowWaterMark) : DEFAULT_LOW_WATER;
  const targetLevel = args.target != null ? BigInt(args.target) : DEFAULT_TARGET;
  const maxPerTopup = args.maxPerTopup != null ? BigInt(args.maxPerTopup) : targetLevel;

  const { ethers } = await import("ethers"); // lazy — keeps the planner unit-testable without deps
  const provider = new ethers.JsonRpcProvider(rpc);
  const aacContract = new ethers.Contract(aac, AAC_POSITIONS_ABI, provider);
  const usdcContract = new ethers.Contract(usdcAddress, ERC20_BALANCE_ABI, provider);

  const position = await aacContract.positions(signer, usdcAddress);
  const liquidNow = BigInt(position.liquid);
  const walletAvailable = BigInt(await usdcContract.balanceOf(signer));

  const plan = planRewardBankTopup({ liquidNow, lowWaterMark, targetLevel, maxPerTopup, walletAvailable });

  console.log(`reward bank (signer ${signer} AAC.liquid): ${usdc(liquidNow)} | float (wallet USDC): ${usdc(walletAvailable)}`);
  console.log(`low-water ${usdc(lowWaterMark)} → target ${usdc(targetLevel)} (max/run ${usdc(maxPerTopup)})`);
  console.log(`plan: ${plan.reason}`);
  if (plan.treasuryLow) console.log("::warning:: treasury float low — a human should refill the signer wallet (Layer-3).");

  if (!plan.shouldTopup) return;

  const depositCmd = ["scripts/ops/fund-signer-usdc-deposit.mjs", "--amount", String(plan.amount), ...(args.useKms ? ["--use-kms"] : []), "--commit"];
  if (args.dryRun) {
    console.log(`dry-run — would top up ${usdc(plan.amount)} via:\n  node ${depositCmd.join(" ")}`);
    return;
  }
  console.log(`committing top-up ${usdc(plan.amount)} via fund-signer-usdc-deposit…`);
  const { execFileSync } = await import("node:child_process");
  execFileSync("node", depositCmd, { cwd: repoRoot, stdio: "inherit" });
}

// Run only as a CLI; importing (tests) just gets the pure exports.
const isCli = process.argv[1] && process.argv[1].endsWith("auto-topup-reward-bank.mjs");
if (isCli) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
