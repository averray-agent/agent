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
const AAC = ["function deposit(address asset, uint256 amount)",
             "function positions(address account, address asset) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)"];

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
  // 1Password keeps whatever was pasted, so accept a bare 32-byte hex key as well
  // as the 0x-prefixed form. The construction is guarded because ethers puts the
  // OFFENDING VALUE in its error — and here that value is the private key, which
  // would then be printed by an unhandled rejection.
  const raw = stdout.trim();
  try {
    return new Wallet(raw.startsWith("0x") ? raw : `0x${raw}`, provider);
  } catch {
    throw new Error(`${ref} is not a valid private key (32 bytes of hex, with or without 0x).`);
  }
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

  // Funding is THREE transactions, not one, and the middle one is easy to miss:
  // the poster reserve is spent from the poster's own AgentAccountCore position,
  // so USDC has to be deposited INTO AAC first. Approving EscrowCore instead —
  // the obvious-looking move, and this driver's original bug — silently funds
  // nothing. Addresses and formulas come from the live /poster/onboarding
  // contract rather than constants here, for the same reason the calldata is
  // encoded from the quote: the server is the authority, not this file.
  const onboarding = await (await fetch(`${API}/poster/onboarding`)).json();
  const aac = onboarding.agentAccountCore;
  const token = onboarding.token?.address;
  if (!aac || !token) throw new Error("/poster/onboarding did not report agentAccountCore + token.");

  const required = BigInt(quote.fundingRequirement?.posterReservedRaw ?? args[2]);
  const aacContract = new Contract(aac, AAC, wallet);
  const [liquid] = await aacContract.positions(wallet.address, token);
  const owed = required > liquid ? required - liquid : 0n;
  // §1.3: deposit LESS than the quote demands, on purpose. The question under
  // test is what a poster who underpays actually experiences — a clean refusal
  // with their money still withdrawable, or silence with the funds stuck.
  const deposit = flags["deposit-raw"] === undefined ? owed : BigInt(flags["deposit-raw"]);

  const erc20 = new Contract(token, ERC20, wallet);
  const held = await erc20.balanceOf(wallet.address);

  console.log(JSON.stringify({
    posterReservedRaw: required.toString(),
    aacLiquidRaw: liquid.toString(),
    depositOwedRaw: owed.toString(),
    depositSendingRaw: deposit.toString(),
    underfundedBy: deposit < owed ? (owed - deposit).toString() : "0",
    walletUsdcRaw: held.toString(),
    sufficient: held >= deposit,
    steps: [
      deposit > 0n ? { step: "approve", to: token, spender: aac, amount: deposit.toString() } : { step: "approve", skipped: "deposit is 0" },
      deposit > 0n ? { step: "deposit", to: aac, asset: token, amount: deposit.toString() } : { step: "deposit", skipped: "deposit is 0" },
      { step: "createSinglePayoutJob", to: calldata.to, function: calldata.function, args }
    ],
    commit: Boolean(flags.commit)
  }, null, 2));

  if (!flags.commit) {
    console.error("\nDRY RUN — nothing sent. Re-run with --commit to execute.");
    return;
  }
  if (held < deposit) {
    throw new Error(`Wallet holds ${held} raw USDC but needs ${deposit} to deposit. Refusing to send a partial funding sequence.`);
  }

  if (deposit > 0n) {
    const allowance = await erc20.allowance(wallet.address, aac);
    if (allowance < deposit) {
      const approval = await erc20.approve(aac, deposit);
      console.error(`approve tx ${approval.hash}`);
      await approval.wait();
    }
    const deposited = await aacContract.deposit(token, deposit);
    console.error(`deposit tx ${deposited.hash}`);
    await deposited.wait();
  }

  const tx = await wallet.sendTransaction({ to: calldata.to, data });
  console.error(`funding tx ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(JSON.stringify({ txHash: tx.hash, status: receipt.status, block: receipt.blockNumber }, null, 2));
}

/**
 * Poll the quote until the watcher materialises it. The draft is the only place
 * the transition is visible: on-chain funding succeeding does NOT mean the job
 * is live, and the gap between the two is exactly where a poster is left
 * guessing.
 */
async function commandStatus(wallet, flags) {
  // --draft-id probes an arbitrary id (ownership / existence-oracle testing);
  // otherwise the id comes from a quote this poster actually holds.
  const quote = flags["draft-id"]
    ? { draftId: String(flags["draft-id"]) }
    : JSON.parse(readFileSync(String(flags["quote-file"] ?? "quote.json"), "utf8"));
  const token = await signIn(wallet);
  const attempts = Number(flags.attempts ?? 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(`${API}/jobs/draft/${quote.draftId}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = await response.json().catch(() => ({}));
    console.log(JSON.stringify({
      attempt,
      http: response.status,
      status: body?.status ?? null,
      fundingStatus: body?.fundingStatus ?? null,
      jobId: body?.jobId ?? null,
      catalogJobId: body?.catalogJobId ?? body?.job?.id ?? null,
      note: body?.note ?? body?.error ?? null
    }));
    if (body?.status === "live" || attempt === attempts) return;
    await new Promise((resolve) => setTimeout(resolve, Number(flags["interval-ms"] ?? 15_000)));
  }
}

const { command, flags } = parseArgs(process.argv.slice(2));
const provider = new JsonRpcProvider(RPC);
const wallet = await loadWallet(provider);
console.error(`poster ${wallet.address}\n`);

if (command === "quote") await commandQuote(wallet, flags);
else if (command === "fund") await commandFund(wallet, flags);
else if (command === "status") await commandStatus(wallet, flags);
else {
  console.error("usage: run-adversarial-poster.mjs <quote|fund|status> [flags]  (see the header)");
  process.exit(1);
}
