import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SelfIdentityRegistry } from "../core/self-identity-registry.js";
import {
  OvernightLedgerService,
  createPersistedRewardBankHealthProvider,
  recordCapabilityWarningTransitions,
  recordDeployMarker
} from "./overnight-ledger.js";

const NOW = new Date("2026-08-24T06:00:00.000Z");
const EXTERNAL = "0xAa000000000000000000000000000000000000Aa";
const EXTERNAL_LOWER = EXTERNAL.toLowerCase();
const CANARY = "0xBb000000000000000000000000000000000000Bb";
const SIGNER_A = "0x1111111111111111111111111111111111111111";
const SIGNER_B = "0x2222222222222222222222222222222222222222";

function session({
  sessionId,
  wallet,
  workerAmountRaw,
  retainedRaw = "0",
  protocolFeeRaw = "0",
  claimNumber = 1,
  claimedAt = "2026-08-23T22:00:00.000Z",
  resolvedAt = "2026-08-23T23:00:00.000Z",
  canary = false
}) {
  return {
    sessionId,
    jobId: `job-${sessionId}`,
    wallet,
    status: "resolved",
    claimedAt,
    submittedAt: "2026-08-23T22:30:00.000Z",
    resolvedAt,
    updatedAt: resolvedAt,
    claimNumber,
    claimEconomicsWaivedAtClaim: retainedRaw === "0",
    gasRetention: {
      supported: true,
      brokered: true,
      waived: retainedRaw === "0",
      retentionFlatRaw: "100000",
      retentionCapBps: 2_000,
      rewardRaw: (BigInt(workerAmountRaw) + BigInt(retainedRaw)).toString(),
      retainedRaw
    },
    progression: {
      tier: claimNumber >= 3 ? "pro" : "starter",
      justChanged: claimNumber >= 3 ? { field: "tier", from: "starter", to: "pro" } : null
    },
    verificationSummary: { outcome: "approved" },
    payoutTx: {
      status: 1,
      txHash: `0x${sessionId.padStart(64, "0")}`,
      blockNumber: Number(sessionId),
      settlement: {
        worker: wallet,
        workerAmountRaw,
        protocolFeeAmountRaw: protocolFeeRaw,
        gasRetention: {
          retainedRaw,
          rewardRaw: (BigInt(workerAmountRaw) + BigInt(retainedRaw)).toString()
        }
      }
    },
    ...(canary ? {
      claimantAttribution: {
        kind: "hosted_worker_canary",
        evidence: "wallet_bound_marker_v1"
      }
    } : {})
  };
}

function fixture({ closingReservedRaw = "2200000" } = {}) {
  const sessions = [
    session({
      sessionId: "1",
      wallet: EXTERNAL,
      workerAmountRaw: "1000000",
      retainedRaw: "100000",
      protocolFeeRaw: "50000",
      claimNumber: 3
    }),
    // Deliberately use a second casing for the same external wallet. The
    // aggregation must still produce one wallet row.
    {
      ...session({
        sessionId: "2",
        wallet: EXTERNAL_LOWER,
        workerAmountRaw: "0",
        retainedRaw: "0",
        claimNumber: 2,
        claimedAt: "2026-08-23T21:00:00.000Z",
        resolvedAt: "2026-08-22T21:30:00.000Z"
      }),
      status: "claimed",
      resolvedAt: undefined,
      verificationSummary: undefined,
      payoutTx: undefined
    },
    session({
      sessionId: "3",
      wallet: CANARY,
      workerAmountRaw: "500000",
      retainedRaw: "0",
      canary: true
    })
  ];
  const events = [
    {
      id: "graduated",
      topic: "ops.wallet_graduated",
      wallet: EXTERNAL,
      timestamp: "2026-08-23T23:00:00.000Z",
      data: { from: "starter", to: "pro" }
    },
    {
      id: "claim-stuck",
      topic: "ops.claim_stuck",
      wallet: CANARY,
      timestamp: "2026-08-24T00:00:00.000Z",
      severity: "warn",
      data: { reason: "verification_timeout" }
    },
    {
      id: "withdrawal",
      topic: "account.withdrawn",
      wallet: EXTERNAL,
      timestamp: "2026-08-24T01:00:00.000Z",
      txHash: `0x${"a".repeat(64)}`,
      blockNumber: 99,
      data: { amount: "200000" }
    },
    {
      id: "deploy",
      topic: "ops.deploy",
      timestamp: "2026-08-24T02:00:00.000Z",
      data: { deployedSha: "b".repeat(40) }
    }
  ];
  const state = {
    snapshots: [
      {
        asOf: "2026-08-23T05:59:59.000Z",
        liquidRaw: "10000000",
        reservedRaw: "2000000",
        source: "fixture_position"
      },
      {
        asOf: NOW.toISOString(),
        liquidRaw: "8450000",
        reservedRaw: closingReservedRaw,
        source: "fixture_position"
      }
    ]
  };
  return {
    sessions,
    events,
    async listRecentSessions(limit, offset) {
      return sessions.slice(offset, offset + limit);
    },
    async getVerificationResult() { return undefined; },
    async listEventLog() { return { events, gap: false }; },
    async getServiceState(scope) {
      return scope === "overnight-ledger:reward-bank-snapshots" ? state : {};
    }
  };
}

