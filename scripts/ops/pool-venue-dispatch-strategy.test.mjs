import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AbiCoder, Interface, ZeroAddress, ZeroHash, encodeBytes32String, keccak256 } from "ethers";
import { XCM_WRAPPER_ABI } from "../../mcp-server/src/blockchain/abis.js";
import {
  main, runCli, recoverHistoricalDepositSwap, RECALL_HISTORY_TIMEOUT_MS, MAX_RECALL_HISTORY_BLOCKS,
  dryRunStageAndFunding, dryRunStageAndRecallSell, deriveLaneRequestId, deriveLaneRecallRequestId,
  assertStagedDeployBinding, assertStagedRecallBinding, readStagedLaneEvent,
} from "./pool-venue-dispatch.mjs";

const manifest = JSON.parse(readFileSync(new URL("../../deployments/mainnet.json", import.meta.url)));
const REQUEST = `0x${"11".repeat(32)}`;
const GARBAGE = `0x${"ff".repeat(32)}`;
const ACCOUNT = manifest.bankXcmV2Deployment.convertedAccountId32.toLowerCase();
const NOW = 2_000_000_000;
const ASSETS = 2_000_000n;
const SELL = ASSETS - 50_000n;
const LEGACY = encodeBytes32String("HYDRATION_USDC_POOL_V1");
const CURRENT = encodeBytes32String("AAC_IDLE_HYDRATION_V1");
const wrapperInterface = new Interface(XCM_WRAPPER_ABI);
const venueInterface = new Interface([
  "event LaneRequestStaged(bytes32 indexed requestId,bytes32 indexed laneRequestId,uint256 laneShares)",
  "function stageDeploy(bytes32,(uint256 sellAmount,uint256 minimumOutput,uint256 maxFeePerLeg,uint64 dispatchDeadline,uint64 nonce))",
]);
const parameters = { sellAmount: SELL, minimumOutput: SELL, maxFeePerLeg: 40_000n, dispatchDeadline: BigInt(NOW + 604_800), nonce: 1n };
const hex = (value) => ({ toHex: () => value });

// Independent copy of the PRE-FIX contract encoding, with strategy as an
// explicit fixture input. Never calls the predictor being mutated in a drill.
function contractRequestId(strategyId, venue, kind = 0) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint8", "address", "address", "address", "uint256", "uint256", "uint64"],
    [strategyId, kind, venue, manifest.contracts.token, venue, kind === 0 ? ASSETS : 0n, kind === 1 ? ASSETS : 0n, 1n],
  ));
}

function fixture({ legacy = false, recall = false } = {}) {
  const pool = manifest.contracts[legacy ? "legacyDepositPoolV2" : "depositPoolV21"];
  const venue = manifest.contracts[legacy ? "hydrationDepositPoolAdapterV2" : "hydrationDepositPoolAdapterV21"];
  const lane = manifest.contracts[legacy ? "depositPoolLaneV2" : "depositPoolLaneV21"];
  const strategyId = legacy ? LEGACY : CURRENT;
  const kind = recall ? 1 : 0;
  const laneId = contractRequestId(strategyId, venue, kind);
  const wrapper = manifest.contracts.xcmWrapper;
  const eventLog = (address, iface, event, args) => ({ address, ...iface.encodeEventLog(iface.getEvent(event), args) });
  const stagedLog = eventLog(venue, venueInterface, "LaneRequestStaged", [REQUEST, laneId, recall ? ASSETS : 0n]);
  const logs = [
    stagedLog,
    eventLog(wrapper, wrapperInterface, "RequestQueued", [laneId, strategyId, kind, venue, manifest.contracts.token, venue, recall ? 0n : ASSETS, recall ? ASSETS : 0n, 1n]),
  ];
  return { pool, venue, lane, strategyId, laneId, wrapper, logs, stagedLog, recall };
}

