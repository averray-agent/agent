import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";

import { MemoryStateStore } from "../core/state-store.js";
import {
  CREDIT_READ_GRACE_CEILING_MS,
  CREDIT_READ_GRACE_DEFAULT_MS,
  LOCKED_TIER_EARLY_EXIT_TERMS,
  LOCKED_TIER_YIELD_INACTIVE_TEXT,
  LockedTierService,
  loadLockedTierConfig,
  lockedTierActivationGate,
  lockedTierPriority
} from "./locked-tier-service.js";

const SIGNER = new Wallet(`0x${"11".repeat(32)}`);
const START = new Date("2026-08-24T10:00:00.000Z");
const USDC = "0x1111111111111111111111111111111111111111";
const DAY_MS = 24 * 60 * 60 * 1_000;

function activationLock({
  idByte = "aa",
  amountRaw = "25000000",
  remainingDays = 89,
  expiresAt
} = {}) {
  return {
    id: `0x${idByte.repeat(32)}`,
    wallet: SIGNER.address.toLowerCase(),
    tier: remainingDays > 30 ? "t90" : "t30",
    amountRaw,
    expiresAt: expiresAt ?? new Date(START.getTime() + remainingDays * DAY_MS).toISOString(),
    status: "active"
  };
}

function harness({
  liquidRaw = "50000000",
  creditRaw = "0",
  creditReadable = true,
  creditReadGraceMs = CREDIT_READ_GRACE_DEFAULT_MS,
  now = START
} = {}) {
  const stateStore = new MemoryStateStore();
  let clock = new Date(now);
  let outstandingDebtRaw = creditRaw;
  let creditPositionReadable = creditReadable;
  const service = new LockedTierService({
    stateStore,
    accountPositionReader: async (wallet) => ({
      wallet,
      asset: { address: USDC, symbol: "USDC", decimals: 6 },
      position: { liquidRaw, jobStakeLockedRaw: "0" }
    }),
    creditPositionReader: async () => creditPositionReadable
      ? { credit: { available: true, outstandingDebtRaw } }
      : { credit: { available: false, reason: "credit_pool_read_failed" } },
    config: {
      enabled: true,
      perWalletCapRaw: 25_000_000n,
      perWalletCapUsdc: "25",
      cohortCapRaw: 1_000_000_000n,
      cohortCapUsdc: "1000",
      creditReadGraceMs
    },
    chainId: 420_420_419,
    siweDomain: "api.averray.com",
    publicBaseUrl: "https://api.averray.com",
    vestingHours: 48,
    now: () => new Date(clock)
  });
  return {
    service,
    stateStore,
    poolInfo: poolInfo(SIGNER.address),
    setNow(value) { clock = new Date(value); },
    setCredit(value) { outstandingDebtRaw = String(value); },
    setCreditReadable(value) { creditPositionReadable = Boolean(value); }
  };
}

async function seedActiveT90(h) {
  await h.stateStore.upsertLockedTierEntry({
    id: `0x${"cc".repeat(32)}`,
    wallet: SIGNER.address.toLowerCase(),
    tier: "t90",
    amountRaw: "25000000",
    lockedAt: START.toISOString(),
    termDays: 90,
    expiresAt: "2026-11-22T10:00:00.000Z",
    consentRef: `0x${"dd".repeat(32)}`,
    status: "active",
    publicProfileOptIn: true
  });
}

function poolInfo(wallet, overrides = {}) {
  return {
    available: true,
    asset: USDC,
    block: { number: 123, hash: `0x${"ab".repeat(32)}`, timestamp: 1_777_000_000 },
    totalAssets: { raw: "10000000", decimals: 6 },
    totalShares: { raw: "10000000", decimals: 6 },
    sharePrice: {
      model: "principal-cost-basis",
      assetsPerShare: { raw: "1000000", decimals: 6 },
      numeratorAssetsRaw: "10000000",
      denominatorSharesRaw: "10000000"
    },
    caps: {
      poolHeadroom: { raw: "990000000", decimals: 6 }
    },
    wallet: {
      address: wallet,
      perAgentHeadroom: { raw: "100000000", decimals: 6 }
    },
    ...overrides
  };
}

