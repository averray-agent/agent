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

function activationLock({
  amountRaw = "25000000",
  daysRemaining = 89,
  id = `0x${"ee".repeat(32)}`,
  tier = "t90"
} = {}) {
  return {
    id,
    wallet: SIGNER.address.toLowerCase(),
    tier,
    amountRaw,
    lockedAt: START.toISOString(),
    termDays: tier === "t90" ? 90 : 30,
    expiresAt: new Date(START.getTime() + daysRemaining * DAY_MS).toISOString(),
    status: "active"
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

test("today's 25-USDC T90 cohort opens on its 89-day remaining cycle", async () => {
  const h = harness({ now: new Date(START.getTime() + DAY_MS) });
  await seedActiveT90(h);
  const gate = (await h.service.getPoolTelemetry()).activationGate;
  assert.equal(gate.projection.cycleDays, 89);
  assert.deepEqual(gate.projection.projectedCycleYield, { raw: "301127", decimals: 6 });
  assert.equal(gate.open, true);
  assert.deepEqual(gate.blockers, []);
  assert.deepEqual(gate.projection.cycleBasis, {
    kind: "shortest_remaining_lock_term",
    shortestRemainingTermDays: 89,
    activeLocksConsidered: 1
  });
});

test("a 25-USDC T90 lock with 10 days remaining closes the activation gate", () => {
  const gate = lockedTierActivationGate([
    activationLock({ daysRemaining: 10 })
  ], START);
  assert.equal(gate.projection.cycleDays, 10);
  assert.equal(gate.projection.projectedCycleYield.raw, "33834");
  assert.equal(gate.open, false);
  assert.deepEqual(gate.blockers, ["projected_cycle_yield_below_2x_friction"]);
});

test("a new T30 lock shortens the shared cycle and recomputes the larger cohort", () => {
  const gate = lockedTierActivationGate([
    activationLock(),
    activationLock({
      amountRaw: "10000000",
      daysRemaining: 30,
      id: `0x${"ef".repeat(32)}`,
      tier: "t30"
    })
  ], START);
  assert.equal(gate.totalLocked.raw, "35000000");
  assert.equal(gate.projection.cycleDays, 30);
  assert.equal(gate.projection.projectedCycleYield.raw, "142105");
  assert.equal(gate.projection.cycleBasis.activeLocksConsidered, 2);
});

test("the 15-USDC activation floor still binds independently of a long cycle", () => {
  const gate = lockedTierActivationGate([
    activationLock({ amountRaw: "14999999" })
  ], START);
  assert.equal(gate.projection.cycleDays, 89);
  assert.equal(gate.open, false);
  assert.deepEqual(gate.blockers, ["locked_cohort_below_minimum"]);
});

test("activation-gate-cannot-be-config-opened: config and entry overrides cannot override cohort economics", () => {
  const config = loadLockedTierConfig({
    LOCKED_TIERS_ENABLED: "true",
    LOCKED_TIER_ACTIVATION_GATE_OPEN: "true",
    LOCKED_TIER_PROJECTED_YIELD_RAW: "999999999",
    LOCKED_TIER_CYCLE_DAYS: "999",
    LOCKED_TIER_YIELD_MARGIN_MULTIPLE: "0"
  });
  assert.equal(config.enabled, true);
  assert.equal(Object.hasOwn(config, "activationGateOpen"), false);
  const gate = lockedTierActivationGate([{
    ...activationLock({ amountRaw: "3820000", daysRemaining: 10 }),
    cycleDays: 999,
    remainingTermDays: 999,
    yieldMarginMultiple: 0
  }], START);
  assert.equal(gate.open, false);
  assert.equal(gate.projection.cycleDays, 10);
  assert.equal(gate.friction.marginMultiple, 2);
  assert.deepEqual(gate.blockers, [
    "locked_cohort_below_minimum",
    "projected_cycle_yield_below_2x_friction"
  ]);
});

test("an unreadable active-lock composition fails closed with a named reason", () => {
  const gate = lockedTierActivationGate(undefined, START);
  assert.equal(gate.open, false);
  assert.deepEqual(gate.blockers, ["locked_cohort_composition_unavailable"]);
  assert.equal(gate.projection.cycleDays, null);
  assert.equal(gate.projection.cycleBasis.activeLocksConsidered, null);
});

test("zero active locks close cleanly without division by zero", () => {
  const gate = lockedTierActivationGate([], START);
  assert.equal(gate.open, false);
  assert.equal(gate.totalLocked.raw, "0");
  assert.equal(gate.projection.cycleDays, 0);
  assert.equal(gate.projection.projectedCycleYield.raw, "0");
  assert.equal(gate.projection.cycleBasis.activeLocksConsidered, 0);
  assert.deepEqual(gate.blockers, [
    "locked_cohort_below_minimum",
    "projected_cycle_yield_below_2x_friction"
  ]);
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