function service(options = {}) {
  return new OvernightLedgerService({
    stateStore: options.store ?? fixture(options),
    selfIdentityRegistry: new SelfIdentityRegistry(),
    env: options.env ?? {
      AUTH_CHAIN_ID: "999999",
      SIGNER_ADDRESS: SIGNER_A,
      ONBOARDING_SUBSIDY_DAILY_BUDGET_USDC: "8"
    },
    now: () => NOW
  });
}

test("invariant 1 — ledger identity exposes the exact equality and never silently rebalances", async () => {
  const result = await service().getLedger("24h");
  const ledger = result.reconciliation;
  const expected = BigInt(ledger.openingLiquid.raw)
    - BigInt(ledger.payoutsOut.netUsdc.raw)
    + BigInt(ledger.retentionFeesIn.raw)
    - BigInt(ledger.reservedDelta.raw);
  assert.equal(expected.toString(), ledger.closingLiquid.raw);
  assert.equal(ledger.match, "CONFIRMED");
  assert.equal(ledger.delta.raw, "0");
  assert.equal(ledger.retentionFeesIn.raw, "150000");
});

test("invariant 2 — digest ledger state and delta consume the reconciliation derivation", async () => {
  const result = await service().getLedger("24h");
  assert.equal(result.digest.ledgerMatchState, result.reconciliation.match);
  assert.strictEqual(result.digest.ledgerDelta, result.reconciliation.delta);
});

test("invariant 3 — waiver slots and reputation progression remain two independent ladders", async () => {
  const result = await service().getLedger("24h");
  const worker = result.workers.items.find((row) => row.wallet === EXTERNAL_LOWER);
  assert.equal(worker.waiverSlotsUsed, 3);
  assert.equal(worker.waiverSlotsTotal, 3);
  assert.equal(worker.reputationTier, "pro");
  assert.deepEqual(worker.tierEvents.map((event) => event.to), ["pro"]);
  assert.equal(worker.retentionWaived.raw, "0");
  assert.equal("ladder" in worker, false);
});

test("invariant 4 — liquid-only runway is unchanged by an arbitrarily large reserved balance", async () => {
  const normal = await service({ closingReservedRaw: "2200000" }).getLedger("24h");
  const huge = await service({ closingReservedRaw: "90000200000" }).getLedger("24h");
  assert.equal(normal.rewardBankSplit.liquid.raw, huge.rewardBankSplit.liquid.raw);
  assert.equal(normal.rewardBankSplit.runwayDays, huge.rewardBankSplit.runwayDays);
  assert.notEqual(normal.rewardBankSplit.reserved.raw, huge.rewardBankSplit.reserved.raw);
  assert.equal(huge.rewardBankSplit.runwayBasis, "liquid_only");
});

