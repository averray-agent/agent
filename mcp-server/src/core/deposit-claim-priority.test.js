import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PRIORITY_WINDOW_SECONDS,
  MAX_PRIORITY_WINDOW_SECONDS,
  PRIORITY_WINDOW_ACTIVE_REASON,
  createDepositClaimPriorityPolicy,
  loadDepositClaimPriorityConfig
} from "./deposit-claim-priority.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LISTED_AT = "2026-08-22T12:00:00.000Z";

function job(overrides = {}) {
  return {
    id: "curated-priority-1",
    category: "coding",
    tier: "starter",
    rewardAsset: "USDC",
    rewardAmount: 0.25,
    onboardingWaiverEligible: false,
    lifecycle: { status: "open", createdAt: LISTED_AT, updatedAt: LISTED_AT },
    ...overrides
  };
}

function policy({ capacity, lockedTierPriority, now = "2026-08-22T12:02:00.000Z" } = {}) {
  return createDepositClaimPriorityPolicy({
    config: {
      enabled: true,
      windowSeconds: 300,
      thresholdRaw: 1_000_000n,
      thresholdUsdc: "1"
    },
    workerExposurePolicy: {
      capacityForWallet: async () => capacity ?? {
        vestedAssetsRaw: "0",
        vestingAvailable: true,
        credit: { available: true, outstandingDebtRaw: "0" }
      }
    },
    lockedTierPriorityReader: lockedTierPriority
      ? async () => lockedTierPriority
      : undefined,
    now: () => new Date(now)
  });
}

test("deposit claim priority defaults off at 300 seconds and 1.0 USDC", () => {
  const config = loadDepositClaimPriorityConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.windowSeconds, DEFAULT_PRIORITY_WINDOW_SECONDS);
  assert.equal(config.thresholdRaw, 1_000_000n);
  assert.equal(config.thresholdUsdc, "1");

  const dormant = createDepositClaimPriorityPolicy({ config });
  assert.deepEqual(dormant.listingFor(job()), { listedAt: LISTED_AT });
});

test("the non-yield tier-perks rollout activates the existing priority window", () => {
  const config = loadDepositClaimPriorityConfig({ NON_YIELD_TIER_PERKS_ENABLED: "true" });
  assert.equal(config.enabled, true);
  assert.equal(config.windowSeconds, DEFAULT_PRIORITY_WINDOW_SECONDS);
  assert.equal(config.thresholdUsdc, "1");
});

test("priority window clamps values above the 1800-second hard ceiling and warns", () => {
  const warnings = [];
  const config = loadDepositClaimPriorityConfig(
    { PRIORITY_WINDOW_SECONDS: "9999" },
    { logger: { warn: (...args) => warnings.push(args) } }
  );
  assert.equal(config.windowSeconds, MAX_PRIORITY_WINDOW_SECONDS);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0].configuredSeconds, 9_999);
  assert.equal(warnings[0][0].effectiveSeconds, 1_800);
  assert.equal(warnings[0][1], "deposit_claim_priority.window_clamped");
});

test("curated and ingested inventory is windowed while waiver starter and external jobs never are", () => {
  const value = policy();
  const expectedWindowedListing = {
    listedAt: LISTED_AT,
    priorityWindow: {
      openAt: "2026-08-22T12:05:00.000Z",
      qualifiesWith: "≥ 1 USDC vested deposit and no outstanding credit draw"
    }
  };
  assert.deepEqual(value.listingFor(job()), expectedWindowedListing);
  assert.deepEqual(
    value.listingFor(job({ source: { type: "github_issue" } })),
    expectedWindowedListing
  );
  assert.deepEqual(
    value.listingFor(job({ onboardingWaiverEligible: true })),
    { listedAt: LISTED_AT }
  );
  assert.deepEqual(
    value.listingFor(job({ source: { type: "external" } })),
    { listedAt: LISTED_AT }
  );
});

test("qualifying vested wallet passes inside the priority window", async () => {
  const decision = await policy({
    capacity: {
      vestedAssetsRaw: "1000000",
      vestingAvailable: true,
      credit: { available: true, outstandingDebtRaw: "0" }
    }
  }).assessClaim({ wallet: WALLET, job: job() });
  assert.equal(decision.active, true);
  assert.equal(decision.eligible, true);
  assert.equal(decision.status, "priority_qualified");
  assert.equal(decision.qualification.qualifies, true);
});

test("active 7d commitment gains priority claim access without a vested pool deposit", async () => {
  const decision = await policy({
    capacity: {
      vestedAssetsRaw: "0",
      vestingAvailable: true,
      credit: { available: true, outstandingDebtRaw: "0" },
      tierPerks: {
        tier: "t7",
        priorityClaimAccess: {
          access: "priority",
          rank: 1,
          eligibleDuringPriorityWindow: true
        }
      }
    }
  }).assessClaim({ wallet: WALLET, job: job() });
  assert.equal(decision.eligible, true);
  assert.equal(decision.qualification.depositQualified, false);
  assert.equal(decision.qualification.committedTierQualified, true);
  assert.equal(decision.qualification.lockedTierPriority.tier, "t7");
});

test("non-qualifying wallet is refused by name inside and succeeds after openAt", async () => {
  const inside = policy();
  const insideDecision = await inside.assessClaim({ wallet: WALLET, job: job() });
  assert.equal(insideDecision.eligible, false);
  assert.equal(insideDecision.reason, PRIORITY_WINDOW_ACTIVE_REASON);
  await assert.rejects(
    () => inside.requireClaim({ wallet: WALLET, job: job() }),
    (error) => {
      assert.equal(error.code, PRIORITY_WINDOW_ACTIVE_REASON);
      assert.equal(error.details.openAt, "2026-08-22T12:05:00.000Z");
      return true;
    }
  );

  const after = await policy({ now: "2026-08-22T12:05:00.000Z" })
    .assessClaim({ wallet: WALLET, job: job() });
  assert.equal(after.active, false);
  assert.equal(after.eligible, true);
  assert.equal(after.status, "open_to_everyone");
});

test("outstanding credit draw refuses priority despite enough vested deposit", async () => {
  const decision = await policy({
    capacity: {
      vestedAssetsRaw: "5000000",
      vestingAvailable: true,
      credit: { available: true, outstandingDebtRaw: "1" }
    }
  }).assessClaim({ wallet: WALLET, job: job() });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, PRIORITY_WINDOW_ACTIVE_REASON);
  assert.equal(decision.qualification.depositQualified, true);
  assert.equal(decision.qualification.noOutstandingCreditDraw, false);
});

test("deposit priority reads the locked-tier rank without changing admission", async () => {
  const base = {
    capacity: {
      vestedAssetsRaw: "5000000",
      vestingAvailable: true,
      credit: { available: true, outstandingDebtRaw: "0" }
    }
  };
  const t90 = await policy({
    ...base,
    lockedTierPriority: { tier: "t90", rank: 2, perksActive: true }
  }).assessClaim({ wallet: WALLET, job: job() });
  const t30 = await policy({
    ...base,
    lockedTierPriority: { tier: "t30", rank: 1, perksActive: true }
  }).assessClaim({ wallet: WALLET, job: job() });
  const flex = await policy(base).assessClaim({ wallet: WALLET, job: job() });
  assert.equal(t90.eligible, true);
  assert.equal(t30.eligible, true);
  assert.equal(flex.eligible, true);
  assert.ok(
    t90.qualification.lockedTierPriority.rank
      > t30.qualification.lockedTierPriority.rank
  );
  assert.ok(
    t30.qualification.lockedTierPriority.rank
      > flex.qualification.lockedTierPriority.rank
  );
});
