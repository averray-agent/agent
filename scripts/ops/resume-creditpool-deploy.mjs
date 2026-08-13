#!/usr/bin/env node
/**
 * Surgical resume for the 2026-08-14 pool-v2 ceremony: deploy ONLY the fourth
 * contract (creditPool) at admin nonce 18.
 *
 * Context: the deploy phase landed lane/venueAdapter/depositPoolV2 exactly at
 * their predicted addresses (nonces 15-17), then the creditPool CREATE was
 * refused by the tx pool (1010 Invalid Transaction — upfront gas hold exceeded
 * the remaining balance; each CREATE costs ~0.9 DOT on the Hub, storage
 * deposit included). depositPoolV2 was constructed pointing at the PREDICTED
 * creditPool, which is exactly what admin nonce 18 mints — so completing the
 * fourth CREATE at nonce 18 restores the full rehearsed state. The admin must
 * send NOTHING before this.
 *
 * Rebuilds the identical plan from the sim (same artifacts, startNonce 15) and
 * sends only transactions[3]. Dry-run default; --commit sends.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ethers } from "ethers";
import { buildDeploymentPlan } from "./simulate-creditpool-l1-migration.mjs";

const EXPECTED_CHAIN = 420420419n;
const RPC = "https://services.polkadothub-rpc.com/mainnet/";
const DEPLOYER = "0x9Ab8531FBb0948C542a31298FD61335f30064239";
const START_NONCE = 15;
const RESUME_NONCE = 18;
const EXPECTED = {
  lane: "0x88eE70277E486136676c0b50Ed9b7D7A1a31371f",
  venueAdapter: "0xE2801E6C640e0180798912649fD567E1Ea459a35",
  depositPoolV2: "0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30",
  creditPool: "0x903B318586A3772c99185000676f4AC356DD6E4B"
};

const commit = process.argv.includes("--commit");
const refIndex = process.argv.indexOf("--signer-secret-ref");
if (refIndex === -1) throw new Error("--signer-secret-ref op://… is required");
const secretRef = process.argv[refIndex + 1];
if (!secretRef?.startsWith("op://")) throw new Error("secret refs must be op:// references");

const provider = new ethers.JsonRpcProvider(RPC, { chainId: Number(EXPECTED_CHAIN), name: "polkadot-hub" });
const net = await provider.getNetwork();
if (net.chainId !== EXPECTED_CHAIN) throw new Error(`chain ${net.chainId}; refusing`);

const manifest = JSON.parse(readFileSync("deployments/mainnet.json", "utf8"));
const plan = buildDeploymentPlan({ manifest, deployer: DEPLOYER, startNonce: START_NONCE, artifactsDir: "out" });
for (const [step, addr] of Object.entries(EXPECTED)) {
  if (ethers.getAddress(plan.predicted[step]) !== ethers.getAddress(addr)) {
    throw new Error(`plan drift: predicted ${step} ${plan.predicted[step]} != expected ${addr}. STOP.`);
  }
}
const tx = plan.transactions[3];
if (tx.step !== "creditPool") throw new Error(`transactions[3] is ${tx.step}, not creditPool. STOP.`);

// The three prior CREATEs must be live at their predicted addresses.
for (const step of ["lane", "venueAdapter", "depositPoolV2"]) {
  const code = await provider.getCode(EXPECTED[step]);
  if (code === "0x") throw new Error(`${step} has no code at ${EXPECTED[step]}. STOP.`);
  console.log(`  ${step} live at ${EXPECTED[step]} (${(code.length - 2) / 2} bytes)`);
}
const baked = ethers.getAddress(await new ethers.Contract(EXPECTED.depositPoolV2,
  ["function creditPool() view returns (address)"], provider).creditPool());
if (baked !== ethers.getAddress(EXPECTED.creditPool)) throw new Error(`poolV2.creditPool() = ${baked}; STOP.`);
console.log(`  poolV2.creditPool() -> ${baked} ✓`);

const nonce = Number(await provider.getTransactionCount(DEPLOYER, "pending"));
if (nonce !== RESUME_NONCE) throw new Error(`pending nonce ${nonce} != ${RESUME_NONCE}. STOP — nonce moved.`);
const bal = await provider.getBalance(DEPLOYER);
console.log(`  admin nonce ${nonce} ✓, balance ${ethers.formatEther(bal)} DOT`);
if (bal < ethers.parseEther("2")) throw new Error(`balance below 2.0 DOT — the upfront hold (~1.84) needs headroom. Top up first.`);
console.log(`  creditPool creation: ${((tx.data.length - 2) / 2).toLocaleString()} bytes -> will mint ${EXPECTED.creditPool}`);

if (!commit) { console.log("\nDRY RUN. Re-run with --commit to deploy creditPool at nonce 18."); process.exit(0); }

const signer = new ethers.Wallet(execFileSync("op", ["read", secretRef], { encoding: "utf8" }).trim(), provider);
if (signer.address.toLowerCase() !== DEPLOYER.toLowerCase()) throw new Error(`key derives ${signer.address}. Refusing.`);
const receipt = await (await signer.sendTransaction({ data: tx.data, nonce: RESUME_NONCE })).wait();
if (receipt.status !== 1) throw new Error("creditPool deploy tx failed on-chain. STOP.");
const actual = ethers.getAddress(receipt.contractAddress);
if (actual !== ethers.getAddress(EXPECTED.creditPool)) throw new Error(`CREATE drift: ${actual}. STOP.`);
console.log(`  creditPool deployed ${actual} (block ${receipt.blockNumber}, tx ${receipt.hash})`);
const disclosure = await new ethers.Contract(actual, ["function RISK_DISCLOSURE() view returns (string)"], provider).RISK_DISCLOSURE();
console.log(`  postcondition creditPool.RISK_DISCLOSURE(): ${JSON.stringify(disclosure)}`);
console.log(`\nNext: node scripts/ops/encode-poolv2-multisig.mjs --lane ${EXPECTED.lane}`);
process.exit(0);
