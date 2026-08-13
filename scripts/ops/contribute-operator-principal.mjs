#!/usr/bin/env node

/**
 * Guarded operator-principal contribution (yield-epoch precondition 2).
 *
 * Seeds deployable capital into the deposit pool via
 * contributeOperatorPrincipal: shares mint to the POOL itself
 * (operatorPrincipalShares), never to an agent position, so the contribution
 * raises maxDeployableAssets without raising the bufferFloor exit guarantee
 * and can never dilute depositors (contract rounds down).
 *
 * Mirrors pool-venue-ceremony.mjs conventions exactly: read-only by default,
 * the only write mode is --commit --use-kms --expected-signer 0x…, and the
 * script never accepts a private key. The USDC must already sit as ERC-20 on
 * the operator EOA (Coinbase -> Hub route); do NOT fund-signer-deposit it
 * into AAC first.
 */

import { Contract, getAddress } from "ethers";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { KmsSigner } from "../../mcp-server/src/blockchain/kms-signer.js";
import { createCeremonyRpcContext } from "./ceremony-rpc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const POOL_ABI = [
  "function asset() view returns (address)",
  "function operator() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function bufferAssets() view returns (uint256)",
  "function bufferFloor() view returns (uint256)",
  "function maxDeployableAssets() view returns (uint256)",
  "function operatorContributedPrincipal() view returns (uint256)",
  "function operatorPrincipalShares() view returns (uint256)",
  "function TOTAL_ASSET_CAP() view returns (uint256)",
  "function contributeOperatorPrincipal(uint256 assets) returns (uint256 shares)",
  "event OperatorPrincipalContributed(uint256 assets,uint256 shares,uint256 totalContributed)"
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];

function parseArgs(argv) {
  const args = { commit: false, useKms: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--assets") args.assets = BigInt(next());
    else if (arg === "--profile") args.profile = next();
    else if (arg === "--expected-signer") args.expectedSigner = next();
    else if (arg === "--commit") args.commit = true;
    else if (arg === "--use-kms") args.useKms = true;
    else throw new Error(`unknown arg ${arg}`);
  }
  if (args.profile !== "mainnet") throw new Error("--profile mainnet is required (no default).");
  if (!args.assets || args.assets <= 0n) throw new Error("--assets <raw> is required.");
  if (!args.expectedSigner) throw new Error("--expected-signer is mandatory; the ceremony never guesses its operator.");
  if (args.commit && !args.useKms) throw new Error("--commit requires --use-kms; this script never accepts a private key.");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(
    await readFile(resolve(repoRoot, "deployments", `${args.profile}.json`), "utf8")
  );
  const { provider } = await createCeremonyRpcContext({ manifest, profile: args.profile });
  const poolAddress = getAddress(manifest.contracts?.depositPool);
  const pool = new Contract(poolAddress, POOL_ABI, provider);
  const expectedSigner = getAddress(args.expectedSigner);

  const [asset, operator, totalAssets, bufferAssets, bufferFloor, deployable, contributed, principalShares, cap] =
    await Promise.all([
      pool.asset(), pool.operator(), pool.totalAssets(), pool.bufferAssets(), pool.bufferFloor(),
      pool.maxDeployableAssets(), pool.operatorContributedPrincipal(), pool.operatorPrincipalShares(),
      pool.TOTAL_ASSET_CAP()
    ]);
  if (getAddress(operator) !== expectedSigner) {
    throw new Error(`pool.operator() ${operator} != --expected-signer ${expectedSigner}. Refusing.`);
  }
  const usdc = new Contract(getAddress(asset), ERC20_ABI, provider);
  const walletUsdc = await usdc.balanceOf(expectedSigner);
  if (walletUsdc < args.assets) {
    throw new Error(`operator EOA holds ${walletUsdc} raw USDC as ERC-20; needs ${args.assets}. (AAC.liquid does not count — the contribute call pulls ERC-20.)`);
  }
  if (totalAssets + args.assets > cap) {
    throw new Error(`contribution would exceed TOTAL_ASSET_CAP ${cap}.`);
  }

  console.log(`pool ${poolAddress} (manifest depositPool)`);
  console.log(`before: totalAssets ${totalAssets} buffer ${bufferAssets} floor ${bufferFloor} deployable ${deployable}`);
  console.log(`        operatorContributedPrincipal ${contributed} operatorPrincipalShares ${principalShares}`);
  console.log(`plan: usdc.approve(pool, ${args.assets}) -> pool.contributeOperatorPrincipal(${args.assets})`);
  console.log(`expected after: totalAssets ${totalAssets + args.assets}, deployable ${totalAssets + args.assets - bufferFloor} (floor unchanged)`);

  if (!args.commit) {
    console.log("\nDRY RUN. Re-run with --commit --use-kms to contribute.");
    return;
  }

  const keyId = String(process.env.KMS_KEY_ID ?? "").trim();
  const region = String(process.env.AWS_REGION ?? "").trim();
  if (!keyId) throw new Error("--use-kms requires KMS_KEY_ID.");
  if (!region) throw new Error("--use-kms requires AWS_REGION.");
  const signer = new KmsSigner({ keyId, region, provider });
  const signerAddress = getAddress(await signer.getAddress());
  if (signerAddress !== expectedSigner) {
    throw new Error(`KMS key derives ${signerAddress}, expected ${expectedSigner}. Refusing.`);
  }

  let receipt = await (await usdc.connect(signer).approve(poolAddress, args.assets)).wait();
  if (receipt.status !== 1) throw new Error("approve failed on-chain. STOP.");
  console.log(`  approved, tx ${receipt.hash}`);
  receipt = await (await pool.connect(signer).contributeOperatorPrincipal(args.assets)).wait();
  if (receipt.status !== 1) throw new Error("contributeOperatorPrincipal failed on-chain. STOP.");
  console.log(`  contributed, tx ${receipt.hash} (block ${receipt.blockNumber})`);

  const [afterAssets, afterBuffer, afterFloor, afterDeployable, afterContributed, afterShares] = await Promise.all([
    pool.totalAssets(), pool.bufferAssets(), pool.bufferFloor(), pool.maxDeployableAssets(),
    pool.operatorContributedPrincipal(), pool.operatorPrincipalShares()
  ]);
  if (afterAssets !== totalAssets + args.assets) throw new Error(`totalAssets drift: ${afterAssets}. Investigate before any deploy.`);
  if (afterContributed !== contributed + args.assets) throw new Error(`operatorContributedPrincipal drift: ${afterContributed}.`);
  if (afterFloor !== bufferFloor) throw new Error(`bufferFloor moved (${bufferFloor} -> ${afterFloor}); operator principal must not raise the floor. Investigate.`);
  console.log(`after: totalAssets ${afterAssets} buffer ${afterBuffer} floor ${afterFloor} deployable ${afterDeployable}`);
  console.log(`       operatorContributedPrincipal ${afterContributed} operatorPrincipalShares ${afterShares}`);
  console.log("postconditions exact.");
}

main().catch((error) => {
  console.error(`contribute-operator-principal failed: ${error?.message ?? error}`);
  process.exit(1);
});
