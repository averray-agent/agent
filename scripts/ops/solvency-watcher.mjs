/**
 * solvency-watcher.mjs
 *
 * Layer-2 automation #3 from docs/MAINNET_AUTOMATION_PLAN.md — the safety net.
 *
 * Each run reads on-chain state and asserts cheap, indexer-free solvency
 * invariants. On a CRITICAL breach it recommends an immediate pause (the
 * guarded-launch tripwire). v1 is **detect + recommend only** — it never sends
 * a tx. Auto-execute (calling TreasuryPolicy.pause via the pauser key) is a
 * deliberate, gated follow-up, because auto-halting the live protocol on a
 * false positive is its own risk.
 *
 * Invariants checked (cheap — no account enumeration):
 *   - solvency-lower-bound: the AAC's actual USDC balance must cover the signer's
 *     contract-held funds (liquid + reserved + jobStakeLocked + collateralLocked).
 *     Normally true with a wide margin (every other account is in there too); a
 *     breach means a drain took the contract below even the reward-bank holder's
 *     share → insolvent. CRITICAL.
 *   - debt-gate: a borrowed account's liquid must cover its debtOutstanding
 *     (the #688 withdrawable invariant). HIGH.
 *   - balance-floor: contract USDC must never fall below a configured floor
 *     (a coarse drain tripwire). CRITICAL.
 *
 * The full Σ-over-all-accounts solvency check needs the indexer (account list);
 * that's a follow-up. This v1 catches gross insolvency + the debt-gate cheaply.
 *
 * Usage:
 *   node scripts/ops/solvency-watcher.mjs [--profile testnet] [--signer 0x…]
 *     [--rpc <url>] [--floor <usdcBaseUnits>]
 * Exit code 2 on a CRITICAL breach (so a scheduler/alert can page).
 */

const DEFAULT_RPC = "https://eth-rpc-testnet.polkadot.io";
const USDC_PRECOMPILE = "0x0000053900000000000000000000000001200000";

const POLICY_ABI = ["function paused() view returns (bool)"];
const ERC20_ABI = ["function balanceOf(address account) view returns (uint256)"];
const AAC_ABI = [
  "function positions(address account, address asset) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)",
];

/**
 * Pure invariant checker. All amounts are bigint USDC base units; `paused` bool;
 * `absoluteFloor` optional bigint.
 * @returns {{ healthy: boolean, violations: Array<{severity:string,invariant:string,detail:string}>, recommendPause: boolean }}
 */
export function checkSolvencyInvariants({ contractUsdcBalance, signerAccounted, signerLiquid, signerDebt, absoluteFloor }) {
  const violations = [];
  if (contractUsdcBalance < signerAccounted) {
    violations.push({
      severity: "critical",
      invariant: "solvency-lower-bound",
      detail: `contract USDC ${contractUsdcBalance} < signer-accounted ${signerAccounted}`,
    });
  }
  if (signerLiquid < signerDebt) {
    violations.push({
      severity: "high",
      invariant: "debt-gate",
      detail: `signer liquid ${signerLiquid} < debtOutstanding ${signerDebt}`,
    });
  }
  if (absoluteFloor != null && contractUsdcBalance < absoluteFloor) {
    violations.push({
      severity: "critical",
      invariant: "balance-floor",
      detail: `contract USDC ${contractUsdcBalance} < floor ${absoluteFloor}`,
    });
  }
  return {
    healthy: violations.length === 0,
    violations,
    recommendPause: violations.some((v) => v.severity === "critical"),
  };
}

export function parseArgs(argv) {
  const args = { profile: "testnet" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") args.profile = argv[++i];
    else if (arg === "--signer") args.signer = argv[++i];
    else if (arg === "--rpc") args.rpc = argv[++i];
    else if (arg === "--floor") args.floor = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return args;
}

function usdc(baseUnits) {
  return `${(Number(baseUnits) / 1e6).toFixed(2)} USDC`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("See the header of scripts/ops/solvency-watcher.mjs for usage.");
    return;
  }
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const deployments = JSON.parse(await readFile(resolve(repoRoot, "deployments", `${args.profile}.json`), "utf8"));
  const contracts = deployments.contracts || deployments;
  const aac = contracts.agentAccountCore || contracts.AgentAccountCore;
  const policy = contracts.treasuryPolicy || contracts.TreasuryPolicy;
  const usdcAddress = contracts.token || USDC_PRECOMPILE;
  const signer = args.signer || process.env.SIGNER_ADDRESS || deployments.verifier;
  const rpc = args.rpc || process.env.RPC_URL || deployments.rpcUrl || DEFAULT_RPC;
  if (!aac || !policy || !signer) throw new Error("could not resolve agentAccountCore + treasuryPolicy + signer from deployments/env");
  const absoluteFloor = args.floor != null ? BigInt(args.floor) : null;

  const { ethers } = await import("ethers");
  const provider = new ethers.JsonRpcProvider(rpc);
  const paused = await new ethers.Contract(policy, POLICY_ABI, provider).paused();
  const contractUsdcBalance = BigInt(await new ethers.Contract(usdcAddress, ERC20_ABI, provider).balanceOf(aac));
  const p = await new ethers.Contract(aac, AAC_ABI, provider).positions(signer, usdcAddress);
  const signerAccounted = BigInt(p.liquid) + BigInt(p.reserved) + BigInt(p.jobStakeLocked) + BigInt(p.collateralLocked);

  const result = checkSolvencyInvariants({
    contractUsdcBalance,
    signerAccounted,
    signerLiquid: BigInt(p.liquid),
    signerDebt: BigInt(p.debtOutstanding),
    absoluteFloor,
  });

  console.log(`AAC USDC balance: ${usdc(contractUsdcBalance)} | signer-accounted (liquid+reserved+stake+collateral): ${usdc(signerAccounted)} | paused: ${paused}`);
  if (result.healthy) {
    console.log("✓ solvency invariants hold.");
  } else {
    for (const v of result.violations) console.log(`::error:: [${v.severity}] ${v.invariant} — ${v.detail}`);
  }
  if (result.recommendPause && !paused) {
    console.log("::error:: CRITICAL solvency breach and protocol is NOT paused — pause immediately (TreasuryPolicy.pause via the pauser key).");
  }
  if (paused) console.log("::warning:: protocol is currently paused — a human should investigate before un-pausing.");

  if (result.recommendPause) process.exitCode = 2;
}

const isCli = process.argv[1] && process.argv[1].endsWith("solvency-watcher.mjs");
if (isCli) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
