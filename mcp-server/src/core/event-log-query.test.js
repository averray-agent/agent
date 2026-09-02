import test from "node:test";
import assert from "node:assert/strict";

import { listEventLogFromRecords, normalizeListLimit } from "./event-log-query.js";

const records = [
  {
    id: "event-1",
    topic: "escrow.job_funded",
    source: "chain",
    phase: "funding",
    severity: "info",
    wallet: "0xaaa",
    wallets: ["0xaaa"],
    jobId: "job-1",
    correlationId: "job-1",
    timestamp: "2026-01-01T00:00:00.000Z"
  },
  {
    id: "event-2",
    topic: "xcm.settlement_failed",
    source: "settlement",
    phase: "settlement",
    severity: "error",
    wallet: "0xaaa",
    wallets: ["0xaaa"],
    jobId: "job-1",
    correlationId: "settlement-1",
    timestamp: "2026-01-01T00:00:01.000Z"
  },
  {
    id: "event-3",
    topic: "session.claimed",
    source: "state",
    phase: "claim",
    severity: "info",
    wallet: "0xbbb",
    wallets: ["0xbbb"],
    jobId: "job-2",
    correlationId: "session-1",
    timestamp: "2026-01-01T00:00:02.000Z"
  }
];

test("listEventLogFromRecords returns the latest limited events without a cursor", () => {
  const result = listEventLogFromRecords(records, { limit: 2 });

  assert.equal(result.gap, false);
  assert.deepEqual(result.events.map((event) => event.id), ["event-2", "event-3"]);
});

test("listEventLogFromRecords filters the latest page without a cursor", () => {
  const result = listEventLogFromRecords(records, {
    wallet: "0xaaa",
    sources: ["settlement"],
    limit: 10
  });

  assert.equal(result.gap, false);
  assert.deepEqual(result.events.map((event) => event.id), ["event-2"]);
});

test("listEventLogFromRecords returns a forward page after a cursor", () => {
  const result = listEventLogFromRecords(records, {
    jobId: "job-1",
    lastEventId: "event-1",
    limit: 10
  });

  assert.equal(result.gap, false);
  assert.deepEqual(result.events.map((event) => event.id), ["event-2"]);
});

test("listEventLogFromRecords reports a gap only when a missing cursor has records behind it", () => {
  const missingCursor = listEventLogFromRecords(records, { lastEventId: "missing", limit: 2 });
  assert.equal(missingCursor.gap, true);
  assert.deepEqual(missingCursor.events.map((event) => event.id), ["event-1", "event-2"]);

  const empty = listEventLogFromRecords([], { lastEventId: "missing", limit: 2 });
  assert.equal(empty.gap, false);
  assert.deepEqual(empty.events, []);
});

test("normalizeListLimit falls back for invalid limits and caps valid limits", () => {
  assert.equal(normalizeListLimit(undefined, 100, 500), 100);
  assert.equal(normalizeListLimit("nope", 100, 500), 100);
  assert.equal(normalizeListLimit(0, 100, 500), 100);
  assert.equal(normalizeListLimit(-3, 100, 500), 100);
  assert.equal(normalizeListLimit(12.9, 100, 500), 12);
  assert.equal(normalizeListLimit(900, 100, 500), 500);
});
