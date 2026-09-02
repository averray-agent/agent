import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_OVERLAY_CLASSIFICATION,
  AccountMutationService
} from "./account-mutation-service.js";

function makeService(seedAccount) {
  const accounts = new Map();
  if (seedAccount) {
    accounts.set(seedAccount.wallet, seedAccount);
  }
  // getAccountSummary is unused for the precedence tests below — they
  // exercise `attachStoredTreasuryMetadata` directly. Pass a stub so
  // the constructor signature is satisfied.
  const getAccountSummary = async () => ({});
  return { accounts, service: new AccountMutationService(accounts, undefined, getAccountSummary) };
}

test("ACCOUNT_OVERLAY_CLASSIFICATION enumerates every field the service stores", () => {
  // Locks the classification table at module-load time so a future
  // contributor adding a new overlay field has to explicitly classify
  // it (and update this test) before it can ship.
  const expected = new Set([
    "liquid",
    "reserved",
    "strategyAllocated",
    "collateralLocked",
    "jobStakeLocked",
    "debtOutstanding",
    "strategyShares",
    "strategyActivity",
    "strategyPending",
    "strategyAccounting",
    "recurringTemplateReserves",
    "treasuryTimeline"
  ]);
  const actual = new Set(Object.keys(ACCOUNT_OVERLAY_CLASSIFICATION));
  assert.deepEqual(actual, expected);

  // Spot-check the four classification buckets exist with sensible
  // assignments. If you change any of these, also update the field
  // table in the docstring at the top of account-mutation-service.js.
  assert.equal(ACCOUNT_OVERLAY_CLASSIFICATION.liquid, "chain_authoritative");
  assert.equal(ACCOUNT_OVERLAY_CLASSIFICATION.strategyShares, "derived_cache");
  assert.equal(ACCOUNT_OVERLAY_CLASSIFICATION.recurringTemplateReserves, "derived_cache");
  assert.equal(ACCOUNT_OVERLAY_CLASSIFICATION.strategyActivity, "display_only");
  assert.equal(ACCOUNT_OVERLAY_CLASSIFICATION.treasuryTimeline, "display_only");
});

test("attachStoredTreasuryMetadata — live wins over stored for derived_cache fields (strategyShares)", () => {
  const wallet = "0xabc";
  const { service } = makeService({
    wallet,
    strategyShares: { "default-low-risk": 80, "stale-strategy": 7 }
  });

  const live = {
    wallet,
    strategyShares: { "default-low-risk": 100 }
  };

  const merged = service.attachStoredTreasuryMetadata(wallet, live);

  // Sub-key present in live → live wins.
  assert.equal(merged.strategyShares["default-low-risk"], 100);
  // Sub-key only in stored → gap-fill from stored.
  assert.equal(merged.strategyShares["stale-strategy"], 7);
});

test("attachStoredTreasuryMetadata — same live-wins rule for strategyPending and strategyAccounting", () => {
  const wallet = "0xabc";
  const { service } = makeService({
    wallet,
    strategyPending: {
      "default-low-risk": { lastStatus: "pending", pendingDepositAssets: 5 },
      "stale-strategy": { lastStatus: "succeeded", pendingDepositAssets: 0 }
    },
    strategyAccounting: {
      "default-low-risk": { principal: 50, markValue: 50, sharePrice: undefined }
    }
  });

  const live = {
    wallet,
    strategyPending: {
      "default-low-risk": { lastStatus: "succeeded", pendingDepositAssets: 0 }
    },
    strategyAccounting: {
      "default-low-risk": { principal: 50, markValue: 60, sharePrice: 1.2 }
    }
  };

  const merged = service.attachStoredTreasuryMetadata(wallet, live);

  // Live overlap wins per-strategy.
  assert.equal(merged.strategyPending["default-low-risk"].lastStatus, "succeeded");
  assert.equal(merged.strategyAccounting["default-low-risk"].markValue, 60);
  assert.equal(merged.strategyAccounting["default-low-risk"].sharePrice, 1.2);

  // Stored gap-fills for keys live does not surface.
  assert.equal(merged.strategyPending["stale-strategy"].lastStatus, "succeeded");
});

test("attachStoredTreasuryMetadata — live wins for recurring template reserve overlays", () => {
  const wallet = "0xabc";
  const { service } = makeService({
    wallet,
    recurringTemplateReserves: {
      templateA: { asset: "USDC", amount: 5 },
      templateStoredOnly: { asset: "USDC", amount: 3 }
    }
  });

  const live = {
    wallet,
    recurringTemplateReserves: {
      templateA: { asset: "USDC", amount: 7 }
    }
  };

  const merged = service.attachStoredTreasuryMetadata(wallet, live);

  assert.deepEqual(merged.recurringTemplateReserves.templateA, { asset: "USDC", amount: 7 });
  assert.deepEqual(merged.recurringTemplateReserves.templateStoredOnly, { asset: "USDC", amount: 3 });
});

test("attachStoredTreasuryMetadata — treasuryTimeline is display_only and comes from stored when live omits it", () => {
  const wallet = "0xabc";
  const storedTimeline = [
    { id: "treasury-2", at: "2026-05-15T00:00:00.000Z", kind: "allocate" },
    { id: "treasury-1", at: "2026-05-14T00:00:00.000Z", kind: "fund" }
  ];
  const { service } = makeService({ wallet, treasuryTimeline: storedTimeline });

  const live = { wallet, liquid: { USDC: 100 } };

  const merged = service.attachStoredTreasuryMetadata(wallet, live);

  // No treasuryTimeline on live → stored wins.
  assert.deepEqual(
    merged.treasuryTimeline.map((entry) => entry.id),
    ["treasury-2", "treasury-1"]
  );
});

test("attachStoredTreasuryMetadata — defensive live-wins when live ever begins surfacing treasuryTimeline", () => {
  // Today the gateway response shape has no treasuryTimeline. If a
  // future gateway begins providing one, the merge must prefer the
  // fresh live array over the stored breadcrumb log. This test locks
  // that defensive behavior in now so the regression is caught.
  const wallet = "0xabc";
  const { service } = makeService({
    wallet,
    treasuryTimeline: [{ id: "stored-1", at: "2026-05-14T00:00:00.000Z" }]
  });

  const live = {
    wallet,
    treasuryTimeline: [{ id: "live-1", at: "2026-05-17T00:00:00.000Z" }]
  };

  const merged = service.attachStoredTreasuryMetadata(wallet, live);

  assert.deepEqual(
    merged.treasuryTimeline.map((entry) => entry.id),
    ["live-1"]
  );
});

test("attachStoredTreasuryMetadata — top-level live fields override stored (the original spread)", () => {
  // Sanity: the previous behavior (`...liveAccount` first, then strategy
  // sub-merges) already had live winning at the top level for plain
  // scalar fields like `liquid` and `reserved`. The Package C fix only
  // changes the per-key precedence for the nested strategy maps. Lock
  // the top-level live-wins behavior so a future refactor doesn't
  // regress it.
  const wallet = "0xabc";
  const { service } = makeService({
    wallet,
    liquid: { USDC: 10 },
    reserved: { USDC: 5 }
  });

  const live = {
    wallet,
    liquid: { USDC: 200 },
    reserved: { USDC: 0 }
  };

  const merged = service.attachStoredTreasuryMetadata(wallet, live);
  assert.deepEqual(merged.liquid, { USDC: 200 });
  assert.deepEqual(merged.reserved, { USDC: 0 });
});
