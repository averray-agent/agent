import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Interface, encodeBytes32String } from "ethers";
import { XCM_WRAPPER_ABI, HYDRATION_USDC_ADAPTER_V22_ABI } from "../../mcp-server/src/blockchain/abis.js";
import { waitForTransaction } from "../../mcp-server/src/blockchain/transaction-wait.js";
import { parseArgs, main as dispatchMain, waitForAaveSwap, assertDispatchMargin } from "./pool-venue-dispatch.mjs";
import { assertFailedRecallPreserved, main as ceremonyMain } from "./pool-venue-ceremony.mjs";
import {
  SELL_NOT_EXECUTED, MAX_RECALL_ATTEMPTS, abandonUnexecutedSell,
  assertRecallAttemptBudget, classifyRecallSell, readRecallSellObservation,
} from "./recall-sell-unwind.mjs";

const REQUEST = "0x7fa1e25d6cdd02c9e70143fe9a53245ae83372b89b7d68a7fd6b2fe278ff1385";
const ACCOUNT = "0x48df881b65e682f05ac24dc8f668a8938225e973f6ebfce08cd5a3835491e7f3";
const HASH = "0x91d5129009b239390e529e4c678731ba4a19a0394684333600e73bfcad95b405";
const SHARES = 10_193_881n;
const BALANCE = 10_215_087n; // both views, Hydration 14870297, independently read
const LANE = "0x2E01Bff98adB023e4061044F8D1E2516151b3FB3";
const WRAPPER = `0x${"11".repeat(20)}`;
const SIGNER = `0x${"22".repeat(20)}`;
const TX = `0x${"33".repeat(32)}`;
const wrapperInterface = new Interface(XCM_WRAPPER_ABI);
const laneInterface = new Interface(HYDRATION_USDC_ADAPTER_V22_ABI);
const processed = (id = REQUEST) => ({ event: { section: "messageQueue", method: "Processed",
  data: { id, origin: { Sibling: "1,000" }, success: true, weightUsed: { refTime: "16,792,356,734", proofSize: "161,328" } } } });
const swapped = (id = REQUEST) => ({ event: { section: "broadcast", method: "Swapped3", data: {
  operationStack: [{ Xcm: [id] }], fillerType: "AAVE",
  inputs: [{ asset: "1003", amount: SHARES.toString() }], outputs: [{ asset: "22", amount: SHARES.toString() }],
} } });

function observationReader({ records = [processed()], evmRaw = BALANCE, substrateRaw = BALANCE, unreadableBlock,
  head = 3, messageCount = 0n, bookError = false, recordsByBlock } = {}) {
  const calls = [];
  const blockHash = (number) => number === head ? HASH : `0x${String(number).padStart(64, "0")}`;
  const api = {
    createType: (_type, value) => ({ toHex: () => value }),
    rpc: { chain: { getFinalizedHead: async () => ({ toHex: () => HASH }),
      getHeader: async (hash) => { assert.equal(hash, HASH); return { number: { toNumber: () => head } }; },
      getBlockHash: async (number) => ({ toHex: () => blockHash(number) }) } },
    at: async (hash) => ({
      call: { currenciesApi: { freeBalance: async (asset, account) => {
        calls.push(["substrate", hash, asset, account]); return substrateRaw;
      } } },
      query: { messageQueue: { bookStateFor: async (origin) => {
        calls.push(["book", hash, origin]);
        if (bookError) throw new Error("message queue read unavailable");
        return { messageCount };
      } }, system: { events: async () => {
        calls.push(["events", hash]);
        if (hash === blockHash(unreadableBlock)) throw new Error("pruned history");
        return { toHuman: () => recordsByBlock
          ? (Object.entries(recordsByBlock).find(([number]) => hash === blockHash(Number(number)))?.[1] ?? [])
          : hash === blockHash(2) ? records : [] };
      } } },
    }),
  };
  const provider = {
    getBlockNumber: async () => 102,
    getBlock: async () => ({ number: 101, hash: TX, timestamp: 2_000_000_000 }),
    getLogs: async (filter) => {
      assert.deepEqual(filter.topics, [wrapperInterface.getEvent("RequestLegDispatched").topicHash, REQUEST, `0x${"0".repeat(63)}2`]);
      return [{ address: WRAPPER, blockNumber: 101, blockHash: TX, transactionHash: TX,
        ...wrapperInterface.encodeEventLog(wrapperInterface.getEvent("RequestLegDispatched"), [REQUEST, 2, SIGNER, HASH, TX, 80_000n]) }];
    },
  };
  const positionTarget = { account: ACCOUNT, contract: "0x2ec4884088d84e5c2970a034732e5209b0acfa93" };
  const read = (options = {}) => readRecallSellObservation({ provider, wrapperAddress: WRAPPER, laneRequestId: REQUEST,
    fromHubBlock: 100, hydrationApi: api, positionTarget,
    balanceReader: { read: async (target, options) => {
      calls.push(["evm", target, options]); return { raw: evmRaw };
    } },
    historyRange: async (_api, timestamp) => { assert.equal(timestamp, 2_000_000_000); return { scan: { fromBlock: 1, toBlock: head + 1 } }; },
    ...options,
  });
  return { read, calls, provider, api };
}

