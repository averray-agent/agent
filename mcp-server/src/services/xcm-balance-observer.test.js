import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { MemoryStateStore } from "../core/state-store.js";
import { EventBus } from "../core/event-bus.js";
import { XcmSettlementWatcherService } from "./xcm-settlement-watcher.js";
import { XcmBalanceObserverService } from "./xcm-balance-observer.js";
import { VenueBalanceReader, normalizeVenueBalanceTarget } from "./venue-balance-reader.js";

const REQUEST_ID = `0x${"11".repeat(32)}`;
const ACCOUNT = "0xaf39ad769a03cb535d9799e49459b033c1fab84ee23ffe5d0852f8d82f02a71e";
const AUSDC = "0x2ec4884088d84e5c2970a034732e5209b0acfa93";
const HYD_SUBSTRATE = "wss://hydration-rpc.n.dwellir.com";
const HYD_EVM = "https://rpc.hydradx.cloud";
const POSTAGE = "16Mf98wAbYTVWaeHkD1SUdRPc5nmoLj9LyNtPtP1xvkF7Sxb";
const MAINNET_ACCOUNT = "0x42e55ecf123da7d3eba1c55998b3cbf8238c446367c981f1388acbc0626cf354";
const MAINNET_ACCOUNT_SS58 = "12WiJGBSjqTBNqD7a7TN6mt47ZJd7f8SqyhTc2bYLFzcHYD9";
const WRAPPER = "0xecee778e11b238d2fc096e56460e7b98dc7b26b8";
const USDC = "0x0000053900000000000000000000000001200000";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/hydration-bank-round-trip.json", import.meta.url),
  "utf8"
));

function targetFor(name) {
  return name === "asset22"
    ? { ledger: "substrate_tokens", endpoint: HYD_SUBSTRATE, account: ACCOUNT, assetId: 22 }
    : {
        ledger: "erc20",
        endpoint: HYD_EVM,
        chainId: 222222,
        account: ACCOUNT,
        accountTransform: "hydration_truncate20",
        contract: AUSDC
      };
}

test("VenueBalanceReader target binds Hydration aUSDC to truncate20(AccountId32)", () => {
  const normalized = normalizeVenueBalanceTarget(targetFor("aUsdc"));
  assert.equal(normalized.evmAccount, fixture.convertedH160);
  assert.equal(normalized.contract, fixture.aUsdcContract);
});

test("SS58 Hydration account normalizes to the proven AccountId32 and truncate20 address", () => {
  const position = normalizeVenueBalanceTarget({
    ledger: "erc20",
    endpoint: HYD_EVM,
    chainId: 222222,
    account: MAINNET_ACCOUNT_SS58,
    accountTransform: "hydration_truncate20",
    contract: AUSDC
  });
  const float = normalizeVenueBalanceTarget({
    ledger: "substrate_tokens",
    endpoint: HYD_SUBSTRATE,
    account: MAINNET_ACCOUNT_SS58,
    assetId: 22
  });

  assert.equal(position.account, MAINNET_ACCOUNT);
  assert.equal(float.account, MAINNET_ACCOUNT);
  assert.equal(position.evmAccount, "0x42e55ecf123da7d3eba1c55998b3cbf8238c4463");
});

test("SS58 AccountId32 normalization rejects an invalid checksum", () => {
  assert.throws(
    () => normalizeVenueBalanceTarget({
      ledger: "substrate_tokens",
      endpoint: HYD_SUBSTRATE,
      account: `${MAINNET_ACCOUNT_SS58.slice(0, -1)}a`,
      assetId: 22
    }),
    /must be a 32-byte AccountId or SS58 address/u
  );
});

