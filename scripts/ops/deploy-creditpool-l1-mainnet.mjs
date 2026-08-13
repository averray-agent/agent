#!/usr/bin/env node
/**
 * Guarded MAINNET ceremony for the DepositPool v1 -> v2 + CreditPool L1 migration.
 *
 * Executes exactly the plan the fork rehearsal validates: this script IMPORTS
 * buildDeploymentPlan / predictCreditPoolMigrationAddresses /
 * assertByteExactMigration from simulate-creditpool-l1-migration.mjs, so the
 * creation bytes and constructor args cannot drift from the rehearsed ones.
 *
 * Phases (each dry-run by default; --commit sends; distinct signers):
 *   deploy   admin EOA (--signer-secret-ref op://…)  4 CREATEs at predicted addresses
 *   migrate  dogfood key (--wallet-key-op op://…)    v1 redeem(all) -> approve -> v2 deposit(assets)
 *   verify   read-only                               position byte-exact, v1 empty
 *
 * No seed phase: the deploy preflight REFUSES an off-par v1 (assets != shares),
 * and at par a plain deposit into the empty v2 mints exactly the same share
 * count — the fork's ratio-seed generality is provably unnecessary here.
 *
 * The wrapper repoint (pause -> setStrategyAdapter -> unpause) is MULTISIG-ONLY:
 * generate blobs with encode-poolv2-multisig.mjs after `deploy`.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ethers } from "ethers";
import {
  buildDeploymentPlan,
  assertByteExactMigration
} from "./simulate-creditpool-l1-migration.mjs";

const EXPECTED_CHAIN = 420420419n;
const RPCS = ["https://services.polkadothub-rpc.com/mainnet/", "https://eth-rpc.polkadot.io/"];

function parseArgs(argv) {
  const args = { phase: undefined, commit: false, profile: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--phase") args.phase = argv[++i];
    else if (a === "--commit") args.commit = true;
    else if (a === "--dry-run") args.commit = false;
    else if (a === "--profile") args.profile = argv[++i];
    else if (a === "--expected-deployer") args.expectedDeployer = argv[++i];
    else if (a === "--signer-secret-ref") args.signerSecretRef = argv[++i];
    else if (a === "--wallet-key-op") args.walletKeyOp = argv[++i];
    else if (a === "--expected-start-nonce") args.expectedStartNonce = Number(argv[++i]);
    else throw new Error(`unknown arg ${a}`);
  }
  if (args.profile !== "mainnet") throw new Error("--profile mainnet is required (no default).");
  if (!args.phase) throw new Error("--phase deploy|migrate|verify is required.");
  return args;
}

function opRead(ref) {
  if (!ref?.startsWith("op://")) throw new Error("secret refs must be op:// references");
  return execFileSync("op", ["read", ref], { encoding: "utf8" }).trim();
}

async function provider() {
  for (const url of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(url, { chainId: Number(EXPECTED_CHAIN), name: "polkadot-hub" });
      const net = await p.getNetwork();
      if (net.chainId !== EXPECTED_CHAIN) throw new Error(`chain ${net.chainId}`);
      console.log(`rpc: ${url} (chain ${net.chainId} ✓)`);
      return p;
    } catch (e) { console.error(`rpc failed ${url}: ${String(e).slice(0, 60)}`); }
  }
  throw new Error("no RPC reachable");
}

const POOL_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function assetsOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function redeem(uint256,address,address) returns (uint256)",
  "function deposit(uint256,address) returns (uint256)",
  "function mint(uint256,address) returns (uint256)",
  "function RISK_DISCLOSURE() view returns (string)"
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256)", "function transfer(address,uint256)"];
const AAC_ABI = ["function positions(address,address) view returns (uint256 liquid,uint256 reserved,uint256 strategyAllocated,uint256 collateralLocked,uint256 jobStakeLocked,uint256 debtOutstanding)", "function withdraw(address,uint256)", "function deposit(address,uint256)"];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync("deployments/mainnet.json", "utf8"));
  const p = await provider();
  const USDC = ethers.getAddress(manifest.contracts.token);
  const AAC = ethers.getAddress(manifest.contracts.agentAccountCore);
  const OLD_POOL = ethers.getAddress(manifest.contracts.depositPool);
  const OPERATOR = ethers.getAddress(manifest.verifier);
  const DOGFOOD = "0xdc1Ed1061e4a6E35aafb8f4E59B8893113d2EDeC";
  const usdc = new ethers.Contract(USDC, ERC20_ABI, p);
  const oldPool = new ethers.Contract(OLD_POOL, POOL_ABI, p);

  // Live single-depositor preflight, every phase: refuse if anything moved.
  const [dfShares, dfAssets, supply, tAssets] = await Promise.all([
    oldPool.balanceOf(DOGFOOD), oldPool.assetsOf(DOGFOOD), oldPool.totalSupply(), oldPool.totalAssets()
  ]);
  console.log(`v1 position: shares ${dfShares} assets ${dfAssets} | supply ${supply} totalAssets ${tAssets}`);

  if (args.phase === "deploy") {
    if (dfShares !== supply) throw new Error("v1 is no longer single-depositor; STOP and reassess.");
    if (dfAssets !== dfShares) throw new Error("v1 is off par (venue history?); the seed math assumes par. STOP.");
    if (!args.expectedDeployer || !args.signerSecretRef) throw new Error("deploy needs --expected-deployer and --signer-secret-ref");
    const key = opRead(args.signerSecretRef);
    const signer = new ethers.Wallet(key, p);
    if (signer.address.toLowerCase() !== args.expectedDeployer.toLowerCase()) throw new Error(`key derives ${signer.address}, expected ${args.expectedDeployer}. Refusing.`);
    const bal = await p.getBalance(signer.address);
    if (bal < ethers.parseEther("2")) throw new Error(`deployer holds ${ethers.formatEther(bal)} DOT; needs >= 2.0 for four CREATEs.`);
    const startNonce = Number(await p.getTransactionCount(signer.address, "pending"));
    if (args.expectedStartNonce !== undefined && startNonce !== args.expectedStartNonce) {
      throw new Error(`live pending nonce ${startNonce} != --expected-start-nonce ${args.expectedStartNonce}. Refusing.`);
    }
    const plan = buildDeploymentPlan({ manifest, deployer: signer.address, startNonce, artifactsDir: "out" });
    plan.startNonce = startNonce;
    console.log("predicted addresses:", JSON.stringify(plan.predicted, null, 2));
    console.log("strategyId:", plan.strategyId, "(HYDRATION_USDC_POOL_V1 — repoint, not new)");
    for (const t of plan.transactions) console.log(`  ${t.step}: creation ${((t.data.length - 2) / 2).toLocaleString()} bytes`);
    if (!args.commit) { console.log("\nDRY RUN. Re-run with --commit to deploy all four."); return; }
    for (const [index, t] of plan.transactions.entries()) {
      const nonce = Number(await p.send("eth_getTransactionCount", [signer.address, "pending"]));
      if (nonce !== startNonce + index) throw new Error(`nonce drift before ${t.step}: ${nonce} != ${startNonce + index}. STOP.`);
      const receipt = await (await signer.sendTransaction({ data: t.data, nonce })).wait();
      if (receipt.status !== 1) throw new Error(`${t.step} deploy tx failed on-chain. STOP.`);
      const actual = ethers.getAddress(receipt.contractAddress);
      if (actual !== ethers.getAddress(plan.predicted[t.step])) throw new Error(`${t.step} CREATE prediction drift: ${actual}`);
      console.log(`  ${t.step} deployed ${actual} (block ${receipt.blockNumber}, tx ${receipt.hash})`);
    }
    const v2 = new ethers.Contract(plan.predicted.depositPoolV2, POOL_ABI, p);
    const cp = new ethers.Contract(plan.predicted.creditPool, POOL_ABI, p);
    console.log("postcondition v2 RISK_DISCLOSURE:", JSON.stringify(await v2.RISK_DISCLOSURE()));
    console.log("postcondition creditPool RISK_DISCLOSURE:", JSON.stringify(await cp.RISK_DISCLOSURE()));
    console.log("\nNext: node scripts/ops/encode-poolv2-multisig.mjs --lane", plan.predicted.lane);
    return;
  }

  // Later phases need the deployed v2 address passed via env for explicitness.
  const V2 = process.env.POOL_V2_ADDRESS && ethers.getAddress(process.env.POOL_V2_ADDRESS);
  if (["migrate", "verify"].includes(args.phase) && !V2) throw new Error("set POOL_V2_ADDRESS=0x… (from the deploy phase output)");
  const newPool = V2 && new ethers.Contract(V2, POOL_ABI, p);

  if (args.phase === "migrate") {
    if (!args.walletKeyOp) throw new Error("migrate needs --wallet-key-op op://…");
    const wallet = new ethers.Wallet(opRead(args.walletKeyOp), p);
    if (wallet.address.toLowerCase() !== DOGFOOD.toLowerCase()) throw new Error(`key derives ${wallet.address}, expected dogfood ${DOGFOOD}. Refusing.`);
    if (dfAssets !== dfShares) throw new Error("v1 off par; the no-seed migration assumes par. STOP.");
    const v2Supply = await newPool.totalSupply();
    if (v2Supply !== 0n) throw new Error(`v2 is not empty (supply ${v2Supply}); the no-seed migration assumes an empty pool. STOP.`);
    console.log(`plan: v1.redeem(${dfShares}) -> usdc.approve(v2, ${dfAssets}) -> v2.deposit(${dfAssets})`);
    if (!args.commit) { console.log("DRY RUN."); return; }
    let r = await (await oldPool.connect(wallet).redeem(dfShares, wallet.address, wallet.address)).wait();
    if (r.status !== 1) throw new Error("v1 redeem failed. STOP.");
    console.log("  v1 redeemed, tx", r.hash);
    r = await (await usdc.connect(wallet).approve(V2, dfAssets)).wait();
    if (r.status !== 1) throw new Error("approve failed. STOP.");
    r = await (await newPool.connect(wallet).deposit(dfAssets, wallet.address)).wait();
    if (r.status !== 1) throw new Error("v2 deposit failed. STOP.");
    const gotShares = await newPool.balanceOf(wallet.address);
    if (gotShares.toString() !== dfShares.toString()) throw new Error(`share count drift: got ${gotShares}, expected ${dfShares}. STOP.`);
    console.log("  v2 deposited, tx", r.hash, "— shares exact:", gotShares.toString());
    return;
  }

  if (args.phase === "verify") {
    const [nShares, nAssets, oSupply] = await Promise.all([
      newPool.balanceOf(DOGFOOD), newPool.assetsOf(DOGFOOD), oldPool.totalSupply()
    ]);
    console.log(`v2 dogfood: shares ${nShares} assets ${nAssets} | v1 residual supply: ${oSupply}`);
    assertByteExactMigration({
      before: { sharesRaw: "10000000", assetsRaw: "10000000", principalRaw: "10000000", tranches: [] },
      after: { sharesRaw: nShares.toString(), assetsRaw: nAssets.toString(), principalRaw: "10000000", tranches: [] }
    });
    console.log("byte-exact migration: OK");
    return;
  }
}

main().catch((e) => { console.error(`ceremony failed: ${e.message}`); process.exit(1); });