test("D1: complete far-side fixtures classify executed-unobserved, not-executed, and unknown", async () => {
  const intact = observationReader();
  const observation = await intact.read();
  assert.equal(classifyRecallSell(observation, SHARES).verdict, "sell_not_executed");
  assert.equal(observation.scan.toBlock, 2, "scan stops at the successful processing block");
  assert.equal(intact.calls.filter(([kind]) => kind === "events").length, 2);
  assert.deepEqual(intact.calls.find(([kind]) => kind === "substrate"), ["substrate", HASH, 1003, ACCOUNT]);
  assert.deepEqual(intact.calls.find(([kind]) => kind === "evm")[2], { blockTag: 3 });
  const executed = await observationReader({ records: [processed(), swapped()], evmRaw: 21_206n, substrateRaw: 21_206n }).read();
  assert.equal(classifyRecallSell(executed, SHARES).verdict, "sell_executed_unobserved");
  const malformed = structuredClone(executed);
  malformed.swaps[0].data.inputs[0].amount = "schema changed";
  assert.equal(classifyRecallSell(malformed, SHARES).verdict, "unknown");
  for (const options of [
    { records: [] }, { records: [processed(TX)] }, { evmRaw: SHARES - 1n, substrateRaw: SHARES - 1n },
    { substrateRaw: BALANCE + 1n }, { unreadableBlock: 1 },
    { records: [processed(), { event: { section: "tokens", method: "Withdrawn", data: { currencyId: "1003", who: ACCOUNT, amount: "1" } } }] },
  ]) assert.equal(classifyRecallSell(await observationReader(options).read(), SHARES).verdict, "unknown");
  assert.equal(classifyRecallSell(await observationReader({ records: [processed(), swapped(TX)] }).read(), SHARES).verdict, "sell_not_executed", "unrelated swap is not request evidence");
});

test("processing proof: Processed plus same-block swap after it is executed-unobserved", async () => {
  const f = observationReader({ records: [processed(), swapped()], head: 10_500, unreadableBlock: 3 });
  const result = await f.read();
  assert.equal(classifyRecallSell(result, SHARES).verdict, "sell_executed_unobserved");
  assert.equal(result.scan.toBlock, 2);
  assert.equal(result.swaps.length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === "events").length, 2, "never scan the 10k-block tail");
});

test("processing proof: Processed without swap plus empty book and intact position is not-executed", async () => {
  const f = observationReader({ head: 10_500, unreadableBlock: 3 });
  const result = await f.read({ timeoutMs: 900_000 });
  assert.equal(classifyRecallSell(result, SHARES).verdict, "sell_not_executed");
  assert.equal(result.timeoutMs, 900_000);
  assert.equal(result.scan.stopReason, "successful_topic_processed");
  assert.deepEqual(result.scan.processingBlocks.map((block) => block.blockNumber), [2]);
  assert.deepEqual(f.calls.find(([kind]) => kind === "book"), ["book", HASH, { Sibling: 1000 }]);
  assert.ok(f.calls.findIndex(([kind]) => kind === "book") > f.calls.findLastIndex(([kind]) => kind === "events"));
  assert.deepEqual(f.calls.find(([kind]) => kind === "evm")[2], { blockTag: 10_500 });
});

