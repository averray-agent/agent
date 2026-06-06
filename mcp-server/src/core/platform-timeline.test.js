import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEventBusTimelineEntry,
  buildSessionTimelineEntries,
  buildTimelineEntry,
  buildVerificationTimelineEntry,
  compactTimelineData,
  compareTimelineEntries
} from "./platform-timeline.js";

test("buildSessionTimelineEntries turns status history into ordered session transition entries", () => {
  const entries = buildSessionTimelineEntries({
    jobId: "job-1",
    sessionId: "session-1",
    wallet: "0xworker",
    status: "resolved",
    statusHistory: [
      { from: "claimed", to: "submitted", at: "2026-01-01T00:00:01.000Z" },
      { from: "submitted", to: "resolved", at: "2026-01-01T00:00:02.000Z" }
    ]
  }, { correlationId: "corr-1" });

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.type), ["session_transition", "session_transition"]);
  assert.deepEqual(entries.map((entry) => entry.phase), ["verification", "terminal"]);
  assert.ok(entries.every((entry) => entry.correlationId === "corr-1"));
  assert.ok(entries.every((entry) => entry.timestamp === entry.at));
  assert.equal(entries[0].data.to, "submitted");
});

test("buildSessionTimelineEntries creates a snapshot when history is absent", () => {
  const [entry] = buildSessionTimelineEntries({
    jobId: "job-1",
    sessionId: "session-1",
    wallet: "0xworker",
    status: "disputed",
    updatedAt: "2026-01-01T00:00:03.000Z"
  });

  assert.equal(entry.type, "session_snapshot");
  assert.equal(entry.topic, "session.snapshot");
  assert.equal(entry.phase, "verification");
  assert.equal(entry.severity, "warn");
  assert.equal(entry.data.status, "disputed");
});

test("buildVerificationTimelineEntry includes verification metadata and omits undefined fields", () => {
  const entry = buildVerificationTimelineEntry({
    jobId: "job-1",
    sessionId: "session-1",
    wallet: "0xworker",
    updatedAt: "2026-01-01T00:00:04.000Z"
  }, {
    outcome: "rejected",
    reasonCode: "BAD_OUTPUT",
    handler: "benchmark",
    handlerVersion: 2,
    verifierConfigVersion: undefined
  });

  assert.equal(entry.type, "verification");
  assert.equal(entry.source, "verification");
  assert.equal(entry.severity, "error");
  assert.equal(entry.data.reasonCode, "BAD_OUTPUT");
  assert.ok(!("verifierConfigVersion" in entry.data));
});

test("buildEventBusTimelineEntry preserves durable event metadata", () => {
  const entry = buildEventBusTimelineEntry({
    id: "chain-funded-1",
    topic: "escrow.job_funded",
    source: "chain",
    phase: "funding",
    jobId: "job-1",
    sessionId: "session-1",
    wallet: "0xworker",
    blockNumber: 123n,
    txHash: "0xabc",
    timestamp: "2026-01-01T00:00:05.000Z",
    data: {
      amountRaw: "1000000"
    }
  }, 0);

  assert.equal(entry.id, "chain-funded-1");
  assert.equal(entry.type, "event_bus");
  assert.equal(entry.correlationId, "session-1");
  assert.equal(entry.data.topic, "escrow.job_funded");
  assert.equal(entry.data.blockNumber, 123n);
  assert.equal(entry.data.amountRaw, "1000000");
});

test("timeline helpers compact data and provide stable ordering", () => {
  assert.deepEqual(compactTimelineData({ a: 1, b: undefined, c: null }), {
    a: 1,
    c: null
  });

  const later = buildTimelineEntry({
    id: "b",
    type: "custom",
    at: "2026-01-01T00:00:02.000Z",
    correlationId: "corr",
    phase: "phase",
    topic: "topic"
  });
  const earlier = buildTimelineEntry({
    id: "a",
    type: "custom",
    at: "2026-01-01T00:00:01.000Z",
    correlationId: "corr",
    phase: "phase",
    topic: "topic"
  });

  assert.deepEqual([later, earlier].sort(compareTimelineEntries).map((entry) => entry.id), ["a", "b"]);
});