test("invariant 5 — top-up route has no address literals and derives SS58 from runtime config", () => {
  const routeSource = readFileSync(
    new URL("../protocols/http/admin-overnight-ledger-routes.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(routeSource, /0x[0-9a-f]{40}/iu);
  assert.doesNotMatch(routeSource, /\b1[1-9A-HJ-NP-Za-km-z]{46,48}\b/u);
  assert.doesNotMatch(routeSource, /\b(?:gateway|provider|rpc)\b/iu);
  const env = { AUTH_CHAIN_ID: "999999", SIGNER_ADDRESS: SIGNER_A };
  const ledger = service({ env });
  const first = ledger.getTopupDestinations();
  env.SIGNER_ADDRESS = SIGNER_B;
  const second = ledger.getTopupDestinations();
  assert.notEqual(
    first.topupDestinations.signerGas.ss58Address,
    second.topupDestinations.signerGas.ss58Address
  );
  assert.equal(
    second.topupDestinations.signerGas.ss58Address,
    second.topupDestinations.rewardBank.ss58Address
  );
});

test("invariant 6 — wallet aggregation lowercases every key before grouping", async () => {
  const result = await service().getLedger("24h");
  const externalRows = result.workers.items.filter((row) => row.wallet === EXTERNAL_LOWER);
  assert.equal(externalRows.length, 1);
  assert.ok(result.workers.items.every((row) => row.wallet === row.wallet.toLowerCase()));
  assert.equal(externalRows[0].claims, 2);
});

test("invariant 7 — self identity is shared-registry classified and canaries stay out of digest counts", async () => {
  const result = await service().getLedger("24h");
  const canary = result.workers.items.find((row) => row.wallet === CANARY.toLowerCase());
  assert.equal(canary.selfIdentity.kind, "canary");
  assert.equal(canary.selfIdentity.self, true);
  assert.equal(result.digest.walletCount, 1);
  assert.equal(result.digest.settlementCount, 1);
  assert.equal(result.digest.paid.raw, "1500000");
  assert.equal(result.reconciliation.payoutsOut.count, 2);
  assert.equal(result.retention.protocolRevenueDelta.raw, "150000");
});

test("events retain a total count while returning at most the newest 200 rows", async () => {
  const base = fixture();
  base.events.splice(0, base.events.length, ...Array.from({ length: 205 }, (_, index) => ({
    id: `deploy-${index}`,
    topic: "ops.deploy",
    timestamp: new Date(Date.parse("2026-08-23T06:00:00.000Z") + index * 1_000).toISOString(),
    data: { index }
  })));
  const result = await service({ store: base }).getLedger("24h");
  assert.equal(result.events.totalCount, 205);
  assert.equal(result.events.items.length, 200);
  assert.equal(result.events.hasOlder, true);
  assert.equal(result.events.items[0].payload.index, 5);
});

test("reward-bank health polling persists exact liquid and reserved snapshots for read-only ledger requests", async () => {
  const writes = [];
  const provider = createPersistedRewardBankHealthProvider({
    getRewardBankHealth: async () => ({
      readable: true,
      account: SIGNER_A,
      asOf: NOW.toISOString(),
      liquidRaw: "8450000",
      reservedRaw: "2200000",
      decimals: 6,
      source: "agent_account_position"
    }),
    stateStore: {
      async getServiceState() { return {}; },
      async upsertServiceState(scope, value) { writes.push({ scope, value }); }
    }
  });
  await provider();
  assert.equal(writes[0].scope, "overnight-ledger:reward-bank-snapshots");
  assert.deepEqual(writes[0].value.snapshots[0], {
    account: SIGNER_A.toLowerCase(),
    asOf: NOW.toISOString(),
    liquidRaw: "8450000",
    reservedRaw: "2200000",
    decimals: 6,
    source: "agent_account_position"
  });
});

test("capability warnings and deploys emit at their lifecycle transitions rather than being reconstructed", async () => {
  const states = new Map();
  const published = [];
  const stateStore = {
    async getServiceState(scope) { return states.get(scope) ?? {}; },
    async upsertServiceState(scope, value) {
      states.set(scope, { ...(states.get(scope) ?? {}), ...value });
    }
  };
  const eventBus = { publish(event) { published.push(event); } };
  await recordCapabilityWarningTransitions({
    stateStore,
    eventBus,
    warnings: [{ code: "indexer_lagging" }],
    now: NOW
  });
  await recordCapabilityWarningTransitions({ stateStore, eventBus, warnings: [], now: NOW });
  assert.deepEqual(published.slice(0, 2).map((event) => event.topic), [
    "ops.capability_warning_opened",
    "ops.capability_warning_closed"
  ]);
  assert.equal(await recordDeployMarker({
    stateStore,
    eventBus,
    deployedSha: "a".repeat(40),
    now: NOW
  }), true);
  assert.equal(await recordDeployMarker({
    stateStore,
    eventBus,
    deployedSha: "a".repeat(40),
    now: NOW
  }), false);
  assert.equal(published.filter((event) => event.topic === "ops.deploy").length, 1);
});
