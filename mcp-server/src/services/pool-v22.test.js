import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { MemoryStateStore } from "../core/state-store.js";
import { LockedTierService, loadLockedTierConfig, lockedTierActivationGate } from "./locked-tier-service.js";
import { PoolV22LockedKeeper, sharedCommitmentPlan } from "./pool-v22-locked-keeper.js";
import { poolV22Config, PoolV22CommitmentReader, POOL_V22_NAV_DISCLOSURE, POOL_V22_MIGRATION_PENDING } from "./pool-v22-commitments.js";
import { DepositPoolDoorService } from "./deposit-pool-door.js";
import { buildDepositPoolSurface } from "../../../app/lib/ui/deposit-pool-surface.js";

const NOW = 1_800_000_000;
const DAY = 86400;
const WALLET = `0x${"11".repeat(20)}`;
const WALLET2 = `0x${"22".repeat(20)}`;
const POOL = `0x${"33".repeat(20)}`;
const RATE = { approved: true, evidence: "fixture:measurement-only", principalRaw: "10000000", yieldRaw: "10000", elapsedSeconds: "86400" };
const iso = (seconds) => new Date(seconds * 1000).toISOString();
function entry(id, days, { wallet = WALLET, shares = "0", ...overrides } = {}) {
  return { id, wallet, status: "active", tier: days > 30 ? "t90" : "t30", amountRaw: "25000000",
    expiresAt: iso(NOW + days * DAY), commitmentConsentUntil: iso(NOW + days * DAY),
    poolV22: { sharesRaw: shares, status: shares === "0" ? "idle" : "float" }, ...overrides };
}

async function harness(records, { until = 0, poolShares = "0", measuredRate = RATE, consent = true } = {}) {
  const stateStore = new MemoryStateStore();
  for (const record of records) await stateStore.upsertLockedTierEntry(record);
  const calls = [];
  const snapshot = { now: NOW, committedUntil: until, poolSharesRaw: poolShares,
    totalSharesRaw: String(records.reduce((s, e) => s + BigInt(e.poolV22.sharesRaw), 0n)),
    totalAssetsRaw: "25000000", floatRaw: poolShares === "0" ? "25000000" : "0",
    accounts: Object.fromEntries(records.map((e) => [e.wallet, { liquidRaw: "75000000", strategyAllocatedRaw: "25000000",
      sharesRaw: e.poolV22.sharesRaw, debtRaw: "0" }])) };
  const chain = {
    snapshot: async () => structuredClone(snapshot),
    allocate: async (wallet, amount) => {
      calls.push(["allocate", wallet, amount]);
      snapshot.accounts[wallet].sharesRaw = String(BigInt(snapshot.accounts[wallet].sharesRaw) + BigInt(amount));
      snapshot.totalSharesRaw = String(BigInt(snapshot.totalSharesRaw) + BigInt(amount));
    },
    sweep: async (amount, until) => { calls.push(["sweep", amount, until]); snapshot.committedUntil = until; snapshot.poolSharesRaw = amount; snapshot.floatRaw = "0"; },
    commit: async (until) => { calls.push(["commit", until]); snapshot.committedUntil = until; },
    requestExit: async (shares) => { calls.push(["exit", shares]); return { requestId: "1" }; },
    readExit: async () => ({ unlockAt: NOW - 1, fulfilled: false }),
    fulfilExit: async () => { calls.push(["fulfil"]); snapshot.poolSharesRaw = "0"; snapshot.floatRaw = "25000000"; },
    deallocate: async (wallet, amount) => { calls.push(["deallocate", wallet, amount]); snapshot.accounts[wallet].sharesRaw = "0"; }
  };
  const lockedTierService = { readMeasuredVenueRate: async () => measuredRate,
    allocationConsentCovers: async () => consent };
  const keeper = new PoolV22LockedKeeper({ config: { enabled: true }, stateStore, chain, lockedTierService });
  return { keeper, stateStore, chain, calls, snapshot, lockedTierService };
}