// These are the runtime's actual ContractEmitted codec fields, not a predicted
// identity returned by a fake stage function. Exercise the public helper's
// stage-only → decode → batch → forwarded-wire → Hydration deposit path.
function dryRunApi(f, { missingEvent = false, differentReplay = false, badExecution = false, paraId = 2034 } = {}) {
  const calls = [];
  const batches = [];
  const wire = `0x05002c${f.laneId.slice(2)}`;
  const emittedEvents = f.logs.map((log) => ({ section: "revive", method: "ContractEmitted",
    data: { contract: log.address, data: hex(log.data), topics: log.topics.map(hex) } }));
  const head = { number: { toNumber: () => 123 }, hash: hex(ZeroHash) };
  const hub = {
    tx: {
      revive: { call: (...args) => ({ args }) },
      utility: { batchAll: (entries) => { batches.push(entries); return { entries, method: hex("0x1234") }; } },
    },
    rpc: { chain: { getHeader: async () => head } },
    query: { timestamp: { now: async () => BigInt(NOW * 1000) } },
    call: {
      reviveApi: { accountId: async () => hex(ACCOUNT) },
      dryRunApi: { dryRunCall: async (_origin, call) => {
        calls.push(call);
        const events = missingEvent ? [] : emittedEvents;
        return {
          isOk: true, asOk: { emittedEvents: differentReplay && call.entries ? [] : events },
          toHuman: () => ({}),
          toJSON: () => ({ ok: { executionResult: badExecution ? { err: "ContractReverted" } : { ok: {} },
            forwardedXcms: [[{ v5: { interior: { x1: [{ parachain: paraId }] } } }, [{ v5: [] }]]] } }),
        };
      } },
    },
    createType: (type) => { assert.equal(type, "XcmVersionedXcm"); return hex(wire); },
    disconnect: async () => {},
  };
  const hydration = {
    call: { dryRunApi: { dryRunXcm: async (_origin, receivedWire) => {
      assert.equal(receivedWire, wire);
      return { toJSON: () => ({ ok: { executionResult: { complete: {} } } }),
        toHuman: () => ({ Ok: { emittedEvents: f.recall
          ? [{ section: "broadcast", method: "Swapped3", data: { fillerType: "AAVE", inputs: [{ asset: "1003", amount: String(ASSETS) }], outputs: [{ asset: "22", amount: String(ASSETS) }] } }]
          : [{ section: "tokens", method: "Deposited", data: { currencyId: "22", who: ACCOUNT, amount: "2,000,000" } }] } }) };
    } } },
    createType: (type, who) => { assert.equal(type, "AccountId32"); return hex(who); },
    disconnect: async () => {},
  };
  return {
    calls, batches,
    module: { WsProvider: class { constructor(url) { this.url = url; } },
      ApiPromise: { create: async ({ provider }) => provider.url === "wss://hub.invalid" ? hub : hydration } },
  };
}

