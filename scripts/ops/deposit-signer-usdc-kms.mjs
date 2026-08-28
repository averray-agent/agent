#!/usr/bin/env node
/**
 * Deposit the settlement signer's on-chain USDC into AgentAccountCore, i.e.
 * top up the REWARD BANK (the bank is the signer's AAC `liquid` position).
 *
 *   node deposit-signer-usdc-kms.mjs --amount 40075000            # dry run
 *   node deposit-signer-usdc-kms.mjs --amount 40075000 --commit   # approve + deposit
 *
 * Runs INSIDE agent-mainnet-backend, the only place the mainnet KMS key is
 * usable (Roles Anywhere via the shared-config profile "averray-signer"; no
 * static AWS keys exist for mainnet by design).
 *
 * Single purpose by design: it does exactly approve + deposit, on hardcoded
 * mainnet addresses that are asserted against the chain before anything signs.
 */
const tryImport = async (specs) => {
  let last;
  for (const s of specs) { try { return await import(s); } catch (e) { last = e; } }
  throw new Error(`could not resolve ${specs[0]}: ${last?.message ?? last}`);
};
const { KmsSigner } = await tryImport([
  "../../mcp-server/src/blockchain/kms-signer.js", "/app/src/blockchain/kms-signer.js"
]);
const { buildKmsCredentialsProvider, PROFILE_BLOCKCHAIN_SIGNER } = await tryImport([
  "../../mcp-server/src/services/aws-credentials.js", "/app/src/services/aws-credentials.js"
]);
const { JsonRpcProvider, Contract } = await tryImport(["ethers", "/app/node_modules/ethers/lib.esm/index.js"]);

const USDC = "0x0000053900000000000000000000000001200000";
const AAC = "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57";
const EXPECTED_SIGNER = "0x5a6836c6D4d293F6E5377E6c28054F4171915813";
const RPC = process.env.HUB_RPC_URL ?? "https://services.polkadothub-rpc.com/mainnet/";

const argv = process.argv;
const commit = argv.includes("--commit");
const amountArg = argv[argv.indexOf("--amount") + 1];
if (!/^\d+$/u.test(amountArg ?? "")) throw new Error("usage: --amount <USDC base units, 6dp> [--commit]");
const amount = BigInt(amountArg);

const provider = new JsonRpcProvider(RPC);
const signer = new KmsSigner({
  keyId: process.env.KMS_KEY_ID,
  region: process.env.AWS_REGION,
  provider,
  credentialsProvider: buildKmsCredentialsProvider({ profile: PROFILE_BLOCKCHAIN_SIGNER })
});
const me = await signer.getAddress();
if (me.toLowerCase() !== EXPECTED_SIGNER.toLowerCase()) {
  throw new Error(`derived signer ${me} is not the settlement signer ${EXPECTED_SIGNER} — refusing.`);
}

const usdc = new Contract(USDC, [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
], signer);
const aac = new Contract(AAC, [
  "function positions(address,address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function deposit(address,uint256)"
], signer);

if ((await provider.getCode(AAC)) === "0x") throw new Error(`no contract at AAC ${AAC} — wrong network?`);
const u = (x) => (Number(x) / 1e6).toFixed(6);
const eoaBefore = await usdc.balanceOf(me);
const posBefore = await aac.positions(me, USDC);
console.log(JSON.stringify({
  kind: "averray.rewardBankTopUp", mode: commit ? "commit" : "dry-run",
  signer: me, amount: amount.toString(),
  eoaUsdcBefore: u(eoaBefore), rewardBankBefore: u(posBefore[0]),
  rewardBankAfterExpected: u(posBefore[0] + amount),
  chainId: Number((await provider.getNetwork()).chainId)
}, null, 2));
if (eoaBefore < amount) throw new Error(`EOA holds ${u(eoaBefore)} but ${u(amount)} requested.`);
if (!commit) { console.log("\nDRY RUN ONLY — nothing signed."); process.exit(0); }

const a = await usdc.approve(AAC, amount); await a.wait();
console.log("approve tx:", a.hash);
const d = await aac.deposit(USDC, amount); await d.wait();
console.log("deposit tx:", d.hash);
const posAfter = await aac.positions(me, USDC);
console.log(JSON.stringify({
  approveTx: a.hash, depositTx: d.hash,
  rewardBankAfter: u(posAfter[0]), eoaUsdcAfter: u(await usdc.balanceOf(me)),
  delta: u(posAfter[0] - posBefore[0]),
  matchesRequested: (posAfter[0] - posBefore[0]) === amount
}, null, 2));