test("enabled Substrate read dynamically loads @polkadot/api before querying Tokens.accounts", async () => {
  let loadedModule;
  const reader = new VenueBalanceReader({
    async substrateApiFactory(_endpoint, polkadotApi) {
      loadedModule = polkadotApi;
      return {
        query: {
          tokens: {
            async accounts(account, assetId) {
              assert.equal(account, ACCOUNT);
              assert.equal(assetId, 22);
              return { toJSON: () => ({ free: "149380" }) };
            }
          }
        },
        async disconnect() {}
      };
    }
  });

  const reading = await reader.read(targetFor("asset22"));
  assert.equal(typeof loadedModule.ApiPromise.create, "function");
  assert.equal(reading.raw, 149_380n);
  await reader.close();
});

test("postage read uses System.account free balance for the wrapper SS58 account", async () => {
  let queried;
  const reader = new VenueBalanceReader({
    async polkadotApiLoader() { return {}; },
    async substrateApiFactory() {
      return {
        query: {
          system: {
            async account(account) {
              queried = account;
              return { toJSON: () => ({ data: { free: "15100000000" } }) };
            }
          }
        }
      };
    }
  });
  const reading = await reader.read({
    ledger: "substrate_system",
    endpoint: "wss://polkadot-asset-hub-rpc.polkadot.io",
    account: POSTAGE
  });

  assert.equal(queried, POSTAGE);
  assert.equal(reading.raw, 15_100_000_000n);
});

test("feed polling runs beside the observer without enabling XCM settlement", async () => {
  let feedPolls = 0;
  const observer = new XcmBalanceObserverService(
    {
      async listPendingXcmBalanceWatches() {
        throw new Error("settlement observer must remain disabled");
      }
    },
    undefined,
    undefined,
    undefined,
    {
      enabled: false,
      bankLaneFeed: {
        enabled: true,
        async pollOnce() { feedPolls += 1; }
      }
    }
  );

  assert.deepEqual(await observer.pollOnce(), []);
  assert.equal(feedPolls, 1);
});

test("RequestQueued chain event creates a staged-on-chain watch before dispatch", async () => {
  const store = new MemoryStateStore();
  const bus = new EventBus();
  const observer = new XcmBalanceObserverService(
    store,
    { async read() { return { raw: 100_000n, asOf: "2026-08-04T10:00:00.000Z" }; } },
    { async observeOutcome() {} },
    bus,
    {
      enabled: true,
      pollIntervalMs: 60_000,
      now: () => Date.parse("2026-08-04T10:00:02.000Z"),
      chainEventWatchConfig: {
        expectedWrapper: WRAPPER,
        depositTarget: targetFor("aUsdc"),
        withdrawTarget: {
          ledger: "erc20",
          endpoint: "https://services.polkadothub-rpc.com/mainnet/",
          account: WRAPPER,
          contract: USDC
        }
      }
    }
  );
  observer.start();
  bus.publish({
    id: "staging-event-1",
    topic: "xcm.request_queued",
    timestamp: "2026-08-04T10:00:00.000Z",
    txHash: "0xstage",
    blockNumber: 123,
    data: {
      requestId: REQUEST_ID,
      wrapperAddress: WRAPPER,
      kind: 0,
      assetsRaw: "150000",
      sharesRaw: "0"
    }
  });
  await observer.flushChainEventIngestion();
  bus.publish({
    id: "dispatch-event-1",
    topic: "xcm.request_leg_dispatched",
    timestamp: "2026-08-04T10:00:01.000Z",
    txHash: "0xdispatch",
    blockNumber: 124,
    data: {
      requestId: REQUEST_ID,
      wrapperAddress: WRAPPER,
      leg: 0,
      messageHash: `0x${"aa".repeat(32)}`,
      feeAmount: "0"
    }
  });
  await observer.flushChainEventIngestion();
  const watch = await observer.requireArmedWatch(REQUEST_ID, { wrapperAddress: WRAPPER });
  observer.stop();

  assert.equal(watch.registrationSource, "chain_event");
  assert.equal(watch.phase, "leg-0-dispatched-on-chain");
  assert.equal(watch.dispatchBitmap, 1);
  assert.equal(watch.lastDispatchTxHash, "0xdispatch");
  assert.equal(watch.baselineRaw, "100000");
  assert.equal(watch.sourceEventId, "staging-event-1");
  assert.equal(watch.stagingTxHash, "0xstage");
  assert.deepEqual(watch.settlement, { assets: "delta", shares: "delta" });
});