function command(options = {}) {
  const f = fixture(options);
  let staged = options.staged ?? false;
  let settled = false;
  let bitmap = options.bitmap ?? 0n;
  let sold = bitmap === 3n;
  const historical = sold;
  const priorPosition = historical ? 17_457n : 0n;
  const observedSwapAmount = historical ? SELL + 4n : SELL;
  const eventBlocks = [];
  const positionReads = [];
  const observations = [];
  const forwardScans = [];
  let heads = 0;
  const head = options.head ?? 110;
  const swapBlock = options.swapBlock ?? 105;
  const timestamp = (block) => BigInt(NOW) * 1_000n + BigInt(block - 100) * 6_000n;
  const hydrationApi = {
    rpc: { chain: {
      getHeader: async () => ({ number: { toNumber: () => head + heads++ } }),
      getBlockHash: async (block) => ({ toHex: () => `block-${block}`, toString: () => `block-${block}` }),
    } },
    at: async (hash) => {
      const block = Number(String(hash).replace("block-", ""));
      return { query: {
        timestamp: { now: async () => timestamp(block) },
        system: { events: async () => {
          eventBlocks.push(block);
          return { toHuman: () => block === swapBlock ? [{ event: {
            section: "broadcast", method: "Swapped3", data: {
              operationStack: [{ Xcm: [options.wrongSwapRequest ? GARBAGE : f.laneId] }], fillerType: "AAVE",
              inputs: [{ asset: "22", amount: observedSwapAmount.toString() }],
              outputs: [{ asset: "1003", amount: observedSwapAmount.toString() }],
            },
          } }] : [] };
        } },
        tokens: { accounts: async (account, asset) => {
          assert.equal(account, ACCOUNT); assert.equal(asset, 22); assert.equal(block, swapBlock - 1);
          return { free: ASSETS };
        } },
      } };
    },
  };
  const sent = [];
  const dispatched = [];
  const reverseLookups = [];
  const chainStrategyReads = [];
  const dry = dryRunApi(f, options);
  const wrapperRecord = () => ({ context: { strategyId: f.strategyId, kind: 0, account: f.venue, assets: ASSETS, nonce: 1n },
    queuedBy: f.lane, status: settled ? 2 : 1, createdAt: options.createdAt ?? BigInt(NOW) });
  const pool = {
    operator: async () => manifest.verifier, venueAdapter: async () => f.venue,
    bufferAssets: async () => 10_000_000n, totalAssets: async () => 12_000_000n, venuePrincipalCostBasis: async () => ASSETS,
    venueDeployments: async () => ({ adapterRequestId: REQUEST }), venueRecalls: async () => ({}), activeVenueRecallId: async () => 0n,
    getFunction: () => ({ staticCall: async () => {} }),
  };
  const venue = {
    pool: async () => f.pool, lane: async () => f.lane,
    activeDeployRequestId: async () => REQUEST, activeRecallRequestId: async () => ZeroHash, reservedDeployAssets: async () => ASSETS,
    getRequest: async () => ({ kind: 0, status: 1, requestedAssets: ASSETS, returnBy: parameters.dispatchDeadline, claimed: false }),
    poolRequestForLaneRequest: async (id) => { reverseLookups.push(id); return staged && id === f.laneId ? REQUEST : ZeroHash; },
    getFunction: (name) => ({ staticCall: async () => { assert.equal(name, "cancelUnstaged"); assert.equal(staged, false); } }),
  };
  const lane = {
    strategyId: async (at) => { chainStrategyReads.push(at); return options.chainStrategy ?? f.strategyId; },
    asset: async () => manifest.contracts.token, agentAccountCore: async () => f.venue, xcmWrapper: async () => f.wrapper,
    totalAssets: async () => 0n, totalShares: async () => 0n, pendingDepositAssets: async () => staged ? ASSETS : 0n,
    getAdapterRequest: async () => ({ status: settled ? 2 : 1, settled }),
  };
  const wrapper = {
    dispatchPaused: async () => false, operator: async () => manifest.verifier,
    getRequest: async (id) => staged && id === f.laneId ? wrapperRecord() : { context: { account: ZeroAddress } },
    getRequestParameters: async () => parameters, requestDispatchBitmap: async () => bitmap,
  };
  const provider = { getBlockNumber: async () => 123, getBlock: async () => ({ number: 123, hash: ZeroHash, timestamp: NOW }),
    getLogs: async () => staged ? [f.stagedLog] : [], call: async () => "0x" };
  const signer = { sendTransaction: async (tx) => {
    sent.push(tx);
    if (tx.to === f.venue) { assert.equal(staged, false); staged = true; }
    else { assert.equal(tx.to, f.lane); settled = true; }
    return { hash: ZeroHash, wait: async () => ({ status: 1, logs: f.logs, blockNumber: 123, gasUsed: 1n }) };
  } };
  const io = {
    readDeploymentManifest: async () => ({ ...manifest, deploymentBlocks: { ...manifest.deploymentBlocks,
      hydrationDepositPoolAdapterV2: 123, hydrationDepositPoolAdapterV21: 123 } }),
    createCeremonyRpcContext: async () => ({ provider, chainId: 420420419, selectedUrl: "mock" }),
    resolveSigner: async () => ({ address: manifest.verifier, signer, backend: "mock-no-credentials" }),
    Contract: class { constructor(address) {
      const result = new Map([[f.pool, pool], [f.venue, venue], [f.lane, lane], [f.wrapper, wrapper]]).get(address);
      assert.ok(result, `Unexpected contract ${address}`); return result;
    } },
    VenueBalanceReader: class {
      async read(target) { return { raw: target.ledger === "substrate_system" ? 1_000_000_000n
        : historical ? (target.ledger === "erc20" ? priorPosition + observedSwapAmount : 49_980n) : 0n }; }
      async close() {}
    },
    fetchJson: async () => ({ available: true, pool: f.pool, reconciled: true, flows: { status: "ok" }, block: { timestamp: NOW } }),
    captureParQuote: async () => ({ quote: { fillerType: "AAVE", assetIn: 22, assetOut: 1003, amountInRaw: SELL, amountOutRaw: SELL } }),
    dryRunStageAndFunding: (input) => dryRunStageAndFunding(input, dry.module),
    makeRuntime: () => ({
      targets: { float: "float", position: { endpoint: "mock", chainId: 222222 } },
      balanceReader: {
        read: async (target, opts) => {
          if (target === "float") return { raw: sold ? (historical ? 49_980n : 50_000n) : ASSETS };
          positionReads.push(opts);
          if (opts?.blockTag) {
            assert.equal(opts.blockTag, swapBlock - 1);
            if (options.unavailableBaseline) throw new Error("historical position unavailable");
            return { raw: priorPosition };
          }
          return { raw: priorPosition + observedSwapAmount };
        },
        getSubstrateApi: async () => hydrationApi,
        getEvmProvider: () => provider, close: async () => {},
      },
      dispatcher: { dispatch: async (input) => {
        assert.equal(input.requestId, f.laneId); dispatched.push(input);
        if (input.leg === "deposit_sell") { sold = true; bitmap |= 2n; } else bitmap |= 1n;
        return { evidence: { dryRun: { fundingDeposits: [{}], wireFrames: [{ frameSource: "runtime_transformed_local_execute" }] } } };
      } },
    }),
    waitForAaveSwap: async (_api, scan) => { forwardScans.push(scan); return { amountInRaw: SELL, amountOutRaw: SELL }; },
    persistEvidence: async (_args, evidence) => { observations.push(evidence); },
    ...(options.garbagePredictor ? { deriveLaneRequestId: () => GARBAGE } : {}),
  };
  const run = (action = "stage-dispatch", commit = false, cli = false) => (cli ? runCli : main)([
    action, "--profile", "mainnet", "--pool", f.pool, "--request-id", REQUEST, "--deployment-id", "1",
    "--expected-signer", manifest.verifier, "--observability-url", "http://monitor.invalid",
    "--asset-hub-ws", "wss://hub.invalid", "--hydration-ws", "wss://hydration.invalid",
    ...(commit ? ["--commit", "--use-kms"] : []),
  ], io);
  return { f, dry, run, sent, dispatched, reverseLookups, chainStrategyReads,
    hydrationApi, eventBlocks, positionReads, observations, forwardScans, headReads: () => heads };
}

