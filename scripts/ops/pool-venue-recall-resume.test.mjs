import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAddress } from "ethers";
import * as driver from "./pool-venue-dispatch.mjs";

const source = readFileSync(new URL("./pool-venue-dispatch.mjs", import.meta.url), "utf8");
const REQUEST = `0x${"11".repeat(32)}`;
const LANE_REQUEST = `0x${"22".repeat(32)}`;
const ZERO32 = `0x${"00".repeat(32)}`;
const VENUE = "0xE2801E6C640e0180798912649fD567E1Ea459a35";
const LANE = "0x88eE70277E486136676c0b50Ed9b7D7A1a31371f";
const STRATEGY = "0x485944524154494f4e5f555344435f504f4c5f563100000000000000000000";
const SHARES = 4_450_000n;
const DISPATCH_REACHED = new Error("fixture reached pending-leg dispatch; no transaction sent");

function sourceBetween(text, start, end) {
  assert.equal(text.split(start).length, 2, `source anchor must occur exactly once: ${start}`);
  const offset = text.indexOf(start);
  const finish = text.indexOf(end, offset + start.length);
  assert.ok(finish > offset, `missing source end anchor: ${end}`);
  return text.slice(offset, finish);
}

function fixture({ bitmap = 4n, balance = 15_351n, commit = true, fresh = false, script = source } = {}) {
  const calls = { quotes: [], dispatch: [], history: 0 };
  const quote = { fillerType: "AAVE", assetIn: 1003, assetOut: 22, amountInRaw: SHARES, amountOutRaw: SHARES };
  const api = {
    rpc: { chain: {
      getHeader: async () => ({ number: { toNumber: () => 2 }, hash: { toHex: () => LANE_REQUEST } }),
      getBlockHash: async (number) => ({ toHex: () => `block-${number}` }),
    } },
    at: async (hash) => {
      calls.history += 1;
      return { query: {
        system: { events: async () => ({ toHuman: () => hash === "block-1" ? [{ event: {
          section: "broadcast", method: "Swapped3",
          data: { fillerType: "AAVE", operationStack: [{ Xcm: [LANE_REQUEST] }],
            inputs: [{ asset: "1003", amount: SHARES.toString() }],
            outputs: [{ asset: "22", amount: SHARES.toString() }] },
        } }] : [] }) },
        timestamp: { now: async () => 1_000 },
        tokens: { accounts: async () => ({ free: 1_546_105n }) },
      } };
    },
    query: { timestamp: { now: async () => 1_000 } },
    tx: { router: { sell: () => ({ method: { toHex: () => "0x1234" } }) } },
    call: { dryRunApi: { dryRunCall: async () => ({ toHuman: () => ({}) }) } },
    disconnect: async () => {},
  };
  // Execute the production quote body, substituting only its network import.
  // In particular, the supplied-account balance refusal is not mocked away.
  const quoteImport = '  const { ApiPromise, WsProvider } = await import("@polkadot/api");\n';
  const quoteSource = sourceBetween(script, "export async function captureParQuote(", "\nfunction extractForwardedXcms(");
  assert.equal(quoteSource.split(quoteImport).length, 2, "quote network-import seam must match exactly once");
  const captureQuote = new Function(
    "ApiPromise", "WsProvider", "extractAaveUnwindQuote", "assertParAaveUnwindQuote",
    `${quoteSource.replace("export ", "").replace(quoteImport, "")}\nreturn captureParQuote;`,
  )({ create: async () => api }, class {}, () => quote, driver.assertParAaveUnwindQuote);

  const request = { kind: 1, status: 1, requestedAssets: SHARES, settledAssets: 0n, returnBy: 2_000_000_000n, claimed: false };
  const record = { context: { strategyId: STRATEGY, kind: 1, account: VENUE, shares: SHARES }, queuedBy: LANE, status: 1 };
  const state = {
    block: { timestamp: 1_999_900_000 },
    pool: { activeVenueRecallId: 6n, recall: { status: 1, requestedAssets: SHARES, adapterRequestId: REQUEST } },
    venue: { request, activeRecallRequestId: REQUEST, laneRequestId: fresh ? ZERO32 : LANE_REQUEST,
      postage: { raw: 1_000_000_000n, asOf: "fixture" } },
    wrapper: { dispatchPaused: false },
    lane: { totalAssets: SHARES, totalShares: SHARES },
    farSide: { aUsdc: { raw: balance }, floatAsset22: { raw: 5_975_118n } },
  };
  const balanceReader = {
    getSubstrateApi: async () => api,
    read: async (target) => ({ raw: target === "float" ? 5_975_118n : 15_351n }),
    close: async () => {},
  };
  const bindings = {
    ...driver, getAddress, state, common: {}, requestId: REQUEST, recallId: 6n,
    venueAddress: VENUE, laneAddress: LANE, wrapperAddress: LANE, operatingLane: "excluded",
    convertedAccountId32: `0x${"33".repeat(32)}`, stateArgs: {}, balanceReader,
    args: { command: "stage-recall", commit, hydrationWs: "fixture://hydration", maxFeePerLeg: "80000" },
    EXPECTED_STRATEGY_ID: STRATEGY, ZERO32, ZERO_ADDRESS: `0x${"00".repeat(20)}`,
    normalizeBytes32: (value) => value.toLowerCase(),
    wrapper: { getRequest: async () => record, requestDispatchBitmap: async () => bitmap },
    venue: { poolRequestForLaneRequest: async () => REQUEST },
    manifest: { contracts: { token: LANE } },
    rpc: { provider: {} }, identity: { address: VENUE, signer: {} }, ERC20_ABI: [],
    Contract: class { async balanceOf() { return 0n; } },
    readState: async () => state,
    captureParQuote: async (...args) => { calls.quotes.push(args); return captureQuote(...args); },
    persistEvidence: async () => {}, console: { log() {} },
    makeRuntime: () => ({
      balanceReader, targets: { position: "position", float: "float" },
      dispatcher: { dispatch: async (input) => { calls.dispatch.push(input); throw DISPATCH_REACHED; } },
    }),
  };
  // Run the real CLI recall branch through the dispatch boundary, rather than
  // testing a parallel bitmap helper that could leave main() unreachable.
  const recallSource = sourceBetween(script, '    if (args.command === "stage-recall") {', "\n    const margin = assertDispatchMargin(");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = () => new AsyncFunction(...Object.keys(bindings), recallSource)(...Object.values(bindings));
  return { run, calls };
}