test("processing proof: non-empty, unavailable, or malformed book is unknown", async () => {
  for (const options of [{ messageCount: 1n }, { bookError: true }, { messageCount: "wrong-shape" }]) {
    const result = await observationReader(options).read();
    assert.equal(classifyRecallSell(result, SHARES).verdict, "unknown");
  }
});

test("processing proof: earlier failed processing blocks also retain movement evidence", async () => {
  const failed = processed(); failed.event.data.success = false;
  const debit = { event: { section: "tokens", method: "Withdrawn", data: { currencyId: "1003", who: ACCOUNT, amount: "1" } } };
  const result = await observationReader({ recordsByBlock: { 1: [failed, debit], 2: [processed()] } }).read();
  assert.equal(classifyRecallSell(result, SHARES).verdict, "unknown");
  assert.deepEqual(result.scan.processingBlocks.map((block) => block.blockNumber), [1, 2]);
});

async function abandonFixture() {
  const observation = await observationReader().read();
  const before = { bitmap: 4n, wrapperRecord: { status: 1, context: { kind: 1, shares: SHARES } },
    laneRequest: { kind: 1, status: 1, settled: false, requestedShares: SHARES },
    pendingWithdrawalShares: SHARES, observation, totalAssets: SHARES, totalShares: SHARES };
  const after = structuredClone(before);
  Object.assign(after, { pendingWithdrawalShares: 0n, requiresRemoteRecovery: false, recoveryAssetsOutstanding: 0n });
  Object.assign(after.wrapperRecord, { status: 3, remoteRef: HASH, failureCode: SELL_NOT_EXECUTED });
  Object.assign(after.laneRequest, { status: 3, settled: true, settledAssets: 0n, settledShares: 0n, remoteRef: HASH, failureCode: SELL_NOT_EXECUTED });
  const sent = [], staticCalls = [], waits = [], logs = [];
  let never = false;
  const run = (commit = true) => abandonUnexecutedSell({ laneRequestId: REQUEST, laneAddress: LANE, commit,
    readFresh: async (options) => options?.postcondition ? after : before,
    provider: { call: async (tx) => { staticCalls.push(tx); } },
    signer: { address: SIGNER, sendTransaction: async (tx) => {
      sent.push(tx);
      return { hash: TX, nonce: 42, from: SIGNER, wait: async (...args) => {
        waits.push(args); return never ? new Promise(() => {}) : { status: 1, blockNumber: 123 };
      } };
    } },
    wait: (tx, options) => { assert.equal(options.stage, "recall.abandonUnexecutedSell"); return waitForTransaction(tx, { ...options, timeoutMs: 10 }); },
    emit: (record) => logs.push(record),
  });
  return { before, after, sent, staticCalls, waits, logs, run, hang: () => { never = true; } };
}

test("D2: abandon encodes Failed 0/0/0 against abis.js and never dispatches withdraw_home", async () => {
  const f = await abandonFixture();
  const preview = await f.run(false);
  assert.equal(f.sent.length, 0);
  assert.equal(preview.before.observation.position.evmRaw, BALANCE);
  const result = await f.run();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, LANE);
  assert.equal(f.sent[0].data, laneInterface.encodeFunctionData("settleRequest", [REQUEST, 3, 0, 0, 0, HASH, encodeBytes32String("SELL_NOT_EXECUTED")]));
  assert.equal(f.waits[0][0], 1);
  assert.ok(f.waits[0][1] > 0 && f.waits[0][1] <= 10);
  assert.ok(f.logs.some((record) => record.event === "tx_wait_completed"));
  assert.equal(result.after.totalAssets, f.before.totalAssets);
  assert.equal(result.after.totalShares, f.before.totalShares);
  assert.equal(result.after.pendingWithdrawalShares, 0n);
});

