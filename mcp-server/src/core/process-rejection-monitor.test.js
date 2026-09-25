import test from "node:test";
import assert from "node:assert/strict";
import { createProcessRejectionMonitor, PROCESS_REJECTION_WARNING_MS } from "./process-rejection-monitor.js";
import { MetricRegistry } from "./metrics.js";
import { createLogger } from "./logger.js";

test("process rejection warning expires 24 hours after the most recent occurrence", () => {
  let now = Date.parse("2026-09-25T00:00:00Z");
  const logs = [], metrics = new MetricRegistry();
  const monitor = createProcessRejectionMonitor({ metrics, now: () => now,
    logger: createLogger({ sink: (_level, record) => logs.push(record) }) });
  assert.deepEqual(monitor.getWarnings(), []);
  monitor.onUnhandledRejection(new Error("first"));
  now += PROCESS_REJECTION_WARNING_MS - 1;
  assert.equal(monitor.getWarnings()[0].count, 1);
  monitor.onUnhandledRejection("second");
  now += 1;
  assert.equal(monitor.getWarnings()[0].count, 2);
  assert.equal(Object.hasOwn(monitor.getWarnings()[0], "lastMessage"), false);
  assert.equal(monitor.getWarnings()[0].lastAt, "2026-09-25T23:59:59.999Z");
  now += PROCESS_REJECTION_WARNING_MS - 1;
  assert.deepEqual(monitor.getWarnings(), []);
  assert.equal(logs.length, 2);
  assert.equal(logs[1].err.message, "second");
  assert.match(metrics.serialize(), /^process_unhandled_rejections_total 2$/mu);
});

test("process rejection diagnostics tolerate non-Error values", () => {
  const metrics = new MetricRegistry();
  const monitor = createProcessRejectionMonitor({ metrics, logger: { error() {} } });
  for (const value of [null, undefined, 1n, Symbol("reason"), { get message() { throw new Error("getter"); } }]) {
    assert.doesNotThrow(() => monitor.onUnhandledRejection(value));
  }
  assert.equal(monitor.getWarnings()[0].count, 5);
});

test("process rejection retains its warning and metric if the error log sink fails", (t) => {
  const output = [];
  t.mock.method(process.stderr, "write", (line) => { output.push(JSON.parse(line)); return true; });
  const metrics = new MetricRegistry();
  const monitor = createProcessRejectionMonitor({ metrics, logger: { error() { throw new Error("sink unavailable"); } } });
  assert.doesNotThrow(() => monitor.onUnhandledRejection(new Error("reported failure")));
  assert.equal(Object.hasOwn(monitor.getWarnings()[0], "lastMessage"), false);
  assert.equal(output.length, 1);
  assert.equal(output[0].msg, "process.unhandled_rejection");
  assert.equal(output[0].err.message, "reported failure");
  assert.match(metrics.serialize(), /^process_unhandled_rejections_total 1$/mu);
});
