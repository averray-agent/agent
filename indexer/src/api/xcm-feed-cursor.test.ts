import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAdvancingNextCursor } from "./xcm-feed-cursor.ts";

test("XCM feed cursor normalization accepts empty end-of-feed pages", () => {
  assert.equal(normalizeAdvancingNextCursor(undefined, 0, "test source"), undefined);
  assert.equal(normalizeAdvancingNextCursor("   ", 0, "test source"), undefined);
});

test("XCM feed cursor normalization trims advancing cursors", () => {
  assert.equal(normalizeAdvancingNextCursor(" cursor-2 ", 1, "test source"), "cursor-2");
});

test("XCM feed cursor normalization rejects non-empty batches without nextCursor", () => {
  assert.throws(
    () => normalizeAdvancingNextCursor(undefined, 1, "test source"),
    /non-empty XCM batches must advance the cursor/u
  );
});
