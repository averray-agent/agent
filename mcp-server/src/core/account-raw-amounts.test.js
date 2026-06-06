import test from "node:test";
import assert from "node:assert/strict";

import {
  addRawAmount,
  addRequestId,
  applyRawDeallocation,
  hasRequestId,
  normalizeRequestIds,
  normalizeUnsignedRawAmount,
  removeRequestId,
  subtractRawAmount
} from "./account-raw-amounts.js";
import { ValidationError } from "./errors.js";

test("normalizeUnsignedRawAmount accepts exact non-negative raw amounts", () => {
  assert.equal(normalizeUnsignedRawAmount(undefined), undefined);
  assert.equal(normalizeUnsignedRawAmount(null), undefined);
  assert.equal(normalizeUnsignedRawAmount(""), undefined);
  assert.equal(normalizeUnsignedRawAmount(0), "0");
  assert.equal(normalizeUnsignedRawAmount(42), "42");
  assert.equal(normalizeUnsignedRawAmount(42n), "42");
  assert.equal(normalizeUnsignedRawAmount(" 00042 "), "42");
});

test("normalizeUnsignedRawAmount rejects negative, fractional, and unsafe values", () => {
  assert.throws(() => normalizeUnsignedRawAmount(-1), ValidationError);
  assert.throws(() => normalizeUnsignedRawAmount(1.5), ValidationError);
  assert.throws(() => normalizeUnsignedRawAmount(Number.MAX_SAFE_INTEGER + 1), ValidationError);
  assert.throws(() => normalizeUnsignedRawAmount(-1n), ValidationError);
  assert.throws(() => normalizeUnsignedRawAmount("-1"), ValidationError);
  assert.throws(() => normalizeUnsignedRawAmount("1.5"), ValidationError);
  assert.throws(() => normalizeUnsignedRawAmount({ value: 1 }), ValidationError);
});

test("raw amount arithmetic keeps undefined current values and clamps subtraction at zero", () => {
  assert.equal(addRawAmount(undefined, undefined), undefined);
  assert.equal(addRawAmount(undefined, 5), "5");
  assert.equal(addRawAmount("7", 5n), "12");
  assert.equal(subtractRawAmount(undefined, 5), undefined);
  assert.equal(subtractRawAmount("7", undefined), "7");
  assert.equal(subtractRawAmount("7", 2), "5");
  assert.equal(subtractRawAmount("7", 9), "0");
});

test("request id helpers normalize, dedupe, test, and remove ids", () => {
  assert.deepEqual(normalizeRequestIds(undefined), []);
  assert.deepEqual(normalizeRequestIds([" ABC ", "", undefined, "def"]), ["abc", "def"]);

  const added = addRequestId([" ABC "], "abc");
  assert.deepEqual(added, ["abc"]);
  assert.equal(hasRequestId(added, " ABC "), true);
  assert.equal(hasRequestId(added, "missing"), false);
  assert.deepEqual(addRequestId(added, " DEF "), ["abc", "def"]);
  assert.deepEqual(removeRequestId(["abc", "def"], " ABC "), ["def"]);
  assert.deepEqual(removeRequestId(["abc", "def"], ""), ["abc", "def"]);
});

test("applyRawDeallocation updates raw principal, yield, and mark value proportionally", () => {
  const entry = {
    principalRaw: "1000",
    markValueRaw: "1250",
    realizedYieldRaw: "10"
  };

  const result = applyRawDeallocation(entry, "500");

  assert.deepEqual(result, { realizedYieldDeltaRaw: "100" });
  assert.equal(entry.principalRaw, "600");
  assert.equal(entry.markValueRaw, "750");
  assert.equal(entry.realizedYieldRaw, "110");
});

test("applyRawDeallocation is a no-op when raw principal is absent", () => {
  const entry = {};

  const result = applyRawDeallocation(entry, "500");

  assert.deepEqual(result, {});
  assert.deepEqual(entry, {});
});