test("D2: every abandonment gate refuses before simulation or broadcast", async (t) => {
  const cases = {
    "bitmap zero": (b) => { b.bitmap = 0n; }, "bitmap twelve": (b) => { b.bitmap = 12n; },
    "wrapper not pending": (b) => { b.wrapperRecord.status = 3; },
    "not a withdrawal": (b) => { b.wrapperRecord.context.kind = 0; },
    "lane not pending": (b) => { b.laneRequest.status = 3; },
    "lane already settled": (b) => { b.laneRequest.settled = true; },
    "pending shares mismatch": (b) => { b.pendingWithdrawalShares--; },
    "requested shares mismatch": (b) => { b.laneRequest.requestedShares--; },
    "aUSDC one unit short": (b) => { b.observation.position.evmRaw = SHARES - 1n; b.observation.position.substrateRaw = SHARES - 1n; },
    "Substrate view disagrees": (b) => { b.observation.position.substrateRaw--; },
    "topic-bound Swapped3": (b) => { b.observation.swaps = [{ data: swapped().event.data }]; },
    "no Processed": (b) => { b.observation.processed = []; },
    "non-empty book": (b) => { b.observation.book.messageCount = 1n; },
    "wrong sibling": (b) => { b.observation.processed[0].sibling = 2000n; },
    "Processed unsuccessful": (b) => { b.observation.processed[0].success = false; },
    "incomplete history": (b) => { b.observation.scan.complete = false; },
    "read unavailable": (b) => { b.observation.errors = ["offline"]; },
    "unbound observation": (b) => { b.observation.laneRequestId = TX; },
    "missing observation hash": (b) => { b.observation.hydrationBlock.hash = undefined; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const f = await abandonFixture(); mutate(f.before);
    await assert.rejects(f.run());
    assert.equal(f.staticCalls.length, 0); assert.equal(f.sent.length, 0);
  });
});

test("D2: bounded wait retains the broadcast hash on timeout and never sends twice", async () => {
  const f = await abandonFixture(); f.hang();
  await assert.rejects(f.run(), (error) => error.code === "brokered_tx_timeout" && error.unwindEvidence.transaction.hash === TX);
  assert.equal(f.sent.length, 1);
  assert.ok(f.logs.some((record) => record.event === "recall_abandon_transaction" && record.txHash === TX));
});

test("D2: postconditions refuse hidden recovery or changed lane cost accounting", async () => {
  for (const field of ["pendingWithdrawalShares", "recoveryAssetsOutstanding", "totalAssets", "totalShares"]) {
    const f = await abandonFixture(); f.after[field]++;
    await assert.rejects(f.run(), /postcondition failed/u);
  }
  const f = await abandonFixture(); f.after.requiresRemoteRecovery = true;
  await assert.rejects(f.run(), /postcondition failed/u);
});

test("D4: three chain-derived attempts survive process restart; a fourth recall is refused", async () => {
  assert.equal(MAX_RECALL_ATTEMPTS, 3);
  const rows = [1n, 2n, 2n, 2n];
  const pool = { nextVenueRecallId: async () => BigInt(rows.length + 1), venueRecalls: async (id) => ({ deploymentId: rows[Number(id) - 1] }) };
  const current = await assertRecallAttemptBudget(pool, 2n, { currentRecallId: 4n });
  assert.equal(current.attempt, 3);
  await assert.rejects(assertRecallAttemptBudget(pool, 2n), /recall_retry_cap/u);
  await assert.rejects(assertRecallAttemptBudget({ ...pool }, 2n), /recall_retry_cap/u);
  rows.pop();
  assert.equal((await assertRecallAttemptBudget(pool, 2n)).attempt, 3);
});

test("D4 ruling B: nonzero min-out slack is refused by name before any RPC", async () => {
  for (const value of ["1", "-1", "1.5", "999999999"]) {
    assert.throws(() => parseArgs(["stage-recall", "--min-out-slack-raw", value]), /stageRecall requires minimumOutput == requestedAssets/u);
  }
  assert.equal(parseArgs(["stage-recall", "--min-out-slack-raw", "0"]).command, "stage-recall");
  await assert.rejects(dispatchMain(["stage-recall", "--min-out-slack-raw", "1"], {
    readDeploymentManifest: () => assert.fail("must not reach RPC setup"),
  }), /minimumOutput == requestedAssets/u);
});

function accounting() {
  const before = { activeVenueDeploymentId: 2n, activeVenueRecallId: 2n,
    venuePrincipalCostBasis: 10_193_881n, bufferAssets: 20_000_000n, totalAssets: 30_193_881n,
    venueDeployment: { id: 2n, principalAssets: 10_193_881n, recalledPrincipalAssets: 0n,
      writtenOffPrincipalAssets: 0n, returnBy: 1_790_135_406n, adapterRequestId: REQUEST, status: 2 } };
  const after = { ...structuredClone(before), activeVenueRecallId: 0n, venueRecall: { status: 3, returnedAssets: 0n } };
  return { before, after, events: [] };
}