test("pin 8: shared position uses earliest 20-day consent, never the co-depositor's 100 days", async () => {
  const a = entry("a", 20, { shares: "25000000" });
  const b = entry("b", 100, { wallet: WALLET2, shares: "25000000" });
  const h = await harness([a, b]);
  const result = await h.keeper.runOnce();
  assert.equal(result.status, "committed");
  assert.deepEqual(h.calls, [["sweep", "25000000", NOW + 20 * DAY]]);
  assert.equal(result.isolationTrigger, true);
  assert.equal((await h.stateStore.getServiceState("pool-v22:isolation-trigger")).triggered, true);
  assert.equal(sharedCommitmentPlan([b], null, h.snapshot).committedUntil, NOW + 90 * DAY);
});

test("pin 8: seven-day newcomer to a 28-day commitment stays idle in AAC with /me reason", async () => {
  const h = await harness([entry("a", 30, { shares: "25000000" }), entry("b", 7, { wallet: WALLET2 })], {
    until: NOW + 28 * DAY, poolShares: "25000000"
  });
  const result = await h.keeper.runOnce();
  assert.equal(result.reason, "lock_shorter_than_shared_commitment");
  assert.deepEqual(h.calls, []);
  const persisted = (await h.stateStore.listLockedTierEntries(WALLET2))[0];
  assert.equal(persisted.poolV22.status, "idle");
  assert.equal(persisted.poolV22.reason, "lock_shorter_than_shared_commitment");
});

test("locked keeper moves only the consented principal, commits on a fresh subsequent tick", async () => {
  const h = await harness([entry("a", 30)]);
  assert.equal((await h.keeper.runOnce()).status, "allocated");
  assert.deepEqual(h.calls, [["allocate", WALLET, "25000000"]]); // AAC has 75, not all deployable.
  assert.equal((await h.keeper.runOnce()).status, "committed");
  assert.deepEqual(h.calls[1], ["sweep", "25000000", NOW + 30 * DAY]);
});

test("consent revoked between allocation and pool deposit refuses with no commitment", async () => {
  const h = await harness([entry("a", 30)]);
  await h.keeper.runOnce();
  h.lockedTierService.allocationConsentCovers = async () => false;
  assert.equal((await h.keeper.runOnce()).reason, "commitment_consent_missing_or_revoked");
  assert.equal(h.calls.length, 1);
});

test("closed gate blocks new allocation, not a revoked depositor's exit", async () => {
  const h = await harness([entry("a", 30, { shares: "25000000", status: "exiting" })], {
    measuredRate: null, consent: false, poolShares: "25000000"
  });
  assert.equal((await h.keeper.runOnce()).status, "exit_pending");
  assert.deepEqual(h.calls, [["exit", "25000000"]]);
  assert.equal((await h.keeper.runOnce()).status, "exit_recalled");
  assert.equal((await h.keeper.runOnce()).status, "returned");
  assert.deepEqual(h.calls[2], ["deallocate", WALLET, "25000000"]);
});

test("revocation or exit during durable intent persistence refuses before the send", async () => {
  for (const change of ["revoked", "exit"]) {
    const h = await harness([entry("a", 30)]);
    const persist = h.stateStore.upsertServiceState.bind(h.stateStore);
    h.stateStore.upsertServiceState = async (key, value) => {
      await persist(key, value);
      if (key !== "pool-v22:movement" || !value.pending) return;
      if (change === "revoked") h.lockedTierService.allocationConsentCovers = async () => false;
      else await h.stateStore.upsertLockedTierEntry(entry("a", 30, { status: "exiting" }));
    };
    assert.equal((await h.keeper.runOnce()).reason, change === "revoked"
      ? "pool_v22_consent_missing_or_revoked_before_send" : "pool_v22_commitment_changed_before_send");
    assert.deepEqual(h.calls, []);
    assert.equal((await h.stateStore.getServiceState("pool-v22:movement")).pending, false);
  }
});

test("ambiguous sends persist intent and are never repeated after restart", async () => {
  const h = await harness([entry("a", 30)]);
  h.chain.allocate = async () => { h.calls.push(["allocate"]); throw new Error("timeout"); };
  await h.keeper.runOnce();
  assert.equal((await h.keeper.runOnce()).reason, "movement_reconciliation_required");
  assert.equal(h.calls.length, 1);
});