test("withdraw RequestQueued watches the wrapper-image USDC return, not the aUSDC position", async () => {
  const store = new MemoryStateStore();
  const bus = new EventBus();
  let baselineTarget;
  const withdrawTarget = {
    ledger: "erc20",
    endpoint: "https://services.polkadothub-rpc.com/mainnet/",
    account: WRAPPER,
    contract: USDC
  };
  const observer = new XcmBalanceObserverService(
    store,
    { async read(target) { baselineTarget = target; return { raw: 0n, asOf: "2026-08-04T10:00:00.000Z" }; } },
    { async observeOutcome() {} },
    bus,
    {
      enabled: true,
      pollIntervalMs: 60_000,
      now: () => Date.parse("2026-08-04T10:00:02.000Z"),
      chainEventWatchConfig: {
        expectedWrapper: WRAPPER,
        depositTarget: targetFor("aUsdc"),
        withdrawTarget
      }
    }
  );
  observer.start();
  bus.publish({
    id: "withdraw-staging-event",
    topic: "xcm.request_queued",
    timestamp: "2026-08-04T10:00:00.000Z",
    data: { requestId: REQUEST_ID, wrapperAddress: WRAPPER, kind: 1, assetsRaw: "0", sharesRaw: "100000" }
  });
  await observer.flushChainEventIngestion();
  const watch = await observer.requireArmedWatch(REQUEST_ID, { wrapperAddress: WRAPPER });
  observer.stop();

  assert.equal(baselineTarget.account, WRAPPER);
  assert.equal(baselineTarget.contract, USDC);
  assert.deepEqual(watch.settlement, { assets: "delta", shares: "requested_shares" });
});

test("chain-event ingestion failure is visible and cannot arm a dispatcher watch", async () => {
  const store = new MemoryStateStore();
  const bus = new EventBus();
  const observer = new XcmBalanceObserverService(
    store,
    { async read() { throw new Error("hydration balance unavailable"); } },
    { async observeOutcome() {} },
    bus,
    {
      enabled: true,
      pollIntervalMs: 60_000,
      chainEventWatchConfig: {
        expectedWrapper: WRAPPER,
        depositTarget: targetFor("aUsdc"),
        withdrawTarget: {
          ledger: "erc20",
          endpoint: "https://services.polkadothub-rpc.com/mainnet/",
          account: WRAPPER,
          contract: USDC
        }
      },
      logger: { error() {}, warn() {} }
    }
  );
  observer.start();
  bus.publish({
    id: "staging-event-failed",
    topic: "xcm.request_queued",
    timestamp: "2026-08-04T10:00:00.000Z",
    data: { requestId: REQUEST_ID, wrapperAddress: WRAPPER, kind: 0, assetsRaw: "1", sharesRaw: "0" }
  });
  await observer.flushChainEventIngestion();
  const status = await observer.getStatus();
  observer.stop();

  assert.match(status.chainEventIngestionError, /hydration balance unavailable/u);
  await assert.rejects(
    observer.requireArmedWatch(REQUEST_ID, { wrapperAddress: WRAPPER }),
    /No pending chain-event observer watch/u
  );
});

