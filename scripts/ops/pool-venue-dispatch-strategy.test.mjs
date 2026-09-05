import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AbiCoder, Interface, ZeroAddress, ZeroHash, encodeBytes32String, keccak256 } from "ethers";
import { XCM_WRAPPER_ABI } from "../../mcp-server/src/blockchain/abis.js";
import {
  main, dryRunStageAndFunding, dryRunStageAndRecallSell, deriveLaneRequestId, deriveLaneRecallRequestId,
  assertStagedRecallBinding, readStagedLaneEvent,
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
  let sold = false;
  let bitmap = 0n;
  const sent = [];
  const dispatched = [];
  const reverseLookups = [];
  const chainStrategyReads = [];
  const dry = dryRunApi(f, options);
  const wrapperRecord = () => ({ context: { strategyId: f.strategyId, kind: 0, account: f.venue, assets: ASSETS, nonce: 1n },
    queuedBy: f.lane, status: settled ? 2 : 1 });
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
      async read(target) { return { raw: target.ledger === "substrate_system" ? 1_000_000_000n : 0n }; }
      async close() {}
    },
    fetchJson: async () => ({ available: true, pool: f.pool, reconciled: true, flows: { status: "ok" }, block: { timestamp: NOW } }),
    captureParQuote: async () => ({ quote: { fillerType: "AAVE", assetIn: 22, assetOut: 1003, amountInRaw: SELL, amountOutRaw: SELL } }),
    dryRunStageAndFunding: (input) => dryRunStageAndFunding(input, dry.module),
    makeRuntime: () => ({
      targets: { float: "float", position: { endpoint: "mock", chainId: 222222 } },
      balanceReader: {
        read: async (target) => ({ raw: target === "float" ? (sold ? 50_000n : ASSETS) : SELL }),
        getSubstrateApi: async () => ({ rpc: { chain: { getHeader: async () => ({ number: { toNumber: () => 100 } }) } } }),
        getEvmProvider: () => provider, close: async () => {},
      },
      dispatcher: { dispatch: async (input) => {
        assert.equal(input.requestId, f.laneId); dispatched.push(input);
        if (input.leg === "deposit_sell") { sold = true; bitmap |= 2n; } else bitmap |= 1n;
        return { evidence: { dryRun: { fundingDeposits: [{}], wireFrames: [{ frameSource: "runtime_transformed_local_execute" }] } } };
      } },
    }),
    waitForAaveSwap: async () => ({ amountInRaw: SELL, amountOutRaw: SELL }),
    persistEvidence: async () => {},
    ...(options.garbagePredictor ? { deriveLaneRequestId: () => GARBAGE } : {}),
  };
  const run = (action = "stage-dispatch", commit = false) => main([
    action, "--profile", "mainnet", "--pool", f.pool, "--request-id", REQUEST, "--deployment-id", "1",
    "--expected-signer", manifest.verifier, "--observability-url", "http://monitor.invalid",
    "--asset-hub-ws", "wss://hub.invalid", "--hydration-ws", "wss://hydration.invalid",
    ...(commit ? ["--commit", "--use-kms"] : []),
  ], io);
  return { f, dry, run, sent, dispatched, reverseLookups, chainStrategyReads };
}

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