test("bitmap 3 resume observes the historical request-bound swap and settles observed amounts without dispatch", async () => {
  const c = command({ staged: true, bitmap: 3n });
  assert.equal((await c.run("status")).nextAction, "rerun stage-dispatch --commit to observe and settle");
  const result = await c.run("stage-dispatch", true);
  assert.deepEqual(c.dispatched, []);
  assert.deepEqual(c.forwardScans, []);
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].to, c.f.lane);
  const settle = new Interface(["function settleRequest(bytes32,uint8,uint256,uint256,uint256,bytes32,bytes32)"])
    .decodeFunctionData("settleRequest", c.sent[0].data);
  assert.deepEqual([...settle].slice(0, 5), [c.f.laneId, 2n, SELL + 4n, SELL + 4n, 0n]);
  assert.equal(result.swapObservation.status, "found");
  assert.equal(result.hydrationSwap.blockNumber, 105);
  assert.equal(result.hydrationSwap.requestId, c.f.laneId);
  assert.equal(result.hydrationSwap.scan.source, "wrapper.createdAt");
  assert.equal(result.historicalBaselines.aUsdcRaw, 17_457n, "restart-time balance is not the baseline");
  assert.equal(result.feeLedger.sellExecutionFeeRaw, 16n);
  assert.equal(result.postState.adapterRequest.settled, true);
  assert.deepEqual(c.positionReads, [{ blockTag: 104 }, undefined]);
});