test("an overdue chain-event watch cannot authorize dispatch", async () => {
  const store = new MemoryStateStore();
  const observer = new XcmBalanceObserverService(
    store,
    { async read() { throw new Error("stored baseline must be used"); } },
    { async observeOutcome() {} },
    undefined,
    {
      enabled: true,
      now: () => Date.parse("2026-08-04T10:16:00.000Z"),
      chainEventWatchConfig: {
        expectedWrapper: WRAPPER,
        depositTarget: targetFor("aUsdc"),
        withdrawTarget: {
          ledger: "erc20",
          endpoint: "https://services.polkadothub-rpc.com/mainnet/",
          account: WRAPPER,
          contract: USDC
        }
      }
    }
  );
  await observer.register({
    requestId: REQUEST_ID,
    target: targetFor("aUsdc"),
    direction: "increase",
    settlement: { assets: "delta", shares: "delta" },
    kind: "deposit",
    wrapperAddress: WRAPPER,
    registrationSource: "chain_event_backfill",
    baselineRaw: "0",
    startedAt: "2026-08-04T10:00:00.000Z"
  });

  await assert.rejects(
    observer.requireArmedWatch(REQUEST_ID, { wrapperAddress: WRAPPER }),
    /overdue and cannot authorize dispatch/u
  );
});

test("standing chain-event backfill requires and preserves an explicit baseline", async () => {
  const store = new MemoryStateStore();
  const observer = new XcmBalanceObserverService(
    store,
    { async read() { throw new Error("backfill must not invent a current baseline"); } },
    { async observeOutcome() {} },
    undefined,
    {
      enabled: true,
      chainEventWatchConfig: {
        expectedWrapper: WRAPPER,
        depositTarget: targetFor("aUsdc"),
        withdrawTarget: {
          ledger: "erc20",
          endpoint: "https://services.polkadothub-rpc.com/mainnet/",
          account: WRAPPER,
          contract: USDC
        }
      }
    }
  );
  await assert.rejects(
    observer.register({
      requestId: REQUEST_ID,
      target: targetFor("aUsdc"),
      direction: "increase",
      wrapperAddress: WRAPPER,
      registrationSource: "chain_event_backfill"
    }),
    /requires an explicit chain-height-bound baselineRaw/u
  );
  await observer.register({
    requestId: REQUEST_ID,
    target: targetFor("aUsdc"),
    direction: "increase",
    baselineRaw: "4242",
    wrapperAddress: WRAPPER,
    sourceEventId: "manual-backfill:block-123",
    registrationSource: "chain_event_backfill"
  });
  const watch = await observer.requireArmedWatch(REQUEST_ID, { wrapperAddress: WRAPPER });
  assert.equal(watch.baselineRaw, "4242");
  assert.equal(watch.registrationSource, "chain_event_backfill");
});

test("enabled observer polls only the current v2.2 target and fails unknown scope closed", async () => {
  const store = new MemoryStateStore();
  const now = Date.parse("2026-08-04T08:00:00.000Z");
  const baseWatch = {
    status: "pending",
    direction: "increase",
    baselineRaw: "0",
    currentRaw: "0",
    deltaRaw: "0",
    settlement: { assets: "delta", shares: "delta" },
    startedAt: new Date(now - 1_000).toISOString(),
    deadlineAt: new Date(now + 60_000).toISOString(),
    attemptCount: 0
  };
  const currentId = `0x${"41".repeat(32)}`;
  const retiredId = `0x${"42".repeat(32)}`;
  const unknownId = `0x${"43".repeat(32)}`;
  await store.upsertXcmBalanceWatch({
    ...baseWatch,
    requestId: currentId,
    target: { ...targetFor("aUsdc"), account: MAINNET_ACCOUNT }
  });
  await store.upsertXcmBalanceWatch({
    ...baseWatch,
    requestId: retiredId,
    target: {
      ...targetFor("aUsdc"),
      account: "0x98f0033e26aa4ecf2899e6d09237d40d29fcb68e64d22a621520bde1123564ac"
    }
  });
  await store.upsertXcmBalanceWatch({ ...baseWatch, requestId: unknownId });

  const reads = [];
  const bankLaneFeed = {
    enabled: true,
    classifyRequestWatch(watch) {
      if (!watch.target) return "unknown";
      return watch.target.account === MAINNET_ACCOUNT ? "current" : "foreign";
    },
    async pollOnce() {}
  };
  const observer = new XcmBalanceObserverService(
    store,
    {
      async read(target) {
        reads.push(target.account);
        return { raw: 0n, asOf: new Date(now).toISOString(), target };
      }
    },
    { async observeOutcome() {} },
    undefined,
    { enabled: true, bankLaneFeed, now: () => now }
  );

  await observer.pollOnce();
  assert.deepEqual(reads, [MAINNET_ACCOUNT]);
  assert.equal((await store.getXcmBalanceWatch(currentId)).attemptCount, 1);
  assert.equal((await store.getXcmBalanceWatch(retiredId)).attemptCount, 0);
  assert.equal((await store.getXcmBalanceWatch(unknownId)).lastError, "observer_target_scope_unknown");
  const status = await observer.getStatus();
  assert.equal(status.pendingCount, 2);
  assert.equal(status.readErrorCount, 1);
});

