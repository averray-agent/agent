import test from "node:test";
import assert from "node:assert/strict";

import { createLogger, resolveRequestId } from "./logger.js";
import { AppError } from "./errors.js";

function collectingSink() {
  const records = [];
  const sink = (level, record) => {
    records.push({ level, record });
  };
  return { sink, records };
}

test("logger emits JSON records above the level threshold", () => {
  const { sink, records } = collectingSink();
  const logger = createLogger({ name: "test", level: "info", sink });
  logger.debug("suppressed");
  logger.info({ foo: "bar" }, "hello");
  logger.warn("warn-only");
  assert.equal(records.length, 2);
  assert.equal(records[0].record.msg, "hello");
  assert.equal(records[0].record.foo, "bar");
  assert.equal(records[0].record.name, "test");
  assert.equal(records[1].record.msg, "warn-only");
});

test("logger.child merges base fields into subsequent records", () => {
  const { sink, records } = collectingSink();
  const logger = createLogger({ name: "test", level: "info", sink });
  const child = logger.child({ requestId: "abc-123" });
  child.info({ action: "login" }, "auth.success");
  assert.equal(records[0].record.requestId, "abc-123");
  assert.equal(records[0].record.action, "login");
});

test("logger serializes errors with stack and code fields", () => {
  const { sink, records } = collectingSink();
  const logger = createLogger({ name: "test", level: "error", sink });
  const error = new AppError("boom", { code: "boom_code", statusCode: 500 });
  logger.error({ err: error }, "boom");
  assert.equal(records[0].record.err.message, "boom");
  assert.equal(records[0].record.err.code, "boom_code");
  assert.ok(typeof records[0].record.err.stack === "string");
});

test("logger falls back to info when level is invalid", () => {
  const { sink, records } = collectingSink();
  const logger = createLogger({ name: "test", level: "bogus", sink });
  logger.debug("suppressed");
  logger.info("surfaced");
  assert.equal(records.length, 1);
  assert.equal(records[0].record.msg, "surfaced");
});

test("resolveRequestId prefers X-Request-Id header when supplied", () => {
  const id = resolveRequestId({ headers: { "x-request-id": "client-supplied-123" } });
  assert.equal(id, "client-supplied-123");
});

test("resolveRequestId generates a uuid when no header present", () => {
  const id = resolveRequestId({ headers: {} });
  assert.match(id, /^[0-9a-f-]{36}$/);
});

test("resolveRequestId ignores oversize header values", () => {
  const oversized = "x".repeat(200);
  const id = resolveRequestId({ headers: { "x-request-id": oversized } });
  assert.notEqual(id, oversized);
  assert.match(id, /^[0-9a-f-]{36}$/);
});