test("bitmap 4 recall with near-zero asset-1003 reaches only withdraw_home dispatch", async () => {
  const { run, calls } = fixture();
  await assert.rejects(run(), (error) => error === DISPATCH_REACHED);
  assert.deepEqual(calls.dispatch, [{ requestId: LANE_REQUEST, leg: "withdraw_home" }]);
  assert.equal(calls.quotes.length, 0);
  assert.ok(calls.history > 0);
});

test("bitmap 0 recall retains the exact staged-share par quote before withdraw_sell", async () => {
  const { run, calls } = fixture({ bitmap: 0n, balance: 4_465_335n });
  await assert.rejects(run(), (error) => error === DISPATCH_REACHED);
  assert.equal(calls.quotes.length, 1);
  assert.equal(calls.quotes[0][1], SHARES);
  assert.deepEqual(calls.quotes[0][2], {
    assetIn: 1003, assetOut: 22, quoteAccount: `0x${"33".repeat(32)}`, quoteAccountBalance: 4_465_335n,
  });
  assert.deepEqual(calls.dispatch, [{ requestId: LANE_REQUEST, leg: "withdraw_sell" }]);
});

test("bitmap 12 recall still refuses settle-only resume before quote or dispatch", async () => {
  const { run, calls } = fixture({ bitmap: 12n });
  await assert.rejects(run(), /settle-only resume is not implemented/u);
  assert.equal(calls.quotes.length, 0);
  assert.deepEqual(calls.dispatch, []);
});

test("pre-sell duplicate staging against a drained asset-1003 account still refuses", async () => {
  for (const fresh of [true, false]) {
    const { run, calls } = fixture({ fresh, bitmap: 0n });
    await assert.rejects(run(), /Supplied asset-1003 quote account cannot support the exact 4450000 read-only quote/u);
    assert.equal(calls.quotes.length, 1);
    assert.deepEqual(calls.dispatch, []);
  }
});

test("sell-done recall evidence records the request-bound executed swap instead of a live quote", async () => {
  const plan = await fixture({ commit: false }).run();
  assert.equal(plan.freshParUnwindQuote, null);
  assert.equal(plan.guards.freshExactAmountAaveParUnwindQuote, false);
  assert.equal(plan.executedUnwindSwap.resumedHistoricalLeg, true);
  assert.equal(plan.executedUnwindSwap.requestId, LANE_REQUEST);
  assert.equal(plan.executedUnwindSwap.blockNumber, 1);
  assert.equal(plan.executedUnwindSwap.event, "Swapped3");
  assert.equal(plan.executedUnwindSwap.assetIn, 1003);
  assert.equal(plan.executedUnwindSwap.assetOut, 22);
  assert.equal(plan.executedUnwindSwap.amountOutRaw, SHARES);
});