test("unknown shared participants fail closed, and overlapping runs cannot both send", async () => {
  const h = await harness([entry("a", 30)]);
  h.snapshot.totalSharesRaw = "1";
  assert.equal((await h.keeper.runOnce()).reason, "pool_v22_unknown_participant");
  assert.equal(h.calls.length, 0);
  h.snapshot.totalSharesRaw = "0";
  const results = await Promise.all([h.keeper.runOnce(), h.keeper.runOnce()]);
  assert.ok(results.some((r) => r.reason === "keeper_lock_held"));
  assert.equal(h.calls.length, 1);
});

test("pin 9: gate stays venue_rate_unmeasured until evidence; one friction per full term", async () => {
  const records = [entry("a", 28)];
  const unmeasured = lockedTierActivationGate(records, new Date(NOW * 1000));
  assert.equal(unmeasured.open, false);
  assert.deepEqual(unmeasured.blockers, ["venue_rate_unmeasured"]);
  assert.equal(unmeasured.projection.basis, null);
  const gate = lockedTierActivationGate(records, new Date(NOW * 1000), { measuredRate: RATE });
  assert.equal(gate.projection.projectedCycleYield.raw, "700000");
  assert.equal(gate.friction.roundTripsPerTerm, 1);
  assert.equal(gate.friction.cycleFriction.raw, "51765");
  assert.equal(gate.friction.requiredProjectedYield.raw, "103530");
  assert.equal(gate.open, true);
  const h = await harness(records, { measuredRate: null });
  assert.equal((await h.keeper.runOnce()).reason, "venue_rate_unmeasured");
  assert.deepEqual(h.calls, []);
});

test("Ceremony C and keeper flags are both default off", async () => {
  assert.equal(poolV22Config({}).enabled, false);
  assert.equal(poolV22Config({ POOL_V22_LOCKED_KEEPER_ENABLED: "1" }).enabled, false);
  assert.throws(() => poolV22Config({ POOL_V22_CEREMONY_COMPLETE: "1" }), /addresses_missing/u);
});

test("lock reads reconcile on-chain commitment every time and early exit cannot auto-release", async () => {
  const h = await harness([entry(`0x${"ab".repeat(32)}`, 30, { shares: "25000000" })], { until: NOW + 20 * DAY });
  let reads = 0;
  const service = new LockedTierService({ stateStore: h.stateStore,
    creditPositionReader: async () => ({ credit: { available: true, outstandingDebtRaw: "0" } }),
    config: loadLockedTierConfig({}), now: () => new Date(NOW * 1000) });
  service.poolV22Chain = { snapshot: async (...args) => { reads++; return h.chain.snapshot(...args); } };
  const state = await service.getWalletState(WALLET);
  assert.ok(reads >= 1);
  assert.match(state.entries[0].poolV22.commitmentText, /Principal is committed on chain until/u);
  assert.match(state.yieldStatusText, /adapter float, not pool shares/u);
  h.snapshot.poolSharesRaw = "25000000";
  assert.match((await service.getWalletState(WALLET)).yieldStatusText, /holds a shared v2.2 pool position/u);
  const result = await service.requestExit(WALLET, `0x${"ab".repeat(32)}`);
  assert.equal(result.entry.releaseAt, iso(NOW + 27 * DAY));
  service.now = () => new Date((NOW + 100 * DAY) * 1000);
  assert.equal((await service.getWalletState(WALLET)).entries[0].status, "exiting");
  service.poolV22Chain.snapshot = async () => { throw new Error("offline"); };
  assert.equal((await service.getWalletState(WALLET)).entries[0].poolV22.reconciliation, "unavailable");
  assert.match((await service.getWalletState(WALLET)).yieldStatusText, /no current NAV participation is claimed/u);
});

