// Move an AgentAccountCore USDC liquid balance into the operator reward bank
// (the KMS signer's AAC position) with ONE internal transfer: sendToAgent.
// Dry run by default. --commit reads the key with `op read` in YOUR shell.
//   node .scratch/aac-send-to-bank.mjs --expected-wallet 0x… [--amount <raw6dp>|all]
//   node .scratch/aac-send-to-bank.mjs --expected-wallet 0x… --signer-secret-ref 'op://…' --commit
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";
const AAC = "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57", USDC = "0x0000053900000000000000000000000001200000";
const BANK = "0x5a6836c6D4d293F6E5377E6c28054F4171915813"; // reward bank = KMS signer AAC position
const CHAIN_ID = 420420419n;
const ABI = ["function positions(address,address) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)", "function sendToAgent(address recipient, address asset, uint256 amount)"];
const args = { rpc: "https://eth-rpc.polkadot.io", commit: false, amount: "all" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) { const a = argv[i]; if (a === "--commit") args.commit = true; else if (a === "--rpc") args.rpc = argv[++i]; else if (a === "--expected-wallet") args.expectedWallet = argv[++i]; else if (a === "--signer-secret-ref") args.signerSecretRef = argv[++i]; else if (a === "--amount") args.amount = argv[++i]; else throw new Error(`unknown argument ${a}`); }
if (!args.expectedWallet) throw new Error("--expected-wallet is mandatory.");
const expected = ethers.getAddress(args.expectedWallet);
if (args.commit && !args.signerSecretRef?.startsWith("op://")) throw new Error("--commit requires --signer-secret-ref 'op://…'.");
const provider = new ethers.JsonRpcProvider(args.rpc, undefined, { staticNetwork: true });
if ((await provider.getNetwork()).chainId !== CHAIN_ID) throw new Error("wrong chain");
const aac = new ethers.Contract(AAC, ABI, provider);
const [pos, bank, dot, block] = await Promise.all([aac.positions(expected, USDC), aac.positions(BANK, USDC), provider.getBalance(expected), provider.getBlock("latest")]);
const f6 = (x) => ethers.formatUnits(x, 6);
console.log(`AAC ${AAC} — ${args.commit ? "COMMIT" : "DRY RUN"} — block ${block.number} ${new Date(block.timestamp * 1000).toISOString()}`);
console.log(`from ${expected}: liquid ${f6(pos.liquid)} reserved ${f6(pos.reserved)} debt ${f6(pos.debtOutstanding)} | DOT ${ethers.formatEther(dot)}`);
console.log(`bank ${BANK}: liquid ${f6(bank.liquid)} (before)`);
const amount = args.amount === "all" ? pos.liquid : BigInt(args.amount);
if (amount <= 0n) throw new Error("nothing to move (liquid is 0).");
if (amount > pos.liquid) throw new Error(`amount ${f6(amount)} exceeds liquid ${f6(pos.liquid)}.`);
if (pos.debtOutstanding > 0n) throw new Error("account has outstanding debt; refusing.");
if (dot < ethers.parseEther("0.05")) throw new Error("sender holds < 0.05 DOT for gas.");
const data = aac.interface.encodeFunctionData("sendToAgent", [BANK, USDC, amount]);
const gas = await provider.estimateGas({ from: expected, to: AAC, data });
console.log(`plan: sendToAgent(recipient=${BANK}, asset=USDC, amount=${amount} [${f6(amount)}])\n  to ${AAC}\n  calldata ${data}\n  simulated OK, gas ${gas}`);
if (!args.commit) { console.log("DRY RUN — nothing sent."); process.exit(0); }
const read = spawnSync("op", ["read", args.signerSecretRef], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
if (read.status !== 0) throw new Error(`op read failed: ${read.stderr.trim()}`);
let key = read.stdout.trim(); if (!key.startsWith("0x")) key = `0x${key}`;
const wallet = new ethers.Wallet(key, provider);
if (wallet.address !== expected) throw new Error(`key resolves to ${wallet.address}, not ${expected}. Stop.`);
const tx = await wallet.sendTransaction({ to: AAC, data, gasLimit: gas * 12n / 10n < 200000n ? 200000n : gas * 12n / 10n });
console.log(`sent ${tx.hash}`); const r = await tx.wait(1, 120000);
if (r.status !== 1) throw new Error(`tx ${tx.hash} reverted.`);
const after = await aac.positions(BANK, USDC);
console.log(JSON.stringify({ txHash: tx.hash, block: r.blockNumber, moved: f6(amount), bankLiquidAfter: f6(after.liquid), feeDot: ethers.formatEther(r.gasUsed * r.gasPrice) }, null, 2));
