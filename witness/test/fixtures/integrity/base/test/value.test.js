import assert from "node:assert/strict";
import test from "node:test";

import { value } from "../src/value.js";

test("returns one", () => {
  assert.equal(value(), 1);
});
