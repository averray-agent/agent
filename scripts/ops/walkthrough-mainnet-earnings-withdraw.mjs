#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Contract, Interface, JsonRpcProvider, Wallet, getAddress } from "ethers";

import { AgentPlatformClient } from "../../sdk/agent-platform-client.js";
import { readOpSecret } from "./get-admin-refresh-token.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const MAINNET_CHAIN_ID = 420420419n;
const WITHDRAW_INTERFACE = new Interface(["function withdraw(address asset,uint256 amount)"]);
const TOKEN_INTERFACE = new Interface(["function transfer(address to,uint256 amount) returns (bool)"]);
const POSITION_ABI = [
  "function positions(address account,address asset) view returns(uint256 liquid,uint256 reserved,uint256 strategyAllocated,uint256 collateralLocked,uint256 jobStakeLocked,uint256 debtOutstanding)"
];
const TOKEN_ABI = ["function balanceOf(address account) view returns(uint256)"];

export function verifyWithdrawDoorResponse({ response, wallet, agentAccountCore, asset, amount, destination }) {
  const owner = getAddress(wallet);
  const accountAddress = getAddress(agentAccountCore);
  const assetAddress = getAddress(asset);
  const requested = BigInt(amount);
  const expectedCount = destination ? 2 : 1;
  if (response?.available !== true) throw new Error("Withdrawal door did not report available: true.");
  if (getAddress(response.wallet) !== owner) throw new Error("Withdrawal response is not bound to the signer wallet.");
  if (response.chainId !== undefined && BigInt(response.chainId) !== MAINNET_CHAIN_ID) {
    throw new Error(`Withdrawal response chainId ${response.chainId} is not mainnet.`);
  }
  if (!Array.isArray(response.templates) || response.templates.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} complete unsigned template(s).`);
  }
  if (response.whatYourBalanceCanDo?.retentionNotGates?.templatesRemainComplete !== true) {
    throw new Error("Retention block does not affirm that templates remain complete.");
  }
  for (const gate of ["conditionsWithdrawal", "delaysWithdrawal", "pricesWithdrawal", "addsWithdrawalSteps"]) {
    if (response.whatYourBalanceCanDo.retentionNotGates[gate] !== false) {
      throw new Error(`Retention block illegally gates withdrawal through ${gate}.`);
    }
  }

  const withdrawal = response.templates[0];
  assertTemplateEnvelope(withdrawal, { from: owner, to: accountAddress });
  const decodedWithdrawal = WITHDRAW_INTERFACE.decodeFunctionData("withdraw", withdrawal.data);
  if (getAddress(decodedWithdrawal.asset) !== assetAddress || decodedWithdrawal.amount !== requested) {
    throw new Error("Independent AAC.withdraw calldata decode did not match the requested asset and amount.");
  }

  if (destination) {
    const target = getAddress(destination);
    const transfer = response.templates[1];
    assertTemplateEnvelope(transfer, { from: owner, to: assetAddress });
    if (transfer.prerequisite !== "withdraw_confirmed_on_chain") {
      throw new Error("Onward transfer is missing the withdrawal-confirmation prerequisite.");
    }
    const decodedTransfer = TOKEN_INTERFACE.decodeFunctionData("transfer", transfer.data);
    if (getAddress(decodedTransfer.to) !== target || decodedTransfer.amount !== requested) {
      throw new Error("Independent ERC-20 transfer calldata decode did not match the destination and amount.");
    }
  }
  return true;
}

function assertTemplateEnvelope(template, { from, to }) {
  if (template?.unsigned !== true) throw new Error("Template is not explicitly unsigned.");
  if (getAddress(template.from) !== from) throw new Error("Template from is not the authenticated wallet.");
  if (getAddress(template.to) !== to) throw new Error("Template target is not the independently expected contract.");
  if (BigInt(template.chainId) !== MAINNET_CHAIN_ID) throw new Error("Template chainId is not Polkadot Hub mainnet.");
  if (BigInt(template.value ?? 0) !== 0n) throw new Error("Template unexpectedly transfers native value.");
  if (typeof template.data !== "string" || !template.data.startsWith("0x")) throw new Error("Template calldata is missing.");
}

export async function runMainnetEarningsWithdrawWalkthrough({
  apiBaseUrl = "https://api.averray.com",
  amountRaw,
  destination,
  expectedWallet,
  walletKeyOp,
  commit = false,
  evidenceFile,
  fetchImpl = globalThis.fetch,
  readSecretImpl = readOpSecret,
  provider: injectedProvider,
  log = console.log
} = {}) {
  const amount = exactPositiveRaw(amountRaw, "amount");
  if (!walletKeyOp?.startsWith("op://")) throw new Error("--wallet-key-op must be a 1Password op:// reference.");
  if (commit && !expectedWallet) throw new Error("--commit requires --expected-wallet to bind the retained key explicitly.");

  const manifest = JSON.parse(readFileSync(resolve(repoRoot, "deployments/mainnet.json"), "utf8"));
  const provider = injectedProvider ?? new JsonRpcProvider(manifest.rpcUrl);
  const privateKey = await readSecretImpl(walletKeyOp);
  const wallet = new Wallet(privateKey, provider);
  const owner = getAddress(wallet.address);
  if (expectedWallet && owner !== getAddress(expectedWallet)) {
    throw new Error(`1Password key resolved to ${owner}, not --expected-wallet ${expectedWallet}.`);
  }
  const [chainId, health] = await Promise.all([
    provider.getNetwork().then((network) => network.chainId),
    fetchJson(fetchImpl, `${stripSlash(apiBaseUrl)}/health`)
  ]);
  if (chainId !== MAINNET_CHAIN_ID || BigInt(health?.auth?.chainId ?? 0) !== MAINNET_CHAIN_ID) {
    throw new Error(`Mainnet chain binding failed: RPC=${chainId}, API=${health?.auth?.chainId ?? "missing"}.`);
  }
  const agentAccountCore = getAddress(manifest.contracts.agentAccountCore);
  const asset = getAddress(manifest.contracts.token);
  if (getAddress(health.addresses.agentAccountCore) !== agentAccountCore || getAddress(health.addresses.token) !== asset) {
    throw new Error("API health addresses do not match the checked-in mainnet manifest.");
  }

  const anonymous = new AgentPlatformClient({ baseUrl: stripSlash(apiBaseUrl), fetchImpl });
  const nonce = await anonymous.issueNonce(owner);
  const signature = await wallet.signMessage(nonce.message);
  const auth = await anonymous.verifySignature(nonce.message, signature);
  if (getAddress(auth.wallet) !== owner) throw new Error("SIWE response wallet does not match the retained signer.");
  const platform = new AgentPlatformClient({ baseUrl: stripSlash(apiBaseUrl), token: auth.token, fetchImpl });

  const accountContract = new Contract(agentAccountCore, POSITION_ABI, provider);
  const tokenContract = new Contract(asset, TOKEN_ABI, provider);
  const [doorAccount, beforePosition, beforeEoaRaw, dotRaw] = await Promise.all([
    platform.getAccountPosition("USDC"),
    accountContract.positions(owner, asset),
    tokenContract.balanceOf(owner),
    provider.getBalance(owner)
  ]);
  if (getAddress(doorAccount.account.owner) !== owner) throw new Error("Account door returned a different owner.");
  if (BigInt(doorAccount.account.available.raw) !== beforePosition.liquid) {
    throw new Error("Account door available balance differs from the independent AAC.positions read.");
  }
  if (beforePosition.liquid < amount) {
    throw new Error(`Retained wallet has ${beforePosition.liquid} raw USDC available; requested ${amount}.`);
  }

  const built = await platform.buildWithdrawTransactions({
    asset: "USDC",
    amount: amount.toString(),
    ...(destination ? { destination: getAddress(destination) } : {})
  });
  verifyWithdrawDoorResponse({
    response: built,
    wallet: owner,
    agentAccountCore,
    asset,
    amount,
    destination
  });
  const transcript = {
    schemaVersion: 1,
    profile: "mainnet",
    chainId: chainId.toString(),
    wallet: owner,
    agentAccountCore,
    asset,
    amountRaw: amount.toString(),
    destination: destination ? getAddress(destination) : owner,
    mode: commit ? "commit" : "dry_run",
    before: {
      accountAvailableRaw: beforePosition.liquid.toString(),
      eoaUsdcRaw: beforeEoaRaw.toString(),
      dotRaw: dotRaw.toString()
    },
    verification: {
      apiAccountMatchesChain: true,
      calldataIndependentlyDecoded: true,
      envelopeIndependentlyBound: true,
      retentionDoesNotGate: true,
      gas: built.templates[0].gas
    }
  };

  if (!commit) {
    log(JSON.stringify(transcript, null, 2));
    if (evidenceFile) await writeFile(evidenceFile, `${JSON.stringify(transcript, null, 2)}\n`, { mode: 0o600 });
    return transcript;
  }

  if (built.templates[0].gas?.sufficient !== true) {
    throw new Error("Door reports insufficient DOT for the retained wallet; refusing to broadcast.");
  }
  // This is the first and only money-moving line. Every identity, network,
  // balance, retention, envelope, and calldata assertion above has completed.
  const transaction = await wallet.sendTransaction({
    to: built.templates[0].to,
    data: built.templates[0].data,
    value: 0n
  });
  const receipt = await transaction.wait(1);
  if (receipt?.status !== 1) throw new Error(`Withdrawal transaction ${transaction.hash} did not succeed.`);
  const [afterPosition, afterEoaRaw] = await Promise.all([
    accountContract.positions(owner, asset),
    tokenContract.balanceOf(owner)
  ]);
  const accountDecrease = beforePosition.liquid - afterPosition.liquid;
  const eoaIncrease = afterEoaRaw - beforeEoaRaw;
  if (accountDecrease !== amount || eoaIncrease !== amount) {
    throw new Error(
      `Outcome mismatch: AAC decreased ${accountDecrease}, EOA increased ${eoaIncrease}, expected ${amount}.`
    );
  }
  transcript.transaction = {
    hash: transaction.hash,
    blockNumber: Number(receipt.blockNumber),
    status: receipt.status
  };
  transcript.after = {
    accountAvailableRaw: afterPosition.liquid.toString(),
    eoaUsdcRaw: afterEoaRaw.toString(),
    accountDecreaseRaw: accountDecrease.toString(),
    eoaIncreaseRaw: eoaIncrease.toString()
  };
  transcript.outcome = "exact_withdrawal_confirmed";
  log(JSON.stringify(transcript, null, 2));
  if (evidenceFile) await writeFile(evidenceFile, `${JSON.stringify(transcript, null, 2)}\n`, { mode: 0o600 });
  return transcript;
}

function exactPositiveRaw(value, field) {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) throw new Error(`--${field} must be a positive exact integer.`);
  return BigInt(normalized);
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${body?.message ?? text}`);
  return body;
}

function stripSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

function parseArgs(argv) {
  const args = { commit: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--commit") args.commit = true;
    else if (token === "--amount") args.amountRaw = argv[++index];
    else if (token === "--destination") args.destination = argv[++index];
    else if (token === "--expected-wallet") args.expectedWallet = argv[++index];
    else if (token === "--wallet-key-op") args.walletKeyOp = argv[++index];
    else if (token === "--api") args.apiBaseUrl = argv[++index];
    else if (token === "--evidence") args.evidenceFile = argv[++index];
    else throw new Error(`Unknown argument ${token}.`);
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMainnetEarningsWithdrawWalkthrough(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}