test("V6 term disagreement alarms and forfeits perks without pretending principal released", async () => {
  const h = await harness([entry("a", 20, { shares: "25000000" })], { until: NOW + 30 * DAY });
  const service = new LockedTierService({ stateStore: h.stateStore,
    creditPositionReader: async () => ({ credit: { available: true, outstandingDebtRaw: "0" } }),
    config: loadLockedTierConfig({}), now: () => new Date(NOW * 1000) });
  service.poolV22Chain = h.chain;
  assert.equal((await service.getWalletState(WALLET)).entries[0].status, "exiting");
  assert.equal((await h.stateStore.getServiceState("pool-v22:reconciliation-alarm")).reason, "commitment_exceeds_consent");
});

test("pin 10: /pool and door carry migration and R3 disclosure, no public commitment wallets", async () => {
  const door = new DepositPoolDoorService({ poolAddress: POOL, chainId: 1337,
    chainReader: { readSnapshot: async () => ({ blockNumber: 1, blockTimestamp: NOW, asset: WALLET,
      totalAssets: 20_000_000n, totalSupply: 20_000_000n, bufferAssets: 20_000_000n,
      deployedPrincipal: 0n, totalAssetCap: 1_000_000_000n, perAgentAssetCap: 100_000_000n }) } });
  const info = await door.getInfo();
  assert.equal(info.commitmentDisclosure, POOL_V22_NAV_DISCLOSURE);
  assert.match(info.commitmentDisclosure, /shared pro-rata by all pool shares, including Flex/u);
  assert.equal(info.transition.statement, POOL_V22_MIGRATION_PENDING);
  assert.match(info.transition.statement, /Ceremony C is pending/u);
  assert.match(info.transition.statement, /7-day notice.*at their leisure.*never moved by Averray/u);
  const surface = buildDepositPoolSurface(info);
  assert.equal(surface.commitments.disclosure, POOL_V22_NAV_DISCLOSURE);
  assert.equal(surface.transition, POOL_V22_MIGRATION_PENDING);
  assert.equal(Object.hasOwn(info.commitments, "holder"), false);
  const component = await readFile(new URL("../../../app/components/pool/DepositPoolSurface.tsx", import.meta.url), "utf8");
  const marketing = await readFile(new URL("../../../marketing/public/pool-reader.js", import.meta.url), "utf8");
  assert.match(component, /surface\.commitments\?\.disclosure/u);
  assert.match(component, /surface\.transition/u);
  assert.match(marketing, /source\.commitmentDisclosure/u);
  assert.match(marketing, /source\.transition\.statement/u);
});

test("pool reader uses one block for all three capacities, backing and aggregate tier amounts", async () => {
  const reader = new PoolV22CommitmentReader(undefined, POOL);
  const calls = [];
  const read = (name, result) => async (...args) => { calls.push([name, ...args]); return result; };
  reader.pool = {
    deployableFor: read("deployableFor", 12n), committedSharesBeyond: read("committedSharesBeyond", 13n),
    committedSharesByTier: read("committedSharesByTier", [1n, 2n, 3n]),
    convertToAssets: read("convertToAssets", 14n), bufferFloor: read("bufferFloor", 15n),
    commitment: read("commitment", { tier: 2n, committedUntil: BigInt(NOW + 20 * DAY) })
  };
  const publicRead = await reader.read({ blockNumber: 88, blockTimestamp: NOW });
  assert.deepEqual(calls.filter(([name]) => name === "deployableFor").map((call) => call[1]), [7, 30, 90].map((d) => d * DAY));
  assert.deepEqual(calls.filter(([name]) => name === "committedSharesBeyond").map((call) => call[1]), [7, 30, 90].map((d) => NOW + d * DAY));
  assert.ok(calls.every((call) => call.at(-1).blockTag === 88));
  assert.equal(publicRead.tiers[2].assets.raw, "14");
  assert.equal(Object.hasOwn(publicRead, "holder"), false);
  assert.equal(JSON.stringify(publicRead).includes(WALLET), false);
  assert.equal((await reader.read({ wallet: WALLET, blockNumber: 88, blockTimestamp: NOW })).holder.committedUntil, NOW + 20 * DAY);
});