test("round-trip fixtures replay all four destination-ledger balance deltas", async () => {
  let sequence = [];
  const outcomes = [];
  const store = new MemoryStateStore();
  const reader = {
    async read(target) {
      const raw = BigInt(sequence.shift());
      return { raw, asOf: "2026-08-02T12:00:00.000Z", target };
    }
  };
  const sink = { async observeOutcome(requestId, outcome) { outcomes.push({ requestId, ...outcome }); } };
  let now = Date.parse("2026-08-02T12:00:00.000Z");
  const observer = new XcmBalanceObserverService(store, reader, sink, undefined, {
    enabled: true,
    now: () => now
  });

  for (let index = 0; index < fixture.transactions.length; index += 1) {
    const tx = fixture.transactions[index];
    const requestId = `0x${String(index + 1).padStart(64, "0")}`;
    sequence = [tx.beforeRaw, tx.afterRaw];
    await observer.register({
      requestId,
      target: targetFor(tx.target),
      direction: tx.direction,
      requestedAssetsRaw: tx.actualDeltaRaw,
      requestedSharesRaw: tx.actualDeltaRaw,
      settlement: { assets: "delta", shares: "delta" }
    });
    await observer.pollOnce();
    const stored = await store.getXcmBalanceWatch(requestId);
    assert.equal(stored.status, "succeeded", tx.label);
    assert.equal(stored.deltaRaw, tx.actualDeltaRaw, tx.label);
    now += 1_000;
  }

  assert.deepEqual(outcomes.map((entry) => entry.settledAssets),
    fixture.transactions.map((entry) => entry.actualDeltaRaw));
});

test("balance delta finalizes through the existing watcher and credits the strategy ledger once", async () => {
  const store = new MemoryStateStore();
  const finalized = [];
  const platform = {
    async preflightXcmSettlementOutcome(requestId, outcome) {
      return { requestId, ok: true, boundedBy: "XcmWrapper._validateSettlementBounds", outcome };
    },
    async finalizeXcmRequest(requestId, outcome) {
      finalized.push({ requestId, outcome });
      return {
        requestId,
        settledVia: "agent_account",
        strategyRequest: { account: "0x1111111111111111111111111111111111111111", statusLabel: "succeeded" }
      };
    }
  };
  const settlementWatcher = new XcmSettlementWatcherService(platform, store, undefined, { enabled: true });
  const reads = [0n, 100_000n];
  const observer = new XcmBalanceObserverService(
    store,
    { async read(target) { return { raw: reads.shift(), asOf: new Date().toISOString(), target }; } },
    settlementWatcher,
    undefined,
    { enabled: true }
  );
  await observer.register({
    requestId: REQUEST_ID,
    target: targetFor("aUsdc"),
    direction: "increase",
    requestedAssetsRaw: "100000",
    requestedSharesRaw: "100000"
  });
  await observer.pollOnce();
  await settlementWatcher.runPendingSettlements();
  await settlementWatcher.runPendingSettlements();

  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].outcome.settledAssets, "100000");
  assert.equal(finalized[0].outcome.settledShares, "100000");
  assert.equal((await store.getXcmObservation(REQUEST_ID)).processed, true);
});

