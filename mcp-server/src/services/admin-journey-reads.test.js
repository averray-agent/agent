import assert from "node:assert/strict";
import test from "node:test";

import { SelfIdentityRegistry } from "../core/self-identity-registry.js";
import { AdminJourneyReadService } from "./admin-journey-reads.js";

const WORKER = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x2222222222222222222222222222222222222222";
const NOW = Date.parse("2026-08-22T12:30:00.000Z");
const COLLECTION_SINCE = Date.parse("2026-08-22T10:00:00.000Z");

function harness({ sessions = [], events = [], operatorWallets = [] } = {}) {
  return new AdminJourneyReadService({
    now: () => NOW,
    arrivalObservatory: {
      async getPreAuthTimelineState() {
        return {
          collectionSinceMs: COLLECTION_SINCE,
          retentionDays: 30,
          buckets: [
            {
              startMs: Date.parse("2026-08-22T10:00:00.000Z"),
              counts: [
                { surface: "manifest", clientClass: "claude", count: 2 },
                { surface: "jobs_reads", clientClass: "cursor", count: 1 }
              ]
            },
            {
              startMs: Date.parse("2026-08-22T11:00:00.000Z"),
              counts: [{ surface: "manifest", clientClass: "claude", count: 1 }]
            }
          ]
        };
      }
    },
    identityRegistry: new SelfIdentityRegistry({ operatorWallets }),
    platformService: {
      async collectSessionHistory(wallet) {
        return sessions.filter((session) => session.wallet === wallet);
      },
      async listRecentSessions() {
        return sessions;
      }
    },
    stateStore: {
      async listJourneyEvents({ wallet } = {}) {
        return {
          events: events.filter((event) => event.wallet.toLowerCase() === wallet),
          gap: false
        };
      },
      async listEventLog({ wallet } = {}) {
        return {
          events: wallet ? events.filter((event) => event.wallet === wallet) : events,
          gap: false
        };
      }
    }
  });
}

test("arrival timeline emits hourly aggregate-only rows with an explicit cutover", async () => {
  const result = await harness().getArrivalTimeline("48h");
  assert.equal(result.collectionSince, "2026-08-22T10:00:00.000Z");
  assert.equal(result.window.bucket, "hour");
  assert.equal(result.window.bucketCount, 48);
  assert.equal(result.window.backfilled, false);
  assert.deepEqual(result.buckets.at(-3).counts, [
    { surface: "jobs_reads", clientClass: "cursor", count: 1 },
    { surface: "manifest", clientClass: "claude", count: 2 }
  ]);
  assert.equal(result.buckets.at(-3).total, 3);
  assert.equal(result.buckets.at(-2).total, 1);
  assert.deepEqual(result.privacy, {
    aggregateOnly: true,
    containsWallets: false,
    containsNetworkIdentifiers: false,
    containsRawUserAgents: false
  });
  assert.doesNotMatch(JSON.stringify(result), /0x[a-f0-9]{40}|203\.0\.113/u);
});

test("30d arrival timeline rolls hourly source buckets into UTC days", async () => {
  const result = await harness().getArrivalTimeline("30d");
  assert.equal(result.window.bucket, "day");
  assert.equal(result.window.bucketCount, 30);
  assert.equal(result.buckets.at(-1).start, "2026-08-22T00:00:00.000Z");
  assert.equal(result.buckets.at(-1).total, 4);
  assert.deepEqual(result.buckets.at(-1).counts, [
    { surface: "jobs_reads", clientClass: "cursor", count: 1 },
    { surface: "manifest", clientClass: "claude", count: 3 }
  ]);
});