async function signedLock(h, {
  tier = "t30",
  amountRaw = "10000000",
  publicProfileOptIn = false,
  nonce = "nonce0001"
} = {}) {
  const quote = await h.service.quote(SIGNER.address, {
    tier,
    amountRaw,
    consentNonce: nonce,
    publicProfileOptIn
  }, { poolInfo: h.poolInfo });
  return h.service.createLock(SIGNER.address, {
    terms: quote.terms,
    termsHash: quote.termsHash,
    consentSignature: await SIGNER.signMessage(quote.consent.message)
  }, { poolInfo: h.poolInfo });
}

test("no-consent-no-lock: creating a lock without signed consent leaves the ledger empty", async () => {
  const h = harness();
  const quote = await h.service.quote(SIGNER.address, {
    tier: "t30",
    amountRaw: "10000000",
    consentNonce: "noconsent1"
  }, { poolInfo: h.poolInfo });
  await assert.rejects(
    () => h.service.createLock(SIGNER.address, {
      terms: quote.terms,
      termsHash: quote.termsHash
    }, { poolInfo: h.poolInfo }),
    /consentSignature must be a 65-byte hex signature/u
  );
  assert.deepEqual(await h.stateStore.listLockedTierEntries(SIGNER.address), []);
});

test("quote discloses exact L4 exit terms, current NAV, gate state, and risk before consent", async () => {
  const h = harness();
  const quote = await h.service.quote(SIGNER.address, {
    tier: "t30",
    amountRaw: "3820000",
    consentNonce: "quote0001"
  }, { poolInfo: h.poolInfo });
  assert.equal(quote.tierTerms.earlyExit, LOCKED_TIER_EARLY_EXIT_TERMS);
  assert.equal(quote.activationGate.status, "closed");
  assert.equal(quote.activationGate.yieldStatusText, LOCKED_TIER_YIELD_INACTIVE_TEXT);
  assert.equal(quote.nav.sharePrice.assetsPerShare.raw, "1000000");
  assert.match(quote.riskSentence, /pro-rata NAV share/u);
  assert.equal(quote.consent.required, true);
});

test("signed consent creates a lowercase durable lock without moving funds", async () => {
  const h = harness();
  const result = await signedLock(h);
  assert.equal(result.created, true);
  assert.equal(result.entry.wallet, SIGNER.address.toLowerCase());
  assert.equal(result.entry.status, "active");
  assert.equal(result.entry.amountRaw, "10000000");
  assert.equal(result.entry.consentRef, result.entry.id);
  assert.equal(result.tierState.encumbered.raw, "10000000");
});

test("a consent retry is idempotent even after its quote expires", async () => {
  const h = harness();
  const quote = await h.service.quote(SIGNER.address, {
    tier: "t30",
    amountRaw: "10000000",
    consentNonce: "retry001"
  }, { poolInfo: h.poolInfo });
  const payload = {
    terms: quote.terms,
    termsHash: quote.termsHash,
    consentSignature: await SIGNER.signMessage(quote.consent.message)
  };
  assert.equal((await h.service.createLock(SIGNER.address, payload, { poolInfo: h.poolInfo })).created, true);
  h.setNow("2026-08-24T10:11:00.000Z");
  const retried = await h.service.createLock(SIGNER.address, payload, { poolInfo: h.poolInfo });
  assert.equal(retried.created, false);
  assert.equal((await h.stateStore.listLockedTierEntries(SIGNER.address)).length, 1);
});

test("early exit drops to Flex immediately and releases full principal after normal vesting", async () => {
  const h = harness();
  const created = await signedLock(h, { tier: "t90", publicProfileOptIn: true });
  assert.equal((await h.service.getPublicCommitment(SIGNER.address)).committedDepositor, true);
  const exited = await h.service.requestExit(SIGNER.address, created.entry.id);
  assert.equal(exited.tierState.tier, "flex");
  assert.equal(exited.entry.status, "exiting");
  assert.equal(exited.consequence.principalHaircutRaw, "0");
  assert.equal(exited.consequence.penaltyFeeRaw, "0");
  assert.equal(await h.service.getPublicCommitment(SIGNER.address), undefined);

  h.setNow("2026-08-26T09:59:59.999Z");
  assert.equal((await h.service.getWalletState(SIGNER.address)).encumbered.raw, "10000000");
  h.setNow("2026-08-26T10:00:00.000Z");
  const released = await h.service.getWalletState(SIGNER.address);
  assert.equal(released.encumbered.raw, "0");
  assert.equal(released.entries[0].status, "released");
});