test("bitmap 3 same-amount swap for another request refuses settlement, reports not_found and exits nonzero", async (t) => {
  const c = command({ staged: true, bitmap: 3n, wrongSwapRequest: true });
  t.mock.method(console, "error", () => {});
  const previous = process.exitCode;
  try {
    process.exitCode = 0;
    await c.run("stage-dispatch", true, true);
    assert.equal(process.exitCode, 1);
  } finally { process.exitCode = previous; }
  assert.deepEqual(c.sent, []);
  assert.deepEqual(c.dispatched, []);
  const report = c.observations.at(-1);
  assert.equal(report.swapObservation.status, "not_found");
  assert.deepEqual(report.swapObservation.scanned, [49, 110]);
  assert.match(report.swapObservation.reason, /without request-bound/);
  assert.equal(c.headReads(), 1, "never follow the advancing head");
  assert.equal(Math.max(...c.eventBlocks), 110);
  assert.equal(new Set(c.eventBlocks).size, c.eventBlocks.length);
});

test("deposit history includes skew padding and delayed execution, but enforces the maximum block budget", async () => {
  for (const swapBlock of [90, 109]) {
    const c = command({ staged: true, bitmap: 3n, swapBlock });
    assert.equal((await c.run("stage-dispatch", true)).hydrationSwap.blockNumber, swapBlock);
  }
  const c = command({ staged: true, bitmap: 3n, head: MAX_RECALL_HISTORY_BLOCKS + 100 });
  await assert.rejects(c.run("stage-dispatch", true), /scan exceeds/);
  assert.deepEqual(c.eventBlocks, []);
  assert.deepEqual(c.sent, []);
  assert.equal(c.observations.at(-1).swapObservation.status, "not_found");
});

test("deposit history read budget stops a stalled event read without scanning another block", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const c = command({ staged: true, bitmap: 3n });
  const original = c.hydrationApi.at;
  let entered;
  const stalled = new Promise((resolve) => { entered = resolve; });
  c.hydrationApi.at = async (hash) => {
    const at = await original(hash);
    at.query.system.events = async () => { entered(); return new Promise(() => {}); };
    return at;
  };
  let completed = false;
  let failure;
  const result = recoverHistoricalDepositSwap(c.hydrationApi, {
    requestId: c.f.laneId, createdAt: BigInt(NOW), expectedInput: SELL,
  }).then(() => { completed = true; }, (error) => { completed = true; failure = error; });
  await stalled;
  t.mock.timers.tick(RECALL_HISTORY_TIMEOUT_MS);
  await new Promise(setImmediate);
  assert.equal(completed, true, "the deadline must release a stalled RPC read");
  await result;
  assert.match(failure?.message ?? "", /exceeded its read budget/);
  assert.equal(failure.swapObservation.status, "not_found");
  assert.deepEqual(failure.swapObservation.scanned, [49, null]);
  assert.deepEqual(c.eventBlocks, []);
  assert.equal(c.headReads(), 1);
});

test("bitmap 1 resume dispatches only sell and observes forward from the sell head", async () => {
  const c = command({ staged: true, bitmap: 1n });
  const result = await c.run("stage-dispatch", true);
  assert.deepEqual(c.dispatched, [{ requestId: c.f.laneId, leg: "deposit_sell" }]);
  assert.deepEqual(c.forwardScans, [{ requestId: c.f.laneId, fromBlock: 110, expectedInput: SELL }]);
  assert.deepEqual(c.eventBlocks, []);
  assert.equal(result.postState.adapterRequest.settled, true);
});

test("bitmap 3 refuses unreadable historical balances instead of inventing a baseline", async () => {
  const c = command({ staged: true, bitmap: 3n, unavailableBaseline: true });
  await assert.rejects(c.run("stage-dispatch", true), /historical position unavailable/);
  assert.deepEqual(c.sent, []);
  assert.deepEqual(c.dispatched, []);
});