test("D3: Failed recall clears only the recall and preserves deployment cost basis with zero returned", () => {
  assert.deepEqual(assertFailedRecallPreserved(accounting()), { deploymentId: 2n, beforeRaw: SHARES, afterRaw: SHARES, unchanged: true });
  for (const field of ["venuePrincipalCostBasis", "bufferAssets", "totalAssets", "activeVenueDeploymentId"]) {
    const f = accounting(); f.after[field]++; assert.throws(() => assertFailedRecallPreserved(f), /Failed recall postcondition/u);
  }
  for (const field of ["principalAssets", "recalledPrincipalAssets", "writtenOffPrincipalAssets"]) {
    const f = accounting(); f.after.venueDeployment[field]++; assert.throws(() => assertFailedRecallPreserved(f), /Failed recall postcondition/u);
  }
  const f = accounting(); f.events.push({ name: "VenueLossWrittenOff" });
  assert.throws(() => assertFailedRecallPreserved(f), /no write-off/u);
});

const manifest = JSON.parse(readFileSync(new URL("../../deployments/mainnet.json", import.meta.url)));
const POOL = manifest.contracts.depositPoolV21;
const VENUE = manifest.contracts.hydrationDepositPoolAdapterV21;
const POOL_REQUEST = "0x78db2e491eaf3d0310df7aabbcdcf9abdebccf19ff9e71ef748a7c274b99c31d";
const ZERO32 = `0x${"00".repeat(32)}`;
const NOW = 2_000_000_000;
const STRATEGY = encodeBytes32String("AAC_IDLE_HYDRATION_V1");

