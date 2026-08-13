import assert from "node:assert/strict";
import test from "node:test";

import { TreasurySummaryService } from "./treasury-summary.js";

const WALLET = "0x4444444444444444444444444444444444444444";
const NOW = Date.parse("2026-08-13T20:00:00.000Z");
const REQUEST_ID = `0x${"11".repeat(32)}`;

function harness(overrides = {}) {
  return new TreasurySummaryService({
    now: () => NOW,
    creditPoolDoor: {
      getInfo: async () => ({
        available: true,
        block: { number: 100, timestamp: NOW / 1_000, timestampIso: new Date(NOW).toISOString() },
        units: { asset: { symbol: "USDC", decimals: 6 } },
        wallet: {
          outstanding: { raw: "250000" },
          loanable: { raw: "1250000" }
        },
        schedule: { ltvBps: 5000, interestBps: 0 }
      })
    },
    gateway: {
      getActiveCreditPoolLoans: async () => [{
        loanId: `0x${"22".repeat(32)}`,
        outstandingRaw: "250000"
      }],
      getTreasuryStrategyLanes: async () => ({
        available: true,
        wrapper: "0x1111111111111111111111111111111111111111",
        block: { number: 101, timestamp: NOW / 1_000, timestampIso: new Date(NOW).toISOString() },
        rows: [
          { strategyId: "bank", asset: "0xasset", allocation: 2, allocationRaw: "2000000" },
          { strategyId: "pool", asset: "0xasset", allocation: 3, allocationRaw: "3000000" }
        ]
      }),
      getTreasuryPolicyStatus: async () => ({
        enabled: true,
        policyAddress: "0x2222222222222222222222222222222222222222",
        paused: false,
        owner: "0x3333333333333333333333333333333333333333",
        pauser: "0x5555555555555555555555555555555555555555",
        roles: {
          signerAddress: "0x6666666666666666666666666666666666666666",
          signerIsVerifier: true,
          signerIsSettlementBroker: true,
          signerIsStrategySettler: true
        },
        risk: {
          dailyOutflowCapRaw: "1000000",
          perAccountBorrowCapRaw: "2000000",
          minimumCollateralRatioBpsRaw: "15000"
        },
        readErrors: []
      })
    },
    platformService: {
      getAccountSummary: async () => ({
        raw: { debtOutstanding: { USDC: "500000" } }
      })
    },
    bankLaneFeed: {
      getFeed: async () => ({
        requests: { items: [{ id: REQUEST_ID }], readAtMs: NOW, lastError: null }
      })
    },
    stateStore: {
      listEventLog: async () => ({
        events: [
          { topic: "xcm.request_queued", blockNumber: 90, timestamp: new Date(NOW - 3_000).toISOString(), data: { requestId: REQUEST_ID } },
          { topic: "xcm.request_leg_dispatched", blockNumber: 91, timestamp: new Date(NOW - 2_000).toISOString(), data: { requestId: REQUEST_ID, leg: 1 } },
          { topic: "xcm.outcome_observed", timestamp: new Date(NOW - 1_000).toISOString(), data: { requestId: REQUEST_ID, status: "succeeded" } },
          { topic: "xcm.request_status_updated", blockNumber: 92, timestamp: new Date(NOW).toISOString(), data: { requestId: REQUEST_ID, statusLabel: "succeeded" } }
        ]
      })
    },
    ...overrides
  });
}

