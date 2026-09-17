// Ceremony C §5a — request a Notice7Days redeem of a holder's FULL v2.1 position.
// Dry run by default (no key read). --commit reads the key via `op read` inside
// YOUR shell and signs locally; the key never leaves this process.
//
//   node .scratch/pool-request-redeem.mjs --expected-wallet 0x… [--rpc URL]
//   node .scratch/pool-request-redeem.mjs --expected-wallet 0x… --signer-secret-ref 'op://…' --commit
import { spawnSync } from "node:child_process";
import { ethers } from "ethers";

const POOL = "0x9B35A102d656Fb86d798aF81959e09961DEc28E0"; // DepositPool v2.1 (mainnet)
const CHAIN_ID = 420420419n;
const TIER_7_DAYS = 0; // enum NoticeTier { Notice7Days, Notice30Days } — 0 = 7 days
const ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function availableShares(address) view returns (uint256)",
  "function lockedShares(address) view returns (uint256)",
  "function pledgedShares(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function nextRedeemRequestId() view returns (uint256)",
  "function NOTICE_7_DAYS() view returns (uint256)",
  "function requestRedeem(uint256 shares, address receiver, uint8 tier) returns (uint256 requestId)",
  "event RedeemRequested(uint256 indexed requestId, address indexed owner, address indexed receiver, uint256 shares, uint8 tier, uint64 unlockAt)"
];

const args = { rpc: "https://eth-rpc.polkadot.io", commit: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--commit") args.commit = true;
  else if (a === "--rpc") args.rpc = argv[++i];
  else if (a === "--expected-wallet") args.expectedWallet = argv[++i];
  else if (a === "--signer-secret-ref") args.signerSecretRef = argv[++i];
  else throw new Error(`unknown argument ${a}`);
}
if (!args.expectedWallet) throw new Error("--expected-wallet is mandatory (dry run and commit).");
const expected = ethers.getAddress(args.expectedWallet);
if (args.commit && !args.signerSecretRef?.startsWith("op://")) throw new Error("--commit requires --signer-secret-ref 'op://…'.");

const provider = new ethers.JsonRpcProvider(args.rpc, undefined, { staticNetwork: true });
const net = await provider.getNetwork();
if (net.chainId !== CHAIN_ID) throw new Error(`wrong chain ${net.chainId}; expected ${CHAIN_ID}`);
const pool = new ethers.Contract(POOL, ABI, provider);
const f6 = (x) => ethers.formatUnits(x, 6);

const [balance, available, locked, pledged, nextId, notice, dot, nonce, block] = await Promise.all([
  pool.balanceOf(expected), pool.availableShares(expected), pool.lockedShares(expected), pool.pledgedShares(expected),
  pool.nextRedeemRequestId(), pool.NOTICE_7_DAYS(), provider.getBalance(expected), provider.getTransactionCount(expected), provider.getBlock("latest")
]);
console.log(`pool v2.1 ${POOL} — ${args.commit ? "COMMIT" : "DRY RUN"} — block ${block.number} ${new Date(block.timestamp * 1000).toISOString()}`);
console.log(`holder ${expected}: shares ${f6(balance)} (≈ ${f6(await pool.convertToAssets(balance))} USDC), available ${f6(available)}, locked ${f6(locked)}, pledged ${f6(pledged)}, DOT ${ethers.formatEther(dot)}, nonce ${nonce}`);
if (balance === 0n) throw new Error("holder has no shares.");
if (locked > 0n) throw new Error(`lockedShares ${f6(locked)} > 0 — a redeem request already exists for this holder; do NOT request twice.`);
if (available !== balance) throw new Error(`availableShares ${f6(available)} != balance ${f6(balance)} — refusing (pledged/locked shares).`);
if (dot < ethers.parseEther("0.2")) throw new Error("holder holds < 0.2 DOT; top up gas first.");

const data = pool.interface.encodeFunctionData("requestRedeem", [balance, expected, TIER_7_DAYS]);
const gas = await provider.estimateGas({ from: expected, to: POOL, data });
const unlockAt = new Date((block.timestamp + Number(notice)) * 1000).toISOString();
console.log(`plan: requestRedeem(shares=${balance} [${f6(balance)}], receiver=self, tier=0 Notice7Days)`);
console.log(`  calldata ${data}`);
console.log(`  simulated OK, gas ${gas}; predicted requestId ${nextId}; unlockAt ≈ ${unlockAt} (+${Number(notice) / 86400} d)`);
if (!args.commit) { console.log("DRY RUN — nothing sent."); process.exit(0); }

const read = spawnSync("op", ["read", args.signerSecretRef], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
if (read.status !== 0) throw new Error(`op read failed: ${read.stderr.trim()}`);
let key = read.stdout.trim(); if (!key.startsWith("0x")) key = `0x${key}`;
if (!/^0x[0-9a-fA-F]{64}$/u.test(key)) throw new Error("op read did not return a 32-byte hex key.");
const wallet = new ethers.Wallet(key, provider);
if (wallet.address !== expected) throw new Error(`key resolves to ${wallet.address}, not --expected-wallet ${expected}. Stop.`);
const gasLimit = gas * 12n / 10n < 200000n ? 200000n : gas * 12n / 10n; // floor: never OOG a notice request over an optimistic estimate
const tx = await wallet.sendTransaction({ to: POOL, data, gasLimit });
console.log(`sent ${tx.hash}`);
const receipt = await tx.wait();
if (receipt.status !== 1) throw new Error(`tx ${tx.hash} reverted (block ${receipt.blockNumber}).`);
const ev = receipt.logs.map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "RedeemRequested");
if (!ev) throw new Error(`no RedeemRequested event in ${tx.hash}; read the pool before retrying.`);
console.log(JSON.stringify({ holder: expected, txHash: tx.hash, block: receipt.blockNumber, requestId: ev.args.requestId.toString(),
  shares: f6(ev.args.shares), tier: Number(ev.args.tier), unlockAt: new Date(Number(ev.args.unlockAt) * 1000).toISOString(),
  feeDot: ethers.formatEther(receipt.gasUsed * (receipt.gasPrice ?? 0n)) }, null, 2));
