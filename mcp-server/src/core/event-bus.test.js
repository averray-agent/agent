import test from "node:test";
import assert from "node:assert/strict";

import { EventBus } from "./event-bus.js";

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
});