test("treasury summary composes four authoritative feeds for the signed-in wallet", async () => {
  const summary = await harness().getSummary(WALLET);

  assert.equal(summary.wallet, WALLET);
  assert.deepEqual(summary.warnings, []);
  assert.equal(summary.creditLine.usedRaw, "750000");
  assert.equal(summary.creditLine.headroomRaw, "1250000");
  assert.equal(summary.creditLine.totalRaw, "2000000");
  assert.equal(summary.creditLine.activeLoans.length, 2);
  assert.equal(summary.creditLine.activeLoans[1].source, "AgentAccountCore.positions.debtOutstanding");
  assert.equal(summary.summary.borrowCapacity, 1.25);
  assert.equal(summary.strategyLanes.rows.length, 2);
  assert.deepEqual(summary.strategyLanes.rows.map((row) => row.deploymentShareBps), [4000, 6000]);
  assert.equal(summary.summary.allocated, 5);
  assert.deepEqual(summary.xcmObserver.rows.map((row) => row.stage), ["request", "request", "observe", "settle"]);
  assert.equal(summary.xcmObserver.rows[1].leg, 1);
  assert.equal(summary.xcmObserver.rows[3].blockNumber, 92);
  assert.ok(summary.policyGate.rows.some((row) => row.source === "TreasuryPolicy.strategySettler"));
});

test("CreditPool loan enumeration mismatch fails closed with a 200-compatible warning payload", async () => {
  const service = harness({
    gateway: {
      getActiveCreditPoolLoans: async () => [],
      getTreasuryStrategyLanes: async () => ({ available: false, reason: "not_configured" }),
      getTreasuryPolicyStatus: async () => ({ enabled: false })
    }
  });
  const summary = await service.getSummary(WALLET);

  assert.equal(summary.creditLine.available, false);
  assert.equal(summary.creditLine.reason, "creditLine_read_failed");
  assert.equal(Object.hasOwn(summary.summary, "borrowCapacity"), false);
  assert.ok(summary.warnings.some((warning) => warning.code === "creditLine_read_failed"));
});

test("missing AgentAccountCore debt does not become an invented zero", async () => {
  const service = harness({
    platformService: {
      getAccountSummary: async () => ({ raw: { debtOutstanding: {} } })
    }
  });
  const summary = await service.getSummary(WALLET);

  assert.equal(summary.creditLine.available, false);
  assert.equal(Object.hasOwn(summary.summary, "borrowCapacity"), false);
  assert.ok(summary.warnings.some((warning) => warning.code === "creditLine_read_failed"));
});

test("stale and quiet sources preserve placeholders instead of emitting zero-valued feeds", async () => {
  const service = harness({
    chainMaxAgeMs: 1_000,
    observerMaxAgeMs: 1_000,
    creditPoolDoor: {
      getInfo: async () => ({
        available: true,
        block: { timestamp: (NOW - 2_000) / 1_000, timestampIso: new Date(NOW - 2_000).toISOString() }
      })
    },
    gateway: {
      getActiveCreditPoolLoans: async () => [],
      getTreasuryStrategyLanes: async () => ({
        available: true,
        block: { timestamp: (NOW - 2_000) / 1_000, timestampIso: new Date(NOW - 2_000).toISOString() },
        rows: []
      }),
      getTreasuryPolicyStatus: async () => ({ enabled: false })
    },
    bankLaneFeed: {
      getFeed: async () => ({ requests: { items: [], readAtMs: NOW, lastError: null } })
    }
  });
  const summary = await service.getSummary(WALLET);

  assert.equal(summary.strategyLanes.stale, true);
  assert.equal(summary.xcmObserver.reason, "xcm_observer_quiet");
  assert.equal(summary.xcmObserver.available, false);
  assert.equal(Object.hasOwn(summary.summary, "allocated"), false);
});

test("an incomplete TreasuryPolicy read hides all policy rows and names the fault", async () => {
  const service = harness();
  service.gateway.getTreasuryPolicyStatus = async () => ({
    enabled: true,
    readErrors: [{ field: "strategySettler(signer)" }]
  });
  const summary = await service.getSummary(WALLET);

  assert.equal(summary.policyGate.available, false);
  assert.equal(summary.policyGate.reason, "treasury_policy_read_incomplete");
  assert.ok(summary.warnings.some((warning) => warning.code === "treasury_policy_read_incomplete"));
});
