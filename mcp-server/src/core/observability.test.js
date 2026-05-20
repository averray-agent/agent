import test from "node:test";
import assert from "node:assert/strict";

import { createObservability } from "./observability.js";

function collectingLogger() {
  const records = [];
  const logger = {};
  for (const level of ["debug", "info", "warn", "error"]) {
    logger[level] = (fieldsOrMessage, message) => {
      records.push({ level, fieldsOrMessage, message });
    };
  }
  return { logger, records };
}

test("observability uses structured-log fallback when Sentry is not configured", async () => {
  const { logger, records } = collectingLogger();
  const observability = await createObservability({ logger, env: {} });

  assert.equal(observability.isEnabled, false);
  observability.captureException(new Error("boom"), { requestId: "req-1" });
  observability.captureMessage("operator.note", { level: "warn", source: "test" });

  assert.equal(records.length, 2);
  assert.equal(records[0].level, "error");
  assert.equal(records[0].message, "observability.captured_exception");
  assert.equal(records[0].fieldsOrMessage.requestId, "req-1");
  assert.equal(records[0].fieldsOrMessage.err.message, "boom");
  assert.equal(records[1].level, "warn");
  assert.equal(records[1].message, "operator.note");
  assert.equal(records[1].fieldsOrMessage.source, "test");
  assert.equal(await observability.flush(), true);
});

test("observability captures to Sentry and still logs locally when configured", async () => {
  const { logger, records } = collectingLogger();
  const sentryCalls = [];
  const observability = await createObservability({
    logger,
    env: {
      SENTRY_DSN: "https://example@sentry.test/1",
      SENTRY_ENVIRONMENT: "testnet"
    },
    sentryLoader: async (dsn, _logger, env) => {
      assert.equal(dsn, "https://example@sentry.test/1");
      assert.equal(env.SENTRY_ENVIRONMENT, "testnet");
      return {
        captureException(error, options) {
          sentryCalls.push({ type: "exception", error, options });
        },
        captureMessage(message, options) {
          sentryCalls.push({ type: "message", message, options });
        },
        flush(timeoutMs) {
          sentryCalls.push({ type: "flush", timeoutMs });
          return Promise.resolve(true);
        }
      };
    }
  });

  assert.equal(observability.isEnabled, true);

  const error = new Error("chain reverted");
  observability.captureException(error, { requestId: "req-2" });
  observability.captureMessage("ops.ready", { level: "info", lane: "deploy" });

  assert.equal(await observability.flush(123), true);
  assert.equal(sentryCalls.length, 3);
  assert.equal(sentryCalls[0].type, "exception");
  assert.equal(sentryCalls[0].error, error);
  assert.deepEqual(sentryCalls[0].options.extra, { requestId: "req-2" });
  assert.equal(sentryCalls[1].type, "message");
  assert.equal(sentryCalls[1].message, "ops.ready");
  assert.deepEqual(sentryCalls[1].options.extra, { lane: "deploy" });
  assert.equal(sentryCalls[2].timeoutMs, 123);

  assert.equal(records.length, 2);
  assert.equal(records[0].level, "error");
  assert.equal(records[0].message, "observability.captured_exception");
  assert.equal(records[1].level, "info");
  assert.equal(records[1].message, "ops.ready");
});

test("observability falls back to logs when Sentry loading fails", async () => {
  const { logger, records } = collectingLogger();
  const observability = await createObservability({
    logger,
    env: { SENTRY_DSN: "https://example@sentry.test/1" },
    sentryLoader: async () => {
      throw new Error("missing package");
    }
  });

  assert.equal(observability.isEnabled, false);
  assert.equal(records.length, 1);
  assert.equal(records[0].level, "warn");
  assert.equal(records[0].message, "observability.sentry_unavailable");
  assert.equal(records[0].fieldsOrMessage.err.message, "missing package");

  observability.captureException(new Error("still logged"), { requestId: "req-3" });
  assert.equal(records[1].level, "error");
  assert.equal(records[1].message, "observability.captured_exception");
  assert.equal(records[1].fieldsOrMessage.requestId, "req-3");
});