test("outstanding credit refuses a lock and suspends an existing T90 priority perk", async () => {
  const h = harness();
  await signedLock(h, { tier: "t90", publicProfileOptIn: true });
  h.setCredit("1");
  const state = await h.service.getWalletState(SIGNER.address);
  assert.equal(state.contractualTier, "t90");
  assert.equal(state.tier, "flex");
  assert.equal(state.perksSuspendedReason, "outstanding_credit_draw");
  await assert.rejects(
    () => h.service.quote(SIGNER.address, {
      tier: "t30",
      amountRaw: "1000000",
      consentNonce: "credit001"
    }, { poolInfo: h.poolInfo }),
    (error) => error.code === "locked_tier_outstanding_credit_draw"
  );
});

test("T90 perks fail closed without a cached credit read and after the grace ceiling", async () => {
  const noCache = harness({ creditReadable: false });
  await seedActiveT90(noCache);
  const unavailable = await noCache.service.getWalletState(SIGNER.address);
  assert.equal(unavailable.tier, "flex");
  assert.equal(unavailable.perksActive, false);
  assert.equal(unavailable.perksSuspendedReason, "credit_position_unavailable");
  assert.equal(unavailable.creditReadStaleSeconds, undefined);

  const expired = harness();
  await signedLock(expired, { tier: "t90", publicProfileOptIn: true });
  expired.setNow(new Date(START.getTime() + CREDIT_READ_GRACE_CEILING_MS + 1));
  expired.setCreditReadable(false);
  const state = await expired.service.getWalletState(SIGNER.address);
  assert.equal(state.tier, "flex");
  assert.equal(state.perksActive, false);
  assert.equal(state.perksSuspendedReason, "credit_position_unavailable");
  assert.equal(state.creditReadStaleSeconds, undefined);
  assert.equal(await expired.service.getPublicCommitment(SIGNER.address), undefined);
});

test("T90 perks never grace a cached outstanding credit draw", async () => {
  const h = harness();
  await signedLock(h, { tier: "t90", publicProfileOptIn: true });
  h.setCredit("1");
  assert.equal((await h.service.getWalletState(SIGNER.address)).perksSuspendedReason, "outstanding_credit_draw");
  h.setNow(new Date(START.getTime() + 60_000));
  h.setCreditReadable(false);
  const state = await h.service.getWalletState(SIGNER.address);
  assert.equal(state.tier, "flex");
  assert.equal(state.perksActive, false);
  assert.equal(state.perksSuspendedReason, "outstanding_credit_draw");
  assert.equal(state.creditReadStaleSeconds, undefined);
});

test("T90 perks survive one failed credit read for 60s and report staleness", async () => {
  const h = harness();
  await signedLock(h, { tier: "t90", publicProfileOptIn: true });
  h.setNow(new Date(START.getTime() + 60_000));
  h.setCreditReadable(false);
  const state = await h.service.getWalletState(SIGNER.address);
  assert.equal(state.contractualTier, "t90");
  assert.equal(state.tier, "t90");
  assert.equal(state.priorityRank, 2);
  assert.equal(state.perksActive, true);
  assert.equal(state.perksSuspendedReason, undefined);
  assert.equal(state.creditReadStaleSeconds, 60);
  assert.equal((await h.service.getPublicCommitment(SIGNER.address)).committedDepositor, true);
});

test("credit-read grace cannot be configured above the code ceiling", async () => {
  const warnings = [];
  const defaults = loadLockedTierConfig({});
  const lowered = loadLockedTierConfig({ CREDIT_READ_GRACE_MS: "60000" });
  const clamped = loadLockedTierConfig(
    { CREDIT_READ_GRACE_MS: String(CREDIT_READ_GRACE_CEILING_MS * 10) },
    { logger: { warn: (...args) => warnings.push(args) } }
  );
  assert.equal(defaults.creditReadGraceMs, CREDIT_READ_GRACE_DEFAULT_MS);
  assert.equal(lowered.creditReadGraceMs, 60_000);
  assert.equal(clamped.creditReadGraceMs, CREDIT_READ_GRACE_DEFAULT_MS);
  assert.equal(warnings[0][1], "locked_tiers.credit_read_grace_clamped");

  const codeCapped = harness({ creditReadGraceMs: CREDIT_READ_GRACE_CEILING_MS * 10 });
  await signedLock(codeCapped, { tier: "t90", publicProfileOptIn: true });
  codeCapped.setNow(new Date(START.getTime() + CREDIT_READ_GRACE_CEILING_MS));
  codeCapped.setCreditReadable(false);
  assert.equal(
    (await codeCapped.service.getWalletState(SIGNER.address)).perksSuspendedReason,
    "credit_position_unavailable"
  );
});

