import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";

import { MemoryStateStore } from "../core/state-store.js";
import {
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

function harness({ liquidRaw = "50000000", creditRaw = "0", now = START } = {}) {
  const stateStore = new MemoryStateStore();
  let clock = new Date(now);
  let outstandingDebtRaw = creditRaw;
  const service = new LockedTierService({
    stateStore,
    accountPositionReader: async (wallet) => ({
      wallet,
      asset: { address: USDC, symbol: "USDC", decimals: 6 },
      position: { liquidRaw, jobStakeLockedRaw: "0" }
    }),
    creditPositionReader: async () => ({
      credit: { available: true, outstandingDebtRaw }
    }),
    config: {
      enabled: true,
      perWalletCapRaw: 25_000_000n,
      perWalletCapUsdc: "25",
      cohortCapRaw: 1_000_000_000n,
      cohortCapUsdc: "1000"
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
    setCredit(value) { outstandingDebtRaw = String(value); }
  };
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

test("T90 perks fail closed while the credit position cannot prove no draw", async () => {
  const h = harness();
  await signedLock(h, { tier: "t90", publicProfileOptIn: true });
  h.service.creditPositionReader = async () => ({
    credit: { available: false, reason: "credit_pool_read_failed" }
  });

  const state = await h.service.getWalletState(SIGNER.address);
  assert.equal(state.tier, "flex");
  assert.equal(state.perksActive, false);
  assert.equal(state.perksSuspendedReason, "credit_position_unavailable");
  assert.equal(await h.service.getPublicCommitment(SIGNER.address), undefined);
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

test("activation-gate-cannot-be-config-opened: config values cannot override the pure economic gate", () => {
  const config = loadLockedTierConfig({
    LOCKED_TIERS_ENABLED: "true",
    LOCKED_TIER_ACTIVATION_GATE_OPEN: "true",
    LOCKED_TIER_PROJECTED_YIELD_RAW: "999999999"
  });
  assert.equal(config.enabled, true);
  assert.equal(Object.hasOwn(config, "activationGateOpen"), false);
  const gate = lockedTierActivationGate(3_820_000n);
  assert.equal(gate.open, false);
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
