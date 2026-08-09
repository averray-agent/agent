#!/usr/bin/env node
/**
 * Adversarial poster driver — §1 of docs/ADVERSARIAL_TEST_PROTOCOL.md.
 *
 * Runs the quote/funding boundary against the OPEN poster door with a dedicated
 * attacker wallet. Real money on mainnet.
 *
 * WHY A SCRIPT AND NOT THE OPERATOR APP
 * The browser path would mean extracting a live bearer token and pasting it into
 * a chat transcript. That already cost a forced admin sign-out once. Here the
 * token never leaves the process, the key is read by 1Password reference and is
 * never printed, and the operator pastes back only JSON results.
 *
 * SAFETY
 *   - Nothing is sent without --commit. Every run prints exactly what it would do.
 *   - Amounts are explicit. --reward-raw MUTATES the quoted reward on purpose,
 *     which is the §1.2/§1.3 binding test: does the watcher still materialise a
 *     job whose on-chain terms no longer match the quote it was given?
 *   - The funding call is encoded from the quote's OWN calldata.function and
 *     calldata.args, so this driver cannot drift from the server's idea of the
 *     transaction. If the server changes the shape, this follows automatically.
 *
 * USAGE
 *   ADVERSARIAL_POSTER_KEY_OP="op://vault/item/private key" \
 *     node scripts/ops/run-adversarial-poster.mjs quote --title "..." --reward 1
 *
 *   ADVERSARIAL_POSTER_KEY_OP=... \
 *     node scripts/ops/run-adversarial-poster.mjs fund --quote-file q.json \
 *       [--reward-raw 990000] [--commit]
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

import { Contract, Interface, JsonRpcProvider, Wallet } from "ethers";

const execFileAsync = promisify(execFile);

const API = (process.env.API_URL ?? "https://api.averray.com").replace(/\/+$/, "");
const RPC = process.env.RPC_URL ?? "https://services.polkadothub-rpc.com/mainnet/";
const ERC20 = ["function approve(address spender, uint256 amount) returns (bool)",
               "function allowance(address owner, address spender) view returns (uint256)",
               "function balanceOf(address account) view returns (uint256)"];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    if (!rest[index].startsWith("--")) continue;
    const key = rest[index].slice(2);
    const next = rest[index + 1];
    flags[key] = next && !next.startsWith("--") ? (index += 1, next) : true;
  }
  return { command, flags };
}

/** Read the key by reference. It is never returned to a caller, logged, or stored. */
async function loadWallet(provider) {
  const ref = String(process.env.ADVERSARIAL_POSTER_KEY_OP ?? "").trim();
  if (!ref.startsWith("op://")) {
    throw new Error("ADVERSARIAL_POSTER_KEY_OP must be a 1Password reference (op://vault/item/field).");
  }
  const { stdout } = await execFileAsync("op", ["read", ref], { encoding: "utf8" });
  return new Wallet(stdout.trim(), provider);
}

async function postJson(path, body, token) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

/** SIWE, exactly as check-siwe-fresh-wallet-proof.mjs does it. */
async function signIn(wallet) {
  const nonce = await postJson("/auth/nonce", { wallet: wallet.address });
  if (nonce.status !== 200 || !nonce.body?.message) {
    throw new Error(`/auth/nonce failed: ${nonce.status} ${JSON.stringify(nonce.body)}`);
  }
  const signature = await wallet.signMessage(nonce.body.message);
  const verified = await postJson("/auth/verify", { message: nonce.body.message, signature });
  const token = verified.body?.token ?? verified.body?.accessToken;
  if (verified.status !== 200 || !token) {
    throw new Error(`/auth/verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  }
  return token;
}

async function commandQuote(wallet, flags) {
  const token = await signIn(wallet);
  const definition = flags["definition-file"]
    ? JSON.parse(readFileSync(String(flags["definition-file"]), "utf8"))
    : {
      title: String(flags.title ?? "adversarial probe"),
      summary: String(flags.summary ?? "Adversarial protocol §1 — quote/funding boundary."),
      rewardUsdc: Number(flags.reward ?? 1),
      ...(flags.anchor ? { anchor: String(flags.anchor) } : {})
    };

  const result = await postJson("/jobs/draft", { definition }, token);
  console.log(JSON.stringify({ status: result.status, quote: result.body }, null, 2));
  if (result.status === 200) {
    const out = String(flags.out ?? "quote.json");
    writeFileSync(out, JSON.stringify(result.body, null, 2));
    console.error(`\nquote written to ${out}`);
  }
}

async function commandFund(wallet, flags) {
  const quote = JSON.parse(readFileSync(String(flags["quote-file"] ?? "quote.json"), "utf8"));
  const calldata = quote.calldata ?? quote.artifacts?.calldata;
  if (!calldata?.function || !Array.isArray(calldata.args)) {
    throw new Error("Quote has no calldata.function/args — cannot encode without drifting from the server.");
  }

  // Encoded from the quote's own signature, so this driver cannot disagree with
  // the server about the transaction shape.
  const iface = new Interface([`function ${calldata.function}`]);
  const name = calldata.function.slice(0, calldata.function.indexOf("("));
  const args = [...calldata.args];

  // §1.2/§1.3: deliberately break the binding between quote and on-chain terms.
  if (flags["reward-raw"]) {
    console.error(`MUTATING reward: ${args[2]} -> ${flags["reward-raw"]}`);
    args[2] = String(flags["reward-raw"]);
  }

  const data = iface.encodeFunctionData(name, args);
  const token = quote.definition?.rewardAsset ?? calldata.args[1];
  const required = BigInt(args[2]) + BigInt(args[3] ?? 0) + BigInt(args[4] ?? 0);

  console.log(JSON.stringify({
    wouldSend: { to: calldata.to, function: calldata.function, args },
    approve: { token, spender: calldata.to, amount: required.toString() },
    commit: Boolean(flags.commit)
  }, null, 2));

  if (!flags.commit) {
    console.error("\nDRY RUN — nothing sent. Re-run with --commit to execute.");
    return;
  }

  const erc20 = new Contract(token, ERC20, wallet);
  const allowance = await erc20.allowance(wallet.address, calldata.to);
  if (allowance < required) {
    const approval = await erc20.approve(calldata.to, required);
    console.error(`approve tx ${approval.hash}`);
    await approval.wait();
  }
  const tx = await wallet.sendTransaction({ to: calldata.to, data });
  console.error(`funding tx ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(JSON.stringify({ txHash: tx.hash, status: receipt.status, block: receipt.blockNumber }, null, 2));
}

const { command, flags } = parseArgs(process.argv.slice(2));
const provider = new JsonRpcProvider(RPC);
const wallet = await loadWallet(provider);
console.error(`poster ${wallet.address}\n`);

if (command === "quote") await commandQuote(wallet, flags);
else if (command === "fund") await commandFund(wallet, flags);
else {
  console.error("usage: run-adversarial-poster.mjs <quote|fund> [flags]  (see the header)");
  process.exit(1);
}
