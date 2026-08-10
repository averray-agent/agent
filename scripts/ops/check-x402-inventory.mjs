#!/usr/bin/env node
/**
 * Two-sided inventory for the x402 poster ramp.
 *
 * WHY THIS EXISTS
 * The rail has an inflow on one chain and an outflow on another. A poster pays
 * USDC on Base; the escrow that job needs is fronted from the pooled account on
 * Polkadot Hub. Nothing moves money back, by design — the packet is explicit
 * that nothing bridges per job and that rebalancing is a periodic treasury
 * operation over an exchange leg.
 *
 * That design is right, and what it costs depends entirely on the price of the
 * return leg. Get the inventory wrong and the ramp does not fail loudly — it just
 * starts refusing paying customers.
 *
 * THE ARITHMETIC, AND WHY IT CURRENTLY DOES NOT BITE
 * A leg with a fixed cost sets a minimum sensible move — `leg / tolerated_friction`
 * — and that minimum is then the inventory the Hub side must carry between two
 * moves. This file was written assuming ~$2 a leg, which implied ~$100 of Hub
 * float, and that assumption was wrong.
 *
 * MEASURED 2026-08-10: the leg is $0.00. Coinbase quoted "incl. $0.00 network
 * fee" for USDC to Polkadot, ~3 minutes, proven with a real $1 transfer that
 * landed on our precompile. Its help page states USDC withdrawals are free on
 * supported networks.
 *
 * With a free leg there is no amount too small to move, so **the inventory has no
 * economic floor at all** and the warn threshold is purely operational: how often
 * do you want to touch this. The `--leg-cost-usd` arithmetic is kept, defaulting
 * to 0, so that if a route with a real fee is ever used the economic floor
 * reappears by itself instead of being rediscovered the hard way.
 *
 * Read-only. Touches no key, moves nothing, enables nothing.
 *
 * USAGE
 *   node scripts/ops/check-x402-inventory.mjs
 *   node scripts/ops/check-x402-inventory.mjs --json
 *   node scripts/ops/check-x402-inventory.mjs --leg-cost-usd 5 --friction-pct 1
 *
 * Exit codes:
 *   0  Hub inventory covers the warning threshold
 *   1  script error (bad config, chain unreachable)
 *   2  Hub inventory is below the warning threshold — the ramp is close to
 *      refusing paying customers
 */
import { Contract, JsonRpcProvider, formatUnits, getAddress } from "ethers";

const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const HUB_RPC = process.env.RPC_URL ?? "https://services.polkadothub-rpc.com/mainnet/";
const HUB_USDC = "0x0000053900000000000000000000000001200000";
const AGENT_ACCOUNT_CORE = "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57";
const ERC20 = ["function balanceOf(address) view returns (uint256)"];
const AAC = [
  "function positions(address,address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"
];

function parseArgs(argv) {
  const args = {
    json: false,
    // The cheapest posting the door will ever take: minRewardUsdc 1, plus the
    // 5% poster-side fee. Runway measured in the SMALLEST unit is the honest
    // direction — a bigger job simply consumes more than one unit of runway.
    postingUsd: 1.05,
    // Measured $0.00 via Coinbase on 2026-08-10. Set non-zero to restore the
    // economic floor if a route with a real fee is ever used.
    legCostUsd: 0,
    frictionPct: 2,
    // Refuse-a-customer is the failure. Warn while there is still time to act.
    warnPostings: 10
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--json") args.json = true;
    else if (flag === "--posting-usd") args.postingUsd = Number(argv[++i]);
    else if (flag === "--leg-cost-usd") args.legCostUsd = Number(argv[++i]);
    else if (flag === "--friction-pct") args.frictionPct = Number(argv[++i]);
    else if (flag === "--warn-postings") args.warnPostings = Number(argv[++i]);
    else if (flag === "--help" || flag === "-h") args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    [
      "Usage: node scripts/ops/check-x402-inventory.mjs [options]",
      "",
      "  --json                 machine-readable report",
      "  --posting-usd <n>      cost of one posting (default 1.05 = 1 reward + 5% fee)",
      "  --leg-cost-usd <n>     what one rebalance costs (default 0 — measured free)",
      "  --friction-pct <n>     friction tolerated on a rebalance (default 2)",
      "  --warn-postings <n>    warn below this many postings of runway (default 10)",
      "",
      "Exit 0 healthy · 1 script error · 2 Hub inventory below the threshold"
    ].join("\n")
  );
  process.exit(0);
}

const payTo = String(process.env.X402_PAYMENT_PAY_TO ?? "").trim();
const pool = String(process.env.X402_POOLED_FUNDING_ACCOUNT ?? "").trim();
if (!payTo || !pool) {
  console.error(
    "Set X402_PAYMENT_PAY_TO (the Base address posters pay) and "
    + "X402_POOLED_FUNDING_ACCOUNT (the Hub account that fronts escrow)."
  );
  process.exit(1);
}

