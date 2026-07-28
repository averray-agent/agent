import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeExternalJobCreationCursor,
  encodeExternalJobCreationCursor
} from "./external-job-creation-cursor.ts";

test("external job creation cursors round-trip exact block and event ordering", () => {
  const encoded = encodeExternalJobCreationCursor({
    blockNumber: 1234n,
    eventId: `0x${"ab".repeat(32)}-7`
  });
  assert.deepEqual(decodeExternalJobCreationCursor(encoded), {
    blockNumber: 1234n,
    eventId: `0x${"ab".repeat(32)}-7`
  });
});

test("external job creation cursors reject malformed and out-of-range values", () => {
  assert.equal(decodeExternalJobCreationCursor("not-base64-json"), undefined);
  assert.equal(decodeExternalJobCreationCursor(Buffer.from(JSON.stringify({
    blockNumber: "-1",
    eventId: "event-1"
  })).toString("base64url")), undefined);
  assert.equal(decodeExternalJobCreationCursor(Buffer.from(JSON.stringify({
    blockNumber: "1",
    eventId: "bad event id"
  })).toString("base64url")), undefined);
});