async function commandFixture({ expired = false, attempts = 1, liveFailure = false, remaining = 100000, observation: suppliedObservation } = {}) {
  const observation = suppliedObservation ?? await observationReader().read();
  let settled = false;
  let poolSettled = false;
  let bitmap = liveFailure ? 0n : 4n;
  const sent = [], evidence = [], calls = [];
  const wrapperRecord = () => ({ status: settled ? 3 : 1, context: { kind: 1, shares: SHARES, strategyId: STRATEGY, account: VENUE },
    queuedBy: LANE, createdAt: BigInt(NOW), remoteRef: HASH, failureCode: SELL_NOT_EXECUTED });
  const pool = {
    asset: async () => manifest.contracts.token, operator: async () => manifest.verifier, venueAdapter: async () => VENUE,
    bufferAssets: async () => 20_000_000n, totalAssets: async () => 20_000_000n + SHARES, venuePrincipalCostBasis: async () => SHARES,
    totalSupply: async () => 20_000_000n + SHARES, bufferFloor: async () => 1_000_000n,
    TOTAL_ASSET_CAP: async () => 100_000_000n, PER_AGENT_ASSET_CAP: async () => 50_000_000n, NOTICE_7_DAYS: async () => 604800n,
    nextRedeemRequestId: async () => 1n, nextVenueDeploymentId: async () => 3n, nextVenueRecallId: async () => BigInt(attempts + 2),
    activeVenueDeploymentId: async () => 2n, activeVenueRecallId: async () => poolSettled ? 0n : 2n,
    venueWrittenOffPrincipalAssets: async () => 0n,
    venueDeployments: async () => ({ principalAssets: SHARES, recalledPrincipalAssets: 0n, returnBy: BigInt(NOW + 100000), adapterRequestId: TX, status: 2 }),
    venueRecalls: async (id) => ({ deploymentId: id === 1n ? 1n : 2n, requestedAssets: SHARES, returnedAssets: 0n,
      adapterRequestId: POOL_REQUEST, status: poolSettled ? 3 : 1 }),
    getFunction: (name) => ({ staticCall: async () => { calls.push(name); assert.equal(name, "settleVenueRecall"); return [3, 0n]; } }),
  };
  const venue = {
    pool: async () => POOL, lane: async () => LANE, activeDeployRequestId: async () => ZERO32,
    activeRecallRequestId: async () => POOL_REQUEST, reservedDeployAssets: async () => 0n,
    getRequest: async () => ({ kind: 1, status: 1, requestedAssets: SHARES, returnBy: BigInt(NOW + (expired ? -1 : remaining)), claimed: false }),
    poolRequestForLaneRequest: async () => POOL_REQUEST,
  };
  const lane = {
    strategyId: async () => STRATEGY, asset: async () => manifest.contracts.token,
    agentAccountCore: async () => VENUE, xcmWrapper: async () => manifest.contracts.xcmWrapper,
    totalAssets: async () => SHARES, totalShares: async () => SHARES, pendingDepositAssets: async () => 0n,
    pendingWithdrawalShares: async () => settled ? 0n : SHARES,
    requiresRemoteRecovery: async () => false, recoveryAssetsOutstanding: async () => 0n,
    getAdapterRequest: async () => ({ kind: 1, status: settled ? 3 : 1, settled, requestedShares: SHARES,
      account: VENUE, recipient: VENUE, requester: VENUE, settledAssets: 0n, settledShares: 0n,
      remoteRef: HASH, failureCode: SELL_NOT_EXECUTED }),
  };
  const wrapper = {
    dispatchPaused: async () => expired, operator: async () => manifest.verifier,
    getRequest: async () => wrapperRecord(), requestDispatchBitmap: async () => bitmap, getRequestParameters: async () => ({}),
  };
  const stagedInterface = new Interface(["event LaneRequestStaged(bytes32 indexed requestId,bytes32 indexed laneRequestId,uint256 laneShares)"]);
  const poolInterface = new Interface(["function settleVenueRecall(uint256)", "event VenueRecallSettled(uint256 indexed recallId,uint256 indexed deploymentId,uint8 status,uint256 returnedAssets)"]);
  const receipt = { status: 1, blockNumber: 124, blockHash: TX, gasUsed: 1n,
    logs: [{ address: POOL, ...poolInterface.encodeEventLog(poolInterface.getEvent("VenueRecallSettled"), [2, 2, 3, 0]) }] };
  const provider = { getBlockNumber: async () => 123, getBlock: async () => ({ number: 123, hash: HASH, timestamp: NOW }),
    getLogs: async () => [{ address: VENUE, ...stagedInterface.encodeEventLog(stagedInterface.getEvent("LaneRequestStaged"), [POOL_REQUEST, REQUEST, SHARES]) }],
    call: async (tx) => { calls.push(tx); return "0x"; } };
  const signer = { sendTransaction: async (tx) => {
    sent.push(tx);
    if (tx.to === LANE) { settled = true; } else {
      assert.equal(tx.to, POOL); assert.equal(tx.data, poolInterface.encodeFunctionData("settleVenueRecall", [2])); poolSettled = true;
    }
    return { hash: TX, from: manifest.verifier, nonce: 42, wait: async () => receipt };
  } };
  const io = {
    readDeploymentManifest: async () => ({ ...manifest, deploymentBlocks: { ...manifest.deploymentBlocks, hydrationDepositPoolAdapterV21: 123 } }),
    createCeremonyRpcContext: async () => ({ provider, chainId: 420420419, selectedUrl: "fixture" }),
    resolveSigner: async () => ({ address: manifest.verifier, signer, backend: "fixture" }),
    Contract: class { constructor(address) {
      const result = new Map([[POOL, pool], [VENUE, venue], [LANE, lane], [manifest.contracts.xcmWrapper, wrapper],
        [manifest.contracts.token, { balanceOf: async () => 0n }]]).get(address);
      assert.ok(result, `Unexpected contract ${address}`); return result;
    } },
    VenueBalanceReader: class {
      async read(target) { return { raw: target.ledger === "substrate_system" ? 1_000_000_000n : BALANCE }; }
      async getSubstrateApi() { return { rpc: { chain: {
        getHeader: async () => ({ number: { toNumber: () => 1 } }), getBlockHash: async () => ({ toHex: () => HASH }),
      } }, at: async () => ({ query: { timestamp: { now: async () => BigInt(NOW * 1000) }, system: { events: async () => ({ toHuman: () => [] }) } } }) }; }
      async close() {}
    },
    fetchJson: async () => ({ available: true, pool: POOL, reconciled: true, flows: { status: "ok" }, block: { timestamp: NOW } }),
    readRecallSellObservation: async (options) => { calls.push("fresh-observation", { observationTimeoutMs: options.timeoutMs }); return observation; },
    captureParQuote: async () => ({ quote: { fillerType: "AAVE", assetIn: 1003, assetOut: 22, amountInRaw: SHARES, amountOutRaw: SHARES } }),
    waitForAaveSwap: (api, options) => waitForAaveSwap(api, { ...options, attempts: 0 }),
    persistEvidence: async (_args, record) => { evidence.push(record); },
    makeRuntime: () => {
      assert.equal(liveFailure, true, "abandon/failed historical recovery must never enter the dispatcher");
      return {
        balanceReader: { getSubstrateApi: async () => ({ rpc: { chain: { getHeader: async () => ({ number: { toNumber: () => 1 } }) } } }), close: async () => {} },
        dispatcher: { dispatch: async ({ leg }) => { calls.push(leg); assert.equal(leg, "withdraw_sell"); bitmap = 4n; return {}; } },
      };
    },
    confirmCanonicalPostState: async ({ readPostState }) => ({ receipt, block: { number: 124, hash: TX, timestamp: NOW },
      postState: await readPostState(124), confirmations: 12, receiptChecks: 1, reorgs: 0 }),
  };
  const common = ["--profile", "mainnet", "--pool", POOL, "--expected-signer", manifest.verifier];
  const run = (abandon = true, commit = false, extra = []) => dispatchMain(["stage-recall", ...common, "--request-id", POOL_REQUEST,
    "--recall-id", "2", "--observability-url", "http://fixture.invalid", "--asset-hub-ws", "wss://fixture.invalid",
    "--hydration-ws", "wss://fixture.invalid", ...(abandon ? ["--abandon-unexecuted-sell"] : []),
    ...(commit ? ["--commit", "--use-kms"] : []), ...extra], io);
  const settle = () => ceremonyMain(["settle", ...common, "--recall-id", "2", "--commit", "--use-kms"], io);
  const recall = () => ceremonyMain(["recall", ...common, "--deployment-id", "2", "--assets", String(SHARES), "--commit", "--use-kms"], io);
  return { run, settle, recall, pool, lane, wrapper, sent, evidence, calls, observation, clearPoolRecall: () => { poolSettled = true; } };
}