test("lock creation still requires a live readable credit position during grace", async () => {
  const h = harness();
  const quote = await h.service.quote(SIGNER.address, {
    tier: "t90",
    amountRaw: "10000000",
    consentNonce: "strictcredit"
  }, { poolInfo: h.poolInfo });
  h.setNow(new Date(START.getTime() + 60_000));
  h.setCreditReadable(false);
  const consentSignature = await SIGNER.signMessage(quote.consent.message);
  await assert.rejects(
    () => h.service.createLock(SIGNER.address, {
      terms: quote.terms,
      termsHash: quote.termsHash,
      consentSignature
    }, { poolInfo: h.poolInfo }),
    (error) => error.code === "locked_tier_credit_position_unavailable"
  );
  assert.deepEqual(await h.stateStore.listLockedTierEntries(SIGNER.address), []);
});

test("per-wallet cap and existing pool cap both refuse excess lock creation", async () => {
  const h = harness();
  await signedLock(h, { amountRaw: "25000000" });
  await assert.rejects(
    () => h.service.quote(SIGNER.address, {
      tier: "t30",
      amountRaw: "1",
      consentNonce: "walletcap"
    }, { poolInfo: h.poolInfo }),
    (error) => error.code === "locked_tier_per_wallet_cap_exceeded"
  );

  const fresh = harness();
  fresh.poolInfo = poolInfo(SIGNER.address, {
    caps: { poolHeadroom: { raw: "999999", decimals: 6 } }
  });
  await assert.rejects(
    () => signedLock(fresh, { amountRaw: "1000000" }),
    (error) => error.code === "locked_tier_cohort_cap_exceeded"
  );
});

test("activation-gate-t90-89-days: today's 25-USDC T90 cohort opens on its true remaining cycle", async () => {
  const h = harness();
  await seedActiveT90(h);
  h.setNow(new Date(START.getTime() + DAY_MS));
  const gate = (await h.service.getPoolTelemetry()).activationGate;
  assert.equal(gate.projection.cycleDays, 89);
  assert.equal(gate.projection.projectedCycleYield.raw, "301127");
  assert.equal(gate.projection.cycleSetBy.rule, "shortest_remaining_active_lock_term");
  assert.equal(gate.projection.cycleSetBy.activeLockCount, 1);
  assert.equal(gate.projection.cycleSetBy.lockId, `0x${"cc".repeat(32)}`);
  assert.deepEqual(gate.minimumLocked, { raw: "15000000", decimals: 6 });
  assert.deepEqual(gate.projection.basis, {
    observedPrincipal: { raw: "9500000", decimals: 6 },
    observedYield: { raw: "9000", decimals: 6 },
    observedDays: 7
  });
  assert.equal(gate.friction.cycleFriction.raw, "60000");
  assert.equal(gate.friction.marginMultiple, 2);
  assert.equal(gate.open, true);
  assert.deepEqual(gate.blockers, []);
});

test("activation-gate-near-expiry: ten remaining days close the gate on cycle economics", () => {
  const gate = lockedTierActivationGate([activationLock({ remainingDays: 10 })], START);
  assert.equal(gate.projection.cycleDays, 10);
  assert.equal(gate.projection.projectedCycleYield.raw, "33834");
  assert.equal(gate.open, false);
  assert.deepEqual(gate.blockers, ["projected_cycle_yield_below_2x_friction"]);
});

test("activation-gate-short-lock: a new T30 sets the whole cohort's shorter cycle", () => {
  const gate = lockedTierActivationGate([
    activationLock({ idByte: "90", remainingDays: 89 }),
    activationLock({ idByte: "30", amountRaw: "5000000", remainingDays: 30 })
  ], START);
  assert.equal(gate.totalLocked.raw, "30000000");
  assert.equal(gate.projection.cycleDays, 30);
  assert.equal(gate.projection.projectedCycleYield.raw, "121804");
  assert.equal(gate.projection.cycleSetBy.activeLockCount, 2);
  assert.equal(gate.projection.cycleSetBy.lockId, `0x${"30".repeat(32)}`);
});

test("activation-gate-floor-independent: a long cycle cannot open a sub-15-USDC cohort", () => {
  const gate = lockedTierActivationGate([
    activationLock({ amountRaw: "14999999", remainingDays: 89 })
  ], START);
  assert.equal(gate.projection.cycleDays, 89);
  assert.ok(BigInt(gate.projection.projectedCycleYield.raw) >= 120_000n);
  assert.equal(gate.open, false);
  assert.deepEqual(gate.blockers, ["locked_cohort_below_minimum"]);
});

