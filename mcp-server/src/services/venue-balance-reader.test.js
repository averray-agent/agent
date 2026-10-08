import assert from "node:assert/strict";
import test from "node:test";
import { VenueBalanceReader } from "./venue-balance-reader.js";
import { BankLaneFeedService } from "./bank-lane-feed.js";

const target = { ledger: "substrate_tokens", endpoint: "wss://venue.example", account: `0x${"11".repeat(32)}`, assetId: 22 };
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("float connect is bounded, reports its reason, and closes a late API before retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve;
  let disconnected = 0;
  let attempts = 0;
  const good = { query: { tokens: { accounts: async () => ({ free: "42" }) } }, disconnect() { disconnected++; } };
  const reader = new VenueBalanceReader({ substrateTimeoutMs: 100,
    polkadotApiLoader: async () => ({}),
    substrateApiFactory: () => ++attempts === 1 ? new Promise((done) => { resolve = done; }) : good });
  const refused = assert.rejects(reader.read(target), /venue_substrate_connect_timeout after 100ms/);
  await nextTurn();
  t.mock.timers.tick(100);
  await refused;
  assert.equal(reader.substrateApis.size, 0);
  resolve(good);
  await nextTurn();
  assert.equal(disconnected, 1);
  assert.equal((await reader.read(target)).raw, 42n);
  await reader.close();
});

test("float query timeout and disconnected socket are explicit failures, not zero balances", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const api = { isConnected: true, query: { tokens: { accounts: () => new Promise(() => {}) } }, disconnect() {} };
  const reader = new VenueBalanceReader({ substrateTimeoutMs: 100, polkadotApiLoader: async () => ({}), substrateApiFactory: async () => api });
  const refused = assert.rejects(reader.read(target), /venue_substrate_query_timeout/);
  await nextTurn();
  t.mock.timers.tick(100);
  await refused;
  assert.equal(reader.substrateApis.size, 0);
  api.isConnected = false;
  await assert.rejects(reader.read(target), /venue_substrate_disconnected/);
  assert.equal(reader.substrateApis.size, 0);
});

test("an old failed query cannot evict or disconnect a replacement API", async () => {
  const reader = new VenueBalanceReader();
  let rejectOld;
  const old = { disconnect() {} };
  let disconnected = 0;
  const fresh = { disconnect() { disconnected++; } };
  reader.substrateApis.set(target.endpoint, Promise.resolve(old));
  const failed = assert.rejects(reader.readSubstrate(target.endpoint, old,
    () => new Promise((_, reject) => { rejectOld = reject; })), /old query failed/);
  await nextTurn();
  const replacement = Promise.resolve(fresh);
  reader.substrateApis.set(target.endpoint, replacement);
  rejectOld(new Error("old query failed"));
  await failed;
  await nextTurn();
  assert.equal(reader.substrateApis.get(target.endpoint), replacement);
  assert.equal(disconnected, 0);
  await reader.close();
});

test("default WS factory stops reconnecting when initialization hangs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let disconnected = 0;
  class WsProvider { disconnect() { disconnected++; } }
  const reader = new VenueBalanceReader({ substrateTimeoutMs: 100, polkadotApiLoader: async () => ({
    WsProvider, ApiPromise: { create: () => new Promise(() => {}) }
  }) });
  const refused = assert.rejects(reader.read(target), /venue_substrate_connect_timeout/);
  await nextTurn();
  t.mock.timers.tick(100);
  await refused;
  await nextTurn();
  assert.equal(disconnected, 1);
  await reader.close();
});

test("float timeout is exposed as an unknown bank reading with the connection reason", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reader = new VenueBalanceReader({ substrateTimeoutMs: 100, polkadotApiLoader: () => new Promise(() => {}) });
  const feed = new BankLaneFeedService({}, reader);
  const pending = feed.readBalance(target);
  await nextTurn();
  t.mock.timers.tick(100);
  const reading = await pending;
  assert.equal(reading.raw, null);
  assert.match(reading.lastError, /venue_substrate_connect_timeout after 100ms/);
});
