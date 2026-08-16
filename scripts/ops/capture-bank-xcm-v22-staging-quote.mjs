#!/usr/bin/env node

/**
 * Read-only Hydration quote for the v2.2 dust-deposit staging packet.
 *
 * It dry-runs the exact Aave Router.sell route against current state using a
 * known funded, stranded rehearsal account. No signature or state write occurs.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_ENDPOINT = "wss://hydration-rpc.n.dwellir.com";
const DEFAULT_QUOTE_ACCOUNT = "0x089a0a57d001bacb8473161e007f0babc1768ceeeeeeeeeeeeeeeeeeeeeeeeee";

function parseArgs(argv) {
  const args = { endpoint: DEFAULT_ENDPOINT, quoteAccount: DEFAULT_QUOTE_ACCOUNT, sellAmount: "100000" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--endpoint") args.endpoint = argv[++index];
    else if (token === "--quote-account") args.quoteAccount = argv[++index];
    else if (token === "--sell-amount") args.sellAmount = argv[++index];
    else if (token === "--out") args.out = argv[++index];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function raw(value) {
  return BigInt(String(value ?? "-1").replaceAll(",", ""));
}

// The AAVE filler's par law is SYMMETRIC and index-relative (measured live
// 2026-08-14 exit / 2026-08-16 entry): router.Executed carries the exact
// requested input while Broadcast.Swapped carries input === output grossed up
// by interest accrued since the last index touch (entry 4,910,000 → event
// 4,910,004/4,910,004). Par therefore holds at the filler level; both event
// amounts may exceed the requested input by a small bounded accrual. Real
// accrual at our sizes is single-digit-to-tens of raw units; anything near
// this ceiling is a pricing fault, not yield.
export function parAccrualCeiling(expectedInput) {
  const expected = BigInt(expectedInput);
  if (expected <= 0n) throw new Error("par accrual ceiling requires a positive expected input");
  return expected / 1000n + 16n;
}

export function extractAaveQuote(human, expectedInput) {
  if (!human?.Ok?.executionResult?.Ok) throw new Error("Hydration Router.sell dry-run did not execute successfully.");
  const event = (human.Ok.emittedEvents ?? []).find((entry) =>
    String(entry.section).toLowerCase() === "broadcast" &&
    /^Swapped/u.test(String(entry.method)) &&
    entry.data?.fillerType === "AAVE"
  );
  const input = event?.data?.inputs?.find((entry) => raw(entry.asset) === 22n);
  const output = event?.data?.outputs?.find((entry) => raw(entry.asset) === 1003n);
  const inputRaw = raw(input?.amount ?? -1);
  const outputRaw = raw(output?.amount ?? -1);
  if (
    !event || inputRaw !== outputRaw || inputRaw < BigInt(expectedInput)
    || inputRaw - BigInt(expectedInput) > parAccrualCeiling(expectedInput)
  ) {
    throw new Error("Hydration quote omitted a filler-par, accrual-bounded Broadcast.Swapped{AAVE,22→1003} event.");
  }
  return {
    runtimeEvent: event.method,
    fillerType: "AAVE",
    assetIn: 22,
    assetOut: 1003,
    amountInRaw: inputRaw.toString(),
    amountOutRaw: outputRaw.toString(),
    entryAccrualRaw: (inputRaw - BigInt(expectedInput)).toString()
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: capture-bank-xcm-v22-staging-quote.mjs --out FILE [--sell-amount 100000]");
    return;
  }
  if (!args.out) throw new Error("--out is required (create-only evidence file).");
  const sellAmount = BigInt(args.sellAmount);
  if (sellAmount <= 0n) throw new Error("--sell-amount must be positive.");
  if (!/^0x[0-9a-f]{64}$/iu.test(args.quoteAccount)) throw new Error("--quote-account must be AccountId32.");

  const { ApiPromise, WsProvider } = await import("@polkadot/api");
  const api = await ApiPromise.create({ provider: new WsProvider(args.endpoint, 5_000), noInitWarn: true, throwOnConnect: true });
  try {
    const call = api.tx.router.sell(22, 1003, sellAmount, 1n, [{ pool: "Aave", assetIn: 22, assetOut: 1003 }]);
    const [chain, header, result] = await Promise.all([
      api.rpc.system.chain(),
      api.rpc.chain.getHeader(),
      api.call.dryRunApi.dryRunCall({ system: { signed: args.quoteAccount } }, call, 5)
    ]);
    if (chain.toString() !== "Hydration") throw new Error(`quote endpoint is ${chain.toString()}, expected Hydration.`);
    const quote = extractAaveQuote(result.toHuman(), sellAmount);
    const evidence = {
      schemaVersion: 1,
      kind: "averray.bankXcmV22StagingQuote",
      profile: "mainnet",
      liveState: true,
      capturedAt: new Date().toISOString(),
      endpoint: args.endpoint,
      chain: chain.toString(),
      blockNumber: header.number.toNumber(),
      quoteAccountId32: args.quoteAccount.toLowerCase(),
      routerCall: call.method.toHex(),
      quote
    };
    await writeFile(resolve(args.out), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify(evidence, null, 2));
    return evidence;
  } finally {
    await api.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`capture-bank-xcm-v22-staging-quote failed: ${error.message}`);
    process.exitCode = 1;
  });
}
