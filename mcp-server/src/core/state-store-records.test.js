import test from "node:test";
import assert from "node:assert/strict";

import {
  cloneJsonRecord,
  filterCapabilityGrantRecords,
  filterFinalFundedJobRecords,
  listCapabilityGrantRecords,
  listFundedJobRecords,
  markXcmObservationFailedRecord,
  markXcmObservationProcessedRecord,
  mergeServiceStateRecord,
  mergeXcmObservationRecord,
  normalizeContentHash,
  normalizeFundedJobId,
  redisRangeFromLimitOffset,
  sliceWindow,
  timestampScore
} from "./state-store-records.js";

test("cloneJsonRecord returns an isolated JSON clone", () => {
  const original = { nested: { count: 1 } };
  const cloned = cloneJsonRecord(original);

  cloned.nested.count = 2;

  assert.equal(original.nested.count, 1);
  assert.equal(cloneJsonRecord(undefined), undefined);
});

test("state-store key helpers normalize content and funded job ids", () => {
  assert.equal(normalizeContentHash("0xABC"), "0xabc");
  assert.equal(normalizeContentHash(null), "");
  assert.equal(normalizeFundedJobId(123), "123");
  assert.equal(normalizeFundedJobId(null), "");
});

test("timestampScore preserves valid timestamps and falls back on invalid ones", () => {
  assert.equal(timestampScore("2026-01-01T00:00:00.000Z", 42), 1767225600000);
  assert.equal(timestampScore("not-a-date", 42), 42);
});

test("sliceWindow clamps offset and limit like the memory store", () => {
  assert.deepEqual(sliceWindow(["a", "b", "c"], { offset: -1, limit: 2 }), ["a", "b"]);
  assert.deepEqual(sliceWindow(["a", "b", "c"], { offset: 1, limit: 0 }), []);
});

test("redisRangeFromLimitOffset preserves inclusive Redis range semantics", () => {
  assert.deepEqual(redisRangeFromLimitOffset(10, 5), { start: 5, stop: 14 });
  assert.deepEqual(redisRangeFromLimitOffset(0, -1), { start: 0, stop: 0 });
});

test("listFundedJobRecords sorts latest first and filters final statuses", () => {
  const records = [
    { jobId: "open-old", fundedAt: "2026-01-01T00:00:00.000Z", finalStatus: "open" },
    { jobId: "merged-new", fundedAt: "2026-01-03T00:00:00.000Z", finalStatus: "merged" },
    { jobId: "reverted-mid", updatedAt: "2026-01-02T00:00:00.000Z", finalStatus: "reverted" }
  ];

  assert.deepEqual(listFundedJobRecords(records, { limit: 3 }).map((record) => record.jobId), [
    "merged-new",
    "reverted-mid",
    "open-old"
  ]);
  assert.deepEqual(listFundedJobRecords(records, { finalOnly: true }).map((record) => record.jobId), [
    "merged-new",
    "reverted-mid"
  ]);
  assert.deepEqual(filterFinalFundedJobRecords(records, true).map((record) => record.jobId), [
    "merged-new",
    "reverted-mid"
  ]);
});

test("mergeXcmObservationRecord preserves defaults and existing state", () => {
  const merged = mergeXcmObservationRecord(
    { requestId: "req-1", observedAt: "2026-01-01T00:00:00.000Z", attemptCount: 2 },
    { requestId: "req-1", status: "succeeded", processed: false },
    { now: "2026-01-02T00:00:00.000Z" }
  );

  assert.deepEqual(merged, {
    requestId: "req-1",
    observedAt: "2026-01-01T00:00:00.000Z",
    attemptCount: 2,
    status: "succeeded",
    processed: false
  });
});

test("xcm observation transition helpers preserve retry/process semantics", () => {
  const current = {
    requestId: "req-1",
    observedAt: "2026-01-01T00:00:00.000Z",
    attemptCount: 1,
    lastError: "old"
  };

  assert.deepEqual(markXcmObservationProcessedRecord(current, { ok: true }, { now: "2026-01-02T00:00:00.000Z" }), {
    requestId: "req-1",
    observedAt: "2026-01-01T00:00:00.000Z",
    attemptCount: 1,
    processed: true,
    processedAt: "2026-01-02T00:00:00.000Z",
    result: { ok: true },
    lastError: undefined
  });

  assert.deepEqual(markXcmObservationFailedRecord(current, new Error("boom"), { now: "2026-01-03T00:00:00.000Z" }), {
    requestId: "req-1",
    observedAt: "2026-01-01T00:00:00.000Z",
    attemptCount: 2,
    processed: false,
    lastError: "boom",
    lastTriedAt: "2026-01-03T00:00:00.000Z"
  });
});

test("mergeServiceStateRecord overlays state and stamps updatedAt", () => {
  assert.deepEqual(
    mergeServiceStateRecord(
      { cursor: "a", count: 1 },
      { count: 2, lastError: undefined },
      { now: "2026-01-01T00:00:00.000Z" }
    ),
    { cursor: "a", count: 2, lastError: undefined, updatedAt: "2026-01-01T00:00:00.000Z" }
  );
});

test("capability grant helpers filter by subject/status and keep newest first", () => {
  const records = [
    { id: "grant-1", subject: "0xaaa", status: "active", issuedAt: "2026-01-01T00:00:00.000Z" },
    { id: "grant-2", subject: "0xAAA", status: "revoked", issuedAt: "2026-01-03T00:00:00.000Z" },
    { id: "grant-3", subject: "0xbbb", status: "active", issuedAt: "2026-01-02T00:00:00.000Z" },
    undefined
  ];

  assert.deepEqual(listCapabilityGrantRecords(records, { subject: "0xaaa", limit: 10 }).map((record) => record.id), [
    "grant-2",
    "grant-1"
  ]);
  assert.deepEqual(filterCapabilityGrantRecords(records, { status: "active" }).map((record) => record.id), [
    "grant-1",
    "grant-3"
  ]);
});