test("activation-gate-cannot-be-config-opened: config or arguments cannot override the cohort cycle or margin", () => {
  const config = loadLockedTierConfig({
    LOCKED_TIERS_ENABLED: "true",
    LOCKED_TIER_ACTIVATION_GATE_OPEN: "true",
    LOCKED_TIER_PROJECTED_YIELD_RAW: "999999999",
    LOCKED_TIER_CYCLE_DAYS: "365",
    LOCKED_TIER_YIELD_MARGIN_MULTIPLE: "1"
  });
  assert.equal(config.enabled, true);
  assert.equal(Object.hasOwn(config, "activationGateOpen"), false);
  assert.equal(Object.hasOwn(config, "cycleDays"), false);
  assert.equal(Object.hasOwn(config, "yieldMarginMultiple"), false);
  const gate = lockedTierActivationGate(
    [activationLock({ remainingDays: 10 })],
    START,
    { cycleDays: 365, yieldMarginMultiple: 1 }
  );
  assert.equal(gate.projection.cycleDays, 10);
  assert.equal(gate.friction.marginMultiple, 2);
  assert.equal(gate.open, false);
  assert.deepEqual(gate.blockers, ["projected_cycle_yield_below_2x_friction"]);
});

test("activation-gate-unreadable-composition: malformed active expiry fails closed by name", () => {
  const lock = activationLock({ expiresAt: "not-a-timestamp" });
  const gate = lockedTierActivationGate([lock], START);
  assert.equal(gate.open, false);
  assert.equal(gate.projection.cycleDays, null);
  assert.equal(gate.projection.projectedCycleYield.raw, "0");
  assert.equal(gate.blockers[0], "active_lock_composition_unreadable");
  assert.deepEqual(gate.projection.cycleSetBy.unreadableLockIds, [lock.id]);
});

test("activation-gate-zero-active-locks: empty composition closes without NaN or division errors", () => {
  const gate = lockedTierActivationGate([], START);
  assert.equal(gate.open, false);
  assert.equal(gate.projection.cycleDays, 0);
  assert.equal(gate.projection.projectedCycleYield.raw, "0");
  assert.equal(gate.projection.cycleSetBy.activeLockCount, 0);
  assert.ok(gate.blockers.includes("no_active_locks"));
  assert.doesNotMatch(JSON.stringify(gate), /NaN|Infinity/u);
});

test("T90 priority rank is above T30 and Flex", () => {
  assert.ok(lockedTierPriority("t90").rank > lockedTierPriority("t30").rank);
  assert.ok(lockedTierPriority("t30").rank > lockedTierPriority("flex").rank);
});

