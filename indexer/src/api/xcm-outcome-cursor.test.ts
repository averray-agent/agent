import assert from "node:assert/strict";
import test from "node:test";

import {
  cursorForSource,
  decodeCursor,
  encodeCursor,
  normalizeObservedAtIso,
  toObservedAtIso
} from "./xcm-outcome-cursor.ts";

const requestId = `0x${"11".repeat(32)}`;

test("XCM outcome cursors round-trip indexed and external modes as strings", () => {
  const indexed = encodeCursor({
    mode: "indexed",
    blockNumber: 123n,
    requestId
  });
  const external = encodeCursor({
    mode: "external",
    observedAt: "2026-04-23T12:00:00.000Z",
    requestId
  });

  assert.equal(typeof indexed, "string");
  assert.equal(typeof external, "string");
  assert.deepEqual(decodeCursor(indexed), {
    mode: "indexed",
    blockNumber: 123n,
    requestId
  });
  assert.deepEqual(decodeCursor(external), {
    mode: "external",
    observedAt: "2026-04-23T12:00:00.000Z",
    requestId
  });
});

test("XCM outcome cursor decode rejects malformed or mismatched mode payloads", () => {
  const wrongModePayload = Buffer.from(JSON.stringify({
    mode: "external",
    blockNumber: "123",
    requestId
  }), "utf8").toString("base64url");
  const ambiguousLegacyPayload = Buffer.from(JSON.stringify({
    blockNumber: "123",
    observedAt: "2026-04-23T12:00:00.000Z",
    requestId
  }), "utf8").toString("base64url");
  const hugeBlockPayload = Buffer.from(JSON.stringify({
    mode: "indexed",
    blockNumber: "9223372036854775808",
    requestId
  }), "utf8").toString("base64url");

  assert.equal(decodeCursor(wrongModePayload), undefined);
  assert.equal(decodeCursor(ambiguousLegacyPayload), undefined);
  assert.equal(decodeCursor(hugeBlockPayload), undefined);
  assert.equal(decodeCursor("not-json"), undefined);
});

test("XCM outcome source cursors are only reused against the matching feed", () => {
  const indexed = decodeCursor(encodeCursor({
    mode: "indexed",
    blockNumber: 7n,
    requestId
  }));
  const external = decodeCursor(encodeCursor({
    mode: "external",
    observedAt: "2026-04-23T12:00:00.000Z",
    requestId
  }));

  assert.equal(cursorForSource(indexed, "indexed"), indexed);
  assert.equal(cursorForSource(indexed, "external"), undefined);
  assert.equal(cursorForSource(external, "external"), external);
  assert.equal(cursorForSource(external, "indexed"), undefined);
});

test("XCM outcome timestamps normalize safely without unsafe Date overflow", () => {
  assert.equal(toObservedAtIso(1_712_345_678n), "2024-04-05T19:34:38.000Z");
  assert.equal(toObservedAtIso(8_640_000_000_001n), undefined);
  assert.equal(normalizeObservedAtIso("2026-04-23T12:00:00Z"), "2026-04-23T12:00:00.000Z");
  assert.equal(normalizeObservedAtIso("not-a-date"), undefined);
});
