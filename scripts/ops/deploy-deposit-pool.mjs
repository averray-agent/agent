#!/usr/bin/env node
/**
 * Deploy the agent deposit pool — lane, venue adapter, pool — in the only order
 * that satisfies all three constructors.
 *
 * Companion to docs/CEREMONY_DEPOSIT_POOL_DEPLOY.md. That document explains WHY
 * the order is forced; this script makes it impossible to get wrong by hand.
 *
 * THE HAZARD THIS EXISTS TO PREVENT
 * The three contracts reference each other in a cycle, resolved only by CREATE
 * address prediction:
 *
 *   tx1  lane          agentAccountCore = predicted venue adapter  (IMMUTABLE)
 *   tx2  venueAdapter  pool_ = predicted pool, lane_ = tx1
 *   tx3  pool          venueAdapter = tx2                          (IMMUTABLE)
 *
 * Predictions are `keccak(rlp([deployer, nonce]))[12:]`, so ANY other transaction
 * from the deployer between tx1 and tx3 shifts them. The failure is not a clean
 * revert — tx1 would deploy a lane permanently bound to an address that will
 * never hold the venue adapter, and the lane is immutable. It would have to be
 * abandoned.
 *
 * So this script re-reads the on-chain nonce before every send and aborts if it
 * moved, and verifies each deployed address equals its prediction before
 * continuing. A mis-wiring becomes a stop instead of a silent, permanent bind.
 *
 * WHAT IT DOES NOT DO
 * It does not send the multisig transaction. `XcmWrapperV22.setStrategyAdapter`
 * is onlyOwner AND requires dispatchPaused — and the wrapper is shared with the
 * live operating bank lane, so pausing it touches the position holding real
 * money. The script prints that calldata for the multisig instead.
 *
 * Usage:
 *   node scripts/ops/deploy-deposit-pool.mjs                 # dry run (default)
 *   node scripts/ops/deploy-deposit-pool.mjs --commit        # broadcast tx1-3
 *
 *   --rpc <url>        EVM RPC (default: deployments/mainnet.json rpcUrl)
 *   --profile <name>   deployment profile (default: mainnet)
 *   --artifacts <dir>  forge output dir (default: out)
 *   --strategy-id <s>  strategy label (default: HYDRATION_USDC_POOL_V1)
 *   --commit           actually broadcast. Requires DEPLOYER_PRIVATE_KEY in env.
 *
 * Claude never handles keys. The commit path reads DEPLOYER_PRIVATE_KEY from the
 * environment so the operator supplies it from their own vault at run time.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ethers } from "ethers";

const DEFAULT_STRATEGY_LABEL = "HYDRATION_USDC_POOL_V1";
const RESERVED_STRATEGY_LABEL = "HYDRATION_USDC_V1";
const EXPECTED_ASSET_DECIMALS = 6;

const CONTRACTS = {
  lane: ["HydrationUsdcAdapterV22.sol", "HydrationUsdcAdapterV22"],
  venueAdapter: ["HydrationDepositPoolAdapter.sol", "HydrationDepositPoolAdapter"],
  pool: ["DepositPool.sol", "DepositPool"],
};

function parseArgs(argv) {
  const args = { commit: false, profile: "mainnet", artifacts: "out", strategyLabel: DEFAULT_STRATEGY_LABEL };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--commit") args.commit = true;
    else if (arg === "--rpc") args.rpc = argv[++i];
    else if (arg === "--profile") args.profile = argv[++i];
    else if (arg === "--artifacts") args.artifacts = argv[++i];
    else if (arg === "--strategy-id") args.strategyLabel = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function strategyIdFromLabel(label) {
  const hex = Buffer.from(label, "utf8").toString("hex");
  if (hex.length > 64) throw new Error(`strategy label "${label}" exceeds 32 bytes.`);
  return `0x${hex.padEnd(64, "0")}`;
}

function loadArtifact(artifactsDir, [sourceFile, contractName]) {
  const path = join(artifactsDir, sourceFile, `${contractName}.json`);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `missing artifact ${path}. Build first: forge build --out ${artifactsDir} --skip test`
    );
  }
  const artifact = JSON.parse(raw);
  const bytecode = artifact?.bytecode?.object;
  if (typeof bytecode !== "string" || !bytecode.startsWith("0x")) {
    throw new Error(`artifact ${path} has no creation bytecode.`);
  }
  return { bytecode, abi: artifact.abi };
}

/**
 * Preconditions that would otherwise surface as an opaque revert mid-ceremony,
 * or — worse — as a successful deploy that is quietly wrong.
 */
