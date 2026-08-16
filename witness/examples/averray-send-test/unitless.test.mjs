import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDuration } from "../../src/duration.js";

test("treats a unitless duration as seconds", () => {
  assert.equal(parseDuration("2"), 2_000);
});