test("D2 CLI: abandonment re-reads gates, works past the dispatch deadline, and never enters the dispatcher", async (t) => {
  t.mock.method(console, "log", () => {});
  const c = await commandFixture({ expired: true });
  assert.equal((await c.run()).unwind.preflight, "success");
  assert.equal(c.sent.length, 0);
  const result = await c.run(true, true);
  assert.equal(result.unwind.after.pendingWithdrawalShares, 0n);
  assert.equal(result.unwind.before.observation.position.evmRaw, BALANCE);
  assert.equal(c.sent.length, 1);
  assert.equal(c.calls.filter((call) => call === "fresh-observation").length, 2);
  const changed = await commandFixture();
  const read = changed.wrapper.requestDispatchBitmap;
  let reads = 0;
  changed.wrapper.requestDispatchBitmap = async () => ++reads === 1 ? read() : 12n;
  await assert.rejects(changed.run(true, true), /bitmap exactly 4/u);
  assert.equal(changed.sent.length, 0);
  assert.ok(changed.evidence.at(-1).unwind.before);
});

test("D1 CLI: missing historical swap records each far-side verdict and the next safe command", async (t) => {
  t.mock.method(console, "log", () => {}); t.mock.method(console, "error", () => {});
  for (const [options, verdict] of [[{}, "sell_not_executed"], [{ records: [processed(), swapped()] }, "sell_executed_unobserved"], [{ unreadableBlock: 1 }, "unknown"]]) {
    const observation = await observationReader(options).read();
    const c = await commandFixture({ observation });
    await assert.rejects(c.run(false, true), /without request-bound Broadcast.Swapped/u);
    const report = c.evidence.at(-1);
    assert.equal(report.classification.verdict, verdict);
    assert.match(report.nextCommand, verdict === "unknown" ? / status /u : / stage-recall /u);
    assert.equal(report.nextCommand.includes("--abandon-unexecuted-sell"), verdict === "sell_not_executed");
    assert.ok(!report.nextCommand.includes("--commit")); assert.equal(c.sent.length, 0);
  }
});