async function checkPreconditions({ provider, manifest, strategyLabel, strategyId }) {
  const findings = [];
  const contracts = manifest.contracts ?? {};
  const asset = contracts.token;
  const policy = contracts.treasuryPolicy;
  const wrapper = contracts.xcmWrapper;

  for (const [name, address] of Object.entries({ asset, policy, wrapper })) {
    if (!address) findings.push(`manifest is missing contracts.${name}.`);
  }
  if (findings.length > 0) return findings;

  // The pool constructor compares asset decimals against its own constant. On an
  // anvil fork this call reverts because USDC on Hub is a runtime precompile with
  // no EVM bytecode — which is exactly why this is checked against the real chain.
  try {
    const decimals = await new ethers.Contract(
      asset,
      ["function decimals() view returns (uint8)"],
      provider
    ).decimals();
    if (Number(decimals) !== EXPECTED_ASSET_DECIMALS) {
      findings.push(
        `asset decimals ${decimals} != ${EXPECTED_ASSET_DECIMALS}; DepositPool would revert with InvalidAssetDecimals.`
      );
    }
  } catch (error) {
    findings.push(
      `could not read asset decimals at ${asset} (${error.shortMessage ?? error.message}). `
      + "An anvil fork cannot model the USDC precompile — run this against a real Hub node."
    );
  }

  // Reusing the operating lane's id would make every downstream money read
  // conflate two positions. Cheap to check, permanent to get wrong.
  if (strategyLabel === RESERVED_STRATEGY_LABEL) {
    findings.push(
      `strategy label ${RESERVED_STRATEGY_LABEL} belongs to the operating bank lane; choose a distinct id.`
    );
  }
  const wrapperContract = new ethers.Contract(
    wrapper,
    [
      "function strategyAdapter(bytes32) view returns (address)",
      "function dispatchPaused() view returns (bool)",
    ],
    provider
  );
  const existing = await wrapperContract.strategyAdapter(strategyId);
  if (existing !== ethers.ZeroAddress) {
    findings.push(`wrapper already maps ${strategyLabel} to ${existing}; refusing to shadow it.`);
  }

  return findings;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 46).join("\n"));
    return;
  }

  const manifest = JSON.parse(readFileSync(`deployments/${args.profile}.json`, "utf8"));
  const rpc = args.rpc || process.env.RPC_URL || manifest.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpc);

  const asset = manifest.contracts.token;
  const policy = manifest.contracts.treasuryPolicy;
  const wrapper = manifest.contracts.xcmWrapper;
  const operator = manifest.verifier;
  const deployer = manifest.deployer;
  const strategyId = strategyIdFromLabel(args.strategyLabel);

  console.log(`deposit-pool ceremony — profile ${args.profile}, rpc ${rpc}`);
  console.log(`  ${args.commit ? "COMMIT — transactions will be broadcast" : "DRY RUN — nothing is sent"}`);
  console.log("");

  const problems = await checkPreconditions({ provider, manifest, strategyLabel: args.strategyLabel, strategyId });
  if (problems.length > 0) {
    console.error("preconditions failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("preconditions ok: asset decimals, strategy id free, manifest addresses present");

  // "pending", not "latest": an already-broadcast-but-unmined transaction from the
  // deployer is invisible to "latest", which is precisely the non-quiescent case this
  // guard exists to catch. Reading pending also makes a same-nonce replacement visible.
  const startNonce = await provider.getTransactionCount(deployer, "pending");
  const predicted = {
    lane: ethers.getCreateAddress({ from: deployer, nonce: startNonce }),
    venueAdapter: ethers.getCreateAddress({ from: deployer, nonce: startNonce + 1 }),
    pool: ethers.getCreateAddress({ from: deployer, nonce: startNonce + 2 }),
  };

  console.log("");
  console.log(`deployer ${deployer} @ nonce ${startNonce}`);
  console.log(`  tx1 lane          -> ${predicted.lane}`);
  console.log(`  tx2 venueAdapter  -> ${predicted.venueAdapter}`);
  console.log(`  tx3 pool          -> ${predicted.pool}`);
  console.log("");
  console.log("constructor arguments");
  console.log(`  lane          (policy=${policy}, asset=${asset}, strategyId=${args.strategyLabel},`);
  console.log(`                 wrapper=${wrapper}, agentAccountCore=${predicted.venueAdapter})`);
  console.log(`  venueAdapter  (pool=${predicted.pool}, lane=${predicted.lane})`);
  console.log(`  pool          (asset=${asset}, operator=${operator}, venueAdapter=${predicted.venueAdapter})`);

  const abi = ethers.AbiCoder.defaultAbiCoder();
  const artifacts = {
    lane: loadArtifact(args.artifacts, CONTRACTS.lane),
    venueAdapter: loadArtifact(args.artifacts, CONTRACTS.venueAdapter),
    pool: loadArtifact(args.artifacts, CONTRACTS.pool),
  };
  const plan = [
    {
      step: "lane",
      data: artifacts.lane.bytecode
        + abi.encode(
          ["address", "address", "bytes32", "address", "address"],
          [policy, asset, strategyId, wrapper, predicted.venueAdapter]
        ).slice(2),
    },
    {
      step: "venueAdapter",
      data: artifacts.venueAdapter.bytecode
        + abi.encode(["address", "address"], [predicted.pool, predicted.lane]).slice(2),
    },
    {
      step: "pool",
      data: artifacts.pool.bytecode
        + abi.encode(["address", "address", "address"], [asset, operator, predicted.venueAdapter]).slice(2),
    },
  ];

  if (!args.commit) {
    console.log("");
    console.log("dry run complete. Re-run with --commit (and DEPLOYER_PRIVATE_KEY set) to broadcast.");
    printMultisigStep({ wrapper, strategyId, lane: predicted.lane, label: args.strategyLabel });
    return;
  }

  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("DEPLOYER_PRIVATE_KEY is not set; refusing to broadcast.");
  const wallet = new ethers.Wallet(key, provider);
  if (ethers.getAddress(wallet.address) !== ethers.getAddress(deployer)) {
    throw new Error(
      `DEPLOYER_PRIVATE_KEY resolves to ${wallet.address}, but the manifest deployer is ${deployer}.`
    );
  }

  const deployed = {};
  for (const [index, { step, data }] of plan.entries()) {
    const expectedNonce = startNonce + index;

    // The whole point of the script. A shifted nonce means every prediction after
    // it is wrong, and tx1's binding is immutable — so stop rather than deploy.
    const nonceNow = await provider.getTransactionCount(deployer, "pending");
    if (nonceNow !== expectedNonce) {
      throw new Error(
        `nonce drift before ${step}: expected ${expectedNonce}, chain says ${nonceNow}. `
        + "Something else transacted from the deployer. Abort, re-read, and restart the ceremony — "
        + "do NOT continue, the remaining predictions are stale."
      );
    }

    const sent = await wallet.sendTransaction({ data, nonce: expectedNonce });
    const receipt = await sent.wait();
    const address = receipt.contractAddress;
    if (ethers.getAddress(address) !== ethers.getAddress(predicted[step])) {
      throw new Error(
        `${step} deployed to ${address}, predicted ${predicted[step]}. The remaining steps would be mis-wired.`
      );
    }
    deployed[step] = address;
    console.log(`  ${step}: ${address}  (tx ${receipt.hash})`);
  }

  console.log("");
  console.log("deployed and address-verified. The contracts exist; the lane cannot dispatch yet.");
  printMultisigStep({ wrapper, strategyId, lane: deployed.lane, label: args.strategyLabel });
}

/**
 * Printed rather than sent: onlyOwner, and it requires dispatchPaused on a wrapper
 * shared with the live operating bank lane.
 */
function printMultisigStep({ wrapper, strategyId, lane, label }) {
  const iface = new ethers.Interface([
    "function setDispatchPaused(bool)",
    "function setStrategyAdapter(bytes32,address)",
  ]);
  console.log("");
  console.log("REMAINING — multisig, on the wrapper shared with the live bank lane:");
  console.log(`  target ${wrapper}`);
  console.log(`  1. setDispatchPaused(true)   ${iface.encodeFunctionData("setDispatchPaused", [true])}`);
  console.log(`  2. setStrategyAdapter(${label}, lane)`);
  console.log(`     ${iface.encodeFunctionData("setStrategyAdapter", [strategyId, lane])}`);
  console.log(`  3. setDispatchPaused(false)  ${iface.encodeFunctionData("setDispatchPaused", [false])}`);
  console.log("");
  console.log("  Take this window when no operating deployment or recall is in flight:");
  console.log("  pendingDepositAssets and pendingWithdrawalShares must both read 0 on the");
  console.log("  operating adapter before pausing.");
  console.log("");
  console.log("  Then update deployments/<profile>.json (contracts + contractProvenance) AND");
  console.log("  CONTRACT_ARTIFACTS in scripts/ops/check-contract-provenance.mjs, or the next");
  console.log("  production deploy will be refused by the D-03 gate.");
}

main().catch((error) => {
  console.error(`deposit-pool ceremony failed: ${error.message}`);
  process.exitCode = 1;
});