test("worker journeys join exact wallet events, session transitions, verification, and settlement", async () => {
  const sessions = [{
    sessionId: "session-1",
    wallet: WORKER,
    jobId: "job-1",
    status: "resolved",
    updatedAt: "2026-08-22T10:06:00.000Z",
    resolvedAt: "2026-08-22T10:06:00.000Z",
    statusHistory: [
      { to: "claimed", at: "2026-08-22T10:03:00.000Z" },
      { to: "submitted", at: "2026-08-22T10:04:00.000Z" },
      { to: "resolved", at: "2026-08-22T10:06:00.000Z" }
    ],
    verification: {
      outcome: "approved",
      reasonCode: "BENCHMARK_MATCH",
      session: { updatedAt: "2026-08-22T10:06:00.000Z" },
      payoutTx: { status: 1, txHash: `0x${"a".repeat(64)}` }
    },
    payoutTx: { status: 1, txHash: `0x${"a".repeat(64)}` }
  }];
  const events = [
    journeyEvent("journey.auth_nonce_issued", "2026-08-22T10:00:00.000Z", { outcome: "issued" }),
    journeyEvent("journey.auth_verified", "2026-08-22T10:01:00.000Z", { outcome: "succeeded" }),
    journeyEvent("journey.preflight_completed", "2026-08-22T10:02:00.000Z", {
      jobId: "job-1", eligible: true, reason: "eligible", claimable: true, claimFundingSufficient: true
    }, { jobId: "job-1" }),
    journeyEvent("journey.withdrawal_intent_created", "2026-08-22T10:07:00.000Z", {
      status: "created", gasGrantRequested: true, gasGrantStatus: "granted"
    }),
    {
      id: "gas-1",
      topic: "operator_gas.first_withdrawal_granted",
      wallet: WORKER,
      timestamp: "2026-08-22T10:08:00.000Z",
      txHash: `0x${"b".repeat(64)}`,
      data: {}
    }
  ];

  const result = await harness({ sessions, events }).getWorkerJourneys({ wallet: WORKER, limit: 10 });
  assert.equal(result.collectionSince, "2026-08-22T10:00:00.000Z");
  assert.equal(result.window.journeyEventPerWalletCap, 250);
  assert.equal(result.window.sessionReadCap, 10_000);
  assert.equal(result.journeys[0].classification, "external");
  assert.equal(result.journeys[0].classificationAuthority, "shared_self_identity_registry");
  assert.deepEqual(result.journeys[0].events.map((event) => event.type), [
    "first_seen",
    "auth_nonce",
    "signed_in",
    "preflighted",
    "claimed",
    "submitted",
    "verified",
    "settled",
    "withdrawal_intent",
    "gas_grant"
  ]);
  assert.ok(result.journeys[0].events.every((event) => event.timestamp && event.sourceStore));
  assert.equal(result.journeys[0].events.find((event) => event.type === "claimed").durationFromPreviousMs, 60_000);
  assert.equal(result.journeys[0].events.find((event) => event.type === "settled").txHash, `0x${"a".repeat(64)}`);
  assert.equal(result.journeys[0].events.find((event) => event.type === "gas_grant").txHash, `0x${"b".repeat(64)}`);
});

test("pre-cutover journeys show recoverable session events without synthesizing auth or preflight", async () => {
  const sessions = [{
    sessionId: "legacy-session",
    wallet: OPERATOR,
    jobId: "legacy-job",
    updatedAt: "2026-08-21T09:02:00.000Z",
    statusHistory: [
      { to: "claimed", at: "2026-08-21T09:00:00.000Z" },
      { to: "submitted", at: "2026-08-21T09:02:00.000Z" }
    ]
  }];
  const result = await harness({ sessions, operatorWallets: [OPERATOR] })
    .getWorkerJourneys({ wallet: OPERATOR });
  assert.equal(result.journeys[0].classification, "operator-run");
  assert.deepEqual(result.journeys[0].events.map((event) => event.type), [
    "claimed", "submitted"
  ]);
  assert.ok(result.journeys[0].events.every((event) => !["signed_in", "preflighted"].includes(event.type)));
});

function journeyEvent(topic, timestamp, data, extra = {}) {
  return {
    id: `${topic}-${timestamp}`,
    topic,
    wallet: WORKER,
    timestamp,
    data,
    ...extra
  };
}