test("D1 CLI: live sell wait timeout persists classification without dispatching home", async (t) => {
  t.mock.method(console, "log", () => {}); t.mock.method(console, "error", () => {});
  const c = await commandFixture({ liveFailure: true });
  await assert.rejects(c.run(false, true), (error) => error.code === "recall_swap_observation_failed");
  assert.equal(c.evidence.at(-1).classification.verdict, "sell_not_executed");
  assert.equal(c.calls.filter((call) => call === "withdraw_sell").length, 1);
  assert.ok(!c.calls.includes("withdraw_home")); assert.equal(c.sent.length, 0);
});

test("D3 CLI: settle sends only settleVenueRecall and prints equal deployment cost basis", async (t) => {
  t.mock.method(console, "log", () => {});
  const c = await commandFixture();
  const result = await c.settle();
  assert.deepEqual(result.postcondition.failedRecallCostBasis, { deploymentId: 2n, beforeRaw: SHARES, afterRaw: SHARES, unchanged: true });
  assert.equal(result.postState.activeVenueRecallId, 0n); assert.equal(result.postState.activeVenueDeploymentId, 2n);
  assert.equal(c.sent.length, 1); assert.equal(c.calls.filter((call) => typeof call === "string").join(), "settleVenueRecall");
});

test("D4 CLI: both recall creation and staging enforce the chain-derived cap before signing", async (t) => {
  t.mock.method(console, "log", () => {});
  const stage = await commandFixture({ attempts: 4 });
  await assert.rejects(stage.run(false, true), /recall_retry_cap/u); assert.equal(stage.sent.length, 0);
  const create = await commandFixture({ attempts: 3 }); create.clearPoolRecall();
  await assert.rejects(create.recall(), /recall_retry_cap/u); assert.equal(create.sent.length, 0);
});

test("CLI observation timeout defaults to 180000 and the override reaches the reader and record", async (t) => {
  t.mock.method(console, "log", () => {});
  assert.equal(parseArgs(["stage-recall"]).observationTimeoutMs, 180_000);
  for (const value of ["0", "-1", "NaN", "1.5", "2147483648"]) {
    assert.throws(() => parseArgs(["stage-recall", "--observation-timeout-ms", value]), /observation-timeout-ms/u);
  }
  const c = await commandFixture();
  const result = await c.run(true, false, ["--observation-timeout-ms", "900000"]);
  assert.equal(result.observationTimeoutMs, 900_000);
  assert.ok(c.calls.some((call) => call?.observationTimeoutMs === 900_000));
});

test("recall margin override below 3600 is refused; default remains six hours and deploy cannot override", () => {
  for (const value of ["3599", "0", "-1", "3600.5", "NaN"]) {
    assert.throws(() => parseArgs(["stage-recall", "--dispatch-margin-seconds", value]), /at least 3600/u);
  }
  assert.throws(() => parseArgs(["stage-dispatch", "--dispatch-margin-seconds", "3600"]), /only allowed for stage-recall/u);
  assert.throws(() => assertDispatchMargin({ nowSeconds: NOW, returnBy: NOW + 7200 }), /21600/u);
  assert.equal(assertDispatchMargin({ nowSeconds: NOW, returnBy: NOW + 3600, minimumMarginSeconds: 3600 }), 3600n);
  assert.throws(() => assertDispatchMargin({ nowSeconds: NOW, returnBy: NOW + 3599, minimumMarginSeconds: 3600 }), /at least 3600/u);
});

test("CLI recall margin override is used at preflight and commit and recorded", async (t) => {
  t.mock.method(console, "log", () => {}); t.mock.method(console, "error", () => {});
  const defaults = await commandFixture({ liveFailure: true, remaining: 7200 });
  await assert.rejects(defaults.run(false, true), /21600/u);
  assert.ok(!defaults.calls.includes("withdraw_sell"));
  const overridden = await commandFixture({ liveFailure: true, remaining: 7200 });
  await assert.rejects(overridden.run(false, true, ["--dispatch-margin-seconds", "3600"]), (error) => error.code === "recall_swap_observation_failed");
  assert.ok(overridden.calls.includes("withdraw_sell"), "both preflight and commit admitted the explicit margin");
  assert.deepEqual(overridden.evidence.at(-1).dispatchMargin, { seconds: 3600, defaultSeconds: 21600, override: true });
});
