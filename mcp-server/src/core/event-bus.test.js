import test from "node:test";
import assert from "node:assert/strict";

import { EventBus } from "./event-bus.js";
import { MemoryStateStore } from "./state-store.js";

test("EventBus replays filtered events after a cursor", () => {
  const bus = new EventBus({ bufferSize: 3 });
  const seen = [];
  bus.subscribe({ wallet: "0xabc", topics: ["session.claimed"] }, (event) => seen.push(event.id));

  bus.publish({ id: "1", topic: "session.claimed", wallet: "0xabc", timestamp: new Date().toISOString() });
  bus.publish({ id: "2", topic: "session.submitted", wallet: "0xabc", timestamp: new Date().toISOString() });
  bus.publish({ id: "3", topic: "session.claimed", wallet: "0xdef", timestamp: new Date().toISOString() });
  bus.publish({ id: "4", topic: "session.claimed", wallet: "0xabc", timestamp: new Date().toISOString() });

  assert.deepEqual(seen, ["1", "4"]);

  const replay = bus.replay({ wallet: "0xabc", topics: ["session.claimed"] }, "2");
  assert.equal(replay.gap, false);
  assert.deepEqual(
    replay.events.map((event) => event.id),
    ["4"]
  );
});

test("EventBus reports gap when cursor is outside the ring buffer", () => {
  const bus = new EventBus({ bufferSize: 2 });
  bus.publish({ id: "a", topic: "alpha", wallet: "0xabc", timestamp: new Date().toISOString() });
  bus.publish({ id: "b", topic: "beta", wallet: "0xabc", timestamp: new Date().toISOString() });
  bus.publish({ id: "c", topic: "gamma", wallet: "0xabc", timestamp: new Date().toISOString() });

  const replay = bus.replay({ wallet: "0xabc" }, "a");
  assert.equal(replay.gap, true);
  assert.deepEqual(
    replay.events.map((event) => event.id),
    ["b", "c"]
  );
});

