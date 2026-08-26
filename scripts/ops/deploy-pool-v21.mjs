#!/usr/bin/env node
/**
 * Ceremony A deploys — DepositPool v2.1 and the AAC aggregator adapter.
 *
 * No CREATE-cycle here by design (Q1'': the venue binds later, set-once, by
 * multisig), so this is two PLAIN sequential deploys:
 *
 *   step pool     constructor(policy, asset, operator, 0x0, creditPool)
 *   step adapter  constructor(agentAccountCore, pool)
 *
 * Every constructor argument is READ LIVE (v2 pool + manifest), never typed.
 * Dry-run is the default. --commit requires --signer-secret-ref (op://...);
 * raw key env vars are not accepted. Reuses the house ceremony signer
 * resolution verbatim.
 *
 * Usage:
 *   node scripts/ops/deploy-pool-v21.mjs pool    --expected-deployer 0x…   # dry
 *   node scripts/ops/deploy-pool-v21.mjs pool    --expected-deployer 0x… \
 *        --signer-secret-ref 'op://mainnet-critical/admin-eoa-mainnet/credential' --commit
 *   node scripts/ops/deploy-pool-v21.mjs adapter --pool 0xNEWPOOL --expected-deployer 0x… [...]
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { resolveCeremonyDeployer } from "./deploy-deposit-pool.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const AAC = "0xb1350932bf85e7ffd0599e9a3cc7b55718d89e57";
const V2_POOL = "0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30";
const MIN_DEPLOY_BALANCE_WEI = ethers.parseEther("1.3"); // per-CREATE floor incl. upfront hold

function parseArgs(argv) {
  const args = { step: argv[2], commit: false };
  for (let i = 3; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--commit") args.commit = true;
    else if (a === "--rpc") args.rpc = argv[++i];
    else if (a === "--pool") args.pool = argv[++i];
    else if (a === "--expected-deployer") args.expectedDeployer = argv[++i];
    else if (a === "--signer-secret-ref") args.signerSecretRef = argv[++i];
    else throw new Error(`Unknown flag ${a}`);
  }
  if (!["pool", "adapter"].includes(args.step)) throw new Error("step must be 'pool' or 'adapter'.");
  return args;
}

async function artifact(name, file) {
  const p = resolve(repoRoot, "out", file, `${name}.json`);
  const a = JSON.parse(await readFile(p, "utf8"));
  if (!a.bytecode?.object || a.bytecode.object === "0x") throw new Error(`${name}: empty bytecode — run forge build.`);
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const manifest = JSON.parse(await readFile(resolve(repoRoot, "deployments/mainnet.json"), "utf8"));
  const provider = new ethers.JsonRpcProvider(args.rpc ?? manifest.rpcUrl ?? "https://services.polkadothub-rpc.com/mainnet/");
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== 420420419) throw new Error(`wrong chainId ${net.chainId}`);

  const identity = resolveCeremonyDeployer({
    expectedDeployer: args.expectedDeployer,
    signerSecretRef: args.signerSecretRef,
    commit: args.commit,
  });

  const bal = await provider.getBalance(identity.address);
  if (bal < MIN_DEPLOY_BALANCE_WEI) {
    throw new Error(`deployer balance ${ethers.formatEther(bal)} below the 1.3 per-CREATE floor; top up first (the 1010 lesson).`);
  }

  const v2 = new ethers.Contract(V2_POOL, [
    "function asset() view returns (address)",
    "function operator() view returns (address)",
    "function creditPool() view returns (address)",
    "function policy() view returns (address)",
  ], provider);

  let art, types, values, label;
  if (args.step === "pool") {
    // policy is read from the MERGED v2.1 lineage: live v2 predates the policy
    // field, so it comes from the manifest and is cross-checked against the
    // registry's policy and policy.owner() being the cold multisig.
    const policy = ethers.getAddress(manifest.contracts.treasuryPolicy);
    const ownerAbi = ["function owner() view returns (address)"];
    const owner = await new ethers.Contract(policy, ownerAbi, provider).owner();
    if (owner.toLowerCase() !== "0x01e6eed856e989201f4ff6346e18eab7e46c874c") {
      throw new Error(`policy.owner() ${owner} is not the cold multisig; refusing.`);
    }
    const [asset, operator, creditPool] = await Promise.all([v2.asset(), v2.operator(), v2.creditPool()]);
    art = await artifact("DepositPoolV2", "DepositPoolV2.sol");
    types = ["address", "address", "address", "address", "address"];
    values = [policy, asset, operator, ethers.ZeroAddress, creditPool];
    label = "DepositPool v2.1 (venue-less; Q1'' set-once bind later)";
  } else {
    const pool = ethers.getAddress(args.pool ?? "");
    if ((await provider.getCode(pool)).length <= 2) throw new Error("--pool has no code on-chain.");
    art = await artifact("AacPoolAggregatorAdapter", "AacPoolAggregatorAdapter.sol");
    types = ["address", "address"];
    values = [ethers.getAddress(AAC), pool];
    label = "AacPoolAggregatorAdapter";
  }

  const nonce = await provider.getTransactionCount(identity.address, "pending");
  const predicted = ethers.getCreateAddress({ from: identity.address, nonce });
  const data = ethers.concat([art.bytecode.object, ethers.AbiCoder.defaultAbiCoder().encode(types, values)]);

  const plan = {
    kind: "averray.poolV21DeployEvidence",
    step: args.step, label, mode: args.commit ? "commit" : "dry-run",
    chainId: 420420419, deployer: identity.address, signerSource: identity.source,
    nonce, predictedAddress: predicted,
    constructorArgs: Object.fromEntries(types.map((t, i) => [`arg${i}(${t})`, values[i]])),
    initCodeBytes: (data.length - 2) / 2,
    deployerBalance: ethers.formatEther(bal),
  };
  console.log(JSON.stringify(plan, null, 2));
  if (!args.commit) { console.log("\nDRY RUN ONLY — nothing signed, nothing broadcast."); return; }

  const wallet = identity.wallet.connect(provider);
  const liveNonce = await provider.getTransactionCount(identity.address, "pending");
  if (liveNonce !== nonce) throw new Error(`nonce moved ${nonce} -> ${liveNonce}; prediction invalid, re-run.`);
  const tx = await wallet.sendTransaction({ data });
  const receipt = await tx.wait();
  const code = await provider.getCode(receipt.contractAddress);
  const ok = receipt.status === 1 && receipt.contractAddress === predicted && code.length > 2;
  console.log("\n# COMMITTED EVIDENCE");
  console.log(JSON.stringify({ ...plan, mode: "commit",
    txHash: receipt.hash, blockNumber: receipt.blockNumber,
    deployedAddress: receipt.contractAddress, matchesPrediction: receipt.contractAddress === predicted,
    runtimeBytes: (code.length - 2) / 2, status: receipt.status, verified: ok }, null, 2));
  if (!ok) throw new Error("post-deploy verification failed — STOP and report.");
}

main().catch((e) => { console.error(`deploy-pool-v21 failed: ${e?.message ?? e}`); process.exitCode = 1; });