test("observer timeout records Failed instead of leaving a silent Pending", async () => {
  const store = new MemoryStateStore();
  const outcomes = [];
  let now = Date.parse("2026-08-02T12:00:00.000Z");
  const observer = new XcmBalanceObserverService(
    store,
    { async read(target) { return { raw: 50n, asOf: new Date(now).toISOString(), target }; } },
    { async observeOutcome(_requestId, outcome) { outcomes.push(outcome); } },
    undefined,
    { enabled: true, defaultTimeoutMs: 1_000, now: () => now }
  );
  await observer.register({
    requestId: REQUEST_ID,
    target: targetFor("asset22"),
    direction: "increase",
    baselineRaw: "50"
  });
  now += 1_001;
  await observer.pollOnce();

  assert.equal(outcomes[0].status, "failed");
  assert.equal((await store.getXcmBalanceWatch(REQUEST_ID)).status, "failed");
  assert.equal((await observer.getStatus()).pendingCount, 0);
});

test("dynamic import failure stays visible and times out as Failed", async () => {
  const store = new MemoryStateStore();
  const outcomes = [];
  let now = Date.parse("2026-08-02T12:00:00.000Z");
  const reader = new VenueBalanceReader({
    async polkadotApiLoader() {
      throw new Error("Cannot find package @polkadot/api");
    }
  });
  const observer = new XcmBalanceObserverService(
    store,
    reader,
    { async observeOutcome(_requestId, outcome) { outcomes.push(outcome); } },
    undefined,
    { enabled: true, defaultTimeoutMs: 1_000, now: () => now }
  );
  await observer.register({
    requestId: REQUEST_ID,
    target: targetFor("asset22"),
    direction: "increase",
    baselineRaw: "0"
  });

  await observer.pollOnce();
  const pendingStatus = await observer.getStatus();
  assert.equal(pendingStatus.pendingCount, 1);
  assert.equal(pendingStatus.readErrorCount, 1);
  assert.equal(pendingStatus.pending[0].observationState, "unknown_stale");
  assert.match(pendingStatus.pending[0].lastError, /Cannot find package @polkadot\/api/u);

  now += 1_001;
  await observer.pollOnce();
  assert.equal(outcomes[0].status, "failed");
  assert.equal((await store.getXcmBalanceWatch(REQUEST_ID)).status, "failed");
});

test("terminal watch registration and polling are idempotent", async () => {
  const store = new MemoryStateStore();
  const outcomes = [];
  const reads = [0n, 7n];
  const observer = new XcmBalanceObserverService(
    store,
    { async read(target) { return { raw: reads.shift() ?? 7n, asOf: new Date().toISOString(), target }; } },
    { async observeOutcome(_requestId, outcome) { outcomes.push(outcome); } },
    undefined,
    { enabled: true }
  );
  const input = {
    requestId: REQUEST_ID,
    target: targetFor("aUsdc"),
    direction: "increase",
    requestedAssetsRaw: "7",
    requestedSharesRaw: "7"
  };
  await observer.register(input);
  await observer.pollOnce();
  await observer.register(input);
  await observer.pollOnce();
  assert.equal(outcomes.length, 1);
});

test("a request id cannot be replayed with different settlement bounds", async () => {
  const store = new MemoryStateStore();
  const observer = new XcmBalanceObserverService(
    store,
    { async read(target) { return { raw: 0n, asOf: new Date().toISOString(), target }; } },
    { async observeOutcome() {} },
    undefined,
    { enabled: true }
  );
  const input = {
    requestId: REQUEST_ID,
    target: targetFor("aUsdc"),
    direction: "increase",
    requestedAssetsRaw: "100000",
    requestedSharesRaw: "100000"
  };
  await observer.register(input);
  await assert.rejects(
    observer.register({ ...input, requestedAssetsRaw: "100001" }),
    /already exists with different bounds/u
  );
});
