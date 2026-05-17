import test from "node:test";
import assert from "node:assert/strict";

import { AccountOverlayStore } from "./account-overlay-store.js";
import { MemoryStateStore } from "./state-store.js";

function silentLogger() {
  return { warn() {}, info() {}, error() {}, debug() {} };
}

test("AccountOverlayStore — Map-compatible get/set/has against the in-memory cache", () => {
  const store = new AccountOverlayStore();
  assert.equal(store.has("0xabc"), false);
  assert.equal(store.get("0xabc"), undefined);
  store.set("0xabc", { wallet: "0xabc", liquid: { USDC: 5 } });
  assert.equal(store.has("0xabc"), true);
  assert.deepEqual(store.get("0xabc"), { wallet: "0xabc", liquid: { USDC: 5 } });
});

test("AccountOverlayStore — every set() mirrors out to the state-store", async () => {
  const stateStore = new MemoryStateStore();
  const store = new AccountOverlayStore({ stateStore });
  store.set("0xabc", { wallet: "0xabc", liquid: { USDC: 12 } });
  store.set("0xdef", { wallet: "0xdef", liquid: { USDC: 0 } });
  await store.flush();

  const aFromBacking = await stateStore.getAccountOverlay("0xabc");
  const bFromBacking = await stateStore.getAccountOverlay("0xdef");
  assert.deepEqual(aFromBacking, { wallet: "0xabc", liquid: { USDC: 12 } });
  assert.deepEqual(bFromBacking, { wallet: "0xdef", liquid: { USDC: 0 } });

  const wallets = await stateStore.listAccountOverlayWallets();
  assert.deepEqual(wallets.sort(), ["0xabc", "0xdef"]);
});

test("AccountOverlayStore — sequential writes to the same wallet persist in order", async () => {
  // Per-wallet serialization: two rapid `.set()`s for the same wallet
  // should not interleave such that the state-store ends up with the
  // older write. The final state-store value must match the last set.
  const stateStore = new MemoryStateStore();
  const store = new AccountOverlayStore({ stateStore });
  store.set("0xabc", { wallet: "0xabc", version: 1 });
  store.set("0xabc", { wallet: "0xabc", version: 2 });
  store.set("0xabc", { wallet: "0xabc", version: 3 });
  await store.flush();

  const backing = await stateStore.getAccountOverlay("0xabc");
  assert.equal(backing.version, 3);
  assert.equal(store.persistQueues.size, 0);
});

test("AccountOverlayStore — hydrate loads every persisted overlay into the cache", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertAccountOverlay("0xabc", { wallet: "0xabc", liquid: { USDC: 7 } });
  await stateStore.upsertAccountOverlay("0xdef", { wallet: "0xdef", liquid: { USDC: 0 } });

  const store = new AccountOverlayStore({ stateStore });
  // Cache empty before hydrate.
  assert.equal(store.get("0xabc"), undefined);

  const result = await store.hydrate();
  assert.equal(result.hydrated, 2);
  assert.equal(result.skipped, 0);
  assert.deepEqual(store.get("0xabc"), { wallet: "0xabc", liquid: { USDC: 7 } });
  assert.deepEqual(store.get("0xdef"), { wallet: "0xdef", liquid: { USDC: 0 } });
});

test("AccountOverlayStore — hydrated entry overwrites a dev seed for the same wallet", async () => {
  // Bootstrap seeds "0xagent" before hydrate runs (see bootstrap.js).
  // If the durable store also has a "0xagent" entry — say from a
  // previous production run — the persisted copy must win, not the
  // hardcoded dev fixture.
  const stateStore = new MemoryStateStore();
  await stateStore.upsertAccountOverlay("0xagent", { wallet: "0xagent", liquid: { USDC: 999 } });
  const store = new AccountOverlayStore({ stateStore });
  store.seed("0xagent", { wallet: "0xagent", liquid: { USDC: 25 } }); // dev fixture
  await store.hydrate();

  assert.equal(store.get("0xagent").liquid.USDC, 999);
});

test("AccountOverlayStore — degrades to a plain in-memory Map when state-store is missing", async () => {
  const store = new AccountOverlayStore();
  store.set("0xabc", { wallet: "0xabc" });
  await store.flush(); // must not throw
  const result = await store.hydrate();
  assert.equal(result.hydrated, 0);
  assert.match(result.reason, /state-store unavailable/u);
  assert.deepEqual(store.get("0xabc"), { wallet: "0xabc" });
});

test("AccountOverlayStore — persist failure is logged but does not crash the caller", async () => {
  const stateStore = {
    upsertAccountOverlay: async () => {
      throw new Error("redis_unavailable");
    }
  };
  const captured = [];
  const logger = {
    warn: (payload, message) => captured.push({ payload, message }),
    info() {},
    error() {},
    debug() {}
  };
  const store = new AccountOverlayStore({ stateStore, logger });
  store.set("0xabc", { wallet: "0xabc" });
  await store.flush();

  assert.equal(captured.length, 1);
  assert.equal(captured[0].message, "account-overlay.persist_failed");
  assert.equal(captured[0].payload.wallet, "0xabc");
  assert.match(captured[0].payload.error, /redis_unavailable/u);
  // Cache still holds the value even though persist failed.
  assert.deepEqual(store.get("0xabc"), { wallet: "0xabc" });
});

test("AccountOverlayStore — restart simulation: write through, drop the store, rebuild from state-store", async () => {
  // This is the close-output integration check for Package C Phase 2:
  // simulate a process restart against a shared durable backing and
  // assert no state loss for overlays operators rely on.
  const stateStore = new MemoryStateStore();
  const before = new AccountOverlayStore({ stateStore, logger: silentLogger() });

  before.set("0xworker-1", {
    wallet: "0xworker-1",
    liquid: { USDC: 100 },
    recurringTemplateReserves: { templateA: { asset: "USDC", amount: 5 } },
    strategyShares: { "default-low-risk": 42 },
    strategyPending: { "default-low-risk": { lastStatus: "pending", pendingDepositAssets: 3 } },
    treasuryTimeline: [
      { id: "treasury-2", at: "2026-05-17T00:00:00.000Z", kind: "allocate" },
      { id: "treasury-1", at: "2026-05-16T00:00:00.000Z", kind: "fund" }
    ]
  });
  before.set("0xworker-2", { wallet: "0xworker-2", liquid: { USDC: 0 } });
  await before.flush();

  // Simulated restart: discard `before`, build a fresh store, hydrate.
  const after = new AccountOverlayStore({ stateStore, logger: silentLogger() });
  await after.hydrate();

  // Cache reflects every overlay the previous process wrote.
  const w1 = after.get("0xworker-1");
  assert.equal(w1.liquid.USDC, 100);
  assert.equal(w1.recurringTemplateReserves.templateA.amount, 5);
  assert.equal(w1.strategyShares["default-low-risk"], 42);
  assert.equal(w1.strategyPending["default-low-risk"].lastStatus, "pending");
  assert.equal(w1.treasuryTimeline.length, 2);
  assert.equal(w1.treasuryTimeline[0].id, "treasury-2");

  const w2 = after.get("0xworker-2");
  assert.deepEqual(w2, { wallet: "0xworker-2", liquid: { USDC: 0 } });
});
