#!/usr/bin/env node
// One reviewed non-USDC asset return. No approvals, deposits, or native transfers.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Contract, Interface, JsonRpcProvider, parseUnits, formatUnits } from "ethers";
import { KmsSigner } from "../../mcp-server/src/blockchain/kms-signer.js";
import { selectRpcUrl, EXPECTED_CHAIN_IDS } from "./fund-signer-usdc-deposit.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];
const iface = new Interface(ABI);
export const NATIVE_FLOOR = parseUnits("2", 18);
const address = (value) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? "")) throw new Error("Expected an EVM H160 address; destination placeholder must be replaced in a reviewed PR");
  return value.toLowerCase();
};
const positive = (value) => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || BigInt(value) >= 2n ** 256n) throw new Error("Amount/maxRaw must be a positive uint256 decimal string");
  return BigInt(value);
};
export function deploymentAddresses(value, found = new Set()) {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) found.add(value.toLowerCase());
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    deploymentAddresses(key, found);
    deploymentAddresses(item, found);
  }
  return found;
}
export function validateAllowList(list, manifest) {
  if (list?.schemaVersion !== "averray.signer-asset-returns.v1" || !Array.isArray(list.returns) || !list.returns.length) throw new Error("Invalid return allow-list schema");
  const signer = address(list.signer);
  if (signer !== address(manifest.verifier)) throw new Error("Allow-list signer mismatch");
  const forbidden = deploymentAddresses(manifest);
  forbidden.add(signer);
  forbidden.add("0x0000000000000000000000000000000000000000");
  const keys = new Set();
  const entries = list.returns.map((entry) => {
    const asset = address(entry.asset);
    if (asset === address(manifest.contracts.token)) throw new Error("USDC must use the deposit path");
    // Only Asset Hub foreign-asset ERC20 precompiles; no native DOT, arbitrary
    // contracts, AgentAccountCore, EscrowCore, or other deployment addresses.
    if (!/^0x[0-9a-f]{8}00000000000000000000000001200000$/.test(asset) || /^0x00000000/.test(asset) || forbidden.has(asset)) throw new Error("Protected or non-asset target");
    const destination = address(entry.destination);
    if (forbidden.has(destination)) throw new Error("Protected destination");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.key ?? "") || keys.has(entry.key)) throw new Error("Invalid or duplicate return key");
    keys.add(entry.key);
    positive(entry.maxRaw);
    if (typeof entry.symbol !== "string" || !entry.symbol || !Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 255) throw new Error("Invalid asset metadata");
    return { ...entry, asset, destination };
  });
  return { signer, entries };
}
export function parseArgs(argv) {
  const args = { commit: false, useKms: false };
  const names = { "--profile": "profile", "--key": "key", "--amount": "amount", "--expected-signer": "expectedSigner", "--expected-plan-hash": "expectedPlanHash", "--confirm": "confirm" };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error(`Duplicate option ${flag}`);
    seen.add(flag);
    if (flag === "--commit") args.commit = true;
    else if (flag === "--use-kms") args.useKms = true;
    else if (names[flag] && argv[i + 1] && !argv[i + 1].startsWith("--")) args[names[flag]] = argv[++i];
    else throw new Error(`Unknown or incomplete option ${flag}`);
  }
  return args;
}
export function planHash(plan) {
  // Fixed field order and string units; unrelated metadata cannot affect approval.
  return createHash("sha256").update(JSON.stringify([String(plan.chainId), plan.signer, plan.asset, plan.destination, plan.amount, plan.calldata])).digest("hex");
}
export async function returnSignerAsset({ args, allowList, manifest, provider, signer, token, log = console.log }) {
  if (args.profile !== "mainnet") throw new Error("--profile mainnet is required");
  if (!args.useKms) throw new Error("--use-kms is required; no private-key path");
  const expectedSigner = address(args.expectedSigner);
  const { signer: signerAddress, entries } = validateAllowList(allowList, manifest);
  if (expectedSigner !== signerAddress || address(await signer.getAddress()) !== signerAddress) throw new Error("Resolved/expected signer mismatch");
  const entry = entries.find((item) => item.key === args.key);
  if (!entry) throw new Error("Unknown return key");
  const amount = positive(args.amount);
  if (amount > BigInt(entry.maxRaw)) throw new Error("Amount exceeds maxRaw");
  const chainId = Number(BigInt(await provider.send("eth_chainId", [])));
  if (chainId !== EXPECTED_CHAIN_IDS.mainnet) throw new Error("Wrong chain id");
  token ??= new Contract(entry.asset, ABI, provider);
  const [symbol, decimals, balance] = await Promise.all([token.symbol(), token.decimals(), token.balanceOf(signerAddress)]);
  if (symbol !== entry.symbol) throw new Error("Asset symbol mismatch");
  if (Number(decimals) !== entry.decimals) throw new Error("Asset decimals mismatch");
  if (balance < amount) throw new Error("Amount exceeds live balance");
  const calldata = iface.encodeFunctionData("transfer", [entry.destination, amount]);
  const plan = { chainId, signer: signerAddress, asset: entry.asset, destination: entry.destination, amount: amount.toString(), calldata };
  const hash = planHash(plan);
  const tx = { to: entry.asset, from: signerAddress, data: calldata, value: 0n, chainId, type: 0 };
  const gasLimit = await provider.estimateGas(tx);
  const gasPrice = BigInt(await provider.send("eth_gasPrice", []));
  const native = await provider.getBalance(signerAddress);
  if (gasLimit <= 0n || gasPrice <= 0n || native - gasLimit * gasPrice < NATIVE_FLOOR) throw new Error("Signer native DOT gas floor: require 2 DOT after cost");
  log(JSON.stringify({ mode: args.commit ? "commit" : "dry-run", ...plan, symbol, decimals: Number(decimals), balance: balance.toString(), nativeDotRaw: native.toString(), nativeDot: formatUnits(native, 18), estimatedCostRaw: String(gasLimit * gasPrice), planHash: hash, confirm: `RETURN ${hash.slice(0, 12)}` }));
  if (!args.commit) return { plan, hash };
  if (args.expectedPlanHash !== hash) throw new Error("Missing or stale --expected-plan-hash");
  if (args.confirm !== `RETURN ${hash.slice(0, 12)}`) throw new Error("Wrong --confirm");
  // Refresh immediately before the only signing/send call. Never auto-retry a send.
  const [before, destinationBefore, nativeBefore] = await Promise.all([
    token.balanceOf(signerAddress), token.balanceOf(entry.destination), provider.getBalance(signerAddress)
  ]);
  if (before < amount) throw new Error("Amount exceeds fresh live balance");
  if (nativeBefore - gasLimit * gasPrice < NATIVE_FLOOR) throw new Error("Signer native DOT gas floor changed");
  const sent = await signer.sendTransaction({ ...tx, gasLimit, gasPrice });
  log(JSON.stringify({ transactionHash: sent.hash }));
  const receipt = await sent.wait(1, 120_000);
  if (!receipt || receipt.status !== 1) throw new Error("Transfer receipt unsuccessful or unavailable; inspect transaction before retrying");
  const [after, destinationAfter] = await Promise.all([
    token.balanceOf(signerAddress, { blockTag: receipt.blockNumber }), token.balanceOf(entry.destination, { blockTag: receipt.blockNumber })
  ]);
  log(JSON.stringify({ signerBefore: String(before), signerAfter: String(after), destinationBefore: String(destinationBefore), destinationAfter: String(destinationAfter), signerDecrease: String(before - after), destinationIncrease: String(destinationAfter - destinationBefore) }));
  if (before - after !== amount || destinationAfter - destinationBefore !== amount) throw new Error("Transfer balance delta mismatch; inspect transaction before retrying");
  return { plan, hash, receipt };
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.profile !== "mainnet" || !args.useKms || !args.expectedSigner) throw new Error("Require --profile mainnet --use-kms --expected-signer <H160> --key <key> --amount <raw>");
  const manifest = JSON.parse(await readFile(resolve(root, "deployments/mainnet.json"), "utf8"));
  const allowList = JSON.parse(await readFile(resolve(root, "deployments/signer-asset-returns.mainnet.json"), "utf8"));
  validateAllowList(allowList, manifest); // Placeholder fails before RPC or AWS.
  const rpc = await selectRpcUrl(manifest, { profile: args.profile });
  const provider = new JsonRpcProvider(rpc.url, rpc.chainId, { staticNetwork: true, cacheTimeout: -1 });
  try {
    const signer = new KmsSigner({ keyId: process.env.KMS_KEY_ID, region: process.env.AWS_REGION, provider });
    await returnSignerAsset({ args, allowList, manifest, provider, signer });
  } finally { provider.destroy(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`return-signer-asset failed: ${error.message}`); process.exitCode = 1; });
}