test("EventBus preserves canonical timeline fields and classifies chain topics", () => {
  const bus = new EventBus();
  const explicit = bus.publish({
    id: "explicit-1",
    topic: "custom.topic",
    wallet: " 0xabc ",
    jobId: " job-1 ",
    sessionId: " session-1 ",
    source: "custom_source",
    phase: "custom_phase",
    severity: "warn",
    correlationId: "correlation-1",
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  assert.equal(explicit.wallet, "0xabc");
  assert.equal(explicit.source, "custom_source");
  assert.equal(explicit.phase, "custom_phase");
  assert.equal(explicit.severity, "warn");
  assert.equal(explicit.correlationId, "correlation-1");

  const funded = bus.publish({
    id: "chain-1",
    topic: "escrow.job_funded",
    jobId: "job-2",
    timestamp: "2026-01-01T00:00:01.000Z"
  });
  assert.equal(funded.source, "chain");
  assert.equal(funded.phase, "funding");
  assert.equal(funded.severity, "info");
  assert.equal(funded.correlationId, "job-2");

  const rejected = bus.publish({
    id: "chain-2",
    topic: "escrow.job_rejected",
    jobId: "job-3",
    sessionId: "session-3",
    timestamp: "2026-01-01T00:00:02.000Z"
  });
  assert.equal(rejected.source, "chain");
  assert.equal(rejected.phase, "settlement");
  assert.equal(rejected.severity, "error");
  assert.equal(rejected.correlationId, "session-3");

  const localFunding = bus.publish({
    id: "funding-1",
    topic: "funding.claim_lock_recorded",
    jobId: "job-4",
    sessionId: "session-4",
    timestamp: "2026-01-01T00:00:03.000Z"
  });
  assert.equal(localFunding.source, "settlement");
  assert.equal(localFunding.phase, "funding");
  assert.equal(localFunding.severity, "info");

  const localSettlement = bus.publish({
    id: "settlement-1",
    topic: "settlement.session_rejected",
    jobId: "job-5",
    sessionId: "session-5",
    timestamp: "2026-01-01T00:00:04.000Z",
    data: { status: "rejected" }
  });
  assert.equal(localSettlement.source, "settlement");
  assert.equal(localSettlement.phase, "settlement");
  assert.equal(localSettlement.severity, "error");

  const localDispute = bus.publish({
    id: "dispute-1",
    topic: "dispute.opened",
    jobId: "job-6",
    sessionId: "session-6",
    timestamp: "2026-01-01T00:00:05.000Z"
  });
  assert.equal(localDispute.source, "settlement");
  assert.equal(localDispute.phase, "dispute");
  assert.equal(localDispute.severity, "warn");
});

test("EventBus classifies governance topics (policy, capability, service-token)", () => {
  const bus = new EventBus();

  const policy = bus.publish({
    id: "policy-1",
    topic: "policy.proposed",
    wallet: "0xadmin",
    timestamp: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(policy.source, "governance");
  assert.equal(policy.phase, "governance");
  assert.equal(policy.severity, "info");

  const grant = bus.publish({
    id: "grant-1",
    topic: "capability.grant",
    wallet: "0xadmin",
    timestamp: "2026-01-01T00:00:01.000Z"
  });
  assert.equal(grant.source, "governance");
  assert.equal(grant.phase, "capability");
  assert.equal(grant.severity, "info");

  // Revoke is the trust-removal signal; classifier escalates severity.
  const revoke = bus.publish({
    id: "revoke-1",
    topic: "capability.revoke",
    wallet: "0xadmin",
    timestamp: "2026-01-01T00:00:02.000Z"
  });
  assert.equal(revoke.source, "governance");
  assert.equal(revoke.phase, "capability");
  assert.equal(revoke.severity, "warn");

  const tokenIssue = bus.publish({
    id: "token-issue-1",
    topic: "service-token.issue",
    wallet: "0xadmin",
    timestamp: "2026-01-01T00:00:03.000Z"
  });
  assert.equal(tokenIssue.source, "governance");
  assert.equal(tokenIssue.phase, "service_token");
  assert.equal(tokenIssue.severity, "info");

  const tokenRotate = bus.publish({
    id: "token-rotate-1",
    topic: "service-token.rotate",
    wallet: "0xadmin",
    timestamp: "2026-01-01T00:00:04.000Z"
  });
  assert.equal(tokenRotate.severity, "info");

  const tokenRevoke = bus.publish({
    id: "token-revoke-1",
    topic: "service-token.revoke",
    wallet: "0xadmin",
    timestamp: "2026-01-01T00:00:05.000Z"
  });
  assert.equal(tokenRevoke.source, "governance");
  assert.equal(tokenRevoke.phase, "service_token");
  assert.equal(tokenRevoke.severity, "warn");
});

test("EventBus persists events and replays durable filters beyond the ring buffer", async () => {
  const store = new MemoryStateStore();
  const bus = new EventBus({ bufferSize: 1, eventStore: store });
  bus.publish({
    id: "funded-1",
    topic: "escrow.job_funded",
    wallet: "0xabc",
    jobId: "job-1",
    timestamp: "2026-01-01T00:00:00.000Z"
  });
  bus.publish({
    id: "submitted-1",
    topic: "session.submitted",
    wallet: "0xabc",
    jobId: "job-1",
    sessionId: "session-1",
    correlationId: "session-1",
    timestamp: "2026-01-01T00:00:01.000Z"
  });
  bus.publish({
    id: "settled-1",
    topic: "xcm.settlement_succeeded",
    wallet: "0xabc",
    jobId: "job-1",
    correlationId: "settlement-1",
    timestamp: "2026-01-01T00:00:02.000Z"
  });
  await bus.flush();

  const chainReplay = await bus.replayDurable({ jobId: "job-1", sources: ["chain"] }, undefined, { limit: 10 });
  assert.equal(chainReplay.gap, false);
  assert.deepEqual(chainReplay.events.map((event) => event.id), ["funded-1"]);

  const correlationReplay = await bus.replayDurable(
    { wallet: "0xabc", correlationId: "settlement-1" },
    undefined,
    { limit: 10 }
  );
  assert.deepEqual(correlationReplay.events.map((event) => event.id), ["settled-1"]);
});