test("synthetic-consent-mismatch-fixture raises a critical withdrawal-gate health alarm", async () => {
  const h = harness({ liquidRaw: "2000000" });
  await h.stateStore.upsertLockedTierEntry({
    id: `0x${"aa".repeat(32)}`,
    wallet: SIGNER.address,
    tier: "t30",
    amountRaw: "1500000",
    lockedAt: START.toISOString(),
    termDays: 30,
    expiresAt: "2026-09-23T10:00:00.000Z",
    consentRef: `0x${"bb".repeat(32)}`,
    status: "active",
    publicProfileOptIn: false
  });
  const decision = await h.service.assessWithdrawal({
    wallet: SIGNER.address,
    requestedRaw: "1000000",
    liquidRaw: "2000000"
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.consentMismatch, true);
  const health = await h.service.getHealth();
  assert.equal(health.ok, false);
  assert.equal(health.severity, "critical");
  assert.equal(health.code, "locked_tier_withdrawal_consent_mismatch");
});

test("new locked-deposit surfaces obey the ratified truth vocabulary", async () => {
  const h = harness();
  const quote = await h.service.quote(SIGNER.address, {
    tier: "t90",
    amountRaw: "1000000",
    consentNonce: "vocab001",
    publicProfileOptIn: true
  }, { poolInfo: h.poolInfo });
  const capability = await h.service.getCapability();
  const text = JSON.stringify({ quote, capability }).toLowerCase();
  for (const forbidden of ["apr", "guaranteed", "interest", "staking"]) {
    assert.doesNotMatch(text, new RegExp(`\\b${forbidden}\\b`, "u"));
  }
  assert.match(text, /locked deposit/u);
  assert.match(text, /priority/u);
  assert.match(text, /nav share/u);
});

// ── Seam test: the REAL door info shape must satisfy the quote's fail-closed
// poolSnapshot requirements. The 2026-08-24 production incident: every quote
// 409'd because the door's getInfo never emitted sharePrice while the service
// required it — fixture poolInfo() had invented the field, so no test caught
// the seam. This test feeds the service the door's actual output.
import { DepositPoolDoorService } from "./deposit-pool-door.js";

test("the real deposit-pool door info satisfies the locked-tier quote seam", async () => {
  const h = harness();
  const door = new DepositPoolDoorService({
    poolAddress: "0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30",
    chainId: 420_420_419,
    rpcUrls: ["https://example.invalid/"],
    vestingHours: 48,
    chainReader: {
      async readSnapshot({ wallet }) {
        return {
          asset: USDC,
          blockNumber: 123,
          blockHash: `0x${"ab".repeat(32)}`,
          blockTimestamp: 1_777_000_000,
          totalAssets: "20000000",
          totalSupply: "20000000",
          bufferAssets: "10500000",
          deployedPrincipal: "9500000",
          totalAssetCap: "1000000000",
          perAgentAssetCap: "100000000",
          wallet: wallet
            ? {
                assetBalance: "1000000",
                depositedAssets: "0",
                shares: "0",
                availableShares: "0",
                allowance: "0"
              }
            : undefined
        };
      }
    }
  });
  const poolInfoLive = await door.getInfo(SIGNER.address);
  assert.equal(poolInfoLive.available, true);
  assert.ok(poolInfoLive.sharePrice, "door info must carry sharePrice for the lock quote");
  const quote = await h.service.quote(SIGNER.address, {
    tier: "t90",
    amountRaw: "25000000",
    consentNonce: "seamnonce01"
  }, { poolInfo: poolInfoLive });
  assert.equal(quote.terms.tier, "t90");
  assert.ok(quote.consent.message.length > 0);
});

// A lock carries its pro-rata venue gain or loss, so the quote must not show
// the cost-basis NAV alone while the pool's own venue adapter contradicts it.
// The gate itself stays off this path: a lock encumbers AAC liquid and mints
// no pool shares, so it is not a money-in-at-a-wrong-price surface.
test("a locked-tier quote discloses the venue mark beside the cost-basis NAV", async () => {
  const h = harness();
  const mispriced = poolInfo(SIGNER.address, {
    totalAssets: { raw: "20395226", decimals: 6 },
    totalShares: { raw: "20501328", decimals: 6 },
    sharePrice: {
      model: "principal-cost-basis",
      assetsPerShare: { raw: "994824", decimals: 6 },
      numeratorAssetsRaw: "20395226",
      denominatorSharesRaw: "20501328"
    },
    markedSharePrice: {
      model: "venue-marked-to-adapter",
      assetsPerShare: { raw: "989946", decimals: 6 },
      numeratorAssetsRaw: "20295226",
      denominatorSharesRaw: "20501328"
    },
    venueMark: {
      status: "shortfall_exceeds_tolerance",
      depositsBlocked: true,
      shortfall: { raw: "100000", decimals: 6 },
      source: "venue_adapter_managed_assets"
    }
  });
  const quote = await h.service.quote(SIGNER.address, {
    tier: "t30",
    amountRaw: "1000000",
    consentNonce: "quotevenuemark01"
  }, { poolInfo: mispriced });

  assert.equal(quote.nav.sharePrice.assetsPerShare.raw, "994824");
  assert.equal(quote.markedSharePrice.assetsPerShare.raw, "989946");
  assert.equal(quote.venueMark.status, "shortfall_exceeds_tolerance");
  // The lock is still quoted: it encumbers AAC liquid and mints no pool
  // shares, so the deposit gate deliberately does not reach this path.
  assert.equal(quote.consent.required, true);
  // The hashed consent artifact keeps its existing shape.
  assert.equal(quote.terms.venueMark, undefined);
  assert.equal(quote.terms.markedSharePrice, undefined);
});

test("a quote with no venue mark available reports null rather than an absent field", async () => {
  const h = harness();
  const quote = await h.service.quote(SIGNER.address, {
    tier: "t30",
    amountRaw: "1000000",
    consentNonce: "quotenomark0001"
  }, { poolInfo: h.poolInfo });
  assert.equal(quote.venueMark, null);
  assert.equal(quote.markedSharePrice, null);
});