test("v2.1 dry run reaches funding with chain strategy; legacy-strategy mutation refuses before funding", async () => {
  const good = command();
  const plan = await good.run();
  assert.equal(plan.strategyId, CURRENT);
  assert.deepEqual(good.chainStrategyReads, [{ blockTag: 123 }]);
  assert.equal(plan.stagedFundingDryRun.status, "success");
  assert.equal(good.dry.batches.length, 1);
  const mutant = command({ chainStrategy: LEGACY });
  await assert.rejects(mutant.run(), /strategyId does not match the chain-bound pool lane/);
  assert.equal(mutant.dry.batches.length, 0);
  assert.equal(mutant.sent.length, 0);
});

test("legacy dry run preserves original stage and funding call bytes and fee parameters", async () => {
  const c = command({ legacy: true });
  const plan = await c.run();
  const oldId = contractRequestId(LEGACY, c.f.venue);
  assert.equal(plan.staging.predictedLaneRequestId, oldId);
  assert.equal(plan.stagedFundingDryRun.laneRequestId, oldId);
  assert.deepEqual(plan.staging.parameters, parameters);
  const calls = c.dry.batches[0];
  assert.equal(calls[0].args[0], c.f.venue);
  assert.equal(calls[0].args[4], venueInterface.encodeFunctionData("stageDeploy", [REQUEST, parameters]));
  assert.equal(calls[1].args[0], c.f.wrapper);
  assert.equal(calls[1].args[4], wrapperInterface.encodeFunctionData("dispatchLeg", [oldId, 0, 0n]));
  assert.deepEqual(calls[0].args.slice(1, 4), calls[1].args.slice(1, 4));
  assert.equal(plan.stagedFundingDryRun.wireFrame.consumedUnchanged, true);
});

test("deploy binding rejects a legacy strategyId in an otherwise valid v2.1 record", () => {
  const f = fixture();
  const record = {
    context: { strategyId: CURRENT, kind: 0, account: f.venue, assets: ASSETS, nonce: 1n },
    queuedBy: f.lane, status: 1,
  };
  const input = { record, strategyId: CURRENT, laneAddress: f.lane, venueAddress: f.venue, requestedAssets: ASSETS, nonce: 1n };
  assert.equal(assertStagedDeployBinding(input), true);
  assert.throws(() => assertStagedDeployBinding({
    ...input, record: { ...record, context: { ...record.context, strategyId: LEGACY } },
  }), /dedicated pool lane/);
});

test("v2.1 recall-resume binding accepts its chain strategy and refuses another pool lane", () => {
  const f = fixture();
  const record = { context: { strategyId: CURRENT, kind: 1, account: f.venue, shares: 50n }, queuedBy: f.lane };
  const input = { record, strategyId: CURRENT, laneAddress: f.lane, venueAddress: f.venue };
  assert.equal(assertStagedRecallBinding(input), true);
  assert.throws(() => assertStagedRecallBinding({ ...input, record: { ...record, queuedBy: fixture({ legacy: true }).lane } }), /dedicated pool lane/);
  assert.throws(() => assertStagedRecallBinding({ ...input, strategyId: LEGACY }), /dedicated pool lane/);
});

test("recall preview shares emitted-ID decoding while retaining wire topic and AAVE unwind evidence", async () => {
  for (const legacy of [true, false]) {
    const f = fixture({ legacy, recall: true });
    const api = dryRunApi(f);
    const result = await dryRunStageAndRecallSell({
      args: { assetHubWs: "wss://hub.invalid", hydrationWs: "wss://hydration.invalid" },
      signerAddress: manifest.verifier, venueAddress: f.venue, wrapperAddress: f.wrapper,
      requestId: REQUEST, strategyId: f.strategyId, stageData: "0x1234", shares: ASSETS, feeAmount: 40_000n,
    }, api.module);
    assert.equal(result.laneRequestId, f.laneId);
    assert.equal(api.calls.length, 2);
    assert.equal(api.batches[0][1].args[4], wrapperInterface.encodeFunctionData("dispatchLeg", [f.laneId, 2, 40_000n]));
    assert.equal(result.hydration.swap.assetIn, 1003);
    assert.equal(result.hydration.swap.assetOut, 22);
    assert.equal(result.hydration.swap.amountOutRaw, ASSETS);
  }
});

