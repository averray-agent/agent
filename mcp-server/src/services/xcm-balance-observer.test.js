import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { MemoryStateStore } from "../core/state-store.js";
import { XcmSettlementWatcherService } from "./xcm-settlement-watcher.js";
import { XcmBalanceObserverService } from "./xcm-balance-observer.js";
import { VenueBalanceReader, normalizeVenueBalanceTarget } from "./venue-balance-reader.js";

const REQUEST_ID = `0x${"11".repeat(32)}`;
const ACCOUNT = "0xaf39ad769a03cb535d9799e49459b033c1fab84ee23ffe5d0852f8d82f02a71e";
const AUSDC = "0x2ec4884088d84e5c2970a034732e5209b0acfa93";
const HYD_SUBSTRATE = "wss://hydration-rpc.n.dwellir.com";
const HYD_EVM = "https://rpc.hydradx.cloud";

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
