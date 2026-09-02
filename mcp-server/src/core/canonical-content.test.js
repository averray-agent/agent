import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizeContent, hashCanonicalContent } from "./canonical-content.js";

test("canonicalizeContent sorts object keys deterministically", () => {
  assert.equal(
    canonicalizeContent({ b: 2, a: { z: true, y: null } }),
    '{"a":{"y":null,"z":true},"b":2}'
  );
});

test("hashCanonicalContent is stable across key order", () => {
  assert.equal(
    hashCanonicalContent({ b: 2, a: 1 }),
    hashCanonicalContent({ a: 1, b: 2 })
  );
});