test("garbage predictor cannot change the emitted funding dry-run target", async () => {
  const c = command({ garbagePredictor: true });
  const plan = await c.run();
  assert.equal(plan.staging.predictedLaneRequestId, GARBAGE); // mutation applied
  assert.equal(plan.stagedFundingDryRun.laneRequestId, c.f.laneId);
  assert.equal(wrapperInterface.decodeFunctionData("dispatchLeg", c.dry.batches[0][1].args[4])[0], c.f.laneId);
  assert.equal(c.sent.length, 0);
});

test("garbage predictor cannot change deploy commit receipt ID or bridge postcondition", async () => {
  const c = command({ garbagePredictor: true });
  const result = await c.run("stage-dispatch", true);
  assert.equal(result.staging.predictedLaneRequestId, GARBAGE); // mutation applied
  assert.equal(result.postState.laneRequestId, c.f.laneId);
  assert.deepEqual(c.dispatched, ["deposit_funding", "deposit_sell"].map((leg) => ({ requestId: c.f.laneId, leg })));
  assert.deepEqual(c.reverseLookups, [GARBAGE, c.f.laneId]);
  assert.equal(result.postState.adapterRequest.settled, true);
});

test("status accepts staged v2.1; cancel succeeds unstaged and refuses after lane staging", async () => {
  const staged = command({ staged: true });
  assert.equal((await staged.run("status")).state.venue.laneRequestId, staged.f.laneId);
  await assert.rejects(staged.run("cancel"), /already staged/);
  assert.equal(staged.sent.length, 0);
  const unstaged = await command().run("cancel");
  assert.equal(unstaged.preflight.cancelUnstaged, "success");
  assert.equal(unstaged.transactions[0].name, "cancelUnstaged");
});

test("staged-undispatched v2.1 deploy resumes both legs without staging again", async () => {
  const c = command({ staged: true });
  const result = await c.run("stage-dispatch", true);
  assert.equal(result.resume.resumedFromStagedRequest, true);
  assert.equal(result.resume.bitmap, 0n);
  assert.equal(result.receipts.stage.status, "skipped");
  assert.equal(c.sent.filter((tx) => tx.to === c.f.venue).length, 0);
  assert.deepEqual(c.dispatched, ["deposit_funding", "deposit_sell"].map((leg) => ({ requestId: c.f.laneId, leg })));
  assert.equal(result.postState.adapterRequest.settled, true);
});

test("staging events fail closed on missing, ambiguous, wrong-emitter or failed simulations", async () => {
  const f = fixture();
  for (const logs of [[], [f.stagedLog, f.stagedLog], [{ ...f.stagedLog, address: f.lane }]]) {
    assert.throws(() => readStagedLaneEvent(logs, { venueAddress: f.venue, requestId: REQUEST }), /exactly one/);
  }
  for (const options of [{ missingEvent: true }, { differentReplay: true }, { badExecution: true }, { paraId: 2000 }]) {
    const c = command(options);
    await assert.rejects(c.run(), /exactly one|did not succeed/);
    assert.equal(c.sent.length, 0);
  }
});

test("no single-strategy constant or implicit strategy default controls dispatch correctness", () => {
  const source = readFileSync(new URL("./pool-venue-dispatch.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /EXPECTED_STRATEGY_ID|HYDRATION_USDC_POOL_V1|AAC_IDLE_HYDRATION_V1/);
  assert.throws(() => deriveLaneRequestId({ venueAddress: fixture().venue, asset: manifest.contracts.token, assets: ASSETS, nonce: 1n }), /strategyId must be bytes32/);
  assert.throws(() => deriveLaneRecallRequestId({ venueAddress: fixture().venue, asset: manifest.contracts.token, shares: ASSETS, nonce: 1n }), /strategyId must be bytes32/);
});