let hubLiquidRaw;
let hubReservedRaw;
let baseHeldRaw;
try {
  const hub = new JsonRpcProvider(HUB_RPC, 420420419);
  const aac = new Contract(AGENT_ACCOUNT_CORE, AAC, hub);
  [hubLiquidRaw, hubReservedRaw] = await aac.positions(getAddress(pool), HUB_USDC);

  const base = new JsonRpcProvider(BASE_RPC, 8453);
  const asset = String(process.env.X402_PAYMENT_ASSET_ADDRESS ?? "").trim();
  if (!asset) throw new Error("X402_PAYMENT_ASSET_ADDRESS is required to read the Base side.");
  baseHeldRaw = await new Contract(asset, ERC20, base).balanceOf(getAddress(payTo));
} catch (error) {
  // Deliberately exit 1, not 2. "We could not read the inventory" and "the
  // inventory is low" are different claims, and a monitor must not turn the
  // first into the second.
  console.error(`could not read both sides: ${error.message}`);
  process.exit(1);
}

const usd = (raw) => Number(formatUnits(raw, 6));
const hubLiquid = usd(hubLiquidRaw);
const baseHeld = usd(baseHeldRaw);
const runway = Math.floor(hubLiquid / args.postingUsd);

// A fixed-cost leg forces a minimum move, and that minimum sets the inventory the
// Hub side must carry between two of them. With a FREE leg none of that applies:
// there is no amount too small to move, so inventory stops being an economic
// constraint and becomes a question of how often you want to touch it.
//
// Measured 2026-08-10: $0.00. Coinbase quoted "incl. $0.00 network fee" for USDC
// to Polkadot on the retail account, and its help page says USDC withdrawals are
// free on supported networks. Hence legCostUsd defaults to 0 — but the arithmetic
// stays, because the fee is a vendor policy that can change, and if it does the
// economic floor should reappear on its own rather than be rediscovered.
const hasLegCost = args.legCostUsd > 0;
const minMoveUsd = hasLegCost ? args.legCostUsd / (args.frictionPct / 100) : 0;
const requiredPostings = Math.floor(minMoveUsd / args.postingUsd);
const healthy = runway >= args.warnPostings;

// Free leg: move whenever Hub is short and Base holds enough to help at all.
// Costed leg: also wait until the move clears the economic floor.
const rebalanceDue = hasLegCost
  ? baseHeld >= minMoveUsd
  : !healthy && baseHeld >= args.postingUsd;

const report = {
  hub: { liquidUsd: hubLiquid, reservedUsd: usd(hubReservedRaw), account: getAddress(pool) },
  base: { heldUsd: baseHeld, payTo: getAddress(payTo) },
  runwayPostings: runway,
  policy: {
    postingUsd: args.postingUsd,
    legCostUsd: args.legCostUsd,
    frictionPct: args.frictionPct,
    legIsFree: !hasLegCost,
    minSensibleMoveUsd: minMoveUsd,
    requiredHubInventoryUsd: minMoveUsd,
    requiredRunwayPostings: requiredPostings,
    warnPostings: args.warnPostings
  },
  rebalanceDue,
  healthy
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("# x402 two-sided inventory\n");
  console.log(`  Hub pool      ${hubLiquid.toFixed(6)} USDC liquid   (${getAddress(pool)})`);
  console.log(`                ${usd(hubReservedRaw).toFixed(6)} USDC reserved — already committed to live escrow`);
  console.log(`  Base payTo    ${baseHeld.toFixed(6)} USDC           (${getAddress(payTo)})`);
  console.log("");
  console.log(`  RUNWAY        ${runway} posting${runway === 1 ? "" : "s"} at ${args.postingUsd} USDC each`);
  console.log("");
  if (hasLegCost) {
    console.log(`  A rebalance costs ~$${args.legCostUsd} however much it moves, so at ${args.frictionPct}%`);
    console.log(`  tolerated friction the smallest sensible move is $${minMoveUsd.toFixed(0)} —`);
    console.log(`  which is ${requiredPostings} postings. Hub inventory has to cover that many`);
    console.log(`  between rebalances, so the target is ~$${minMoveUsd.toFixed(0)} of Hub float.`);
  } else {
    console.log("  Repatriating Base → Hub is free (measured 2026-08-10: Coinbase quoted");
    console.log("  $0.00, ~3 minutes). So there is no amount too small to move, and no");
    console.log(`  economic floor under the inventory — the ${args.warnPostings}-posting threshold below is`);
    console.log("  an operational choice about how often you want to touch it, nothing more.");
  }
  console.log("");
  console.log(
    rebalanceDue
      ? hasLegCost
        ? `  REBALANCE DUE — Base holds ${baseHeld.toFixed(2)}, at or past the $${minMoveUsd.toFixed(0)} move size.`
        : `  REBALANCE DUE — Hub is short and Base holds ${baseHeld.toFixed(2)}, enough to help.`
      : hasLegCost
        ? `  No rebalance yet — Base holds ${baseHeld.toFixed(2)} of the $${minMoveUsd.toFixed(0)} needed to move economically.`
        : `  No rebalance needed — Hub has runway; Base is holding ${baseHeld.toFixed(2)} until it does not.`
  );
  console.log(
    healthy
      ? `  Hub inventory OK — ${runway} postings of runway, threshold ${args.warnPostings}.`
      : `  HUB INVENTORY LOW — ${runway} postings of runway, below the ${args.warnPostings} threshold.`
        + "\n  The ramp will start refusing paying customers. Fund the pooled account."
  );
}

process.exitCode = healthy ? 0 : 2;
